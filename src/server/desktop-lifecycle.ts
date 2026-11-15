/**
 * Desktop lifecycle channel ("lh:lifecycle") between the server child and
 * the Electron shell, over the inherited IPC pipe the shell already uses
 * for credential leases.
 *
 * Server → shell:
 *   { op: "before-load", state: "start", plugins: string[] }  show the splash
 *   { op: "before-load", state: "done" }                      hide it, resume the start timeout
 *   { op: "hooks", beforeQuit: boolean }                      whether quit must wait for hooks
 *   { op: "restart" }                                         restart the server, reload windows
 *   { op: "before-quit", state: "done" }                      quit hooks finished
 * Shell → server:
 *   { op: "skip" }          the splash's Skip
 *   { op: "before-quit" }   run the quit sequence
 *   { op: "quit-now" }      the quit screen's Quit now
 *
 * Without a desktop parent (development, web) nothing is sent and restart
 * reports "unavailable".
 */

import { abortAllWork, acquireHold, activeHold } from "../core/host-hold.ts";

export const LIFECYCLE_CHANNEL = "lh:lifecycle";
/** Shared time limit for all beforeLoad hooks, and for the whole quit sequence. */
export const LIFECYCLE_HOOK_LIMIT_MS = 30_000;

type InboundOp = "skip" | "before-quit" | "quit-now";

interface LifecycleGlobal {
	listeners: Map<InboundOp, Set<() => void>>;
	installed: boolean;
	quitting?: Promise<void>;
}

function desktopConnected(): boolean {
	return process.env.LH_DESKTOP_SERVER === "1" && typeof process.send === "function" && process.connected === true;
}

function lifecycle(): LifecycleGlobal {
	const g = globalThis as typeof globalThis & { __lhDesktopLifecycle?: LifecycleGlobal };
	const state = (g.__lhDesktopLifecycle ??= { listeners: new Map(), installed: false });
	if (!state.installed && desktopConnected()) {
		state.installed = true;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: unknown; op?: unknown } | null;
			if (!message || message.channel !== LIFECYCLE_CHANNEL || typeof message.op !== "string") return;
			for (const listener of [...(state.listeners.get(message.op as InboundOp) ?? [])]) {
				try { listener(); } catch (error) { console.error(`[lifecycle] ${message.op} listener failed:`, error); }
			}
		});
	}
	return state;
}

export function hasDesktopShell(): boolean {
	return desktopConnected();
}

export function sendLifecycle(message: Record<string, unknown>): void {
	if (!desktopConnected()) return;
	try { process.send!({ ...message, channel: LIFECYCLE_CHANNEL }, (error: Error | null) => { if (error) console.warn("[lifecycle] send failed:", error.message); }); }
	catch (error) { console.warn("[lifecycle] send failed:", error); }
}

export function onLifecycle(op: InboundOp, listener: () => void): () => void {
	const state = lifecycle();
	let set = state.listeners.get(op);
	if (!set) state.listeners.set(op, (set = new Set()));
	set.add(listener);
	return () => { set!.delete(listener); };
}

/** ctx.host.requestRestart: the shell stops this process, starts a fresh
 *  server (beforeLoad runs again) and reloads every window. */
export async function requestDesktopRestart(): Promise<{ restarted: boolean; reason?: "unavailable" }> {
	if (!desktopConnected()) return { restarted: false, reason: "unavailable" };
	sendLifecycle({ op: "restart" });
	return { restarted: true };
}

/** The startup signal for beforeLoad hooks: the shared time limit plus the
 *  splash's Skip. */
export function startupHookSignal(): { signal: AbortSignal; dispose(): void } {
	const skip = new AbortController();
	const off = onLifecycle("skip", () => skip.abort(new Error("Skipped by the user")));
	const signal = AbortSignal.any([AbortSignal.timeout(LIFECYCLE_HOOK_LIMIT_MS), skip.signal]);
	return { signal, dispose: off };
}

/** Wire the quit sequence: on the shell's "before-quit", take the host hold
 *  (forced, writes open), abort running work through its own abort paths so
 *  partial results save, close writes, run every beforeQuit hook, then
 *  report done. One shared time limit; "quit-now" aborts it. */
export function installQuitSequence(runBeforeQuit: (signal: AbortSignal) => Promise<void>): void {
	if (!desktopConnected()) return;
	onLifecycle("before-quit", () => {
		const state = lifecycle();
		state.quitting ??= (async () => {
			const quitNow = new AbortController();
			const offQuitNow = onLifecycle("quit-now", () => quitNow.abort(new Error("Quit now")));
			const signal = AbortSignal.any([AbortSignal.timeout(LIFECYCLE_HOOK_LIMIT_MS), quitNow.signal]);
			try {
				// A plugin hold in progress (a manual sync) finishes first.
				while (activeHold() && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, 100));
				const hold = acquireHold({ owner: "host", reason: "Syncing before quit", force: true, writesAllowed: true });
				await abortAllWork(signal);
				hold?.blockWrites();
				if (!signal.aborted) await runBeforeQuit(signal);
			} catch (error) {
				console.error("[lifecycle] quit sequence failed:", error);
			} finally {
				offQuitNow();
				sendLifecycle({ op: "before-quit", state: "done" });
			}
		})();
	});
}
