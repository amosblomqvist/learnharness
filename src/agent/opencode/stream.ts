import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type SimpleStreamOptions,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { externalCliEnv } from "../../core/auth-env.ts";
import { getOpenCodeBinary } from "./binary.ts";

export class OpenCodeLaunchError extends Error {}

function lastUserText(context: TranscriptContext): string {
	const message = [...context.messages].reverse().find((entry) => entry.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export const streamOpenCode: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: output });

	void (async () => {
		const binary = getOpenCodeBinary();
		if (!binary) {
			output.stopReason = "error";
			output.errorMessage = "OpenCode is not installed.";
			stream.push({ type: "error", reason: "error", error: output });
			return;
		}
		const args = ["run", "--format", "json", "--auto", "--model", `github-copilot/auto`, lastUserText(context as TranscriptContext)];
		const child = spawn(binary, args, { cwd: process.cwd(), env: externalCliEnv(), stdio: ["ignore", "pipe", "pipe"] });
		if (options?.signal?.aborted) {
			child.kill("SIGTERM");
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			return;
		}
		const stopAbort = () => child.kill("SIGTERM");
		options?.signal?.addEventListener("abort", stopAbort, { once: true });

		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => {
			try {
				const event = JSON.parse(line);
				if (event.type === "text" && typeof event.part?.text === "string") {
					const block = output.content[0];
					if (block?.type === "text") {
						const delta = event.part.text;
						block.text += delta;
						output.usage.output += 1;
						output.usage.totalTokens += 1;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
					}
				}
				if (event.type === "step_finish" && event.part?.tokens) {
					output.usage.input = event.part.tokens.input ?? 0;
					output.usage.output = event.part.tokens.output ?? output.usage.output;
					output.usage.cacheRead = event.part.tokens.cache?.read ?? 0;
					output.usage.cacheWrite = event.part.tokens.cache?.write ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				}
			} catch {}
		});

		await new Promise<void>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code) => code === 0 ? resolve() : reject(new OpenCodeLaunchError(`OpenCode exited with code ${code}`)));
		});
		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });
	})().catch((error) => {
		output.stopReason = "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: "error", error: output });
	}).finally(() => {
		options?.signal?.removeEventListener("abort", () => {});
	});

	return stream;
};
