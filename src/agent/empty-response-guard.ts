import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export const EMPTY_RESPONSE_RETRY_PROMPT =
	"Your previous response contained internal thinking only and produced no message or tool call for the learner. Complete the turn now with a learner-facing response or an appropriate tool call.";

export const EMPTY_RESPONSE_ERROR_MESSAGE =
	"The model ended the turn without producing a response or tool call (thinking only). Retry or switch models.";

const ABORT_MESSAGE = "Request was aborted";

export function hasDeliverableAssistantOutput(message: Pick<AssistantMessage, "content">): boolean {
	return message.content.some(
		(block) =>
			(block.type === "text" && block.text.trim().length > 0) ||
			block.type === "toolCall",
	);
}

export function isEmptyThinkingOnlyStop(
	reason: StopReason,
	message: Pick<AssistantMessage, "content">,
): boolean {
	return (reason === "stop" || reason === "length") && !hasDeliverableAssistantOutput(message);
}

export function buildEmptyResponseRetryContext(context: TranscriptContext): TranscriptContext {
	const messages = [...context.messages];
	const last = messages[messages.length - 1];
	const nudgeBlock = { type: "text" as const, text: EMPTY_RESPONSE_RETRY_PROMPT };

	if (last?.role === "user") {
		const content =
			typeof last.content === "string"
				? [{ type: "text" as const, text: last.content }, nudgeBlock]
				: [...last.content, nudgeBlock];
		messages[messages.length - 1] = { ...last, content };
	} else {
		messages.push({
			role: "user",
			content: [nudgeBlock],
			timestamp: Date.now(),
		});
	}

	return { ...context, messages };
}

export interface EmptyResponseGuardOptions {
	allowRetry?: () => boolean;
}

/**
 * Shared guard for teaching-side agent streams (prober, teacher, practice).
 * When an upstream stream finishes a turn (`stop` or `length`) with no
 * deliverable prose (non-whitespace `text`) and no `toolCall` (e.g. a
 * thinking-only response), retries once cleanly with a transient in-request
 * nudge that never enters persisted chat history. If it still produces no
 * deliverable output (or retries are disallowed), fails with
 * `stopReason: "error"` so the UI surfaces the error banner and Retry button
 * instead of stalling silently.
 */
export function wrapEmptyResponseGuard(
	inner: StreamFunction<Api, SimpleStreamOptions>,
	guardOptions: EmptyResponseGuardOptions = {},
): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, streamOptions) => {
		const outer = createAssistantMessageEventStream();

		void (async () => {
			let emittedStart = false;
			let lastPartial: AssistantMessage | undefined;

			const forwardEvent = (event: AssistantMessageEvent): void => {
				switch (event.type) {
					case "start":
						if (!emittedStart) {
							emittedStart = true;
							lastPartial = event.partial;
							outer.push(event);
						}
						break;
					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						if (!emittedStart) {
							emittedStart = true;
							outer.push({ type: "start", partial: event.partial });
						}
						lastPartial = event.partial;
						outer.push(event);
						break;
				}
			};

			const failEmpty = (message: AssistantMessage, reason: "error" | "aborted"): void => {
				const failed: AssistantMessage = {
					...message,
					stopReason: reason,
					errorMessage: reason === "aborted" ? ABORT_MESSAGE : EMPTY_RESPONSE_ERROR_MESSAGE,
				};
				outer.push({ type: "error", reason, error: failed });
				outer.end();
			};

			const pumpAttempt = async (
				attemptContext: TranscriptContext,
			): Promise<
				| { terminal: "forwarded" }
				| { terminal: "empty_done"; message: AssistantMessage }
			> => {
				const source = await Promise.resolve(inner(model, attemptContext, streamOptions));
				for await (const event of source) {
					if (event.type === "error") {
						outer.push(event);
						outer.end();
						return { terminal: "forwarded" };
					}
					if (event.type === "done") {
						if (!isEmptyThinkingOnlyStop(event.reason, event.message)) {
							outer.push(event);
							outer.end();
							return { terminal: "forwarded" };
						}
						return { terminal: "empty_done", message: event.message };
					}
					forwardEvent(event);
				}

				const settled = await source.result();
				if (settled.stopReason === "error" || settled.stopReason === "aborted") {
					outer.push({ type: "error", reason: settled.stopReason, error: settled });
					outer.end();
					return { terminal: "forwarded" };
				}
				if (!isEmptyThinkingOnlyStop(settled.stopReason, settled)) {
					outer.push({
						type: "done",
						reason: settled.stopReason as "stop" | "length" | "toolUse",
						message: settled,
					});
					outer.end();
					return { terminal: "forwarded" };
				}
				return { terminal: "empty_done", message: settled };
			};

			try {
				const first = await pumpAttempt(context);
				if (first.terminal === "forwarded") return;

				if (streamOptions?.signal?.aborted) {
					failEmpty(first.message, "aborted");
					return;
				}

				const canRetry = guardOptions.allowRetry ? guardOptions.allowRetry() : true;
				if (!canRetry) {
					failEmpty(first.message, "error");
					return;
				}

				const second = await pumpAttempt(buildEmptyResponseRetryContext(context));
				if (second.terminal === "forwarded") return;

				failEmpty(
					second.message,
					streamOptions?.signal?.aborted ? "aborted" : "error",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const aborted = streamOptions?.signal?.aborted === true;
				const fallback: AssistantMessage = lastPartial
					? { ...lastPartial, stopReason: aborted ? "aborted" : "error", errorMessage: message }
					: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: aborted ? "aborted" : "error",
						errorMessage: message,
						timestamp: Date.now(),
					};
				outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: fallback });
				outer.end();
			}
		})();

		return outer;
	};
}
