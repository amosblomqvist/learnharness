import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { ToolCallIdUniquifier } from "./call-ids.ts";
import type { ChatGPTRequestCycle } from "../../agent/chatgpt-request-cycle.ts";

/**
 * THE NATIVE WIRE (Wave D, owner-approved 2026-09-26): one agent turn, streamed
 * to every view as pi AgentEvents — no translation, no part assembly. The one
 * sanctioned rewrite (the Lacan fix, 2026-10-04): tool-call IDs uniquify at
 * this boundary when the provider resets them per response (DeepSeek's
 * `call_0` every turn) — see call-ids.ts and PiTurnSpec.usedToolCallIds.
 * The SSE body is the agent's own event stream:
 *
 *   data: {"type":"agent_start"}\n\n
 *   data: {"type":"message_update","message":{…}}\n\n
 *   …
 *   data: {"type":"agent_end","messages":[…]}\n\n
 *   data: [DONE]\n\n
 *
 * Load-bearing protocol facts (verified against pi-agent-core):
 * - Every `message_update` carries the FULL partial assistant message (each
 *   AssistantMessageEvent ships `partial`) — a view REPLACES its streaming
 *   assistant with `event.message`; no delta assembly exists anywhere.
 * - WIRE DIET (owner, 2026-10-09 — the streaming-freeze postmortem): our
 *   boundary emits the SLIM message_update (`message` only). pi's event also
 *   carries the same full partial a SECOND time as `assistantMessageEvent`
 *   — nothing in this app ever reads it, and re-serializing it per chunk
 *   doubled every stream frame. Client reads `event.message`, always.
 * - Question tools (quiz / ask_user_question): NO suppression (owner ruling,
 *   Wave D fork 2) — the closing `tool_execution_end` with the in-memory
 *   "Question posed" placeholder flows to the client, which ignores it
 *   (question tools are client-owned; the answer arrives as the input event).
 *   The placeholder still never persists and never reaches the model.
 * - Tool-call validation gating survives by construction: `tool_execution_end`
 *   only fires after the call cleared the boundary (an invalid call arrives
 *   as isError — never a clean end), so the dock's mount rule keys on it.
 * - App-level events beyond pi's taxonomy: the reattach terminal
 *   {"type":"turn-settled"} (served by turn-runs when no turn is running) and
 *   the loop-level {"type":"error","errorText"} (agent.continue() threw
 *   outside the event stream — mapped through the handler's masking policy).
 * - Stream-level provider errors ride their message verbatim
 *   (message_end with stopReason "error" + errorMessage).
 *
 * BACKGROUND-TURN RUNNER (owner ruling, 2026-09-25): a turn executes as a
 * server-side background object decoupled from any single HTTP response —
 * clients are VIEWS. runPiTurn returns the handle (compacted state +
 * subscriber set); piTurnResponse wraps a subscriber stream as the SSE
 * response, and the POST /api/chat response and GET /api/chats/[id]/stream
 * are BOTH exactly that. Cancelling a view detaches it ONLY — never aborts
 * the turn; the handle's abort() is the one remote kill.
 *
 * THE COMPACTION LAW (owner, 2026-10-09 — supersedes the unbounded-log ruling
 * of 2026-09-25): the turn log stores STATE, not chunks. pi's native events
 * are full snapshots — one per provider chunk — so retaining every one made
 * memory and replay cost quadratic in message length (a single
 * high-thinking message retained hundreds of MB and every reattach
 * re-serialized the whole history in one blocking stretch — the parallel-
 * session navigation freeze). The log now keeps settled events verbatim plus
 * the LATEST update per in-flight message/tool call, replaced in place;
 * live update fan-out is coalesced to at most one frame per flush window
 * (latest wins — views replace by slot, and message_end carries the full
 * final message, so dropped intermediates are lossless). Replay therefore
 * costs the content once, never the chunk count.
 */

/** The wire event: a pi AgentEvent (with our slim message_update — see the
 * WIRE DIET note above), or one of the two app events. */
export type TurnWireEvent =
	| AgentEvent
	| { type: "message_update"; message: AgentMessage }
	| { type: "error"; errorText: string };

export interface PiTurnSpec {
	requestCycle?: ChatGPTRequestCycle;
	/** The per-turn agent (stateless engine — built from the record). */
	agent: Agent;
	/** The handler's error-masking policy for LOOP-level failures (the
	 *  event stream itself is verbatim — provider errors ride their
	 *  message's stopReason/errorMessage through untouched). */
	onError?: (error: unknown) => string;
	/** Report settlement failure while the views are still open. */
	onSettleError?: (error: unknown) => string;
	/** Release liveness even if the normal finish seam throws. */
	onSettleFailure?: (error: unknown, reportedErrorText?: string) => void;
	/** The canonical end-of-turn seam: persist + usage + extraction + endTurn.
	 *  Receives the agent's FULL final state (native messages) — the caller
	 *  persists the slice past its own base count. */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	/** Tool-call ids already used in this chat's record (THE LACAN FIX,
	 *  owner-approved 2026-10-04): when present, a ToolCallIdUniquifier
	 *  sits at this boundary — providers that reset ids every response
	 *  (DeepSeek's `call_0` × every turn) get colliding ids reminted ONCE
	 *  here, so wire views, the persisted record, the dock, answer
	 *  routing, and the next turn's provider context all agree. Absent →
	 *  verbatim passthrough (the protocol law below still holds). */
	usedToolCallIds?: ReadonlySet<string>;
	/** The coalescing window for update fan-out (COMPACTION LAW above).
	 *  Defaults to 100ms; tests tighten it. */
	updateFlushMs?: number;
}

/** One view onto a running turn: push() replays/streams an event, done()
 *  terminates the view ([DONE] + close). Cheap to be a Set member. */
export interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/** The server-side turn object (background-turn runner wave, 2026-09-25):
 *  runs the agent decoupled from any single HTTP response and owns the
 *  in-memory event log + the live subscriber set. The POST response and
 *  the reattach stream are both subscribers onto it. */
export interface PiTurnHandle {
	/** A fresh subscriber stream: FULL replay of the log, then live events
	 *  until the turn settles (ending [DONE]). Cancelling it detaches the
	 *  view only — the turn runs on. */
	subscribe(): ReadableStream<Uint8Array>;
	/** The remote kill — the ONLY way a running turn dies early: sawAbort +
	 *  agent.abort(); the loop's agent_end does the rest (the settle seam
	 *  persists the partial transcript to every listener). */
	abort(): void;
}

export function runPiTurn(spec: PiTurnSpec): PiTurnHandle {
	const { agent, onError, onFinish, onSettleError, onSettleFailure, usedToolCallIds, updateFlushMs = 100, requestCycle } = spec;
	const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;

	let settled = false;
	let sawAbort = false;
	let reportedErrorText: string | undefined;

	// THE PER-TURN STATE LOG (memory-only — the settle-only disk writes
	// are unchanged). COMPACTION LAW (owner, 2026-10-09, supersedes the
	// 2026-09-25 unbounded-log ruling): settled events append verbatim;
	// in-flight `message_update` / `tool_execution_update` runs are reduced
	// to their LATEST member, replaced in place. Retention is bounded by
	// CONTENT (settled messages + one snapshot per streaming message), not
	// by chunk count — the quadratic blowup that froze parallel sessions is
	// structurally impossible now. The log dies with the turn at settle.
	const log: TurnWireEvent[] = [];
	// Live-update slots: coalesce key → log index of the retained update.
	// One assistant message streams at a time (pi's strict per-step
	// start → updates → end ordering), so messages share one slot; parallel
	// tool executions each own theirs (toolCallId). End events free the slot
	// — a later update for the same key starts a fresh run.
	const updateSlots = new Map<string, number>();
	// The coalescing queue for LIVE fan-out: key → latest event, flushed at
	// most once per flush window (Map preserves first-insertion order, so the
	// relative order of concurrent keys stays chronological).
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<PiTurnSubscriber>();

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
		return null;
	};

	// Send = compact the log + fan out to every live view. A view's own
	// enqueue failure (a cancelled reader) is swallowed by the view — the
	// turn must still settle; onFinish persists regardless of who watches.
	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			// Retention: replace-in-place the run's latest snapshot.
			const idx = updateSlots.get(key);
			if (idx !== undefined) log[idx] = event;
			else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			// Fan-out: coalesced — latest wins, flushed at ≤1/window.
			pending.set(key, event);
			armFlush();
			return;
		}
		// A boundary event ends its update run (end supersedes the partial;
		// the slot frees for any future run of the same key).
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") updateSlots.delete(`tool:${event.toolCallId}`);
		// Strict per-subscriber ordering: anything still pending precedes
		// this boundary event on the wire, never after it.
		flushPending();
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const event of batch) sub.push(event);
	};
	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, updateFlushMs);
		// Never holds the process (or the test runner) open for a straggler.
		(flushTimer as { unref?: () => void }).unref?.();
	};
	const closeAll = () => {
		if (settled) return;
		// Order to the very end: the last pending snapshot precedes [DONE].
		flushPending();
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};
	// The settle seam: the record write is the agent's OWN final state
	// (native history — signatures, usage, provider stamps all real).
	// Copy the array: the agent may outlive this call's read.
	// 0.87.1 (transcript rework): the Agent seeds a leading SystemMessage
	// from initialState.systemPrompt (prompt + tool declarations) — it is
	// synthesized per turn and must NEVER persist (the record would bloat
	// with tool declarations AND replay would see messages[0] === system,
	// suppressing the fresh per-turn re-seed). Our app mints no system
	// messages of its own (the prompt is composed per turn), so dropping
	// the role wholesale is exact; revisit if prompt-updates ever land.
	const settleWith = () => {
		try {
			const settled_ = [...agent.state.messages].filter((m) => (m as { role?: string }).role !== "system");
			onFinish((uniquifier?.remapSettled(settled_) as AgentMessage[]) ?? settled_, sawAbort);
		} catch (err) {
			console.error("[turn] settlement failed:", err);
			try { onSettleFailure?.(err, reportedErrorText); }
			catch (cleanupError) { console.error("[turn] settlement cleanup failed:", cleanupError); }
			if (reportedErrorText === undefined) {
				reportedErrorText = onSettleError?.(err) ?? "An error occurred.";
				send({ type: "error", errorText: reportedErrorText });
			}
		}
	};

	const handle = (event: AgentEvent) => {
		if (settled) return;
		// THE LACAN FIX: ids uniquify HERE, before any view — the one seam
		// every consumer downstream shares. No uniquifier → verbatim.
		const uniqued = uniquifier ? uniquifier.event(event) : event;
		// WIRE DIET: slim the one event pi double-stuffs — our views read
		// `message`, never `assistantMessageEvent` (same full partial twice).
		const wire: TurnWireEvent =
			uniqued.type === "message_update"
				? { type: "message_update", message: uniqued.message }
				: uniqued;
		send(wire);
		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") sawAbort = true;
		}
		if (event.type === "agent_end") {
			// Persist/report before the terminal closes every view to new frames.
			settleWith();
			closeAll();
		}
	};
	requestCycle?.bindRelease(handle);
	agent.subscribe((event) => {
		if (!requestCycle?.hold(event)) handle(event);
	});

	void (async () => {
		try {
			do {
				await agent.continue();
				if (!requestCycle) break;
				const denied = requestCycle.deniedBeforeDispatch;
				const outcome = requestCycle.finishNativeCycle();
				if (denied) agent.state.messages = outcome.messages;
				if (outcome.action !== "resumeForeground") {
					handle({ type: "agent_end", messages: [...agent.state.messages] });
					break;
				}
			} while (!sawAbort);
		} catch (err) {
			// A loop-level failure (not a provider error — those ride the
			// stream as stopReason "error"): surface, close, persist. If the
			// agent already settled (agent_end reached before the throw),
			// the seam has run — never settle twice.
			if (settled) {
				console.error("[turn] error after settlement:", err);
				return;
			}
			console.error("[turn] agent loop failed:", err);
			reportedErrorText = onError?.(err) ?? "An error occurred.";
			send({ type: "error", errorText: reportedErrorText });
			settleWith();
			closeAll();
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								/* reader cancelled — stop emitting, keep running */
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};
					// Attach THEN replay — synchronous, so no event can fall
					// between replay and live (single-threaded: the agent's
					// handle() only runs after this stack returns). The compacted
					// log replays settled events + the latest snapshot per
					// in-flight message — the full content, once, never the chunk
					// history (COMPACTION LAW).
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					// A subscriber that attached after settle (the unregister
					// race) still gets the full history + [DONE].
					if (settled) sub.done();
				},
				cancel() {
					// THE OWNER RULING (2026-09-25): a view leaving NEVER kills
					// the turn — only the explicit abort channel does. The turn
					// runs on; the compacted log keeps the state for the next view.
					if (sub) subscribers.delete(sub);
				},
			});
			return stream;
		},
		abort() {
			if (settled) return;
			sawAbort = true;
			requestCycle?.abort();
			agent.abort();
		},
	};
}

/** The subscriber-shaped SSE response — the POST /api/chat response and
 * GET /api/chats/[id]/stream are BOTH this: same headers, same wire
 * dialect, one protocol for the client to consume. */
export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
