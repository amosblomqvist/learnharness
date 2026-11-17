/**
 * Server-side turn liveness: which chats currently have a teacher turn in
 * flight. The missing half of "sessions keep running in the background" —
 * together with the write-ahead persist in chat-handler, a returning client
 * can tell "the teacher is mid-turn — don't resurrect, don't start anything"
 * apart from "the record IS current".
 *
 * Lives on globalThis, NOT a module-level Map: Next dev compiles each route
 * as its own entry, so a module-level singleton is a DIFFERENT instance in
 * the page render, GET /api/chats/[id], and POST /api/chat — the page would
 * read an empty registry while the chat route holds the live turn (the bug:
 * returning mid-turn showed the 409 banner instead of the busy state).
 * globalThis spans module instances within the process; it is the standard
 * Next.js singleton channel (same reason Prisma clients live there).
 *
 * Still ephemeral BY DESIGN: a process restart clears it, so there are no
 * stale flags to clean up — a crashed turn recovers via the write-ahead
 * record + mount continuation on the next visit. The TTL is a leak guard for
 * teacher turns whose onFinish never fires. Preparation owners are pinned
 * until their callback settles: expiring an executing grader would admit a
 * second writer. Handoff restores the teacher TTL with a fresh timestamp.
 */

import { emit } from "../core/events.ts";
import { clearTurnFailure } from "./turn-runs.ts";

interface TurnOwner {
	token: object;
	preparing: boolean;
}

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
	__lhTurnOwners?: Map<string, TurnOwner>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

function owners(): Map<string, TurnOwner> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnOwners ??= new Map<string, TurnOwner>());
}

const inFlight = registry();
const MAX_TURN_MS = 30 * 60_000;

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began. A private
 * preparation owner pins the entry until handoff; ordinary callers keep
 * the existing TTL behavior and need not pass an owner.
 */
export function beginTurn(chatId: string, preparationOwner?: object): boolean {
	if (isTurnRunning(chatId)) return false;
	clearTurnFailure(chatId);
	if (preparationOwner) owners().set(chatId, { token: preparationOwner, preparing: true });
	else owners().delete(chatId);
	inFlight.set(chatId, Date.now());
	emit("turn-started", { chatId });
	return true;
}

/**
 * Mark the chat's turn as finished after normal settlement, or after the
 * failure notice has been retained by settlement cleanup. A subsequent
 * fetch reads durable truth, never a promise that an unsaved reply landed.
 * Emits only when an entry was actually present: a
 * defensive no-op endTurn must not fire a spurious settle. Passing an
 * owner fences cleanup against a newer turn; omitted retains the original
 * unconditional end API for ordinary turns.
 */
export function endTurn(chatId: string, owner?: object): void {
	if (owner && owners().get(chatId)?.token !== owner) return;
	owners().delete(chatId);
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

/** Private ownership fence for preparation and its handed-off teacher. */
export function isTurnOwner(chatId: string, owner: object): boolean {
	return isTurnRunning(chatId) && owners().get(chatId)?.token === owner;
}

/** Transfer the pinned preparation to the ordinary teacher TTL, without
 * ending/restarting the turn or emitting another lifecycle event. */
export function handoffTurn(chatId: string, owner: object): boolean {
	if (!isTurnOwner(chatId, owner)) return false;
	owners().get(chatId)!.preparing = false;
	inFlight.set(chatId, Date.now());
	return true;
}

/** True while the chat's turn is in flight; lazily evicts stale entries.
 * The eviction path is DELIBERATELY event-free: it is a leak guard for a
 * turn whose onFinish never fired (itself pathological), it runs lazily
 * from a read, and emitting from a read is a side-effect smell. Silence
 * here is a choice, not an oversight. */
export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (!owners().get(chatId)?.preparing && Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		owners().delete(chatId);
		return false;
	}
	return true;
}
