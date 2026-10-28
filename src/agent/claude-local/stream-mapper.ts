/**
 * Raw Anthropic streaming events (the SDK's `stream_event` messages with
 * includePartialMessages) → pi's AssistantMessageEvent vocabulary, with the
 * full partial AssistantMessage on every event — exactly what pi's own
 * provider streams yield, so the turn runner's views, the record and the
 * usage listener see no difference between this route and pi-ai's.
 *
 * Usage: `message_start` carries input/cache tokens, `message_delta`
 * the (cumulative) output tokens; cost is zero by law — plan usage is
 * never dollars. Tool-use names arrive prefixed (`mcp__<server>__quiz`)
 * and are recorded BARE; arguments accumulate from input_json_delta and
 * parse at block stop (a bad JSON body becomes argumentsError, pi's own
 * convention, so validation fails with the text the model sent).
 */
import type { AssistantMessage, AssistantMessageEvent, StopReason, Usage } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SDKMessage } from "./sdk.ts";

/** One raw Anthropic streaming event, as the SDK's stream_event carries it. */
export type RawStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

export function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function emptyAssistant(model: Pick<Model<any>, "api" | "provider" | "id">, stopReason: StopReason = "pending"): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason, timestamp: Date.now() };
}
export function bareToolName(name: string, serverName: string): string {
	const prefix = `mcp__${serverName}__`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
/** pi's Anthropic provider mapping (pi-ai anthropic-messages mapStopReason). */
function mapStopReason(reason: string | null | undefined, explanation?: string | null): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "tool_use": return { stopReason: "toolUse" };
		case "max_tokens": return { stopReason: "length" };
		case "end_turn": case "stop_sequence": return { stopReason: "stop" };
		// A paused long-running turn (server tools): pi records it as a plain
		// stop ("stop is good enough -> resubmit"); the app's next turn resumes.
		case "pause_turn": return { stopReason: "stop" };
		// pi records a refusal as an error with the API's explanation.
		case "refusal": return { stopReason: "error", errorMessage: explanation || "The model refused to complete the request" };
		default: return { stopReason: "stop" };
	}
}
function total(usage: Usage): number { return usage.input + usage.output + usage.cacheRead + usage.cacheWrite; }

interface ToolBlock { index: number; json: string }

export class ClaudeStreamMapper {
	partial: AssistantMessage;
	/** Set once message_start arrived (the assistant message exists). */
	started = false;
	/** Set at message_stop. */
	stopped = false;
	private readonly tools = new Map<number, ToolBlock>();
	private readonly model: Pick<Model<any>, "api" | "provider" | "id">;
	private readonly serverName: string;
	private readonly thinkingLevel?: string;
	private stopReason: StopReason = "pending";
	private stopError?: string;
	constructor(model: Pick<Model<any>, "api" | "provider" | "id">, serverName: string, thinkingLevel?: string) {
		this.model = model; this.serverName = serverName; this.thinkingLevel = thinkingLevel;
		this.partial = emptyAssistant(model);
	}
	private snapshot(): AssistantMessage { return { ...this.partial, content: [...this.partial.content], usage: { ...this.partial.usage, cost: { ...this.partial.usage.cost } } }; }
	/** Feed one raw event; get the pi events it produces (0..n). */
	handle(event: RawStreamEvent): AssistantMessageEvent[] {
		const out: AssistantMessageEvent[] = [];
		switch (event.type) {
			case "message_start": {
				this.started = true;
				const usage = event.message.usage;
				this.partial = { ...emptyAssistant(this.model), ...(event.message.model ? { responseModel: event.message.model } : {}), responseId: event.message.id, ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel as AssistantMessage["thinkingLevel"] } : {}) };
				this.partial.usage.input = usage?.input_tokens ?? 0;
				this.partial.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
				this.partial.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
				this.partial.usage.output = usage?.output_tokens ?? 0;
				this.partial.usage.totalTokens = total(this.partial.usage);
				out.push({ type: "start", partial: this.snapshot() });
				break;
			}
			case "content_block_start": {
				const block = event.content_block;
				if (block.type === "text") {
					this.partial.content[event.index] = { type: "text", text: block.text ?? "" };
					out.push({ type: "text_start", contentIndex: event.index, partial: this.snapshot() });
				} else if (block.type === "thinking") {
					this.partial.content[event.index] = { type: "thinking", thinking: block.thinking ?? "", ...(block.signature ? { thinkingSignature: block.signature } : {}) };
					out.push({ type: "thinking_start", contentIndex: event.index, partial: this.snapshot() });
				} else if (block.type === "redacted_thinking") {
					this.partial.content[event.index] = { type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true };
					out.push({ type: "thinking_start", contentIndex: event.index, partial: this.snapshot() });
				} else if (block.type === "tool_use" || block.type === "mcp_tool_use") {
					const name = bareToolName(block.name, this.serverName);
					const initial = block.input && typeof block.input === "object" && Object.keys(block.input as object).length > 0 ? JSON.stringify(block.input) : "";
					this.tools.set(event.index, { index: event.index, json: initial });
					this.partial.content[event.index] = { type: "toolCall", id: block.id, name, arguments: initial ? (block.input as Record<string, never>) : {} };
					out.push({ type: "toolcall_start", contentIndex: event.index, partial: this.snapshot() });
				}
				break;
			}
			case "content_block_delta": {
				const current = this.partial.content[event.index];
				if (!current) break;
				const delta = event.delta;
				if (delta.type === "text_delta" && current.type === "text") {
					current.text += delta.text;
					out.push({ type: "text_delta", contentIndex: event.index, delta: delta.text, partial: this.snapshot() });
				} else if (delta.type === "thinking_delta" && current.type === "thinking") {
					current.thinking += delta.thinking;
					out.push({ type: "thinking_delta", contentIndex: event.index, delta: delta.thinking, partial: this.snapshot() });
				} else if (delta.type === "signature_delta" && current.type === "thinking") {
					current.thinkingSignature = (current.thinkingSignature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && current.type === "toolCall") {
					const tool = this.tools.get(event.index);
					if (tool) {
						tool.json += delta.partial_json;
						try { current.arguments = JSON.parse(tool.json); } catch { /* incomplete — parsed at stop */ }
					}
					out.push({ type: "toolcall_delta", contentIndex: event.index, delta: delta.partial_json, partial: this.snapshot() });
				}
				break;
			}
			case "content_block_stop": {
				const current = this.partial.content[event.index];
				if (!current) break;
				if (current.type === "text") out.push({ type: "text_end", contentIndex: event.index, content: current.text, partial: this.snapshot() });
				else if (current.type === "thinking") out.push({ type: "thinking_end", contentIndex: event.index, content: current.thinking, partial: this.snapshot() });
				else if (current.type === "toolCall") {
					const tool = this.tools.get(event.index);
					if (tool) {
						const raw = tool.json.trim();
						if (raw) {
							try {
								const parsed = JSON.parse(raw);
								if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current.arguments = parsed;
								else { current.arguments = {}; current.argumentsError = `Tool arguments were not a JSON object: ${raw}`; }
							} catch { current.arguments = {}; current.argumentsError = `Tool arguments were not valid JSON: ${raw}`; }
						} else current.arguments = {};
					}
					out.push({ type: "toolcall_end", contentIndex: event.index, toolCall: current, partial: this.snapshot() });
				}
				break;
			}
			case "message_delta": {
				const usage = event.usage;
				if (usage) {
					if (typeof usage.output_tokens === "number") this.partial.usage.output = usage.output_tokens;
					if (typeof usage.input_tokens === "number" && usage.input_tokens > 0) this.partial.usage.input = usage.input_tokens;
					if (typeof usage.cache_read_input_tokens === "number") this.partial.usage.cacheRead = usage.cache_read_input_tokens;
					if (typeof usage.cache_creation_input_tokens === "number") this.partial.usage.cacheWrite = usage.cache_creation_input_tokens;
					this.partial.usage.totalTokens = total(this.partial.usage);
				}
				if (event.delta?.stop_reason) {
					const mapped = mapStopReason(event.delta.stop_reason, event.delta.stop_details?.explanation);
					this.stopReason = mapped.stopReason;
					this.stopError = mapped.errorMessage;
				}
				break;
			}
			case "message_stop": {
				this.stopped = true;
				this.partial.stopReason = this.stopReason === "pending" ? (this.partial.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop") : this.stopReason;
				break;
			}
		}
		return out;
	}
	/** The start of a message nothing of which streamed (a failure that is
	 *  its own message): every message the runner yields opens with one. */
	start(): AssistantMessageEvent {
		this.started = true;
		if (this.thinkingLevel !== undefined) this.partial.thinkingLevel = this.thinkingLevel as AssistantMessage["thinkingLevel"];
		return { type: "start", partial: this.snapshot() };
	}
	/** The terminal event: `done` with the final message, or `error`. */
	finish(failure?: { reason: "error" | "aborted"; message: string }): AssistantMessageEvent {
		const content = this.partial.content.filter(Boolean);
		// A stop reason pi records as an error (a refusal) ends as one.
		if (!failure && this.stopReason === "error") failure = { reason: "error", message: this.stopError ?? "failed" };
		if (failure) {
			const error: AssistantMessage = { ...this.snapshot(), content, stopReason: failure.reason, errorMessage: failure.message };
			this.partial = error;
			return { type: "error", reason: failure.reason, error };
		}
		const message: AssistantMessage = { ...this.snapshot(), content, stopReason: this.partial.stopReason === "pending" ? (content.some((c) => c.type === "toolCall") ? "toolUse" : "stop") : this.partial.stopReason };
		this.partial = message;
		return { type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message };
	}
}
