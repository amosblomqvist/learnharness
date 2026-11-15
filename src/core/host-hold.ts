/**
 * Host work registry and exclusive hold (GitHub Sync host support).
 *
 * Every piece of running work (turns including preparation, sub-agent jobs,
 * extraction, compaction, side chats, plugin workers, managed plugin agent
 * runs, plugin inference calls) registers with beginWork() and ends in its
 * own finally. The host is idle when nothing is registered.
 *
 * A hold is exclusive: acquireHold() succeeds only while idle (unless forced
 * by the host itself for lifecycle hooks), and while a hold is active
 * beginWork() and every data-folder write refuse with HostHoldError. Holds
 * never expire; the banner's Cancel aborts the hold's signal and releases it.
 *
 * Idle listeners fire on the busy→idle edge only (the last registered work
 * ended and nothing started for IDLE_DEBOUNCE_MS), never on hold release:
 * a plugin that reacts to idle by taking and releasing a hold must not
 * retrigger itself.
 *
 * State lives on globalThis so every Next module instance shares it.
 */

import { emit } from "./events.ts";

export type HostWorkKind =
	| "turn"
	| "job"
	| "extraction"
	| "compaction"
	| "side-chat"
	| "plugin-worker"
	| "plugin-agent"
	| "plugin-inference";

export interface HostWorkEntry {
	kind: HostWorkKind;
	label: string;
	startedAt: number;
}

export interface HostHoldInfo {
	/** Plugin id, or "host" for lifecycle holds. */
	owner: string;
	reason: string;
	since: number;
}

export interface HostHold {
	readonly signal: AbortSignal;
	/** For holds taken with `writesAllowed`: refuse data writes from now on. */
	blockWrites(): void;
	release(): void;
}

export interface HostWorkLease {
	end(): void;
}

export const IDLE_DEBOUNCE_MS = 3000;

const HOST_HOLD_ERROR = Symbol.for("learnharness.host-hold-error");

/** Refusal while a hold is active. status 503 for the HTTP layers. */
export class HostHoldError extends Error {
	readonly status = 503;
	readonly hold: { owner: string; reason: string };
	constructor(hold: HostHoldInfo) {
		super(holdMessage(hold));
		this.name = "HostHoldError";
		this.hold = { owner: hold.owner, reason: hold.reason };
		Object.defineProperty(this, HOST_HOLD_ERROR, { value: true });
	}
}

/** Works across Next module instances. */
export function isHostHoldError(error: unknown): error is HostHoldError {
	return !!error && typeof error === "object" && (error as Record<symbol, unknown>)[HOST_HOLD_ERROR] === true;
}

export function holdMessage(hold: { reason: string }): string {
	return `${hold.reason}. Changes are paused until it finishes; try again in a moment.`;
}

interface WorkRecord extends HostWorkEntry {
	abort?: () => void;
}

interface HoldRecord extends HostHoldInfo {
	controller: AbortController;
	/** New work is always refused; writes only once this is false. */
	writesAllowed: boolean;
}

interface HostHoldState {
	work: Map<symbol, WorkRecord>;
	hold: HoldRecord | null;
	idleListeners: Set<() => void>;
	workWaiters: Set<() => void>;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

function state(): HostHoldState {
	const g = globalThis as typeof globalThis & { __lhHostHold?: HostHoldState };
	return (g.__lhHostHold ??= { work: new Map(), hold: null, idleListeners: new Set(), workWaiters: new Set(), idleTimer: null });
}

/** The write check: throws HostHoldError while a hold refuses writes. */
export function assertNoHold(): void {
	const { hold } = state();
	if (hold && !hold.writesAllowed) throw new HostHoldError(hold);
}

/** Register running work. Throws HostHoldError while a hold is active.
 *  `abort` is called by abortAllWork (app quit); it should go through the
 *  work's normal abort path so partial results are saved. */
export function beginWork(kind: HostWorkKind, label: string, abort?: () => void): HostWorkLease {
	const s = state();
	if (s.hold) throw new HostHoldError(s.hold);
	const token = Symbol(kind);
	s.work.set(token, { kind, label, startedAt: Date.now(), abort });
	if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
	let ended = false;
	return {
		end() {
			if (ended) return;
			ended = true;
			const current = state();
			if (!current.work.delete(token)) return;
			for (const waiter of [...current.workWaiters]) waiter();
			if (current.work.size === 0) scheduleIdle();
		},
	};
}

function scheduleIdle(): void {
	const s = state();
	if (s.idleTimer) clearTimeout(s.idleTimer);
	s.idleTimer = setTimeout(() => {
		const current = state();
		current.idleTimer = null;
		if (current.work.size !== 0 || current.hold) return;
		for (const listener of [...current.idleListeners]) {
			try { listener(); }
			catch (error) { console.error("[host-hold] idle listener failed:", error); }
		}
	}, IDLE_DEBOUNCE_MS);
	s.idleTimer.unref?.();
}

/** Running work, oldest first. */
export function runningWork(): HostWorkEntry[] {
	return [...state().work.values()]
		.map(({ kind, label, startedAt }) => ({ kind, label, startedAt }))
		.sort((a, b) => a.startedAt - b.startedAt);
}

export function isHostIdle(): boolean {
	return state().work.size === 0;
}

export function activeHold(): HostHoldInfo | null {
	const { hold } = state();
	return hold ? { owner: hold.owner, reason: hold.reason, since: hold.since } : null;
}

/** Exclusive hold. Null when any work is running or another hold is active.
 *  `force` (host lifecycle only) takes the hold even while work runs: new
 *  work is refused from then on, and the caller aborts/waits for the rest.
 *  `writesAllowed` keeps data writes open (aborted work saves its partial
 *  results) until blockWrites(). */
export function acquireHold(options: { owner: string; reason: string; force?: boolean; writesAllowed?: boolean }): HostHold | null {
	const s = state();
	if (s.hold) return null;
	if (!options.force && s.work.size !== 0) return null;
	const reason = options.reason.trim() || "Syncing";
	const record: HoldRecord = { owner: options.owner, reason, since: Date.now(), controller: new AbortController(), writesAllowed: options.writesAllowed === true };
	s.hold = record;
	if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
	emit("hold-changed", { active: true });
	return {
		signal: record.controller.signal,
		blockWrites() { record.writesAllowed = false; },
		release() { releaseRecord(record); },
	};
}

function releaseRecord(record: HoldRecord): void {
	const s = state();
	if (s.hold !== record) return;
	s.hold = null;
	emit("hold-changed", { active: false });
}

/** The banner's Cancel: abort the active hold's signal and release it. */
export function cancelHold(): boolean {
	const { hold } = state();
	if (!hold) return false;
	hold.controller.abort(new Error("Cancelled by the user"));
	releaseRecord(hold);
	return true;
}

/** Release every hold owned by `owner` (plugin deactivation). */
export function releaseHoldsOf(owner: string): void {
	const { hold } = state();
	if (!hold || hold.owner !== owner) return;
	hold.controller.abort(new Error("Hold owner deactivated"));
	releaseRecord(hold);
}

/** Busy→idle notifications (debounced). Returns the unsubscribe function. */
export function onHostIdle(listener: () => void): () => void {
	const s = state();
	s.idleListeners.add(listener);
	return () => { state().idleListeners.delete(listener); };
}

/** Abort all registered work through its own abort paths, then wait until
 *  the registry is empty or `signal` aborts. Work without an abort function
 *  (compaction) is waited for. */
export async function abortAllWork(signal?: AbortSignal): Promise<void> {
	const s = state();
	for (const record of [...s.work.values()]) {
		try { record.abort?.(); }
		catch (error) { console.error(`[host-hold] aborting ${record.kind} failed:`, error); }
	}
	if (s.work.size === 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			if (state().work.size !== 0 && !signal?.aborted) return;
			state().workWaiters.delete(done);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		s.workWaiters.add(done);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** Test-only reset. */
export function resetHostHoldForTests(): void {
	const s = state();
	if (s.idleTimer) clearTimeout(s.idleTimer);
	s.work.clear();
	s.hold = null;
	s.idleListeners.clear();
	s.workWaiters.clear();
	s.idleTimer = null;
}
