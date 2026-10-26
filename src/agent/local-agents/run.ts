import { createHash, randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Message, Model, TextContent, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { LocalAgentProviderId } from "../../core/contracts/local-agents.ts";
import type { BridgeTool, BridgeToolResult, ToolBridge, ToolCallRequest } from "./mcp-server.ts";
import type { PromptBlock } from "./transcript.ts";

/**
 * "Park within a run" (docs/architecture.md §8.2). A local CLI runs its own
 * agent loop; pi-agent-core runs the app's. One LocalRun is one live CLI
 * conversation spanning several pi model steps:
 *
 *   step 1  streamFn → cold start: spawn the CLI with the transcript.
 *           The model calls an app tool → the CLI calls the loopback MCP
 *           bridge → the call is surfaced to pi as a toolCall and the pi
 *           step ends with stopReason "toolUse". The MCP request stays
 *           PARKED.
 *   step 2  pi executed the tool; streamFn is called again with the result
 *           → the run matches it (same sessionId, the exact pending call
 *           ids, nothing else appended) → the parked MCP request is
 *           answered and the same CLI process keeps streaming.
 *
 * Anything that does not match (a new learner message, history rewritten,
 * different prompt/tools/model, a lost process) closes the run; the next
 * step cold-starts from the transcript. A run with no pending tool calls is
 * finished and closed — the next learner turn always cold-starts.
 */

export interface RunSession {
	/** Begin the CLI conversation with the opening prompt. */
	start(prompt: PromptBlock[]): void;
	/** Hard stop (idempotent): kill the process, release resources. */
	dispose(): void;
}

export interface DeclaredCall { id: string; name: string; arguments: Record<string, unknown> }

interface CallRecord extends DeclaredCall {
	/** An MCP request has claimed this call. */
	matched: boolean;
	/** pi's result arrived before the MCP request claimed it. */
	result?: BridgeToolResult;
	/** The parked MCP request's resolver. */
	answer?: (result: BridgeToolResult) => void;
	/** Delivered to the CLI — kept only until both sides met. */
	done?: boolean;
}

interface Orphan { request: ToolCallRequest; resolve: (result: BridgeToolResult) => void; timer: ReturnType<typeof setTimeout> }

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** One pi model step's AssistantMessage, built incrementally from CLI events. */
export class StepWriter {
	readonly partial: AssistantMessage;
	private openBlock?: { kind: "text" | "thinking"; index: number };
	ended = false;
	constructor(private readonly out: AssistantMessageEventStream, model: Model<Api>) {
		this.partial = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
		out.push({ type: "start", partial: this.partial });
	}
	private closeBlock() {
		const open = this.openBlock;
		if (!open) return;
		this.openBlock = undefined;
		const block = this.partial.content[open.index]!;
		if (open.kind === "text") this.out.push({ type: "text_end", contentIndex: open.index, content: (block as TextContent).text, partial: this.partial });
		else this.out.push({ type: "thinking_end", contentIndex: open.index, content: (block as { thinking: string }).thinking, partial: this.partial });
	}
	text(delta: string) {
		if (!delta || this.ended) return;
		if (this.openBlock?.kind !== "text") {
			this.closeBlock();
			this.partial.content.push({ type: "text", text: "" });
			this.openBlock = { kind: "text", index: this.partial.content.length - 1 };
			this.out.push({ type: "text_start", contentIndex: this.openBlock.index, partial: this.partial });
		}
		(this.partial.content[this.openBlock.index] as TextContent).text += delta;
		this.out.push({ type: "text_delta", contentIndex: this.openBlock.index, delta, partial: this.partial });
	}
	thinking(delta: string) {
		if (!delta || this.ended) return;
		if (this.openBlock?.kind !== "thinking") {
			this.closeBlock();
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.openBlock = { kind: "thinking", index: this.partial.content.length - 1 };
			this.out.push({ type: "thinking_start", contentIndex: this.openBlock.index, partial: this.partial });
		}
		(this.partial.content[this.openBlock.index] as { thinking: string }).thinking += delta;
		this.out.push({ type: "thinking_delta", contentIndex: this.openBlock.index, delta, partial: this.partial });
	}
	toolCall(call: DeclaredCall) {
		if (this.ended) return;
		this.closeBlock();
		const block: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments as ToolCall["arguments"] };
		this.partial.content.push(block);
		const index = this.partial.content.length - 1;
		this.out.push({ type: "toolcall_start", contentIndex: index, partial: this.partial });
		this.out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.partial });
	}
	get toolCallIds(): string[] { return this.partial.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []); }
	usage(usage: Partial<Omit<Usage, "cost" | "totalTokens">>) {
		const u = this.partial.usage;
		Object.assign(u, usage);
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	}
	done(reason: "stop" | "length" | "toolUse") {
		if (this.ended) return;
		this.closeBlock();
		this.ended = true;
		this.partial.stopReason = reason;
		this.out.push({ type: "done", reason, message: this.partial });
		this.out.end();
	}
	fail(reason: "error" | "aborted", message: string) {
		if (this.ended) return;
		this.closeBlock();
		this.ended = true;
		this.partial.stopReason = reason;
		this.partial.errorMessage = message;
		this.out.push({ type: "error", reason, error: this.partial });
		this.out.end();
	}
}

export function toBridgeResult(result: ToolResultMessage): BridgeToolResult {
	const content: BridgeToolResult["content"] = result.content.map((part) => part.type === "image" ? { type: "image", data: part.data, mimeType: part.mimeType } : { type: "text", text: part.text });
	return { content: content.length ? content : [{ type: "text", text: "" }], ...(result.isError ? { isError: true } : {}) };
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/**
 * What the CLI saw of one message — enough to notice the app's history
 * diverging from the CLI's (compaction, rewrites, a different session)
 * without comparing volatile fields (usage, timestamps, signatures).
 */
function messageKey(message: Message): string {
	let key: string;
	if (message.role === "user") key = `u:${typeof message.content === "string" ? message.content : message.content.map((p) => p.type === "text" ? p.text : `[${p.mimeType}]`).join("\n")}`;
	else if (message.role === "assistant") key = `a:${message.content.map((p) => p.type === "text" ? p.text : p.type === "toolCall" ? `#${p.id}` : "").join("")}`;
	else if (message.role === "toolResult") key = `r:${message.toolCallId}`;
	else key = message.role;
	return createHash("sha1").update(key).digest("base64");
}
export function conversationKeys(messages: readonly Message[]): string[] {
	return messages.filter((m) => m.role !== "system").map(messageKey);
}

const SURFACE_DEBOUNCE_MS = 150;
const ORPHAN_WAIT_MS = 5_000;

export interface LocalRunOptions {
	key: string;
	providerId: LocalAgentProviderId;
	signature: string;
	model: Model<Api>;
	/** ACP: tool calls are only visible when the MCP request arrives. Claude declares them in the stream first. */
	surfaceOnArrival: boolean;
	tools: BridgeTool[];
	idleMs: number;
	onClosed: (run: LocalRun) => void;
}

export class LocalRun {
	readonly key: string;
	readonly providerId: LocalAgentProviderId;
	readonly signature: string;
	readonly tools: BridgeTool[];
	private model: Model<Api>;
	private state: "running" | "parked" | "closed" = "running";
	private writer?: StepWriter;
	private calls: CallRecord[] = [];
	private unsurfaced: CallRecord[] = [];
	private orphans: Orphan[] = [];
	private buffered: Array<{ kind: "text" | "thinking"; delta: string }> = [];
	private surfaceTimer?: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	/** The history this step started from, and what the CLI has seen once parked. */
	private stepKeys: string[] = [];
	private seenKeys: string[] = [];
	session?: RunSession;
	bridge?: ToolBridge;
	/** The latest step ran as background work (withdrawn consent stops it). */
	background = false;
	lastUsed = Date.now();

	constructor(private readonly options: LocalRunOptions) {
		this.key = options.key;
		this.providerId = options.providerId;
		this.signature = options.signature;
		this.model = options.model;
		this.tools = options.tools;
	}

	get closed(): boolean { return this.state === "closed"; }
	get parked(): boolean { return this.state === "parked"; }

	/** Bind the step writer for a cold start from `messages`. */
	attach(writer: StepWriter, messages: readonly Message[]) { this.writer = writer; this.state = "running"; this.stepKeys = conversationKeys(messages); }

	// ── CLI → run ────────────────────────────────────────────────────────
	text(delta: string) { if (this.writer && !this.writer.ended) this.writer.text(delta); else if (delta) this.buffered.push({ kind: "text", delta }); }
	thinking(delta: string) { if (this.writer && !this.writer.ended) this.writer.thinking(delta); else if (delta) this.buffered.push({ kind: "thinking", delta }); }
	usage(usage: Partial<Omit<Usage, "cost" | "totalTokens">>) { this.writer?.usage(usage); }

	/** Claude: a tool_use block completed in the stream. */
	declareToolCall(call: DeclaredCall) {
		if (this.closed) return;
		const record: CallRecord = { ...call, matched: false };
		this.calls.push(record);
		this.writer?.toolCall(record);
		const orphan = this.orphans.find((o) => o.request.name === call.name && canonical(o.request.arguments) === canonical(call.arguments)) ?? this.orphans.find((o) => o.request.name === call.name);
		if (orphan) {
			clearTimeout(orphan.timer);
			this.orphans = this.orphans.filter((o) => o !== orphan);
			record.matched = true;
			void this.awaitResult(record, orphan.request).then(orphan.resolve);
		}
	}

	/**
	 * Claude: a new assistant message began. While parked that means the
	 * CLI moved on without pi's results (it settled a call itself) — the
	 * two conversations no longer line up, so the next step cold-starts.
	 */
	messageStarted() { if (this.state === "parked") this.close(); }

	/** Claude: one assistant message ended. With tool calls the step parks; without, the turn is over. */
	endMessage(reason: "stop" | "length") {
		if (this.state === "parked") { this.close(); return; }
		if (!this.writer || this.writer.ended) return;
		if (this.writer.toolCallIds.length > 0) this.park();
		else this.finish(reason);
	}

	/** The CLI's whole turn completed (ACP prompt response, Claude result). */
	endTurn(reason: "stop" | "length") {
		if (this.writer && !this.writer.ended) {
			// Calls surfaced but the CLI's turn is over: pi still runs them, then cold-starts.
			if (this.writer.toolCallIds.length > 0) { clearTimeout(this.surfaceTimer); this.park(); this.close(); return; }
			this.flushBuffered();
			this.finish(reason);
		} else this.close(); // finished, or parked on calls the CLI no longer waits for
	}

	fail(message: string, reason: "error" | "aborted" = "error") {
		this.writer?.fail(reason, message);
		this.close();
	}

	// ── MCP bridge → run ─────────────────────────────────────────────────
	onBridgeCall(request: ToolCallRequest): Promise<BridgeToolResult> {
		if (this.closed) return Promise.resolve({ content: [{ type: "text", text: "The session ended before the tool could run." }], isError: true });
		const open = this.calls.filter((c) => !c.matched && c.name === request.name);
		const call = open.find((c) => canonical(c.arguments) === canonical(request.arguments)) ?? open[0];
		if (call) { call.matched = true; return this.awaitResult(call, request); }
		if (!this.options.surfaceOnArrival) {
			// The stream may lag the HTTP request by a tick: wait for the declaration.
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.orphans = this.orphans.filter((o) => o.request !== request);
					resolve({ content: [{ type: "text", text: `Unexpected call to ${request.name}.` }], isError: true });
				}, ORPHAN_WAIT_MS);
				this.orphans.push({ request, resolve, timer });
			});
		}
		const record: CallRecord = { id: `lh_${randomUUID()}`, name: request.name, arguments: request.arguments, matched: true };
		this.calls.push(record);
		if (this.writer && !this.writer.ended) { this.writer.toolCall(record); this.scheduleSurfaceEnd(); }
		else this.unsurfaced.push(record);
		return this.awaitResult(record, request);
	}

	private awaitResult(call: CallRecord, request: ToolCallRequest): Promise<BridgeToolResult> {
		const settle = (result: BridgeToolResult) => { call.done = true; this.calls = this.calls.filter((c) => c !== call); return result; };
		if (call.result) return Promise.resolve(settle(call.result));
		return new Promise((resolve) => {
			call.answer = (result) => resolve(settle(result));
			request.abandoned.addEventListener("abort", () => {
				if (call.done) return;
				// The CLI gave up on a parked call (its own timeout): this
				// conversation can no longer line up with pi's — start over.
				this.fail("The agent stopped waiting for a tool result.");
			}, { once: true });
		});
	}

	private scheduleSurfaceEnd() {
		clearTimeout(this.surfaceTimer);
		this.surfaceTimer = setTimeout(() => { if (this.writer && !this.writer.ended && this.writer.toolCallIds.length > 0) this.park(); }, SURFACE_DEBOUNCE_MS);
	}

	// ── pi → run ─────────────────────────────────────────────────────────
	/** The pending call ids this parked run waits on, or undefined if it cannot resume `messages`. */
	resumable(messages: readonly Message[], signature: string): ToolResultMessage[] | undefined {
		if (this.state !== "parked" || signature !== this.signature) return undefined;
		const conversation = messages.filter((m) => m.role !== "system");
		let start = conversation.length;
		while (start > 0 && conversation[start - 1]!.role === "toolResult") start--;
		const results = conversation.slice(start) as ToolResultMessage[];
		const assistant = conversation[start - 1];
		if (results.length === 0 || assistant?.role !== "assistant") return undefined;
		// The app's history must still be exactly what the CLI saw (compaction rewrites it).
		const keys = conversationKeys(conversation.slice(0, start));
		if (keys.length !== this.seenKeys.length || keys.some((key, i) => key !== this.seenKeys[i])) return undefined;
		const asked = assistant.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []);
		const waiting = this.calls.filter((c) => c.result === undefined && !c.done && !this.unsurfaced.includes(c)).map((c) => c.id);
		const answered = new Set(results.map((r) => r.toolCallId));
		if (asked.length !== waiting.length || !asked.every((id) => waiting.includes(id) && answered.has(id))) return undefined;
		return results;
	}

	resume(writer: StepWriter, results: ToolResultMessage[], model: Model<Api>, messages: readonly Message[]) {
		clearTimeout(this.idleTimer);
		this.model = model;
		this.writer = writer;
		this.state = "running";
		this.stepKeys = conversationKeys(messages);
		this.lastUsed = Date.now();
		for (const result of results) {
			const call = this.calls.find((c) => c.id === result.toolCallId);
			if (!call) continue;
			const answer = toBridgeResult(result);
			if (call.answer) call.answer(answer);
			else call.result = answer;
		}
		this.flushBuffered();
		const queued = this.unsurfaced;
		this.unsurfaced = [];
		for (const call of queued) writer.toolCall(call);
		if (queued.length) this.scheduleSurfaceEnd();
	}

	private flushBuffered() {
		const buffered = this.buffered;
		this.buffered = [];
		for (const entry of buffered) entry.kind === "text" ? this.writer?.text(entry.delta) : this.writer?.thinking(entry.delta);
	}

	private park() {
		if (this.writer) this.seenKeys = [...this.stepKeys, messageKey(this.writer.partial)];
		this.writer?.done("toolUse");
		this.writer = undefined;
		this.state = "parked";
		this.lastUsed = Date.now();
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close(), this.options.idleMs);
		this.idleTimer.unref?.();
	}

	private finish(reason: "stop" | "length") {
		this.writer?.done(reason);
		this.close();
	}

	close() {
		if (this.state === "closed") return;
		this.state = "closed";
		clearTimeout(this.idleTimer);
		clearTimeout(this.surfaceTimer);
		this.writer?.fail("error", "The local agent session closed.");
		const closedMessage = { content: [{ type: "text" as const, text: "The session closed before the tool result arrived." }], isError: true };
		for (const call of this.calls) call.answer?.(closedMessage);
		for (const orphan of this.orphans) { clearTimeout(orphan.timer); orphan.resolve(closedMessage); }
		this.calls = []; this.orphans = []; this.unsurfaced = [];
		this.session?.dispose();
		void this.bridge?.close();
		this.options.onClosed(this);
	}
}

// ── registry ─────────────────────────────────────────────────────────────

const MAX_RUNS = 6;
const REGISTRY = Symbol.for("lh.localAgents.runs");
function registry(): Map<string, LocalRun> {
	const g = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, LocalRun> };
	if (!g[REGISTRY]) {
		const runs = new Map<string, LocalRun>();
		g[REGISTRY] = runs;
		// Never leave a CLI process behind the server (kill is synchronous).
		process.once("exit", () => { for (const run of [...runs.values()]) run.close(); });
	}
	return g[REGISTRY];
}

export function findRun(key: string): LocalRun | undefined { return registry().get(key); }

export function createRun(options: Omit<LocalRunOptions, "onClosed">): LocalRun {
	const runs = registry();
	runs.get(options.key)?.close();
	// Bound live processes: evict the least recently used parked runs.
	const parked = [...runs.values()].filter((run) => run.parked).sort((a, b) => a.lastUsed - b.lastUsed);
	while (runs.size >= MAX_RUNS && parked.length) parked.shift()!.close();
	const run = new LocalRun({ ...options, onClosed: (closed) => { if (runs.get(closed.key) === closed) runs.delete(closed.key); } });
	runs.set(options.key, run);
	return run;
}

/** Stop a provider's runs (connection disabled, signed out, identity changed — or only background work, when consent is withdrawn). */
export function closeProviderRuns(providerId: LocalAgentProviderId, options: { backgroundOnly?: boolean } = {}): void {
	for (const run of [...registry().values()]) if (run.providerId === providerId && (!options.backgroundOnly || run.background)) run.close();
}
