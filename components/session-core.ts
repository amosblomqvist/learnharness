/**
 * THE SESSION MODEL (Wave D): the chat session's state machine, extracted
 * PURE — no React, one injectable fetch — so the attach/replay/settle/
 * error/abort paths are testable in the repo's node:test world. The React
 * hook (components/session.ts) is a thin adapter: it re-renders on change
 * and projects the view (core/view.ts).
 *
 * ONE VIEW PROTOCOL: every turn is a server-side background process (owner
 * ruling 2026-09-25); this model is a view. Sends POST one explicit input
 * event ({chatId, input}); the response and the reattach stream
 * (GET /api/chats/[id]/stream) are the SAME verbatim AgentEvent SSE,
 * applied by the same function. Status vocabulary (pre-Wave-D parity):
 * ready | submitted | streaming | error.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	needsContinuation,
	pendingQuestionOf,
	failedResponseAtEnd,
	measuredContextTokens,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	projectView,
	type ChatInput,
	type LhMarkerMessage,
	type LhMessage,
	type LhViewMessage,
	type LiveExecution,
	type QuestionAnswerData,
	type QuestionDraft,
} from "../src/core";

export type SessionStatus = "ready" | "submitted" | "streaming" | "error";

/** How often to poll turnInFlight while a racing turn runs (409 retry). */
export const TURN_POLL_MS = 500;
/** Give up waiting (a wake turn can run long) and surface the 409. */
export const TURN_WAIT_MAX_MS = 30_000;

export interface SessionModelDeps {
	/** Injectable fetch (tests); defaults to the global. */
	fetch?: typeof globalThis.fetch;
	/** Injectable retry timing (tests). */
	pollMs?: number;
	waitMaxMs?: number;
}

/** A local optimistic id (never a server stamp — absorption and the
 *  settle swap both key on this prefix). */
let localSeq = 0;
function localId(): string {
	return `c_${Date.now().toString(36)}_${(localSeq++).toString(36)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function turnInFlight(model: SessionModel): Promise<boolean | null> {
	try {
		const res = await model.fetch(`/api/jobs?chatId=${encodeURIComponent(model.chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null; // network hiccup: keep waiting, the deadline bounds us
	}
}

const STREAM_DROPPED = "The connection dropped before the turn completed.";

/** Mark transport failures without confusing JSON/application bugs with drops. */
class StreamReadError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/** Wire events; return true ONLY for the explicit completion marker. */
async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Record<string, unknown>, boolean> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try { chunk = await reader.read(); }
		catch (err) { throw new StreamReadError(err); }
		const { done, value } = chunk;
		if (done) return false;
		buf += decoder.decode(value, { stream: true });
		for (;;) {
			const end = buf.indexOf("\n\n");
			if (end === -1) break;
			const event = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
			if (!dataLine) continue;
			const data = dataLine.slice("data: ".length);
			if (data === "[DONE]") return true;
			yield JSON.parse(data) as Record<string, unknown>;
		}
	}
}

/** The dangling question call's tool name (the optimistic answer result's
 *  toolName — the server stamps the same from its own record scan). */
export function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null {
	// Match projection's newest-occurrence pairing for pre-uniquifier records.
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if (m.role !== "assistant") continue;
		for (let bi = m.content.length - 1; bi >= 0; bi--) {
			const block = m.content[bi]!;
			if (block.type === "toolCall" && block.id === toolCallId) return block.name;
		}
	}
	return null;
}

/**
 * Has the record ABSORBED this optimistic tail entry? The write-ahead
 * persists content-identical copies with server-stamped ids — match on the
 * content, not the (local) id; only `c_`-prefixed local entries are ever
 * absorbed (live turn content is never dropped).
 */
export function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean {
	if (typeof m.id !== "string" || !m.id.startsWith("c_")) return false;
	const role = (m as { role?: string }).role;
	if (role === "user") {
		const content = (m as { content?: unknown }).content;
		return record.some(
			(r) => (r as { role?: string }).role === "user" && (r as { content?: unknown }).content === content,
		);
	}
	if (role === "toolResult") {
		const toolCallId = (m as ToolResultMessage).toolCallId;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "toolResult" &&
				(r as ToolResultMessage).toolCallId === toolCallId,
		);
	}
	if (role === "custom") {
		// Markers (the thinking submission, 2026-10-05 — the doubled-card
		// bug: the optimistic practice-thinking card was never absorbed, so
		// the adoption window rendered it beside the write-ahead's server
		// copy for the whole turn). TOTAL over roles by identity key — a
		// marker is itself when its customType AND structured details match;
		// types that never appear optimistically simply never reach here.
		const marker = m as LhMarkerMessage;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "custom" &&
				(r as LhMarkerMessage).customType === marker.customType &&
				sameDetails((r as LhMarkerMessage).details, marker.details),
		);
	}
	return false;
}

/** Structural deep-equal for marker details (JSON-stable payloads — the
 *  constructors mint plain data). */
function sameDetails(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export interface SessionState {
	messages: LhViewMessage[];
	nativeMessages: LhMessage[];
	/** Server-read history only; optimistic bubbles are not delivery proof. */
	hasConfirmedConversation: boolean;
	/** Completed conversation usage; null after compaction or before first usage. */
	contextTokens: number | null;
	status: SessionStatus;
	error: { message: string } | null;
	/** Steers sent but not yet drained (composer steering, 2026-10-03):
	 *  the queued indicator's truth. An entry dies when its id lands in
	 *  the messages (the drain's verbatim events upsert the real card) —
	 *  visibleQueuedSteers is the pure fold. */
	steerQueue: SteerQueueItem[];
}

/** One queued composer steer: the client-minted id (the upsert key) + text. */
export interface SteerQueueItem {
	id: string;
	text: string;
}

/** The indicator's fold (pure): a queued steer stays visible until its id
 *  lands in the message list — from the live stream's upsert, the settle
 *  sync, or a reload. A steer parked server-side (stranded behind a
 *  question) keeps its line: honest "waiting" until the next run drains it. */
export function visibleQueuedSteers(
	queue: readonly SteerQueueItem[],
	messages: readonly LhMessage[],
): SteerQueueItem[] {
	const ids = new Set(messages.map((m) => (m as { id?: string }).id));
	return queue.filter((s) => !ids.has(s.id));
}

export interface SessionModelOptions extends SessionModelDeps {
	chatId: string;
	initialMessages: LhMessage[];
	/** Retained, memory-only server failure when reopening a session. */
	initialError?: string;
	/** Fires on every state change (the hook re-renders). */
	onChange?: () => void;
	/** The reattach settled terminal (turn-settled): no turn running, the
	 *  record is current — the caller refetches it. */
	onReattachSettled?: () => void;
}

export class SessionModel {
	readonly chatId: string;
	/** Injectable fetch (tests); defaults to the global. */
	fetch: typeof globalThis.fetch;
	/** Steers sent but not yet drained (the queued indicator's truth). */
	private steerQueueValue: SteerQueueItem[] = [];
	private readonly pollMs: number;
	private readonly waitMaxMs: number;
	private onReattachSettled?: () => void;
	/** The hook's re-render trigger (set by the adapter). */
	onChange?: () => void;

	// THE STATE: the record (server canon) + the live tail (this client's
	// optimistic appends and the streaming turn's messages). The tail dies
	// at every full sync; the write-ahead absorbs the optimistic entries.
	private base: LhMessage[];
	private tail: LhMessage[] = [];
	private questionDrafts = new Map<string, QuestionDraft>();
	/** Only learner answers submitted through send(), never silent dismissals. */
	private unconfirmedAnswers = new Map<string, string>();
	// The live turn's execution layer (view model mid-turn states):
	private executions = new Map<string, LiveExecution>();
	private streamingIds = new Set<string>();
	private incompleteUsageIds = new Set<string>();
	/** The in-flight assistant message's client id (see applyWireEvent). */
	private streamingMessageId: string | null = null;
	private statusValue: SessionStatus = "ready";
	/** Request/loop failures are transient; provider failures derive from messages. */
	private errorValue: { message: string } | null = null;
	/** Dismissing a banner must not authorize an automatic replacement turn. */
	private automaticContinuationBlocked = false;
	/** A completed failure from THIS consume, not the previous attempt's record. */
	private liveFailureId: string | null = null;
	// The single live consume (POST response or reattach stream): a newer
	// consume cancels the older — one reader at a time.
	private consumeAbort: AbortController | null = null;
	/** Retain the latest request across stop(): an opening POST still owns
	 * its refusal after view detachment, but never after a newer request. */
	private latestRequest: AbortController | null = null;
	/** Synchronous ready check for the gate (send/read mount logic). */
	readyRef = true;

	constructor(opts: SessionModelOptions) {
		this.chatId = opts.chatId;
		this.base = opts.initialMessages;
		this.errorValue = opts.initialError === undefined ? null : { message: opts.initialError };
		this.automaticContinuationBlocked = opts.initialError !== undefined;
		// BOUND: the browser's native fetch is a Window method — storing it
		// unbound makes every call throw "Illegal invocation" in the browser
		// (Node's undici doesn't care, so the tests never saw it). Always go
		// through a receiver-preserving wrapper.
		this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.pollMs = opts.pollMs ?? TURN_POLL_MS;
		this.waitMaxMs = opts.waitMaxMs ?? TURN_WAIT_MAX_MS;
		this.onChange = opts.onChange;
		this.onReattachSettled = opts.onReattachSettled;
	}

	/** Injectable settle hook (the adapter wires its ref). */
	setReattachSettled(fn: () => void): void {
		this.onReattachSettled = fn;
	}

	getState(): SessionState {
		const live =
			this.statusValue === "submitted" || this.statusValue === "streaming"
				? { executions: this.executions, inFlight: true, streamingIds: this.streamingIds }
				: undefined;
		const messages = [...this.base, ...this.tail];
		const latest = failedResponseAtEnd(messages);
		// Presentation/compaction markers do not resolve a failure. While
		// trying again, hide the old banner from the first Thinking frame,
		// but show a new completed failure from this consume immediately.
		const providerError =
			latest !== undefined &&
			!this.incompleteUsageIds.has(latest.id) && (!live || latest.id === this.liveFailureId)
				? { message: latest.errorMessage ?? "An error occurred." }
				: null;
		return {
			messages: projectView(messages, live),
			nativeMessages: messages,
			hasConfirmedConversation: this.base.some(m => m.role === "user" || m.role === "assistant"),
			contextTokens: measuredContextTokens(messages, this.incompleteUsageIds),
			status: this.statusValue,
			error: this.errorValue ?? providerError,
			steerQueue: this.steerQueueValue,
		};
	}

	get status(): SessionStatus {
		return this.statusValue;
	}

	/** Mutate model state + notify (the hook re-renders). */
	private mutate(fn: () => void): void {
		fn();
		this.onChange?.();
	}

	private setStatus(status: SessionStatus): void {
		if (status === "submitted") this.liveFailureId = null;
		this.statusValue = status;
		this.readyRef = status === "ready";
		this.onChange?.();
	}

	private setError(message: string | null): void {
		this.errorValue = message === null ? null : { message };
		if (message !== null) this.automaticContinuationBlocked = true;
		this.onChange?.();
	}

	/** The 409 identity-retry fetch (the Wave B contract): the event was
	 *  never persisted (write-ahead happens only on acceptance), so the
	 *  retry waits out the running turn and re-POSTs the SAME body. */
	async postInputEvent(input: ChatInput, signal?: AbortSignal): Promise<Response> {
		const body = JSON.stringify({ chatId: this.chatId, input });
		const init: RequestInit = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		};
		let response = await this.fetch("/api/chat", init);
		let waited = 0;
		while (response.status === 409) {
			await response.body?.cancel().catch(() => {});
			if (signal?.aborted || waited >= this.waitMaxMs) return response;
			await delay(this.pollMs, signal);
			waited += this.pollMs;
			if (signal?.aborted) return response;
			if ((await turnInFlight(this)) !== false) continue;
			response = await this.fetch("/api/chat", init); // may 409 again → loop
		}
		return response;
	}

	/**
	 * ONE event application for both the POST stream and the reattach
	 * replay (pi's events carry the FULL partial message — a view REPLACES,
	 * never assembles deltas). Returns whether the event did VIEW WORK:
	 * the consume flips submitted→streaming on the first ACTED event, not
	 * the first wire byte — agent_start/turn_start release nothing, so
	 * the Thinking… placeholder (gated on submitted) covers the whole
	 * provider-connect gap (owner, optimistic round 3, 2026-10-02).
	 */
	applyWireEvent(event: Record<string, unknown>): boolean {
		if (event.type === "error") {
			// Loop-level failure (agent.continue threw outside the stream) —
			// raw text (owner ruling, Wave D): the banner shows exactly this.
			this.setError(String(event.errorText ?? "An error occurred."));
			return false;
		}
		const agent = event as unknown as AgentEvent;
		switch (agent.type) {
			case "agent_start":
				// Positive evidence of a new/replayed server-owned turn. Any
				// later failure in that replay blocks continuation again.
				this.automaticContinuationBlocked = false;
				if (this.errorValue !== null) this.setError(null);
				return false;
			case "message_start":
			case "message_update":
			case "message_end": {
				const message = agent.message as LhMessage & {
					role?: string;
					id?: string;
				};
				if ((message as { role?: string }).role !== "assistant") {
					// Wave C: markers injected mid-run (pi's follow-up delivery)
					// arrive as custom-role message_start/message_end events -
					// UPSERT by id (markers always carry steer_<id> ids; id-less
					// non-assistant events never occur - injected messages emit
					// start+end only, no streaming partials). Without this the
					// live stream dropped the marker until the settle sync.
					const mid = message.id;
					if (mid === undefined) return false;
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === mid);
						this.tail =
							idx === -1 ? [...this.tail, message as LhMessage] : this.tail.with(idx, message as LhMessage);
					});
					return true;
				}
				// pi streams AssistantMessages with NO id — the id exists only
				// once the server's persistTurn stamps the record (the live
				// streaming bug, 2026-09-26: minting a fresh id per event made
				// every message_update APPEND a full copy — a divider + thinking
				// block per chunk, cleaned up only by the settle sync). The
				// in-flight message is tracked by SLOT instead: message_start
				// mints and remembers the id; updates and the end REPLACE that
				// same tail entry. Exactly one assistant message streams at a
				// time (pi's strict start → updates → end ordering per step; the
				// reattach replay replays the same sequence), so the slot is
				// unambiguous. An explicit message.id (if one ever appears on
				// the wire) still wins.
				const id = message.id ?? this.streamingMessageId ?? localId();
				const withId = { ...message, id } as LhMessage;
				if (agent.type === "message_end") {
					this.incompleteUsageIds.delete(id);
					if (message.role === "assistant" && message.stopReason === "error") {
						this.liveFailureId = id;
						// A newer provider failure replaces an earlier connection/loop
						// error, just as the live message_end did before restoration.
						this.errorValue = null;
					}
				} else this.incompleteUsageIds.add(id);
				if (agent.type === "message_start") {
					this.streamingMessageId = id;
					this.streamingIds.add(id);
					this.mutate(() => {
						this.tail = [...this.tail, withId];
					});
				} else {
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === id);
						this.tail = idx === -1 ? [...this.tail, withId] : this.tail.with(idx, withId);
					});
				}
				if (agent.type === "message_end") {
					this.streamingMessageId = null; // slot done — next start mints fresh
				}
				return true; // a message event is view work, even empty content
			}
			case "tool_execution_end": {
				// The execution layer: clean question placeholders are IGNORED
				// downstream (view.ts fork 2); errors keep their validation text.
				const result = agent.result as
					| { content?: Array<{ type?: string; text?: string }>; details?: unknown }
					| null;
				const text = result?.content?.find((c) => c.type === "text")?.text ?? "The tool call failed.";
				this.mutate(() => {
					this.executions = new Map(this.executions).set(agent.toolCallId, {
						isError: agent.isError,
						output: result?.details,
						errorText: text,
					});
				});
				return true; // the execution layer updated the tool part's card
			}
			case "turn_end": {
				// The results batch: append as native messages (client-stamped
				// ids — the settle sync lands the server canon).
				this.mutate(() => {
					this.tail = [
						...this.tail,
						...(agent.toolResults as ToolResultMessage[]).map(
							(r) => ({ ...r, id: localId() }) as unknown as LhMessage,
						),
					];
				});
				return true;
			}
			default:
				return false; // agent_start/turn_start/tool_execution_start|update: no view work
		}
	}

	/** Consume one SSE body to its [DONE] terminal. The turn-settled
	 *  terminal (stream-route only) fires the settle hook and ends. */
	async consumeStream(res: Response, controller = this.consumeAbort, allowRecovery = true): Promise<void> {
		if (!res.body) throw new Error("The turn stream body is empty.");
		const reader = res.body.getReader();
		let sawEvent = false;
		let sawDone = false;
		try {
			const events = sseEvents(reader);
			for (;;) {
				let next: IteratorResult<Record<string, unknown>, boolean>;
				try { next = await events.next(); }
				catch (err) {
					if (err instanceof StreamReadError) break;
					throw err;
				}
				if (this.consumeAbort !== controller) return;
				if (next.done) { sawDone = next.value; break; }
				const event = next.value;
				if (event.type === "turn-settled") {
					// The raced-settle terminal: no turn to attach to — the
					// record is current; the settle hook refetches.
					sawDone = true;
					this.onReattachSettled?.();
					return;
				}
				const acted = this.applyWireEvent(event);
				if (!sawEvent && acted) {
					sawEvent = true;
					if (this.statusValue !== "error") this.setStatus("streaming");
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
			// A cancelled consume may finish after its replacement has entered
			// Thinking. Only the current owner can settle shared state.
			if (this.consumeAbort === controller) {
				this.streamingIds = new Set();
				this.executions = new Map();
				if (sawDone && this.statusValue !== "error") this.setStatus("ready");
			}
		}
		if (this.consumeAbort !== controller || sawDone) return;
		if (!allowRecovery) throw new StreamReadError(new Error(STREAM_DROPPED));
		// One read-only recovery: refresh the canonical base, then replay the
		// SAME server-owned turn. Never resend the learner's input.
		await this.resumeStream(true, false);
	}

	private async fetchView(url: string, signal: AbortSignal, recoveringDrop: boolean): Promise<Response> {
		try {
			const res = await this.fetch(url, { signal });
			if (recoveringDrop && !res.ok) throw new Error((await res.text()) || STREAM_DROPPED);
			return res;
		} catch (err) {
			if (recoveringDrop && !signal.aborted) throw new StreamReadError(err);
			throw err;
		}
	}

	/**
	 * Reattach (the wake/handoff/mount path): a server-side turn with no
	 * live view of ours. ATTACH-FIRST (owner, reattach round 2026-10-02):
	 * a fresh-mount reattach passes refetchRecordFirst=false — the page
	 * render just read the record, so the blocking record round-trip only
	 * added handshake latency before the instant replay; the running
	 * turn's partial lives solely in the server event log, and the replay
	 * rebuilds it regardless of the refetch. Mid-session callers (the
	 * handoff watch) keep the default: their base may trail the record,
	 * and the refetch absorbs it (write-ahead adoption) before the replay
	 * lands on top. The stream then replays the turn from its first event
	 * through the SAME consume path.
	 */
	async resumeStream(refetchRecordFirst = true, allowRecovery = true): Promise<void> {
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.latestRequest = controller;
		// REPLAY ONTO A CLEAN SLATE (owner, optimistic round 3, 2026-10-02):
		// the reattach stream replays the turn from its FIRST event — an
		// aborted earlier attempt (React StrictMode's simulated remount)
		// must not leave partials the replay would DOUBLE onto. The old
		// record refetch provided this reset accidentally; attach-first
		// made it explicit.
		//
		// THE FLICKER FIX (owner, 2026-10-10 — connection-diet B follow-up):
		// on the REFETCH path the clear must NOT precede the fetch — send()
		// just landed the optimistic answer/note cards in the tail, and any
		// refetch latency (dev-compile stalls measured at 1.7s) re-showed
		// the answered-away question for the whole window: card vanished,
		// dock returned, both snapped back only when the record landed.
		// The refetch block below swaps base+tail ATOMICALLY when the record
		// arrives (and clears on failure — the clean-slate guard holds on
		// every path that actually replays onto a stale tail).
		if (!refetchRecordFirst) {
			this.mutate(() => {
				this.incompleteUsageIds.clear();
				this.tail = [];
				this.streamingMessageId = null;
			});
		}
		this.setStatus("submitted");
		try {
			if (refetchRecordFirst) {
				const recordRes = await this.fetchView(`/api/chats/${encodeURIComponent(this.chatId)}`, controller.signal, !allowRecovery);
				if (this.consumeAbort !== controller) return;
				if (recordRes.ok) {
					let text: string;
					try { text = await recordRes.text(); }
					catch (err) {
						if (!allowRecovery && !controller.signal.aborted) throw new StreamReadError(err);
						throw err;
					}
					// Parse outside the transport catch: malformed JSON is a
					// contract bug, not a connection-drop diagnostic.
					const record = JSON.parse(text) as { messages?: LhMessage[]; turnError?: string };
					if (this.consumeAbort !== controller) return;
					if (Array.isArray(record.messages)) {
						this.mutate(() => {
							this.base = record.messages!;
							if (record.turnError !== undefined) {
								this.errorValue = { message: record.turnError };
								this.automaticContinuationBlocked = true;
							}
							this.forgetResolvedDrafts(record.messages!);
							this.incompleteUsageIds.clear();
							this.tail = [];
						});
					}
				} else {
					// The record did not land — restore the clean-slate guard
					// before the replay (no atomic swap is coming).
					this.mutate(() => {
						this.incompleteUsageIds.clear();
						this.tail = [];
						this.streamingMessageId = null;
					});
				}
			}
			const res = await this.fetchView(`/api/chats/${encodeURIComponent(this.chatId)}/stream`, controller.signal, !allowRecovery);
			if (this.consumeAbort !== controller) return;
			if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
			await this.consumeStream(res, controller, allowRecovery);
		} catch (err) {
			if (this.consumeAbort !== controller || controller.signal.aborted) return; // intentionally cancelled
			// A failed record read can leave the optimistic answer in the tail.
			// Restore its Submit affordance; the next attempt reconciles first.
			this.mutate(() => {
				this.tail = this.tail.filter(m => !this.unconfirmedAnswers.has(m.id));
				this.unconfirmedAnswers.clear();
			});
			this.setError(!allowRecovery && err instanceof StreamReadError ? STREAM_DROPPED : (err as Error).message);
			this.setStatus("error");
		}
	}

	/**
	 * SEND: one explicit input event. Optimistic appends first (the instant
	 * answer/note UX — the server's write-ahead persists the canon), then
	 * POST + consume. Ready-gated: one turn per client at a time (the
	 * server's 409 + identity retry covers the wake-race window).
	 */
	async send(input: ChatInput, onAccepted?: () => void, questionKey?: string): Promise<boolean> {
		const recovering = this.statusValue === "error";
		if (!this.readyRef && !recovering) return false;
		const subject = input.type === "answer" ? pendingQuestionOf([...this.base, ...this.tail]) : null;
		// A render-scoped answer must not move to another occurrence sharing
		// its id. This identity is local only; the server's wire is unchanged.
		if (input.type === "answer" && questionKey !== undefined &&
			(subject?.key !== questionKey || subject.toolCallId !== input.toolCallId)) return false;
		const expectedKey = questionKey ?? (input.type === "answer" && subject?.toolCallId === input.toolCallId ? subject.key : undefined);
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.latestRequest = controller;
		this.setError(null);
		this.setStatus("submitted");
		if (recovering && input.type === "answer") {
			try {
				const res = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}`, { signal: controller.signal });
				if (this.consumeAbort !== controller) return false;
				if (!res.ok) throw new Error((await res.text()) || "An error occurred.");
				const record = await res.json() as { messages?: LhMessage[]; turnInFlight?: boolean; turnError?: string };
				if (this.consumeAbort !== controller) return false;
				// No verified record/liveness: retain the draft and never guess
				// whether a lost acknowledgement meant the input was accepted.
				if (!Array.isArray(record.messages) || typeof record.turnInFlight !== "boolean") throw new Error("An error occurred.");
				this.setMessages(record.messages, record.turnError);
				if (record.turnInFlight) {
					await this.resumeStream(false);
					return false;
				}
				const current = pendingQuestionOf(record.messages);
				if (current?.toolCallId !== input.toolCallId || (expectedKey !== undefined && current.key !== expectedKey)) {
					// The call already resolved, or no longer owns the dock. Adopt
					// truth, never POST that answer a second time.
					this.setStatus("ready");
					return false;
				}
			} catch (err) {
				if (this.consumeAbort !== controller || controller.signal.aborted) return false;
				this.setError((err as Error).message);
				this.setStatus("error");
				return false;
			}
		}
		if (input.type !== "continue") this.automaticContinuationBlocked = false;
		// The optimistic appends — exactly the messages the server's
		// write-ahead will persist (inputAppends), with LOCAL ids so
		// adoption can tell them from the record's absorbed copies.
		const optimistic: LhMessage[] = [];
		if (input.type === "text") optimistic.push({ ...newUserMessage(input.text), id: localId() });
		else if (input.type === "thinking") {
			// The practice submissions (2026-10-04): the marker lands
			// optimistically — the card renders from its details the
			// moment the button fires.
			optimistic.push({ ...newThinkingMessage(input.problemCallId, input.text), id: localId() });
		} else if (input.type === "next") {
			// The move-on signal (owner round 16): the NEXT PROBLEM line
			// renders the instant the chip/Enter fires.
			optimistic.push({ ...newNextMessage(), id: localId() });
		} else if (input.type === "answer") {
			const tool = pendingCallTool([...this.base, ...this.tail], input.toolCallId) ?? "quiz";
			const result = { ...newAnswerResult(input.toolCallId, tool, input.answer), id: localId() };
			optimistic.push(result);
			this.unconfirmedAnswers.set(result.id, expectedKey ?? input.toolCallId);
		}
		if (optimistic.length > 0) this.mutate(() => {
			this.tail = [...this.tail, ...optimistic];
		});
		let accepted = false;
		try {
			// SUBMITS ARE NOT ABORTABLE BY VIEW TEARDOWN (owner, 2026-10-10 —
			// the dead-session-start postmortem): the POST must NOT ride
			// consumeAbort. Diet A's abort-on-unmount (session.ts's stop())
			// fires on React StrictMode's simulated remount in dev — it killed
			// the ?prompt first send ~8ms in (POST aborted, never retried:
			// the page's sentInitial guard had already flipped), leaving the
			// session dead until a second message, which then persisted
			// WITHOUT the first — the optimistic tail rode a record that never
			// contained it. The POST is a ~100ms ack since Diet B; it cannot
			// starve the connection pool, so it needs no teardown guard. The
			// STREAM consume stays on the controller — releasing that held
			// connection is Diet A's whole job.
			const res = await this.postInputEvent(input);
			if (res.status === 409) {
				throw new Error("A turn is already running — try again in a moment.");
			}
			if (!res.ok) {
				// Keep model/key refusal envelopes verbatim: the page's refusal
				// flow parses them. Retry's 400s are ordinary user-facing
				// guidance, so show their error text without JSON syntax.
				let message = (await res.text()) || `The send failed (${res.status}).`;
				if (input.type === "retry" && res.status === 400) {
					try {
						const refusal = JSON.parse(message) as { error?: unknown } | null;
						if (typeof refusal?.error === "string" && refusal.error.length > 0) message = refusal.error;
					} catch { /* Non-envelope failures keep their original text. */ }
				}
				throw new Error(message);
			}
			accepted = true;
			// Opening-message handover ends at acceptance, not stream completion.
			onAccepted?.();
			// CONNECTION DIET B (owner, 2026-10-10 — parallel-session freeze
			// postmortem): the POST acknowledges and closes; there is no stream
			// on this response to consume. Attach through the SAME reattach wire
			// a returning visitor uses (refetch-first: the record refetch absorbs
			// the server's write-ahead copy of our optimistic messages, then the
			// replay lands on top). One live view connection per page, always —
			// the browser's 6-per-origin pool is the scarce resource.
			await res.text().catch(() => {}); // drain the tiny ack; release the socket
			// A stop() or a newer send/consume won while the ack was in
			// flight: the turn is live server-side either way — do not attach
			// a stream from a view that is gone or superseded.
			if (this.consumeAbort !== controller) return true;
			await this.resumeStream(true);
			return true;
		} catch (err) {
			const failedOpening = input.type === "text" && onAccepted !== undefined && !accepted;
			if (failedOpening) {
				// The POST outlives stop(), including StrictMode's cleanup. Remove
				// only its own failed optimistic bubble even if a newer request
				// won; never touch canonical messages or another attempt's tail.
				const ids = new Set(optimistic.map(m => m.id));
				this.mutate(() => { this.tail = this.tail.filter(m => !ids.has(m.id)); });
			}
			const detachedOpening = failedOpening && this.consumeAbort === null && this.latestRequest === controller;
			if ((this.consumeAbort !== controller || controller.signal.aborted) && !detachedOpening) return accepted;
			// A detached opening refusal must still reach the replayed mount's
			// existing setup recovery. A newer send/reattach ALWAYS owns errors
			// and status instead, even if that request has since been stopped.
			// Ordinary text and answer teardown behavior stays unchanged.
			if (input.type === "answer") {
				const ids = new Set(optimistic.map(m => m.id));
				this.mutate(() => {
					this.tail = this.tail.filter(m => !ids.has(m.id));
					for (const id of ids) this.unconfirmedAnswers.delete(id);
				});
			}
			this.setError((err as Error).message);
			this.setStatus("error");
			// true means we observed this POST's acknowledgment. false does
			// NOT prove non-delivery: a network failure may hide acceptance.
			// Opening-message callers restore a draft, never automatically retry.
			return accepted;
		}
	}

	/**
	 *  STEER (composer steering, owner arc 2026-10-03): the learner's
	 *  mid-turn message for the RUNNING turn. NOT a turn — no optimistic
	 *  transcript card, no status flip: the message joins the queued
	 *  indicator (the quiet line above the composer) and POSTs to the
	 *  steer route, which hands it to the live agent's steering queue.
	 *  When pi drains it at the next response boundary, the verbatim
	 *  message events upsert the real card (the client-minted id is the
	 *  key) and the indicator's fold drops the line. A 409 means the turn
	 *  settled mid-send (the race): fall back to the plain text send —
	 *  the entry is dropped and send() pushes its own optimistic card.
	 */
	async steer(text: string): Promise<void> {
		const t = text.trim();
		if (!t) return;
		const id = `steer_${localId()}`;
		this.steerQueueValue = [...this.steerQueueValue, { id, text: t }];
		this.onChange?.();
		const dropSteer = () => {
			this.steerQueueValue = this.steerQueueValue.filter((s) => s.id !== id);
			this.onChange?.();
		};
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "steer", id, text: t } }),
			});
			if (res.ok) return; // parked or delivered — the stream lands the card
			if (res.status === 409) {
				dropSteer();
				await this.send({ type: "text", text: t }); // the settle race: plain send
				return;
			}
			dropSteer();
			this.setError((await res.text()) || `The steer failed (${res.status}).`);
		} catch (err) {
			dropSteer();
			this.setError((err as Error).message);
		}
	}

	/** The answer path (the dock): the answer IS the question call's tool
	 *  result (fork 1), riding as its input event. */
	submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData, questionKey?: string): Promise<void> {
		void tool;
		return this.send({ type: "answer", toolCallId, answer: output }, undefined, questionKey).then(() => undefined);
	}

	/** The dismissal path (owner design 2026-10-03, "A2"): the skipped
	 * toolResult lands optimistically, then the SILENT route persists it
	 * — no turn, no stream, nothing wakes. The session pauses at the
	 * user's choice; the next plain send is the wake. On failure the
	 * durable record wins: the error surfaces, the record-changed sync
	 * (or any later refetch) replaces the optimistic append with truth. */
	async dismissQuestion(toolCallId: string, answer: QuestionAnswerData, questionKey?: string): Promise<void> {
		if (!this.readyRef) return;
		const subject = pendingQuestionOf([...this.base, ...this.tail]);
		if (questionKey !== undefined && (subject?.key !== questionKey || subject.toolCallId !== toolCallId)) return;
		const tool = pendingCallTool([...this.base, ...this.tail], toolCallId) ?? "quiz";
		this.mutate(() => {
			this.tail = [...this.tail, { ...newAnswerResult(toolCallId, tool, answer), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss", toolCallId, answer } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	/** The problem discard (practice sessions, owner 2026-10-04): the
	 *  ask-style dismissal — the UI-only marker lands optimistically, then
	 *  the SILENT route persists it (no turn, no wake). The composer
	 *  returns; the conclude synthesis rides the user's next input. */
	async dismissProblem(problemCallId: string): Promise<void> {
		if (!this.readyRef) return;
		this.mutate(() => {
			this.tail = [...this.tail, { ...newProblemDismissedMarker(problemCallId), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	/** Local detach: cancel the consume, keep the partial tail. The page's
	 *  settle watch adopts the record when the server turn finishes. */
	stop(): void {
		this.consumeAbort?.abort();
		this.consumeAbort = null;
		this.streamingIds = new Set();
		this.streamingMessageId = null;
		this.executions = new Map();
		this.setStatus("ready");
	}

	/** Submission snapshots outlive the dock, not the session mount. */
	questionDraft(questionKey: string): QuestionDraft | undefined {
		return this.questionDrafts.get(questionKey);
	}

	saveQuestionDraft(questionKey: string, draft: Partial<QuestionDraft>): void {
		this.questionDrafts.set(questionKey, { ...this.questionDrafts.get(questionKey), ...draft });
	}

	private forgetResolvedDrafts(record: readonly LhMessage[]): void {
		const pendingKey = pendingQuestionOf(record)?.key;
		for (const key of this.questionDrafts.keys()) {
			if (key !== pendingKey) this.questionDrafts.delete(key);
		}
		for (const [id, key] of this.unconfirmedAnswers) {
			if (key !== pendingKey) this.unconfirmedAnswers.delete(id);
		}
	}

	/** Full snapshot swap (the idle settle sync — server canon). */
	setMessages(record: LhMessage[], turnError?: string): void {
		this.mutate(() => {
			this.base = record;
			if (turnError !== undefined) {
				this.errorValue = { message: turnError };
				this.automaticContinuationBlocked = true;
			}
			this.forgetResolvedDrafts(record);
			this.incompleteUsageIds.clear();
			this.tail = [];
			this.streamingMessageId = null; // the tail (and its slot) is gone
		});
	}

	/**
	 * Append-only adoption (the mid-turn steer/artifact ground rule): swap
	 * in the record — every current base message must still be present
	 * (the server appends only) — keeping the live tail, minus the
	 * optimistic entries the record has absorbed (their server-stamped
	 * copies just landed; without this the input bubble would double).
	 */
	adoptRecord(record: LhMessage[]): void {
		const recordIds = new Set(record.map((m) => (m as { id?: string }).id));
		const baseAbsorbed = this.base.some((m) => !recordIds.has((m as { id?: string }).id));
		if (baseAbsorbed) return; // not a pure append — the idle full sync is the net
		this.mutate(() => {
			this.base = record;
			this.forgetResolvedDrafts(record);
			this.tail = this.tail.filter((m) => !absorbed(m, record));
		});
	}

	/** Automatic mount/sync continuation is never permission to retry a
	 * failed turn. Read current model truth, not a stale React closure. */
	async continueIfOwed(record: readonly LhMessage[]): Promise<void> {
		if (this.statusValue === "ready" && !this.automaticContinuationBlocked && this.getState().error === null && needsContinuation(record)) {
			await this.send({ type: "continue" });
		}
	}

	/** The mount/sync continuation fold (native-messages.ts). */
	static needsContinuation = needsContinuation;

	clearError(): void {
		this.setError(null);
	}
}
