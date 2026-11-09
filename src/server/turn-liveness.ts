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
 * record + mount continuation on the next visit. There is no clock: a turn
 * owns its chat until endTurn, however long it runs, because freeing it
 * while it still runs would allow a second turn and a delete mid-turn. The
 * limit: a turn whose agent ignores Stop never settles, so its chat stays
 * busy until the app restarts.
 */

import { emit } from "../core/events.ts";
import { clearTurnFailure } from "./turn-runs.ts";

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

const inFlight = registry();

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began.
 */
export function beginTurn(chatId: string): boolean {
	if (isTurnRunning(chatId)) return false;
	clearTurnFailure(chatId);
	inFlight.set(chatId, Date.now());
	emit("turn-started", { chatId });
	return true;
}

/**
 * Mark the chat's turn as finished after normal settlement, or after the
 * failure notice has been retained by settlement cleanup. A subsequent
 * fetch reads durable truth, never a promise that an unsaved reply landed.
 * Emits only when an entry was actually present: a
 * defensive no-op endTurn must not fire a spurious settle.
 */
export function endTurn(chatId: string): void {
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

/** True from beginTurn until endTurn, however long the turn runs. */
export function isTurnRunning(chatId: string): boolean {
	return inFlight.has(chatId);
}
