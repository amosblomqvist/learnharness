"use client";
/**
 * The Local Claude card (Settings → Providers → Subscriptions; owner-approved
 * copy, 2026-10-27): the user's OWN Claude Code install runs lesson turns.
 * There is NO sign-in control here by design — Claude Code keeps its own
 * login; the card only shows what the server's probe found, the opt-in,
 * the background consent, the system-prompt mode and an optional path.
 * Preferences write through PUT /api/settings/claudeLocal (replace-whole,
 * the house settings discipline); status and re-check come from
 * GET/POST /api/claude-local. The same component serves the packaged
 * desktop app and web/dev — the Next server owns the route in both.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CLAUDE_LOCAL, type ClaudeLocalStatus, type ClaudeLocalSystemPromptMode } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useNotifyHub } from "@/components/server-events";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { CommitInput, ThinSelect, Toggle } from "./controls";

export const CLAUDE_LOCAL_DISCLOSURE = "Runs lesson turns through the Claude Code you installed and signed in to yourself. LearnHarness only starts your own claude program and reads its replies; it never sees, stores or sends your Claude login. Usage counts against your Claude plan. Anthropic's published terms do not allow third-party apps, including ones built on the Claude Agent SDK, to use claude.ai logins or plan limits; they do allow you to sign in to your own unmodified Claude Code. This route runs only that. Anthropic may restrict it without notice. This route never falls back to an API key.";
export const CLAUDE_LOCAL_BACKGROUND_HINT = "Allow automatic follow-ups (a finished research or demo job waking the lesson) to use your Claude plan.";
export const CLAUDE_LOCAL_PROMPT_HINT: Record<ClaudeLocalSystemPromptMode, string> = {
	custom: "LearnHarness's own teaching instructions (default).",
	preset: "Claude Code's own instructions with LearnHarness's appended — a larger prompt every turn.",
};
const SHARED_SERVER_NOTE = "Everyone using this server shares its Claude Code login and this background setting.";
const PATH = "/api/claude-local";
const headers = { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" };

export function emptyClaudeLocalStatus(): ClaudeLocalStatus {
	return { providerId: CLAUDE_LOCAL.providerId, enabled: false, allowBackgroundUse: true, systemPromptMode: "custom", state: "disabled", binary: null, account: null, models: 0, probedAt: null, revision: 0 };
}

/** The state line (one sentence; the error carries the detail). */
export function claudeLocalStateLine(status: ClaudeLocalStatus): string {
	const version = status.binary?.version ? `Claude Code ${status.binary.version}` : "Claude Code";
	switch (status.state) {
		case "disabled": return status.binary ? `${version} found; not in use.` : "Not in use.";
		case "ready": {
			const plan = status.account?.subscriptionType ? ` (${status.account.subscriptionType})` : "";
			return `${version} found, signed in with a Claude plan${plan}. ${status.models} model${status.models === 1 ? "" : "s"} available.`;
		}
		case "not-found": return "Claude Code not found.";
		case "unsupported-version": return `${version} is older than the required ${CLAUDE_LOCAL.minVersion}.`;
		case "not-signed-in": return `${version} found, not signed in.`;
		case "api-key": return `${version} is signed in with an API key or Console account; this route only runs on a Claude plan login.`;
		case "third-party": return `${version} is configured for a cloud provider; this route only runs on a Claude plan login.`;
		case "unavailable": return `${version} could not be started.`;
	}
}
export function claudeLocalUsageLine(status: ClaudeLocalStatus): string | null {
	const usage = status.usage;
	if (!usage) return null;
	const parts: string[] = [];
	if (usage.utilization !== undefined) parts.push(`${Math.round(usage.utilization * 100)}% of the ${usage.rateLimitType?.replace(/_/g, " ") ?? "current"} window used`);
	if (usage.resetsAt) parts.push(`resets ${new Date(usage.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
	if (usage.isUsingOverage) parts.push("the last turn drew on extra usage, not your plan");
	if (usage.status === "rejected") parts.push("the last request was refused by the plan limit");
	return parts.length ? `Plan usage: ${parts.join("; ")}.` : null;
}

async function fetchStatus(): Promise<ClaudeLocalStatus> {
	const response = await fetch(PATH, { headers, cache: "no-store" });
	if (!response.ok) throw new Error("Local Claude status is unavailable.");
	return response.json() as Promise<ClaudeLocalStatus>;
}
async function probe(): Promise<ClaudeLocalStatus> {
	const response = await fetch(PATH, { method: "POST", headers, body: JSON.stringify({ op: "probe" }) });
	if (!response.ok) throw new Error("Local Claude could not be re-checked.");
	return response.json() as Promise<ClaudeLocalStatus>;
}
async function putSettings(settings: { enabled: boolean; allowBackgroundUse: boolean; systemPromptMode: ClaudeLocalSystemPromptMode; binaryPath: string }): Promise<void> {
	const response = await fetch("/api/settings/claudeLocal", { method: "PUT", headers, body: JSON.stringify(settings) });
	if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "The setting could not be saved.");
}

/** The dialog body — pure over its props (tests render every state). */
export function ClaudeLocalDialogBody({ status, busy, error, onChange, onProbe, web }: {
	status: ClaudeLocalStatus;
	busy: boolean;
	error: string | null;
	onChange: (next: { enabled?: boolean; allowBackgroundUse?: boolean; systemPromptMode?: ClaudeLocalSystemPromptMode; binaryPath?: string }) => void;
	onProbe: () => void;
	web: boolean;
}) {
	const usage = claudeLocalUsageLine(status);
	return <>
		<h2 className="text-sm font-semibold text-foreground">{CLAUDE_LOCAL.title}</h2>
		<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="claude-local-disclosure">{CLAUDE_LOCAL_DISCLOSURE}{web ? ` ${SHARED_SERVER_NOTE}` : ""}</p>
		<div className="mt-4 flex items-center gap-3 text-xs text-foreground">
			<Toggle label="Use my local Claude Code" checked={status.enabled} disabled={busy} onChange={(enabled) => onChange({ enabled })} />
			<span>Use my local Claude Code<span className="mt-1 block leading-relaxed text-muted-foreground">Offers its models for the conversation. Helper agents keep using your other providers.</span></span>
		</div>
		<p className="mt-3 text-xs text-foreground" role="status" data-testid="claude-local-state">{claudeLocalStateLine(status)}</p>
		{status.binary && <p className="mt-1 font-mono text-[11px] text-muted-foreground" data-testid="claude-local-path">{status.binary.path}</p>}
		{status.error && status.state !== "ready" && <p role="alert" className="mt-2 text-xs text-red-400" data-testid="claude-local-error">{status.error}</p>}
		{usage && <p className="mt-2 text-xs text-muted-foreground" data-testid="claude-local-usage">{usage}</p>}
		<div className="mt-4 flex items-center gap-3 text-xs text-foreground">
			<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy || !status.enabled} onChange={(allowBackgroundUse) => onChange({ allowBackgroundUse })} />
			<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{CLAUDE_LOCAL_BACKGROUND_HINT}</span></span>
		</div>
		<div className="mt-4 flex flex-col gap-1 text-xs text-foreground">
			<label className="flex items-center gap-3" htmlFor="claude-local-prompt-mode">
				<span>System prompt</span>
				<ThinSelect value={status.systemPromptMode} ariaLabel="System prompt mode" testid="claude-local-prompt-mode" disabled={busy || !status.enabled} onChange={(value) => onChange({ systemPromptMode: value as ClaudeLocalSystemPromptMode })}>
					<option value="custom">LearnHarness only</option>
					<option value="preset">Claude Code's own + LearnHarness</option>
				</ThinSelect>
			</label>
			<span className="leading-relaxed text-muted-foreground">{CLAUDE_LOCAL_PROMPT_HINT[status.systemPromptMode]}</span>
		</div>
		<div className="mt-4 flex flex-col gap-1 text-xs text-foreground">
			<label className="flex items-center gap-3" htmlFor="claude-local-binary-path">
				<span className="shrink-0">Claude Code path</span>
				<span className="flex-1"><CommitInput value={status.binary?.source === "override" ? status.binary.path : ""} placeholder="detected automatically" ariaLabel="Claude Code path" testid="claude-local-binary-path" onCommit={(binaryPath) => onChange({ binaryPath })} /></span>
			</label>
			<span className="leading-relaxed text-muted-foreground">Optional. Set it when Claude Code is installed somewhere LearnHarness does not look (PATH, ~/.local/bin, Homebrew, npm global).</span>
		</div>
		{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
		<ConnectionFooter testid="claude-local-footer" leading={<Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" disabled={busy} onClick={onProbe}>Re-check</Button>}>
			<span />
		</ConnectionFooter>
	</>;
}

/** The compact row + its dialog. `initialStatus` seeds tests and SSR. */
export function ClaudeLocalConnection({ initialStatus }: { initialStatus?: ClaudeLocalStatus } = {}) {
	const hub = useNotifyHub();
	const [status, setStatus] = useState<ClaudeLocalStatus>(initialStatus ?? emptyClaudeLocalStatus());
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(false);
	const sequence = useRef(0);
	const web = typeof window !== "undefined" && window.lh?.subscriptionTransport !== "desktop" && !window.lh?.subscriptions;
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const next = await fetchStatus();
			if (mounted.current && request === sequence.current) setStatus(next);
		} catch { /* the row keeps its last known state */ }
	}, []);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		const offEvent = hub?.subscribe("subscriptions-changed", () => { void refresh(); notifySettingsSaved("keys"); });
		const offResync = hub?.onResync(() => { void refresh(); });
		return () => { mounted.current = false; offEvent?.(); offResync?.(); };
	}, [hub, refresh]);
	async function run(action: () => Promise<ClaudeLocalStatus | void>) {
		if (busy) return;
		setBusy(true); setError(null);
		try { const next = await action(); if (mounted.current && next) setStatus(next); else await refresh(); notifySettingsSaved("keys"); }
		catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "The setting could not be saved."); }
		finally { if (mounted.current) setBusy(false); }
	}
	const change = (next: { enabled?: boolean; allowBackgroundUse?: boolean; systemPromptMode?: ClaudeLocalSystemPromptMode; binaryPath?: string }) => run(async () => {
		const savedPath = status.binary?.source === "override" ? status.binary.path : "";
		const settings = {
			enabled: next.enabled ?? status.enabled,
			allowBackgroundUse: next.allowBackgroundUse ?? status.allowBackgroundUse,
			systemPromptMode: next.systemPromptMode ?? status.systemPromptMode,
			binaryPath: next.binaryPath ?? savedPath,
		};
		await putSettings(settings);
		// A probe boots Claude Code twice; only the opt-in or the path can change
		// what it finds. Other preferences apply on save — `run` re-reads status.
		if (settings.enabled !== status.enabled || settings.binaryPath !== savedPath) return probe();
	});
	return <div className="flex flex-col gap-2" data-testid="claude-local-connection">
		<ConnectionRow label={CLAUDE_LOCAL.title} action={status.enabled ? "Manage…" : "Set up…"} disabled={false} onAction={() => setOpen(true)}>
			{status.enabled && <span className="font-ui text-[11px] text-muted-foreground" data-testid="claude-local-row-state">{status.state === "ready" ? "ready" : status.state.replace(/-/g, " ")}</span>}
		</ConnectionRow>
		{status.enabled && status.state !== "ready" && status.error && <p role="alert" className="text-xs text-red-400">{status.error}</p>}
		{open && <ConnectionDialog label={`${CLAUDE_LOCAL.title} settings`} testid="claude-local-dialog" backdropTestid="claude-local-backdrop" busy={busy} onClose={() => { if (!busy) setOpen(false); }}>
			<ClaudeLocalDialogBody status={status} busy={busy} error={error} web={web} onChange={(next) => void change(next)} onProbe={() => void run(probe)} />
			<div className="mt-2 flex justify-end"><Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>Close</Button></div>
		</ConnectionDialog>}
	</div>;
}
