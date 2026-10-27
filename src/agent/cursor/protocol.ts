/** Pure translation between an OpenAI chat-completions body and the text
 * cursor-agent sees. LearnHarness keeps the tool loop: the model answers
 * with a JSON envelope, and the proxy turns that envelope into tool_calls. */

export interface CursorToolDef {
	name: string;
	description?: string;
	parameters?: unknown;
}

export interface CursorToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface CursorChatMessage {
	role?: string;
	content?: unknown;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

const BRIDGE_INSTRUCTIONS = [
	"LearnHarness owns every tool listed below. Do not use Cursor's built-in tools, shell, or file edits.",
	"When you need one of those tools, your entire reply must be a single JSON object and no other text:",
	'{"name":"<exact tool name>","arguments":{...}}',
	"The name must be one of the tools below. Arguments must match that tool's schema.",
	"When you do not need a tool, reply with normal text and do not wrap it in JSON.",
].join("\n");

export function toolNames(tools: readonly CursorToolDef[]): Set<string> {
	return new Set(tools.map((tool) => tool.name).filter((name) => name.length > 0));
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as { type?: string; text?: string };
			if (record.type === "text") return record.text ?? "";
			if (record.type === "image_url" || record.type === "image") return "[image]";
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

/** The full prompt handed to cursor-agent. Tool schemas ride in the prompt
 * because the CLI does not accept the caller's tool list as native tools. */
export function buildCursorPrompt(messages: readonly CursorChatMessage[], tools: readonly CursorToolDef[]): string {
	const lines: string[] = [];
	if (tools.length > 0) {
		lines.push(BRIDGE_INSTRUCTIONS, "", "Tools:", JSON.stringify(tools, null, 2), "");
	}
	lines.push("Conversation:");
	for (const message of messages) {
		const role = message.role ?? "user";
		if (role === "tool") {
			lines.push(`Tool result (${message.tool_call_id || message.name || "tool"}):`);
			lines.push(contentToText(message.content));
			continue;
		}
		lines.push(`${role}:`);
		const text = contentToText(message.content);
		if (text) lines.push(text);
		for (const call of message.tool_calls ?? []) {
			const fn = call.function ?? {};
			lines.push(`Tool call ${call.id ?? ""} ${fn.name ?? ""} arguments: ${fn.arguments ?? "{}"}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** A reply that is only a tool envelope (optionally fenced). Prose, or a
 * tool name the caller did not offer, stays text. */
export function parseToolEnvelope(text: string, allowed: ReadonlySet<string>): CursorToolCall[] | null {
	let raw = text.trim();
	const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenced?.[1]) raw = fenced[1].trim();
	if (!raw.startsWith("{") && !raw.startsWith("[")) return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	const items = Array.isArray(data) ? data : [data];
	const calls: CursorToolCall[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") return null;
		const record = item as { name?: unknown; arguments?: unknown };
		if (typeof record.name !== "string" || !record.name) return null;
		if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) return null;
		if (allowed.size > 0 && !allowed.has(record.name)) return null;
		calls.push({ name: record.name, arguments: record.arguments as Record<string, unknown> });
	}
	return calls.length > 0 ? calls : null;
}

export interface DeltaState {
	acc: string;
}

/** cursor-agent mixes partial deltas and cumulative snapshots. Return only
 * the new suffix, or "" when this event repeats text already seen. */
export function nextTextDelta(state: DeltaState, text: string, partial: boolean): string {
	if (!text) return "";
	if (partial) {
		state.acc += text;
		return text;
	}
	if (text.startsWith(state.acc)) {
		const delta = text.slice(state.acc.length);
		state.acc = text;
		return delta;
	}
	state.acc = text;
	return text;
}
