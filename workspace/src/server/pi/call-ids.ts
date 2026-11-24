import type { AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * TOOL-CALL ID UNIQUIFICATION (owner-approved fix, 2026-10-04 — the Lacan
 * incident): some providers (DeepSeek via OpenRouter, observed live) return
 * tool-call ids that reset every response — `call_0`, `call_1`, … — so a
 * one-call-per-turn session names EVERY call `call_0`. Everything in this
 * app keys on toolCallId (the view fold's call↔result join, the pending-
 * question gate, answer routing, the option-shuffle seed), so cross-turn
 * duplicates corrupted all of them at once: the fold applied the quiz
 * answer to the ASK card, the ask question vanished, the order scrambled.
 *
 * THE LAW: ids are uniquified ONCE, at the wire boundary — this class sits
 * inside runPiTurn, sees every AgentEvent before any view, and applies the
 * same minting at settlement. The client, the persisted record, the dock,
 * the answer flow, and the next turn's provider context (rebuilt from the
 * record) all see exactly one set of unique ids. Provider context stays
 * internally paired (call and result rewrite together), which the
 * OpenAI-compatible APIs accept — pi itself synthesizes ids for providers
 * that return none, so arbitrary-but-paired ids are already protocol-legal.
 * History is NEVER rewritten: record messages pass through untouched, and
 * pre-fix duplicate records heal at the fold (view.ts pairs results
 * newest-first).
 *
 * SCHEME: a per-chat seen-set (seeded from the record at turn start) plus
 * per-message tables. Streaming messages carry NO id (ids are stamped at
 * persist), so tables key by OBJECT IDENTITY — the message_end event's
 * object is reference-identical to the object in agent.state.messages
 * (verified against pi-agent-core), and a WeakMap joins the two. A fresh
 * table (epoch) opens at each assistant message_start; the update/end
 * objects of that message attach to it; mints claim once per message, so
 * the same id in a SECOND message of the turn (a retry step) gets its own
 * mint. Colliding ids become `${orig}~2`, `~3`, … skipping used ones.
 */

/** Structurally walk any message's content for tool-call blocks. */
function callBlocks(message: unknown): Array<{ id: string } & Record<string, unknown>> {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b): b is { id: string } & Record<string, unknown> =>
			(b as { type?: string } | null)?.type === "toolCall" && typeof (b as { id?: unknown }).id === "string",
	);
}

/** The ids every consumer may already have seen: all call ids and result
 *  ids in a message list (the chat record — including its legacy dupes,
 *  which is the point: membership is what drives minting). */
export function collectToolCallIds(messages: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			for (const b of callBlocks(m)) ids.push(b.id);
		} else if (role === "toolResult") {
			const id = (m as { toolCallId?: unknown }).toolCallId;
			if (typeof id === "string") ids.push(id);
		}
	}
	return ids;
}

export class ToolCallIdUniquifier {
	private readonly seen = new Set<string>();
	/** assistant message object → its (origId → uniqueId) table. Weak: the
	 *  agent's turn dies at settle; nothing here outlives it. */
	private readonly tables = new WeakMap<object, Map<string, string>>();
	/** The current assistant message's table — opened at its message_start,
	 *  shared by its update/end objects, and the resolution scope for its
	 *  tool_execution events (which fire after its message_end but before
	 *  the next message_start). */
	private epoch: Map<string, string> | null = null;

	constructor(usedIds: Iterable<string>) {
		for (const id of usedIds) this.seen.add(id);
	}

	/** Keep `orig` if never used; otherwise mint an unused `${orig}~n`. */
	private claim(orig: string): string {
		if (!this.seen.has(orig)) {
			this.seen.add(orig);
			return orig;
		}
		for (let n = 2; ; n++) {
			const candidate = `${orig}~${n}`;
			if (!this.seen.has(candidate)) {
				this.seen.add(candidate);
				return candidate;
			}
		}
	}

	/** Register + rewrite one message's tool-call blocks (idempotent across
	 *  the repeated partials of message_update). Returns a cloned message
	 *  when any id changed, else the original object. */
	private remapMessageContent(message: unknown): unknown {
		if ((message as { role?: string }).role !== "assistant") return message;
		const blocks = callBlocks(message);
		if (blocks.length === 0) return message;

		// Attach to the current epoch unless this object already has a table
		// (a re-emitted update/end). A message event with no open epoch
		// (defensive: a stream that skips message_start) opens one.
		let table = this.tables.get(message as object);
		if (!table) {
			table = this.epoch ?? new Map();
			this.epoch = table;
			this.tables.set(message as object, table);
		} else {
			this.epoch = table;
		}

		let changed = false;
		const content = (message as { content: unknown[] }).content.map((block) => {
			if ((block as { type?: string }).type !== "toolCall") return block;
			const orig = (block as { id?: unknown }).id;
			if (typeof orig !== "string") return block;
			let mapped = table!.get(orig);
			if (mapped === undefined) {
				mapped = this.claim(orig);
				table!.set(orig, mapped);
			}
			if (mapped === orig) return block;
			changed = true;
			return { ...(block as object), id: mapped };
		});
		return changed ? { ...(message as object), content } : message;
	}

	/** Every AgentEvent, ids uniquified. Structural and total: unknown
	 *  event shapes pass through untouched. */
	event(event: AgentEvent): AgentEvent {
		switch (event.type) {
			case "message_start": {
				const e = event as { message: { role?: string } };
				// A new assistant message opens a fresh epoch — this is what
				// keeps a retried id in a LATER message from reusing the
				// earlier message's mint.
				if (e.message?.role === "assistant") this.epoch = new Map();
				return this.remapEventMessage(event);
			}
			case "message_update":
			case "message_end":
				return this.remapEventMessage(event);
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				const { toolCallId } = event as { toolCallId: string };
				const mapped = this.epoch?.get(toolCallId) ?? toolCallId;
				if (mapped === toolCallId) return event;
				return { ...(event as object), toolCallId: mapped } as AgentEvent;
			}
			case "turn_end": {
				const e = event as { message: unknown; toolResults: Array<{ toolCallId?: string }> };
				const message = this.remapMessageContent(e.message);
				const table = this.epoch;
				const toolResults = table
					? e.toolResults.map((r) =>
							typeof r.toolCallId === "string" && table.has(r.toolCallId)
								? { ...r, toolCallId: table.get(r.toolCallId)! }
								: r,
						)
					: e.toolResults;
				return { ...(e as object), message, toolResults } as unknown as AgentEvent;
			}
			case "agent_end": {
				const e = event as { messages: unknown[] };
				return { ...(e as object), messages: this.remapSettled(e.messages) } as unknown as AgentEvent;
			}
			default:
				return event;
		}
	}

	private remapEventMessage(event: AgentEvent): AgentEvent {
		const e = event as { message: unknown };
		const remapped = this.remapMessageContent(e.message);
		if (remapped === e.message) return event;
		return { ...(event as object), message: remapped } as AgentEvent;
	}

	/** The settle seam: the agent's final state, rewritten to the ids the
	 *  wire already showed. Only THIS turn's messages rewrite (the ones
	 *  registered by their event objects); prior-turn history — including
	 *  legacy duplicate-id records — passes through verbatim. Tool results
	 *  pair with the most recent registered assistant message (the loop's
	 *  own structure: results follow their calls). */
	remapSettled(messages: readonly unknown[]): unknown[] {
		let scope: Map<string, string> | undefined;
		return messages.map((m) => {
			const role = (m as { role?: string }).role;
			if (role === "assistant") {
				const table = this.tables.get(m as object);
				if (!table) {
					// Prior-turn or unregistered: history is never rewritten.
					scope = undefined;
					return m;
				}
				scope = table;
				return this.remapMessageContent(m);
			}
			if (role === "toolResult") {
				const orig = (m as { toolCallId?: unknown }).toolCallId;
				if (scope && typeof orig === "string" && scope.has(orig)) {
					return { ...(m as object), toolCallId: scope.get(orig)! };
				}
				return m;
			}
			return m;
		});
	}
}
