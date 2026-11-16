import { ANTIGRAVITY_PARK_IDLE_TIMEOUT_MS } from "./constants.ts";

export interface LiveAntigravityProcess {
	readonly owner: symbol;
	readonly sessionId: string | undefined;
	toolCallIds: string[];
	kill(): Promise<void>;
	forceCleanupSync(): void;
}

/** Parked ACP processes stay alive up to 10 minutes idle, strictly under the
 *  30-minute MCP bridge timeout so LearnHarness owns expiry and replay. */
export const LIVE_PROCESS_IDLE_TIMEOUT_MS = ANTIGRAVITY_PARK_IDLE_TIMEOUT_MS;

/** Test seam (mirrors src/agent/claude-code/live-processes.ts). */
export const antigravityIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

const ACTIVE_KEY = Symbol.for("lh.antigravityActiveProcesses");
const PARKED_KEY = Symbol.for("lh.antigravityParkedProcesses");
const HOOKS_KEY = Symbol.for("lh.antigravityShutdownHooksState");

type HookState = {
	attached: boolean;
	onExit: () => void;
	onSigInt: () => void;
	onSigTerm: () => void;
};

function activeRegistry(): Set<LiveAntigravityProcess> {
	const g = globalThis as Record<symbol, Set<LiveAntigravityProcess> | undefined>;
	if (!g[ACTIVE_KEY]) g[ACTIVE_KEY] = new Set();
	return g[ACTIVE_KEY];
}

function parkedRegistry(): Map<LiveAntigravityProcess, NodeJS.Timeout> {
	const g = globalThis as Record<symbol, Map<LiveAntigravityProcess, NodeJS.Timeout> | undefined>;
	if (!g[PARKED_KEY]) g[PARKED_KEY] = new Map();
	return g[PARKED_KEY];
}

function hookState(): HookState {
	const g = globalThis as Record<symbol, HookState | undefined>;
	if (!g[HOOKS_KEY]) {
		const state: HookState = {
			attached: false,
			onExit: () => {
				shutdownAntigravityProcessesSync();
			},
			onSigInt: () => handleShutdownSignal("SIGINT", 130),
			onSigTerm: () => handleShutdownSignal("SIGTERM", 143),
		};
		g[HOOKS_KEY] = state;
	}
	return g[HOOKS_KEY];
}

function handleShutdownSignal(signal: "SIGINT" | "SIGTERM", exitCode: number): void {
	detachShutdownHooks();
	const hasHostListeners = process.listenerCount(signal) > 0;
	if (hasHostListeners) {
		void shutdownAntigravityProcesses();
		return;
	}
	void shutdownAntigravityProcesses().finally(() => {
		process.exit(exitCode);
	});
}

function syncShutdownHooks(): void {
	const hasProcesses = activeRegistry().size > 0 || parkedRegistry().size > 0;
	const state = hookState();
	if (hasProcesses && !state.attached) {
		state.attached = true;
		process.once("exit", state.onExit);
		process.once("SIGINT", state.onSigInt);
		process.once("SIGTERM", state.onSigTerm);
	} else if (!hasProcesses && state.attached) {
		detachShutdownHooks();
	}
}

function detachShutdownHooks(): void {
	const state = hookState();
	if (!state.attached) return;
	state.attached = false;
	process.removeListener("exit", state.onExit);
	process.removeListener("SIGINT", state.onSigInt);
	process.removeListener("SIGTERM", state.onSigTerm);
}

function hasSameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && new Set(b).size === b.length && a.every((id) => b.includes(id));
}

export function registerActiveAntigravityProcess(proc: LiveAntigravityProcess): void {
	activeRegistry().add(proc);
	syncShutdownHooks();
}

export function unregisterActiveAntigravityProcess(proc: LiveAntigravityProcess): void {
	activeRegistry().delete(proc);
	unparkAntigravityProcess(proc);
	syncShutdownHooks();
}

export function parkAntigravityProcess(proc: LiveAntigravityProcess): void {
	unparkAntigravityProcess(proc);
	const timer = setTimeout(() => {
		unparkAntigravityProcess(proc);
		void proc.kill();
	}, antigravityIdleTimeoutMs.current);
	timer.unref();
	parkedRegistry().set(proc, timer);
	syncShutdownHooks();
}

export function unparkAntigravityProcess(proc: LiveAntigravityProcess): void {
	const parked = parkedRegistry();
	const timer = parked.get(proc);
	if (timer !== undefined) {
		clearTimeout(timer);
		parked.delete(proc);
	}
	syncShutdownHooks();
}

export function findParkedAntigravityProcess(
	toolCallIds: readonly string[],
	owner: symbol,
	sessionId: string | undefined,
): LiveAntigravityProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;
	for (const proc of parkedRegistry().keys()) {
		if (proc.owner === owner && proc.sessionId === sessionId && hasSameIds(proc.toolCallIds, toolCallIds)) {
			return proc;
		}
	}
	return null;
}

export function getParkedAntigravityProcessCount(): number {
	return parkedRegistry().size;
}

export function getActiveAntigravityProcessCount(): number {
	return activeRegistry().size;
}

/** Releases and terminates any parked Antigravity ACP process belonging to a finished ephemeral session (e.g. subagents). */
export async function releaseParkedAntigravitySession(sessionId: string | undefined): Promise<void> {
	if (!sessionId) return;
	const matches: LiveAntigravityProcess[] = [];
	for (const proc of parkedRegistry().keys()) {
		if (proc.sessionId === sessionId) matches.push(proc);
	}
	if (matches.length === 0) return;
	for (const proc of matches) {
		unparkAntigravityProcess(proc);
	}
	await Promise.allSettled(matches.map((proc) => proc.kill()));
}

/** Closes and cleans up all active and parked Antigravity ACP processes. */
export async function shutdownAntigravityProcesses(): Promise<void> {
	const processes = new Set<LiveAntigravityProcess>([...activeRegistry(), ...parkedRegistry().keys()]);
	for (const proc of processes) {
		unparkAntigravityProcess(proc);
	}
	await Promise.allSettled([...processes].map((proc) => proc.kill()));
	syncShutdownHooks();
}

/** Synchronous best-effort cleanup for `process.on("exit")` shutdown paths. */
export function shutdownAntigravityProcessesSync(): void {
	const processes = new Set<LiveAntigravityProcess>([...activeRegistry(), ...parkedRegistry().keys()]);
	for (const proc of processes) {
		unparkAntigravityProcess(proc);
		try {
			proc.forceCleanupSync();
		} catch {
			// ignore exit-time cleanup errors
		}
	}
	syncShutdownHooks();
}
