/**
 * The Local Claude route as a pi StreamFunction for TOOL-LESS one-shot
 * calls (the compaction summarizer runs a Local Claude chat's summary on
 * the chat's own engine). Same runner, same admission and masking as the
 * lesson adapter; a context that declares tools is refused up front —
 * v1 serves tools only through the lesson agent (owner-approved scope).
 */
import type { Api, AssistantMessageEvent, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { markUnadmittedUsage, type SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { productionRuntime, type ClaudeLocalRuntime } from "./agent.ts";
import { withoutStderr } from "./launch.ts";
import { claudeLocalError, runClaudeTurn } from "./run.ts";
import { emptyAssistant } from "./stream-mapper.ts";
import { flattenTranscript } from "./transcript.ts";

export function claudeLocalStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle, runtime: ClaudeLocalRuntime = productionRuntime): StreamFunction<Api, SimpleStreamOptions> {
	return (model: Model<Api>, context: TranscriptContext, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = runtime.abortController(purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let committed = false;
			/** The message's done, held until the result says the turn succeeded:
			 *  Claude Code can report a failure after the message stopped, and a
			 *  partial message must never pass as a completed one. */
			let done: Extract<AssistantMessageEvent, { type: "done" }> | undefined;
			let scope: ReturnType<ClaudeLocalRuntime["scope"]> | undefined;
			try {
				if (getCurrentTools(context.messages).length > 0) throw new Error("Local Claude runs tools only in lesson turns; this call declared tools");
				const launch = runtime.launch();
				if (!launch) throw new Error("model catalog unavailable");
				scope = runtime.scope(model.id);
				lifecycle?.captured(runtime.admissionScope(scope));
				if (purpose && !runtime.backgroundAllowed()) throw new Error("background use disabled");
				const level = (options?.reasoning ?? "off") as ThinkingLevel;
				const query = await runtime.query();
				for await (const event of runClaudeTurn({
					query, launch, model, thinkingLevel: level,
					systemPrompt: getCurrentSystemPrompt(context.messages), systemPromptMode: runtime.systemPromptMode(),
					blocks: flattenTranscript(context.messages), tools: [], signal,
					onApiKeySource: (source) => runtime.noteApiKeySource?.(source),
					beforeDispatch: () => { if (!runtime.scopeCurrent(scope!)) throw new Error("connection changed"); lifecycle?.beforeDispatch(runtime.admissionScope(scope!)); committed = true; },
				})) {
					if (event.type === "usage") { runtime.noteUsage(event.report); continue; }
					// The result ends the run here (as the lesson agent does): leaving the
					// loop closes the child at once rather than waiting for it to exit on
					// its own after stdin closed. Only a successful result releases the
					// held done.
					if (event.type === "result") {
						if (!event.ok) throw new Error(event.errors.join("; ") || (signal.aborted ? "aborted" : "Local Claude stream failed"));
						break;
					}
					if (event.type !== "assistant") continue;
					const e = event.event;
					if (e.type === "done") { if (!done) done = e; }
					else if (e.type === "error") throw new Error(e.error.errorMessage ?? "Local Claude stream failed");
					else if (!done) output.push(e);
				}
				if (!done) throw new Error(signal.aborted ? "aborted" : "Claude Code ended without a response");
				output.push(done);
			} catch (error) {
				const message = withoutStderr(error instanceof Error ? error.message : String(error));
				const failed = { ...emptyAssistant(model, signal.aborted ? "aborted" : "error"), errorMessage: claudeLocalError(message) };
				if (!committed) { markUnadmittedUsage(failed.usage); lifecycle?.noDispatch(runtime.denial(scope, controller, options?.signal?.aborted === true, purpose)); }
				output.push({ type: "error", reason: failed.stopReason as "error" | "aborted", error: failed });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
