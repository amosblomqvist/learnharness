import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import {
	createProvider,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Api,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

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
						return `<tool_call>\n${JSON.stringify({ name: p.name, arguments: p.arguments })}\n</tool_call>`;
					}
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function isAntigravityAvailable(): boolean {
	try {
		const cmd = process.platform === "win32" ? "where agy" : "which agy 2>/dev/null";
		const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out.length > 0;
	} catch {
		return false;
	}
}

export function parseToolCallsFromText(text: string): {
	prose: string;
	toolCalls: Array<{ name: string; arguments: JsonObject }>;
} {
	const toolCallRegex = /<tool_call>\s*(?:```(?:json)?\s*)?([\s\S]*?)(?:```\s*)?<\/tool_call>/gi;
	const toolCalls: Array<{ name: string; arguments: JsonObject }> = [];
	let lastIndex = 0;
	let prose = "";
	let match: RegExpExecArray | null;

	while ((match = toolCallRegex.exec(text)) !== null) {
		prose += text.slice(lastIndex, match.index);
		lastIndex = match.index + match[0].length;
		const jsonStr = (match[1] ?? "").trim();
		try {
			const parsed = JSON.parse(jsonStr);
			if (parsed && typeof parsed.name === "string") {
				toolCalls.push({
					name: parsed.name,
					arguments: (parsed.arguments ?? {}) as JsonObject,
				});
			}
		} catch (err) {
			console.error("Failed to parse tool call JSON:", jsonStr, err);
		}
	}
	prose += text.slice(lastIndex);

	if (toolCalls.length === 0 && text.includes("<tool_call>")) {
		const startIdx = text.indexOf("<tool_call>");
		const unclosed = text.slice(startIdx + "<tool_call>".length).trim();
		const cleaned = unclosed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		try {
			const parsed = JSON.parse(cleaned);
			if (parsed && typeof parsed.name === "string") {
				toolCalls.push({
					name: parsed.name,
					arguments: (parsed.arguments ?? {}) as JsonObject,
				});
				prose = text.slice(0, startIdx);
			}
		} catch {
			// incomplete JSON
		}
	}

	return { prose: prose.trim(), toolCalls };
}

export function formatTranscript(context: TranscriptContext): string {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	const sections: string[] = [];

	if (systemPrompt && systemPrompt.trim().length > 0) {
		sections.push(`Instructions:\n${systemPrompt.trim()}`);
	}

	if (tools && tools.length > 0) {
		const toolDocs = tools
			.map((t) => {
				const params = t.parameters ? JSON.stringify(t.parameters) : "{}";
				return `- **${t.name}**: ${t.description}\n  Parameters JSON Schema: ${params}`;
			})
			.join("\n");

		sections.push(
			`# Tools Available\n` +
			`You have access to the following tools to interact with the learning harness and learner:\n\n` +
			`${toolDocs}\n\n` +
			`## Tool Calling Instructions\n` +
			`When you need to ask a question (using probe, quiz, ask_user_question, etc.) or execute an action:\n` +
			`1. Output any introductory prose, feedback, or pedagogical reasoning first.\n` +
			`2. Call the tool using a single <tool_call> block containing a valid JSON object:\n` +
			`<tool_call>\n` +
			`{\n` +
			`  "name": "<tool_name>",\n` +
			`  "arguments": {\n` +
			`    "<parameter_name>": <value>\n` +
			`  }\n` +
			`}\n` +
			`</tool_call>\n` +
			`3. End your turn immediately after closing </tool_call> so the learner can answer in the interactive dock.`
		);
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

	child.on("error", (err: any) => {
		partialMessage.stopReason = "error";
		partialMessage.errorMessage = err?.code === "ENOENT"
			? "Google Antigravity CLI ('agy') was not found in PATH. Please install or authenticate agy."
			: (err?.message ?? "Failed to spawn agy");
		outer.push({ type: "error", reason: "error", error: partialMessage });
		outer.end(partialMessage);
	});

	if (streamOptions?.signal) {
		streamOptions.signal.addEventListener("abort", () => {
			child.kill("SIGTERM");
		});
	}

	let rawOutput = "";
	let textStarted = false;
	let textEmitted = "";
	let textClosed = false;
	let emittedToolCallsCount = 0;
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
					rawOutput += update.text_delta;

					const toolCallIdx = rawOutput.indexOf("<tool_call>");

					if (toolCallIdx === -1) {
						const partialTag = rawOutput.match(/<(?:\/?tool_call.*)?$/);
						const safeIndex = partialTag ? partialTag.index! : rawOutput.length;
						const chunkToEmit = rawOutput.slice(textEmitted.length, safeIndex);
						if (chunkToEmit.length > 0) {
							if (!textStarted) {
								textStarted = true;
								outer.push({
									type: "text_start",
									contentIndex: 0,
									partial: partialMessage,
								});
							}
							textEmitted += chunkToEmit;
							partialMessage.content = [{ type: "text", text: textEmitted }];
							outer.push({
								type: "text_delta",
								contentIndex: 0,
								delta: chunkToEmit,
								partial: partialMessage,
							});
						}
					} else {
						const proseBefore = rawOutput.slice(textEmitted.length, toolCallIdx);
						if (proseBefore.length > 0) {
							if (!textStarted) {
								textStarted = true;
								outer.push({
									type: "text_start",
									contentIndex: 0,
									partial: partialMessage,
								});
							}
							textEmitted += proseBefore;
							partialMessage.content = [{ type: "text", text: textEmitted }];
							outer.push({
								type: "text_delta",
								contentIndex: 0,
								delta: proseBefore,
								partial: partialMessage,
							});
						}
						if (textStarted && !textClosed) {
							textClosed = true;
							outer.push({
								type: "text_end",
								contentIndex: 0,
								content: textEmitted,
								partial: partialMessage,
							});
						}

						const { toolCalls } = parseToolCallsFromText(rawOutput);
						while (emittedToolCallsCount < toolCalls.length) {
							const call = toolCalls[emittedToolCallsCount];
							if (call) {
								const toolCall: ToolCall = {
									type: "toolCall",
									id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
									name: call.name,
									arguments: call.arguments,
								};
								const contentIndex = partialMessage.content.length;
								partialMessage.content.push(toolCall);
								outer.push({ type: "toolcall_start", contentIndex, partial: partialMessage });
								outer.push({ type: "toolcall_end", contentIndex, toolCall, partial: partialMessage });
								partialMessage.stopReason = "toolUse";
							}
							emittedToolCallsCount++;
						}
					}
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
		if (textStarted && !textClosed) {
			textClosed = true;
			outer.push({
				type: "text_end",
				contentIndex: 0,
				content: textEmitted,
				partial: partialMessage,
			});
		}

		const { toolCalls } = parseToolCallsFromText(rawOutput);
		while (emittedToolCallsCount < toolCalls.length) {
			const call = toolCalls[emittedToolCallsCount];
			if (call) {
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
					name: call.name,
					arguments: call.arguments,
				};
				const contentIndex = partialMessage.content.length;
				partialMessage.content.push(toolCall);
				outer.push({ type: "toolcall_start", contentIndex, partial: partialMessage });
				outer.push({ type: "toolcall_end", contentIndex, toolCall, partial: partialMessage });
				partialMessage.stopReason = "toolUse";
			}
			emittedToolCallsCount++;
		}

		partialMessage.usage = {
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		if (code !== 0 && partialMessage.content.length === 0) {
			partialMessage.stopReason = "error";
			partialMessage.errorMessage = stderrText.trim() || `agy exited with code ${code}`;
			outer.push({ type: "error", reason: "error", error: partialMessage });
			outer.end(partialMessage);
			return;
		}

		const reason = partialMessage.stopReason === "toolUse" ? "toolUse" : "stop";
		outer.push({ type: "done", reason, message: partialMessage });
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
