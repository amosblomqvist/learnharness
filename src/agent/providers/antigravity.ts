import { spawn } from "node:child_process";
import readline from "node:readline";
import {
	createProvider,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Api,
	type AssistantMessage,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export const ANTIGRAVITY_MODELS: readonly Model<Api>[] = [
	{
		id: "gemini-3.8-flash-high",
		name: "Gemini 3.8 Flash (High)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "gemini-3.8-flash-medium",
		name: "Gemini 3.8 Flash (Medium)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "gemini-3.8-flash-low",
		name: "Gemini 3.8 Flash (Low)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "gemini-4-argon-high",
		name: "Gemini 4 Argon (High)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "gemini-4-argon-medium",
		name: "Gemini 4 Argon (Medium)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "claude-sonnet-5-5-high",
		name: "Claude Sonnet 5.5 (High)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "claude-sonnet-5-5-medium",
		name: "Claude Sonnet 5.5 (Medium)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "claude-opus-5-5-high",
		name: "Claude Opus 5.5 (High)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
	{
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B (Medium)",
		api: "antigravity",
		provider: "antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	},
];

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (typeof part === "object" && part !== null) {
					const p = part as Record<string, unknown>;
					if (typeof p.text === "string") return p.text;
					if (typeof p.thinking === "string") return `[Thinking: ${p.thinking}]`;
					if (typeof p.name === "string" && p.arguments) {
						return `[ToolCall: ${p.name}(${JSON.stringify(p.arguments)})]`;
					}
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function formatTranscript(context: TranscriptContext): string {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const sections: string[] = [];

	if (systemPrompt && systemPrompt.trim().length > 0) {
		sections.push(`Instructions:\n${systemPrompt.trim()}`);
	}

	for (const msg of context.messages) {
		if (msg.role === "system") continue;
		const text = messageContentToText(msg.content);
		if (!text.trim()) continue;

		if (msg.role === "user") {
			sections.push(`User:\n${text.trim()}`);
		} else if (msg.role === "assistant") {
			sections.push(`Assistant:\n${text.trim()}`);
		} else if (msg.role === "toolResult") {
			const toolName = (msg as Record<string, unknown>).toolName ?? "tool";
			sections.push(`[Tool Result (${toolName})]:\n${text.trim()}`);
		}
	}

	return sections.join("\n\n");
}

function streamAntigravity(
	requestModel: Model<Api>,
	context: TranscriptContext,
	streamOptions?: SimpleStreamOptions,
) {
	const outer = createAssistantMessageEventStream();

	const startTime = Date.now();
	const prompt = formatTranscript(context);

	let modelId = requestModel.id;
	if (streamOptions?.reasoning) {
		const effort = streamOptions.reasoning === "minimal" ? "low" : streamOptions.reasoning;
		const base = modelId.replace(/-(low|medium|high|xhigh|max)$/, "");
		const variantId = `${base}-${effort}`;
		if (ANTIGRAVITY_MODELS.some((m) => m.id === variantId)) {
			modelId = variantId;
		}
	}

	const args = [
		"--output-format", "stream-json",
		"--model", modelId,
	];

	if (!modelId.match(/-(low|medium|high|xhigh|max)$/) && streamOptions?.reasoning) {
		const effort = streamOptions.reasoning === "minimal" ? "low" : streamOptions.reasoning;
		args.push("--effort", effort);
	}

	const child = spawn("agy", args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	if (streamOptions?.signal) {
		streamOptions.signal.addEventListener("abort", () => {
			child.kill("SIGTERM");
		});
	}

	let textStarted = false;
	let fullText = "";
	let inputTokens = 0;
	let outputTokens = 0;

	const partialMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: requestModel.api,
		provider: "antigravity",
		model: requestModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: startTime,
	};

	outer.push({ type: "start", partial: partialMessage });

	const rl = readline.createInterface({ input: child.stdout });

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			const data = JSON.parse(trimmed);
			if (data.event === "step_update" && data.step_update) {
				const update = data.step_update;
				if (update.text_delta) {
					if (!textStarted) {
						textStarted = true;
						outer.push({
							type: "text_start",
							contentIndex: 0,
							partial: partialMessage,
						});
					}
					fullText += update.text_delta;
					partialMessage.content = [{ type: "text", text: fullText }];
					outer.push({
						type: "text_delta",
						contentIndex: 0,
						delta: update.text_delta,
						partial: partialMessage,
					});
				}
				if (update.usage) {
					inputTokens = update.usage.input_tokens ?? inputTokens;
					outputTokens = update.usage.output_tokens ?? outputTokens;
				}
			} else if (data.event === "result" && data.result) {
				if (data.result.usage) {
					inputTokens = data.result.usage.input_tokens ?? inputTokens;
					outputTokens = data.result.usage.output_tokens ?? outputTokens;
				}
			}
		} catch {
			// ignore non-json log lines
		}
	});

	let stderrText = "";
	child.stderr.on("data", (chunk: Buffer | string) => {
		stderrText += chunk.toString();
	});

	child.on("error", (err) => {
		partialMessage.stopReason = "error";
		partialMessage.errorMessage = err.message;
		outer.push({ type: "error", reason: "error", error: partialMessage });
		outer.end(partialMessage);
	});

	child.on("close", (code) => {
		if (textStarted) {
			outer.push({
				type: "text_end",
				contentIndex: 0,
				content: fullText,
				partial: partialMessage,
			});
		}

		partialMessage.usage = {
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		if (code !== 0 && !textStarted) {
			partialMessage.stopReason = "error";
			partialMessage.errorMessage = stderrText.trim() || `agy exited with code ${code}`;
			outer.push({ type: "error", reason: "error", error: partialMessage });
			outer.end(partialMessage);
			return;
		}

		outer.push({ type: "done", reason: "stop", message: partialMessage });
		outer.end(partialMessage);
	});

	child.stdin.end(prompt, "utf-8");

	return outer;
}

export function antigravityProvider(): Provider<Api> {
	return createProvider({
		id: "antigravity",
		name: "Google Antigravity",
		auth: {
			apiKey: {
				name: "Antigravity Ambient",
				resolve: async () => ({
					auth: {},
					source: "local-agy",
				}),
				check: async () => ({
					source: "local-agy",
					type: "api_key",
				}),
			},
		},
		models: ANTIGRAVITY_MODELS,
		api: {
			stream: streamAntigravity,
			streamSimple: streamAntigravity,
		},
	});
}
