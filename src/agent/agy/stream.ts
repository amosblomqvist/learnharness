import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ThinkingLevel,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { parseAgyLine } from "./cli-events.ts";
import { AgyError } from "./constants.ts";
import { AgyLaunchError } from "./launch.ts";
import { toAgyPrompt, toAgyStreamJsonLine } from "./transcript.ts";

export type RunAgyOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };
export type AgyChild = ChildProcessWithoutNullStreams | null;
export type RunAgy = (args: string[], options: RunAgyOptions) => AgyChild | Promise<AgyChild>;

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";

const EFFORTS: Record<ThinkingLevel, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function toAgyArgs(modelId: string, reasoning?: ThinkingLevel): string[] {
	const args = [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--disable-slash-commands",
		"--model",
		modelId,
	];

	const hasFixedEffort = /-high$|-medium$|-low$|-xhigh$|-max$/.test(modelId);
	if (!modelId.startsWith("claude-") && !hasFixedEffort && reasoning) {
		const effort = EFFORTS[reasoning];
		if (effort) {
			args.push("--effort", effort);
		}
	}

	return args;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function startTurn(
	runAgy: RunAgy,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	const output = createOutput(model);
	let finished = false;
	let started = false;
	let cwd: string | null = null;
	let cleanedUp = false;

	const cleanup = async () => {
		if (cleanedUp || !cwd) return;
		cleanedUp = true;
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	};

	const fail = (message: string, reason: "aborted" | "error") => {
		if (finished) return;
		finished = true;
		output.stopReason = reason;
		output.errorMessage = message.toLowerCase().includes("not signed in") ? AgyError.NotSignedIn : message;
		stream.push({ type: "error", reason, error: output });
		stream.end();
		void cleanup();
	};

	if (options?.signal?.aborted) {
		fail(ABORT_MESSAGE, "aborted");
		return;
	}

	try {
		cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
	} catch (err: unknown) {
		fail((err as Error).message || START_FAILED_MESSAGE, "error");
		return;
	}

	const args = toAgyArgs(model.id, options?.reasoning);
	let child: AgyChild;

	try {
		child = await runAgy(args, { cwd, env: externalCliEnv(), signal: options?.signal });
	} catch (err: unknown) {
		const message = options?.signal?.aborted
			? ABORT_MESSAGE
			: err instanceof AgyLaunchError
				? err.message
				: (err as Error).message || START_FAILED_MESSAGE;
		fail(message, options?.signal?.aborted ? "aborted" : "error");
		return;
	}

	if (!child) {
		fail(AgyError.CliNotFound, "error");
		return;
	}

	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};

	type TextBlock = { contentIndex: number; block: { type: "text"; text: string } };
	type ThinkingBlock = { contentIndex: number; block: { type: "thinking"; thinking: string } };

	let currentText: TextBlock | null = null;
	let currentThinking: ThinkingBlock | null = null;

	const closeThinking = () => {
		if (currentThinking) {
			stream.push({
				type: "thinking_end",
				contentIndex: currentThinking.contentIndex,
				content: currentThinking.block.thinking,
				partial: output,
			});
			currentThinking = null;
		}
	};

	const closeText = () => {
		if (currentText) {
			stream.push({
				type: "text_end",
				contentIndex: currentText.contentIndex,
				content: currentText.block.text,
				partial: output,
			});
			currentText = null;
		}
	};

	let stderrOutput = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderrOutput += chunk.toString("utf8");
	});

	child.stdin.on("error", () => {});

	if (options?.signal) {
		const onAbort = () => {
			try {
				child?.kill("SIGTERM");
			} catch {}
			fail(ABORT_MESSAGE, "aborted");
		};

		if (options.signal.aborted) {
			onAbort();
			return;
		}
		options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const rl = createInterface({ input: child.stdout });

	rl.on("line", (line: string) => {
		if (finished) return;
		const event = parseAgyLine(line);
		if (!event) return;

		switch (event.type) {
			case "init":
				start();
				break;

			case "step_update": {
				const update = event.stepUpdate;
				const isThinking =
					Boolean(update.thinking_delta) ||
					update.step_type === "thinking" ||
					update.step_type === "thought" ||
					update.step_type === "reasoning";

				if (isThinking) {
					const delta = update.thinking_delta ?? update.text_delta;
					if (delta) {
						start();
						closeText();
						if (!currentThinking) {
							const contentIndex = output.content.length;
							const block = { type: "thinking" as const, thinking: "" };
							output.content.push(block);
							currentThinking = { contentIndex, block };
							stream.push({ type: "thinking_start", contentIndex, partial: output });
						}
						currentThinking.block.thinking += delta;
						stream.push({
							type: "thinking_delta",
							contentIndex: currentThinking.contentIndex,
							delta,
							partial: output,
						});
					}
					if (update.state === "DONE") {
						closeThinking();
					}
				} else {
					const delta = update.text_delta;
					if (delta) {
						start();
						closeThinking();
						if (!currentText) {
							const contentIndex = output.content.length;
							const block = { type: "text" as const, text: "" };
							output.content.push(block);
							currentText = { contentIndex, block };
							stream.push({ type: "text_start", contentIndex, partial: output });
						}
						currentText.block.text += delta;
						stream.push({
							type: "text_delta",
							contentIndex: currentText.contentIndex,
							delta,
							partial: output,
						});
					}
					if (update.state === "DONE") {
						closeText();
					}
				}

				if (update.usage) {
					if (typeof update.usage.input_tokens === "number") output.usage.input = update.usage.input_tokens;
					if (typeof update.usage.output_tokens === "number") output.usage.output = update.usage.output_tokens;
					if (typeof update.usage.total_tokens === "number") output.usage.totalTokens = update.usage.total_tokens;
					if (typeof update.usage.cache_read_tokens === "number") output.usage.cacheRead = update.usage.cache_read_tokens;
					if (typeof update.usage.thinking_tokens === "number") output.usage.reasoning = update.usage.thinking_tokens;
				}
				break;
			}

			case "result": {
				start();
				closeThinking();
				closeText();

				if (event.result.usage) {
					if (typeof event.result.usage.input_tokens === "number") output.usage.input = event.result.usage.input_tokens;
					if (typeof event.result.usage.output_tokens === "number") output.usage.output = event.result.usage.output_tokens;
					if (typeof event.result.usage.total_tokens === "number") output.usage.totalTokens = event.result.usage.total_tokens;
					if (typeof event.result.usage.cache_read_tokens === "number") output.usage.cacheRead = event.result.usage.cache_read_tokens;
					if (typeof event.result.usage.thinking_tokens === "number") output.usage.reasoning = event.result.usage.thinking_tokens;
				}

				if (event.result.status === "ERROR") {
					fail(event.result.error || stderrOutput.trim() || "AGY turn failed", "error");
					return;
				}

				if (output.content.length === 0 && event.result.response) {
					const contentIndex = output.content.length;
					const block = { type: "text" as const, text: event.result.response };
					output.content.push(block);
					stream.push({ type: "text_start", contentIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex, delta: event.result.response, partial: output });
					stream.push({ type: "text_end", contentIndex, content: event.result.response, partial: output });
				}

				finished = true;
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				void cleanup();
				break;
			}
		}
	});

	child.on("close", (code) => {
		void cleanup();
		if (!finished) {
			if (options?.signal?.aborted) {
				fail(ABORT_MESSAGE, "aborted");
			} else if (code !== 0) {
				fail(stderrOutput.trim() || `agy CLI exited with code ${code}`, "error");
			} else {
				start();
				closeThinking();
				closeText();
				finished = true;
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			}
		}
	});

	child.on("error", (err) => {
		fail(err.message, "error");
	});

	const promptText = toAgyPrompt(context.messages);
	const line = toAgyStreamJsonLine(promptText);

	child.stdin.write(line + "\n", () => {
		child?.stdin.end();
	});
}

export function createAgyStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		startTurn(runAgy, stream, model, context, options).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
		});
		return stream;
	};
}
