import {
	createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, clampThinkingLevel,
	type AssistantMessage, type Model, type Api, type StreamFunction,
} from "@earendil-works/pi-ai";
import { ACP_AGENTS, ACP_THINKING_LEVELS, type AcpAgentId, type AcpConnectionConfig, type AcpModelInfo } from "../../core/acp.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../models.ts";
import { setImmediate } from "node:timers/promises";
import { acquireAcpSession, closeAcpSessions, type PromptResult } from "./session.ts";
export { acpPrompt } from "./transcript.ts";
export { closeAcpSessions, retireAcpSessions } from "./session.ts";
import type { PiUsageLike } from "../../core/usage.ts";

export function acpModel(id: AcpAgentId, info?: AcpModelInfo): Model<Api> {
	const agent = ACP_AGENTS.find((agent) => agent.id === id)!;
	return {
		id: info?.id ?? "default", name: info?.id !== "default" && info ? info.name : `${agent.label} (agent default)`, provider: agent.provider,
		api: "acp", baseUrl: "", input: ["text", "image"], reasoning: Object.keys(info?.reasoning ?? {}).length > 0,
		thinkingLevelMap: Object.fromEntries(ACP_THINKING_LEVELS.map((level) => [level, info?.reasoning[level] ?? null])),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// The native agent owns model selection and context management. Zero
		// means unreported, and is omitted from the app's context-limit joins.
		contextWindow: 0, maxTokens: 0,
	};
}

function recordUsage(message: AssistantMessage, result: PromptResult | undefined) {
	if (!result?.usage) return;
	const count = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	const usage = result.usage;
	(message.usage as PiUsageLike).lhReportedUsage = {
		inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens),
		cacheReadTokens: count(usage.cachedReadTokens), cacheWriteTokens: count(usage.cachedWriteTokens),
		reasoningTokens: count(usage.thoughtTokens),
	};
	message.usage.input = count(usage.inputTokens) ?? 0;
	message.usage.output = count(usage.outputTokens) ?? 0;
	message.usage.cacheRead = count(usage.cachedReadTokens) ?? 0;
	message.usage.cacheWrite = count(usage.cachedWriteTokens) ?? 0;
	message.usage.reasoning = count(usage.thoughtTokens);
	// Reasoning is a subset of output, not another billable token bucket.
	message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
}

function blankMessage(model: Model<Api>): AssistantMessage {
	const usage: AssistantMessage["usage"] & PiUsageLike = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, lhReportedUsage: {} };
	return {
		role: "assistant", content: [], api: "acp", provider: model.provider, model: model.id,
		timestamp: Date.now(), stopReason: "stop",
		usage,
	};
}

export function createAcpEngine(id: AcpAgentId, config: AcpConnectionConfig, info?: AcpModelInfo, requestedLevel?: ThinkingLevel): PiEngine {
	const selectedModel = acpModel(id, info);
	const legacyDefault = info?.modelId === undefined && requestedLevel === "off" && info?.reasoning.off === undefined;
	const level = requestedLevel === undefined || legacyDefault || !selectedModel.reasoning ? undefined : clampThinkingLevel(selectedModel, requestedLevel);
	const owner = Symbol("ACP engine");
	const streamFn: StreamFunction = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const message = blankMessage(model);
		void (async () => {
			let session: Awaited<ReturnType<typeof acquireAcpSession>>["session"] | undefined;
			let activeBlock: number | undefined;
			const endBlock = () => {
				if (activeBlock === undefined) return;
				const part = message.content[activeBlock]!;
				if (part.type === "text") stream.push({ type: "text_end", contentIndex: activeBlock, content: part.text, partial: message });
				if (part.type === "thinking") stream.push({ type: "thinking_end", contentIndex: activeBlock, content: part.thinking, partial: message });
				activeBlock = undefined;
			};
			try {
				options?.signal?.throwIfAborted();
				stream.push({ type: "start", partial: message });
				const tools = getCurrentTools(context.messages);
				const instructions = `${getCurrentSystemPrompt(context.messages)}\n\nYou are running inside LearnHarness. Use only the provided LearnHarness MCP tools for application actions. Native coding, terminal, and file tools are not needed. The conversation history in the prompt is authoritative.`;
				const signature = JSON.stringify({ id, config, info, level, model: [model.provider, model.id], instructions, tools,
					native: process.env.CODEX_PATH, home: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR, profile: process.env.LH_DATA_DIR });
				const acquired = await acquireAcpSession(options?.sessionId ?? owner, id, signature, context, options?.signal);
				session = acquired.session;
				if (acquired.fresh) await session.start(config, info, level, instructions, tools, context);
				while (true) {
					const event = await session.next();
					if (event.type === "text" || event.type === "thinking") {
						if (activeBlock === undefined || message.content[activeBlock]?.type !== event.type) {
							endBlock();
							activeBlock = message.content.length;
							message.content.push(event.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
							stream.push({ type: event.type === "text" ? "text_start" : "thinking_start", contentIndex: activeBlock, partial: message });
						}
						const part = message.content[activeBlock]!;
						if (part.type === "text") part.text += event.text;
						if (part.type === "thinking") part.thinking += event.text;
						stream.push({ type: event.type === "text" ? "text_delta" : "thinking_delta", contentIndex: activeBlock, delta: event.text, partial: message });
						continue;
					}
					endBlock();
					if (event.type === "tool") {
						const toolCall = event.pending.call;
						const index = message.content.length;
						message.content.push({ ...toolCall, arguments: {} });
						stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
						message.content[index] = toolCall;
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
						// Let a stop arriving during the handoff cancel before retention.
						await setImmediate();
						options?.signal?.throwIfAborted();
						message.stopReason = "toolUse";
						await session.park(context, message, event.pending);
						break;
					}
					if (event.type === "complete") {
						const result = event.result;
						if (result.stopReason === "cancelled") throw new DOMException("ACP turn cancelled", "AbortError");
						if (result.stopReason === "max_tokens") message.stopReason = "length";
						else if (result.stopReason !== "end_turn") throw new Error(`ACP turn did not complete (${result.stopReason ?? "missing stop reason"})`);
						recordUsage(message, result);
						await session.close();
						break;
					}
				}
				options?.signal?.throwIfAborted();
				stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			} catch (error) {
				message.stopReason = options?.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				await session?.close();
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} finally { stream.end(); }
		})();
		return stream;
	};
	return { model: selectedModel, level, streamFn, closeSession: (sessionId) => closeAcpSessions(id, sessionId ?? owner) };
}
