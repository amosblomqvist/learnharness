import path from "node:path";
import type { PluginBackendContext, PluginHostControl, PluginLifecycleContext } from "learnharness-plugin-api";
import { createGitSync, GitError, type ConflictChoice, type DataFormats, type InitChoice, type InitResult, type SyncResult } from "./git-sync.ts";
import { createLocalState, type LocalStateStore } from "./local-state.ts";

/** Banner text and refusal reason while GitHub Sync holds the app. */
export const HOLD_REASON = "GitHub Sync is syncing";
export const BUSY_MESSAGE = "LearnHarness is busy. Try again when the current lesson or extraction finishes.";

/** What the window should do after a result. */
export type After = "restarting" | "restart-manually" | "reload";
export type Outcome = (SyncResult | InitResult) & { after?: After };

function record(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

/** The git helper for the whole learning-data folder, ignoring this
 *  plugin's per-machine state file. */
export function syncFor(learningDirectory: string, state: LocalStateStore, dataFormats?: DataFormats, git?: string) {
	const ignore = path.relative(learningDirectory, state.file).split(path.sep).join("/");
	return createGitSync({ directory: learningDirectory, dataFormats, ignore: [ignore], git });
}

/** Remember conflicts (they pause automatic sync) from any sync result. */
export function noteResult(state: LocalStateStore, result: SyncResult | InitResult | null, automatic: boolean): void {
	if (!result) return;
	const at = new Date().toISOString();
	const patch: Parameters<LocalStateStore["update"]>[0] = {};
	if (result.status === "conflict") patch.conflict = { branch: result.branch, remote: result.remote, message: result.message, at };
	if (automatic) patch.lastAuto = { at, status: result.status, message: result.message };
	if (Object.keys(patch).length) state.update(patch);
}

/** beforeLoad / beforeQuit: non-interactive, only when automatic sync is
 *  on and no conflict is waiting for the learner. */
export async function automatic(ctx: PluginLifecycleContext, kind: "pull" | "sync", git?: string): Promise<void> {
	const state = createLocalState(ctx.dataDirectory);
	const current = state.read();
	if (!current.autoSync || current.conflict) return;
	const sync = syncFor(ctx.learningDirectory, state, ctx.dataFormats, git);
	try {
		const result = kind === "pull" ? await sync.autoPull({ signal: ctx.signal }) : await sync.autoSync({ signal: ctx.signal });
		noteResult(state, result, true);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.update({ lastAuto: { at: new Date().toISOString(), status: "error", message } });
		console.warn(`[github-sync] automatic ${kind} failed: ${message}`);
	}
}

export function beforeLoad(ctx: PluginLifecycleContext): Promise<void> {
	return automatic(ctx, "pull");
}

export function beforeQuit(ctx: PluginLifecycleContext): Promise<void> {
	return automatic(ctx, "sync");
}

export function activate(ctx: PluginBackendContext): void {
	// Absent on apps older than the host hold API: manual sync only, as before.
	const host = (ctx as { host?: PluginHostControl }).host;
	const state = createLocalState(ctx.dataDirectory);
	const sync = syncFor(ctx.learning.directory, state, host?.dataFormats);
	const changed = () => ctx.events.emit("state");

	/** Run a manual operation under the exclusive hold; after a result that
	 *  changed files, ask the host to restart (or reload on older apps). */
	async function manual(work: (signal: AbortSignal) => Promise<SyncResult | InitResult>): Promise<Outcome> {
		ctx.signal.throwIfAborted();
		if (!host) {
			const result = await work(ctx.signal);
			noteResult(state, result, false);
			changed();
			return result.changed ? { ...result, after: "reload" } : result;
		}
		const hold = host.acquireHold({ reason: HOLD_REASON });
		if (!hold) throw new GitError(BUSY_MESSAGE);
		let keep = false;
		try {
			const result = await work(hold.signal);
			noteResult(state, result, false);
			changed();
			if (!result.changed) return result;
			// The server still holds the old data in memory: restart it. The hold
			// stays on until the restart, so nothing writes stale data meanwhile.
			keep = true;
			const restart = await host.requestRestart();
			return { ...result, after: restart.restarted ? "restarting" : "restart-manually" };
		} finally {
			if (!keep) hold.release();
		}
	}

	ctx.handle("status", async () => {
		ctx.signal.throwIfAborted();
		const local = state.read();
		return { ...(await sync.status()), autoSync: local.autoSync, conflict: local.conflict ?? null, lastAuto: local.lastAuto ?? null, automaticAvailable: !!host };
	});
	ctx.handle("set-auto", input => {
		const { enabled } = record(input);
		if (typeof enabled !== "boolean") throw new GitError("enabled must be true or false.");
		state.update({ autoSync: enabled });
		changed();
		return { autoSync: enabled };
	});
	ctx.handle("pull", () => manual(signal => sync.pull({ signal })));
	ctx.handle("push", () => manual(signal => sync.push({ signal })));
	ctx.handle("sync", () => manual(signal => sync.sync({ signal })));
	ctx.handle("resolve", async input => {
		const { choice, remote } = record(input);
		try {
			const result = await manual(signal => sync.resolve(choice as ConflictChoice, remote as string, { signal }));
			state.update({ conflict: undefined });
			return result;
		} catch (error) {
			// GitHub moved again: the stored conflict is stale; the next sync finds a fresh one.
			if (error instanceof GitError && /changed again/.test(error.message)) { state.update({ conflict: undefined }); changed(); }
			throw error;
		} finally { changed(); }
	});
	ctx.handle("initialize", async input => {
		const result = await manual(signal => sync.initialize(record(input).url, { signal }));
		if (result.status === "done") { state.update({ autoSync: true }); changed(); }
		return result;
	});
	ctx.handle("initialize-from-remote", async input => {
		const { url, choice, branch } = record(input);
		const result = await manual(signal => sync.initializeFromRemote(url, choice as InitChoice, branch, { signal }));
		if (result.status === "done") { state.update({ autoSync: true }); changed(); }
		return result;
	});

	// Push after work ends: commit under the hold, then push without it.
	// Never pulls, so the running app never needs a restart for this.
	host?.onIdle(() => { void pushAfterWork(); });
	async function pushAfterWork(): Promise<void> {
		const local = state.read();
		if (!host || ctx.signal.aborted || !local.autoSync || local.conflict) return;
		const hold = host.acquireHold({ reason: HOLD_REASON });
		if (!hold) return; // busy again; the next idle edge retries
		let committed: Awaited<ReturnType<typeof sync.autoCommit>>;
		try { committed = await sync.autoCommit({ signal: hold.signal }); }
		catch (error) { console.warn(`[github-sync] commit after work failed: ${error instanceof Error ? error.message : String(error)}`); return; }
		finally { hold.release(); }
		if (!committed) return;
		try {
			const pushed = await sync.autoPush({ signal: ctx.signal });
			if (pushed === "pushed" || pushed === "behind") {
				state.update({ lastAuto: { at: new Date().toISOString(), status: pushed, message: pushed === "pushed" ? "Pushed after work ended." : "GitHub has newer changes; they are pulled on the next start or quit." } });
				changed();
			}
		} catch (error) {
			console.warn(`[github-sync] push after work failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
