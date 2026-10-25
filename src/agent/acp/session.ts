import timers from "node:timers";
import type { AssistantMessage, Tool, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AcpAgentId, AcpConnectionConfig, AcpModelInfo } from "../../core/acp.ts";
import { AcpClient } from "./client.ts";
import { selectAcpModel } from "./catalog.ts";
import { createToolBridge, type PendingAcpTool } from "./tool-bridge.ts";
import { acpHistory, acpHistoryKey, acpPrompt } from "./transcript.ts";

export interface PromptResult {
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number; totalTokens?: number };
}
type NativeEvent = { type: "text" | "thinking"; text: string } | { type: "tool"; pending: PendingAcpTool } | { type: "complete"; result: PromptResult };
type Scope = string | symbol;
const sessions = new Map<Scope, AcpSession>();
const closing = new Set<AcpSession>();
const TIMEOUT_MS = 10 * 60_000;
const MAX_IDLE = 4;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/** A native prompt can span several Pi calls. Its MCP requests stay pending
 * until the next caller proves that only the expected tool results changed. */
class AcpSession {
	active = true;
	private client?: AcpClient;
	private bridge?: Awaited<ReturnType<typeof createToolBridge>>;
	private nativeId?: string;
	private readonly events: NativeEvent[] = [];
	private queuedBytes = 0;
	private wake?: () => void;
	private failure?: Error;
	private ended = false;
	private retired = false;
	private closed = false;
	private closing?: Promise<void>;
	private signal?: AbortSignal;
	private abort?: () => void;
	private deadline?: ReturnType<typeof timers.setTimeout>;
	private checkpoint?: { length: number; key: string; pending: PendingAcpTool[] };

	constructor(readonly scope: Scope, readonly agent: AcpAgentId, readonly signature: string) {}

	bind(signal?: AbortSignal) {
		if (this.abort) this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		this.abort = () => { this.failure = new DOMException("ACP request aborted", "AbortError"); void this.close(); };
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private assertOpen() {
		if (this.closed || this.failure) throw this.failure ?? new Error("ACP session closed");
	}

	private armDeadline() {
		timers.clearTimeout(this.deadline);
		this.deadline = timers.setTimeout(() => {
			if (this.active) this.failure ??= new Error("ACP model call timed out. Check the adapter and its subscription sign-in.");
			void this.close();
		}, TIMEOUT_MS);
		this.deadline.unref();
	}

	private enqueue(event: NativeEvent) {
		if (this.closed) { if (event.type === "tool") event.pending.cancel(); return; }
		this.queuedBytes += this.eventBytes(event);
		if (this.queuedBytes > MAX_QUEUED_BYTES) {
			this.failure = new Error("ACP adapter sent too much output while waiting for an application tool");
			void this.close();
			return;
		}
		this.events.push(event);
		if (event.type === "complete") this.ended = true;
		this.wake?.();
		if (this.ended && !this.active) void this.close();
	}

	private eventBytes(event: NativeEvent) {
		return event.type === "tool" ? Buffer.byteLength(JSON.stringify(event.pending.call))
			: event.type === "complete" ? 0 : Buffer.byteLength(event.text);
	}

	async start(config: AcpConnectionConfig, info: AcpModelInfo | undefined, level: ThinkingLevel | undefined, instructions: string, tools: Tool[], context: TranscriptContext) {
		this.assertOpen();
		this.client = new AcpClient(this.agent, config, {
			applicationTools: tools.map((tool) => tool.name), systemPrompt: instructions,
			onNotification: (method, params) => {
				if (method !== "session/update" || (this.nativeId && params.sessionId !== this.nativeId)) return;
				const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined;
				if (update?.content?.type !== "text" || typeof update.content.text !== "string") return;
				const type = update.sessionUpdate === "agent_message_chunk" ? "text" : update.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
				if (type) this.enqueue({ type, text: update.content.text });
			},
		});
		const initialized = await this.client.initialize();
		this.assertOpen();
		if (tools.length && !initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error("This ACP adapter must support HTTP MCP servers. Update the adapter to use LearnHarness tools.");
		const prompt = acpPrompt(context);
		if (prompt.some((part) => part.type === "image") && !initialized.agentCapabilities?.promptCapabilities?.image) throw new Error("This ACP adapter does not support image input. Choose an image-capable agent for the Vision slot.");
		if (tools.length) {
			this.bridge = await createToolBridge(tools, (pending) => this.enqueue({ type: "tool", pending }), () => {
				if (this.closed) return;
				this.failure ??= new Error("ACP adapter abandoned a pending application tool");
				void this.close();
			});
			if (this.closed) { await this.bridge.close(); this.assertOpen(); }
		}
		const capability = initialized.agentCapabilities?.sessionCapabilities?.systemPrompt;
		const session = await this.client.newSession({
			mcpServers: this.bridge ? [this.bridge.mcpServer] : [],
			...(capability ? { systemPrompt: { mode: capability.mode?.override !== undefined ? "override" : "append", content: [{ type: "text", text: instructions }] } } : {}),
			_meta: { systemPrompt: instructions, disableBuiltInTools: true, claudeCode: { options: { tools: [], allowedTools: tools.map((tool) => `mcp__learnharness__${tool.name}`), settingSources: [], persistSession: false } } },
		});
		this.assertOpen();
		this.nativeId = session.sessionId;
		await selectAcpModel(this.client, session, info, level);
		this.assertOpen();
		// A single prompt remains in flight while MCP requests wait for Pi.
		// Both completion paths are observed even when the Pi caller is paused.
		this.armDeadline();
		void this.client.request<PromptResult>("session/prompt", { sessionId: session.sessionId, prompt }, null).then(
			(result) => this.enqueue({ type: "complete", result }),
			(error: Error) => { if (!this.closed) { this.failure = error; this.wake?.(); if (!this.active) void this.close(); } },
		);
	}

	async next(): Promise<NativeEvent> {
		while (true) {
			this.assertOpen();
			const event = this.events.shift();
			if (event) {
				this.queuedBytes -= this.eventBytes(event);
				return event;
			}
			await new Promise<void>((resolve) => { this.wake = resolve; });
			this.wake = undefined;
		}
	}

	resultsFor(context: TranscriptContext): ToolResultMessage[] | undefined {
		if (this.active || this.closed || this.failure || this.ended || this.retired || !this.checkpoint) return undefined;
		const history = acpHistory(context.messages);
		const { length, key, pending } = this.checkpoint;
		if (history.length !== length + pending.length || acpHistoryKey(history.slice(0, length)) !== key) return undefined;
		const results = context.messages.filter((message) => message.role !== "system").slice(length);
		if (!results.every((message) => message.role === "toolResult")) return undefined;
		const byId = new Map(results.map((message) => [message.toolCallId, message]));
		if (byId.size !== pending.length || pending.some(({ call }) => byId.get(call.id)?.toolName !== call.name)) return undefined;
		return pending.map(({ call }) => byId.get(call.id)!);
	}

	resume(results: ToolResultMessage[]) {
		this.assertOpen();
		this.active = true;
		this.armDeadline();
		const checkpoint = this.checkpoint!;
		this.checkpoint = undefined;
		checkpoint.pending.forEach((pending, i) => pending.complete(results[i]!));
	}

	async park(context: TranscriptContext, message: AssistantMessage, pending: PendingAcpTool) {
		this.assertOpen();
		const history = acpHistory([...context.messages, message]);
		this.checkpoint = { length: history.length, key: acpHistoryKey(history), pending: [pending] };
		this.active = false;
		if (this.ended || this.retired) { await this.close(); return; }
		this.armDeadline();
		// Refresh LRU order. Eviction only discards native state; a later call
		// reconstructs from the authoritative app record without reexecuting tools.
		if (sessions.get(this.scope) === this) { sessions.delete(this.scope); sessions.set(this.scope, this); }
		const idle = [...sessions.values()].filter((session) => !session.active);
		for (const session of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) void session.close();
	}

	retire(): Promise<void> {
		this.retired = true;
		return this.active ? Promise.resolve() : this.close();
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		if (sessions.get(this.scope) === this) sessions.delete(this.scope);
		timers.clearTimeout(this.deadline);
		if (this.abort) this.signal?.removeEventListener("abort", this.abort);
		this.wake?.();
		closing.add(this);
		this.closing = (async () => {
			try { await this.client?.close(); }
			finally { try { await this.bridge?.close(); } finally { closing.delete(this); } }
		})();
		return this.closing;
	}
}

export async function acquireAcpSession(scope: Scope, agent: AcpAgentId, signature: string, context: TranscriptContext, signal?: AbortSignal) {
	const previous = sessions.get(scope);
	if (previous?.active) throw new Error("This ACP conversation already has an active model call");
	const results = previous?.signature === signature ? previous.resultsFor(context) : undefined;
	if (previous && results) {
		previous.bind(signal);
		previous.resume(results);
		return { session: previous, fresh: false };
	}
	const session = new AcpSession(scope, agent, signature);
	sessions.set(scope, session); // Reserve before awaiting cleanup of stale state.
	session.bind(signal);
	try { await previous?.close(); }
	catch (error) { await session.close(); throw error; }
	return { session, fresh: true };
}

/** Disconnect/recheck/shutdown and finite sub-agent runs release their native
 * processes even when a final submit or question stopped Pi at a tool call. */
export async function closeAcpSessions(agent?: AcpAgentId, scope?: Scope): Promise<void> {
	await Promise.all([...new Set([...sessions.values(), ...closing])].filter((session) => (!agent || session.agent === agent) && (scope === undefined || session.scope === scope)).map((session) => session.close()));
}

/** A connection check may refresh identity/catalog state while a reply is
 * streaming. Finish that call, but never reuse its old native context. */
export async function retireAcpSessions(agent: AcpAgentId): Promise<void> {
	await Promise.all([...sessions.values()].filter((session) => session.agent === agent).map((session) => session.retire()));
}
