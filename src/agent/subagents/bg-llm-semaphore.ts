/**
 * THE SHARED BACKGROUND-LLM SEMAPHORE (owner ruling, 2026-09-29): ONE
 * process-wide pool of 3 permits for ALL background LLM jobs — extraction
 * chunks. Total background
 * LLM concurrency is bounded at 3, whoever is calling: no subsystem gets
 * a private lane past the provider-facing stance.
 *
 * Extraction owned this gate alone first (owner, 2026-09-28: at most 3
 * concurrent extractor calls).
 * the ruling then unified them — this module is the single truth, so
 * extraction chunks are the only holders.
 *
 * FIFO; abort-aware (a queued caller that aborts marks its ticket dead —
 * the permit handoff skips it and hands to the next waiter).
 *
 * FRESH-TAKE / HANDED-OFF-PERMIT discipline (the double-count deadlock
 * lesson, extraction 2026-09-28): fresh takers increment `active`
 * themselves; a HANDED-OFF permit does not (the releaser left `active`
 * untouched for the inheritor) — counting both sides is how a semaphore
 * slowly deadlocks at 3-with-empty-queue.
 *
 * The same queue also backs the 1-permit audit gate (extraction.ts), so
 * both FIFO gates share one abort-aware handoff (#522).
 */

/** Total background LLM concurrency, process-wide, across ALL subsystems
 *  (owner ruling 2026-09-29: one shared pool — extraction chunks +
 *  extraction chunks). */
const PERMIT_COUNT = 3;

export interface PermitGate {
	permits: number;
	/** The AbortError message a queued caller gets when it aborts. */
	abortMessage: string;
	active: number;
	queue: { resolve: () => void; dead: boolean }[];
}

interface LhPermitGatesGlobal {
	__lhPermitGates?: Map<string, PermitGate>;
}

/** The process's single gate under `name` (globalThis — Next dev compiles
 *  each route entry as its own module instance; a module-level object
 *  would split the gate per route. One process, one truth). */
export function permitGate(name: string, permits: number, abortMessage: string): PermitGate {
	const g = globalThis as typeof globalThis & LhPermitGatesGlobal;
	const gates = (g.__lhPermitGates ??= new Map());
	let gate = gates.get(name);
	if (!gate) gates.set(name, (gate = { permits, abortMessage, active: 0, queue: [] }));
	return gate;
}

/** The shared background-LLM pool. */
export function bgLlmSlots(): PermitGate {
	return permitGate("bg-llm", PERMIT_COUNT, "background LLM job aborted while queued for a permit");
}

/** Run `critical` under one permit of `gate`. `signal` (the caller's
 *  row/abort controller) kills a queued ticket: it marks itself dead and
 *  rejects AbortError — the handoff skips it. */
export async function withPermit<T>(
	gate: PermitGate,
	signal: AbortSignal | undefined,
	critical: () => Promise<T>,
): Promise<T> {
	let freshTake = true;
	if (gate.active >= gate.permits) {
		freshTake = false;
		await new Promise<void>((resolve, reject) => {
			const ticket: { resolve: () => void; dead: boolean } = { resolve, dead: false };
			gate.queue.push(ticket);
			if (!signal) return;
			const die = () => {
				ticket.dead = true; // the permit handoff must skip us
				const err = new Error(gate.abortMessage);
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) die();
			else signal.addEventListener("abort", die, { once: true });
		});
	}
	if (freshTake) gate.active++;
	try {
		return await critical();
	} finally {
		// Permit handoff: a waiting ticket inherits the permit directly
		// (active stays); dead tickets are skipped — their job already
		// left through the abort path.
		for (;;) {
			const next = gate.queue.shift();
			if (!next) {
				gate.active--;
				break;
			}
			if (next.dead) continue;
			next.resolve();
			break;
		}
	}
}

/** Run `critical` under one permit of the shared background-LLM pool. */
export function withBgLlmSlot<T>(signal: AbortSignal | undefined, critical: () => Promise<T>): Promise<T> {
	return withPermit(bgLlmSlots(), signal, critical);
}
