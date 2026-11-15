/**
 * Server surface of the host work registry and exclusive hold
 * (core/host-hold.ts): the HTTP request gate the proxy applies, and the
 * snapshot/cancel the app banner uses.
 */

import { activeHold, cancelHold, holdMessage, runningWork, type HostHoldInfo, type HostWorkEntry } from "../core/host-hold.ts";

export { activeHold, cancelHold, runningWork };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The request gate: while a hold is active, every API request that may
 *  write is refused, except the holder's own plugin calls and the banner's
 *  cancel. Reads keep working. Returns the refusal body, or null to pass. */
export function holdRequestRefusal(method: string, pathname: string): { error: string; hold: { owner: string; reason: string } } | null {
	if (READ_METHODS.has(method.toUpperCase())) return null;
	const hold = activeHold();
	if (!hold) return null;
	const path = pathname.replace(/\/+$/, "");
	if (path === "/api/hold/cancel") return null;
	if (path === `/api/plugins/${hold.owner}/call`) return null;
	return { error: holdMessage(hold), hold: { owner: hold.owner, reason: hold.reason } };
}

export function holdSnapshot(): { hold: HostHoldInfo | null; work: HostWorkEntry[] } {
	return { hold: activeHold(), work: runningWork() };
}
