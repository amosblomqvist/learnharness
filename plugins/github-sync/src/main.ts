import type { PluginFrontendContext, PluginSettingsRow } from "learnharness-plugin-api";
import type { InitResult, RepoStatus, SyncResult } from "./git-sync.ts";
import type { Outcome } from "./backend.ts";

/** The backend's status: repository plus per-machine state. */
export interface PluginStatus extends RepoStatus {
	autoSync?: boolean;
	conflict?: { branch: string; remote: string; message: string; at: string } | null;
	lastAuto?: { at: string; status: string; message: string } | null;
	/** False on apps without the host hold API: manual sync only. */
	automaticAvailable?: boolean;
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
	sync: svg('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>'),
	pull: svg('<path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M5 20h14"/>'),
	push: svg('<path d="M12 20V8"/><path d="m6 14 6-6 6 6"/><path d="M5 4h14"/>'),
	conflict: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
};

interface Choice { key: string; label: string; variant?: "default" | "destructive" | "outline" | "secondary" }
interface Deps { reload(): void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** Open a host dialog with plugin-owned heading, text and buttons. Resolves the chosen key, or null on close. */
export function choose(ctx: PluginFrontendContext, title: string, body: string[], choices: Choice[]): Promise<string | null> {
	return new Promise(resolve => {
		let settled = false;
		const settle = (value: string | null) => {
			if (settled) return;
			settled = true;
			ctx.signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => settle(null);
		ctx.signal.addEventListener("abort", onAbort);
		const handle = ctx.ui.openDialog({
			title,
			content: (container, signal) => {
				const root = el("div", "github-sync-dialog");
				root.append(el("h2", "github-sync-title", title));
				for (const paragraph of body) root.append(el("p", "github-sync-text", paragraph));
				const row = el("div", "github-sync-buttons");
				root.append(row);
				container.append(root);
				for (const choice of choices) {
					const slot = el("div");
					row.append(slot);
					ctx.ui.mountButton(slot, {
						label: choice.label, variant: choice.variant ?? "default",
						onClick: () => { settle(choice.key); handle.dispose(); },
					}, { signal });
				}
				// Remove only this mount's node: a late cleanup must not clear a newer mount in the same container.
				return () => root.remove();
			},
			onClose: () => settle(null),
		}, { signal: ctx.signal });
	});
}

const message = (ctx: PluginFrontendContext, title: string, text: string) =>
	choose(ctx, title, [text], [{ key: "ok", label: "OK" }]);

/** Show a finished result. After a result that changed files the app
 *  restarts its server (the desktop app reloads this window), or on older
 *  apps the window reloads; without a desktop shell the learner restarts. */
export async function present(ctx: PluginFrontendContext, result: Outcome | SyncResult | InitResult, deps: Deps): Promise<void> {
	if (result.status === "conflict") return resolveConflict(ctx, result, deps);
	if (result.status === "remote-has-data") throw new Error("Unexpected setup result.");
	if (result.status === "newer-data") { await message(ctx, "Update LearnHarness first", result.message); return; }
	const after = "after" in result ? result.after : result.changed ? "reload" : undefined;
	if (after === "restarting") return; // the desktop app reloads this window
	if (after === "reload") { deps.reload(); return; }
	if (after === "restart-manually") {
		await message(ctx, "Restart LearnHarness", `${result.message} Restart LearnHarness to load it. Changes stay paused until then.`);
		return;
	}
	await message(ctx, "GitHub Sync", result.message);
}

export async function resolveConflict(ctx: PluginFrontendContext, conflict: Extract<SyncResult, { status: "conflict" }>, deps: Deps): Promise<void> {
	const choice = await choose(ctx, "GitHub Sync conflict", [
		conflict.message,
		"Keep mine replaces GitHub's version with this computer's data. Take GitHub's replaces this computer's data with GitHub's. The replaced side is saved in a local backup branch either way.",
	], [
		{ key: "keep-local", label: "Keep mine", variant: "destructive" },
		{ key: "take-remote", label: "Take GitHub's", variant: "destructive" },
		{ key: "cancel", label: "Cancel", variant: "outline" },
	]);
	if (choice !== "keep-local" && choice !== "take-remote") return;
	const confirmText = choice === "keep-local"
		? `This force-pushes your local data to GitHub branch ${conflict.branch}. GitHub's current version is kept only in a local backup branch on this computer.`
		: "This replaces your local learning data with GitHub's version and restarts LearnHarness to load it. Your local version is kept in a backup branch.";
	const confirmed = await choose(ctx, "Confirm", [confirmText], [
		{ key: "yes", label: choice === "keep-local" ? "Overwrite GitHub" : "Overwrite local data", variant: "destructive" },
		{ key: "no", label: "Cancel", variant: "outline" },
	]);
	if (confirmed !== "yes") return;
	await present(ctx, await ctx.call<SyncResult>("resolve", { choice, remote: conflict.remote }), deps);
}

/** Continue setup when the GitHub repository already contains data. */
async function adoptRemote(ctx: PluginFrontendContext, url: string, result: Extract<InitResult, { status: "remote-has-data" }>, deps: Deps): Promise<boolean> {
	const choice = await choose(ctx, "GitHub already has data", [
		result.message,
		"Use GitHub's data: copy this folder to a backup next to it, then use GitHub's files. Files only on this computer stay and are uploaded on the next sync.",
		"Merge: commit this computer's data and rebase it onto GitHub's. If the same files differ you will be asked which side to keep.",
	], [
		{ key: "use-remote", label: "Use GitHub's data", variant: "destructive" },
		{ key: "merge", label: "Merge", variant: "default" },
		{ key: "cancel", label: "Cancel", variant: "outline" },
	]);
	if (choice !== "use-remote" && choice !== "merge") return false;
	if (choice === "use-remote") {
		const confirmed = await choose(ctx, "Confirm", [
			"Files that also exist on GitHub will be replaced by GitHub's version. A full copy of the current folder is made first.",
		], [
			{ key: "yes", label: "Use GitHub's data", variant: "destructive" },
			{ key: "no", label: "Cancel", variant: "outline" },
		]);
		if (confirmed !== "yes") return false;
	}
	await present(ctx, await ctx.call<InitResult>("initialize-from-remote", { url, choice, branch: result.branch }), deps);
	return true;
}

function describe(status: PluginStatus): string[] {
	if (!status.repository) return [`Learning-data folder: ${status.directory}`, "Not set up yet. Enter an empty or existing GitHub repository URL and initialize."];
	const lines = [`Learning-data folder: ${status.directory}`, `Branch: ${status.branch ?? "(detached)"}`, `Remote: ${status.remote ?? "(no origin)"}`];
	if (status.ahead !== undefined) lines.push(`Ahead/behind GitHub (as of last fetch): ${status.ahead} / ${status.behind}`);
	lines.push(`Uncommitted changes: ${status.changes ?? 0}`);
	if (status.lastCommit) lines.push(`Last commit: ${status.lastCommit}`);
	if (status.conflict) lines.push(`Sync conflict waiting since ${new Date(status.conflict.at).toLocaleString()}. Automatic sync is paused until you resolve it with “GitHub: Sync conflict”.`);
	if (status.lastAuto) lines.push(`Last automatic sync (${new Date(status.lastAuto.at).toLocaleString()}): ${status.lastAuto.message}`);
	if (status.automaticAvailable === false) lines.push("Automatic sync needs a newer LearnHarness; use the sidebar actions.");
	return lines;
}

export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, deps: Deps): () => void {
	let url = "";
	let renderScope: AbortController | undefined;
	const root = el("div", "github-sync-settings");
	container.append(root);

	async function render(): Promise<void> {
		renderScope?.abort();
		const scope = new AbortController();
		renderScope = scope;
		const scoped = AbortSignal.any([signal, scope.signal]);
		let status: PluginStatus | undefined, error: string | undefined;
		try { status = await ctx.call<PluginStatus>("status"); }
		catch (e) { error = e instanceof Error ? e.message : String(e); }
		if (scoped.aborted) return;
		root.replaceChildren();
		root.append(el("h3", "github-sync-title", "Repository"));
		for (const line of error ? [error] : describe(status!)) root.append(el("p", "github-sync-text", line));
		if (status?.repository && status.automaticAvailable) {
			const rows = el("div");
			root.append(rows);
			let enabled = status.autoSync !== false;
			const autoRow = (): PluginSettingsRow => ({
				key: "auto-sync", type: "toggle", label: "Automatic sync",
				description: "Pull when LearnHarness starts, push after a lesson or extraction ends, and sync when you quit. This setting is for this computer only.",
				value: enabled,
				onChange: async (value: boolean) => {
					enabled = value;
					auto.update({ rows: [autoRow()] });
					await ctx.call("set-auto", { enabled: value });
				},
			});
			const auto = ctx.ui.mountSettingsRows(rows, { rows: [autoRow()] }, { signal: scoped });
		}
		const buttons = el("div", "github-sync-buttons");
		if (status && !status.repository) {
			const rows = el("div");
			root.append(rows);
			const remoteRow = (): PluginSettingsRow => ({
				key: "remote", type: "text", label: "GitHub repository URL",
				description: "SSH or HTTPS URL. Authentication uses your system git (SSH keys or credential helper).",
				value: url,
				onChange: (value: string) => { url = value; handle.update({ rows: [remoteRow()] }); },
			});
			const handle = ctx.ui.mountSettingsRows(rows, { rows: [remoteRow()] }, { signal: scoped });
			const slot = el("div");
			buttons.append(slot);
			ctx.ui.mountButton(slot, {
				label: "Initialize",
				onClick: async () => {
					const target = url.trim();
					const result = await ctx.call<InitResult>("initialize", { url: target });
					if (result.status === "remote-has-data") await adoptRemote(ctx, target, result, deps);
					else await present(ctx, result, deps);
					await render();
				},
			}, { signal: scoped });
		}
		const refresh = el("div");
		buttons.append(refresh);
		ctx.ui.mountButton(refresh, { label: "Refresh", variant: "outline", onClick: () => render() }, { signal: scoped });
		root.append(buttons);
	}
	void render();
	return () => { renderScope?.abort(); root.remove(); };
}

export function activate(ctx: PluginFrontendContext, deps: Deps = { reload: () => window.location.reload() }): void {
	// Sync now turns into "Sync conflict" while a conflict waits (automatic
	// sync found it, or a dialog was closed); it then opens the conflict dialog.
	let conflict: PluginStatus["conflict"] = null;
	let unregisterSync: (() => void) | undefined;
	function registerSync(): void {
		unregisterSync?.();
		const pending = conflict;
		const offAction = ctx.registerAction({
			id: "sync", name: pending ? "GitHub: Sync conflict" : "GitHub: Sync now", icon: pending ? ICONS.conflict : ICONS.sync,
			run: async () => {
				if (pending) return resolveConflict(ctx, { status: "conflict", changed: false, ...pending }, deps);
				return present(ctx, await ctx.call<Outcome>("sync"), deps);
			},
		});
		const offPlacement = ctx.placeAction({ id: "sync-sidebar", actionId: "sync", location: "sidebar" });
		unregisterSync = () => { offPlacement(); offAction(); };
	}
	async function refresh(): Promise<void> {
		let next: PluginStatus["conflict"] = null;
		try { next = (await ctx.call<PluginStatus>("status")).conflict ?? null; }
		catch { return; }
		if (ctx.signal.aborted || (next?.remote ?? null) === (conflict?.remote ?? null)) return;
		conflict = next;
		registerSync();
	}
	registerSync();
	for (const operation of [
		{ id: "pull", name: "GitHub: Pull", icon: ICONS.pull },
		{ id: "push", name: "GitHub: Push", icon: ICONS.push },
	] as const) {
		ctx.registerAction({
			id: operation.id, name: operation.name, icon: operation.icon,
			run: async () => present(ctx, await ctx.call<Outcome>(operation.id), deps),
		});
		ctx.placeAction({ id: `${operation.id}-sidebar`, actionId: operation.id, location: "sidebar" });
	}
	ctx.registerSettings((container, signal) => mountSettings(ctx, container, signal, deps));
	ctx.onNotification?.(event => { if (event.topic === "state") void refresh(); });
	ctx.onResync?.(() => { void refresh(); });
	void refresh();
}
