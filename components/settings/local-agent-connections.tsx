"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { LOCAL_AGENTS, localAgentDescriptor, type LocalAgentAction, type LocalAgentDescriptor, type LocalAgentProviderId, type LocalAgentStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";

/**
 * Local agent connections (docs/architecture.md §8.2): Claude through the
 * learner's own Claude Code, Antigravity through Google's official ACP
 * server. The runtimes keep their own sign-in; this surface shows what
 * they report and holds the two app-side choices (use it here, background
 * use). Status comes from GET /api/connections/local and works in the web
 * build too — nothing here rides the desktop credential bridge.
 */

export function localAgentNotice(agent: LocalAgentDescriptor): string {
	return `LearnHarness runs the ${agent.runtime} installed on this computer. Your prompts, tool results, and relevant session context are sent to ${agent.vendor} through it, and your ${agent.vendor} plan's limits and terms apply. LearnHarness never sees or stores your ${agent.vendor} sign-in; it stays in ${agent.runtime}. This connection never falls back to an API key.`;
}
export const LOCAL_AGENT_BACKGROUND_HINT = "Allow LearnHarness helper agents and automatic follow-ups to use this connection.";
const CONTROL_ERROR = "The connection could not be changed. Try again.";
const POLL_MS = 2_000;

export function emptyLocalAgentStatus(providerId: LocalAgentProviderId): LocalAgentStatus {
	return { providerId, enabled: false, allowBackgroundUse: true, installed: false, signedIn: false, pending: false, connected: false, generation: 0, checkedAt: 0 };
}

async function readStatuses(refresh = false): Promise<LocalAgentStatus[]> {
	const response = await fetch(`/api/connections/local${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
	if (!response.ok) throw new Error(`status ${response.status}`);
	const { statuses } = (await response.json()) as { statuses?: unknown };
	if (!Array.isArray(statuses)) throw new Error("malformed status");
	return statuses as LocalAgentStatus[];
}
async function postAction(providerId: LocalAgentProviderId, action: LocalAgentAction): Promise<LocalAgentStatus[]> {
	const response = await fetch(`/api/connections/local/${providerId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
	const body = await response.json().catch(() => ({})) as { statuses?: LocalAgentStatus[]; error?: string };
	if (!response.ok || !body.statuses) throw new Error(body.error ?? CONTROL_ERROR);
	return body.statuses;
}

const Context = createContext({ statuses: [] as LocalAgentStatus[], busy: false, open: (_providerId: LocalAgentProviderId) => {} });

export function LocalAgentUIProvider({ children }: { children: React.ReactNode }) {
	const [statuses, setStatuses] = useState<LocalAgentStatus[]>([]);
	const [dialog, setDialog] = useState<LocalAgentProviderId | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
	const mounted = useRef(false), sequence = useRef(0), connected = useRef<string>("");
	const descriptor = localAgentDescriptor(dialog ?? undefined);
	const status = statuses.find((s) => s.providerId === dialog) ?? (dialog ? emptyLocalAgentStatus(dialog) : undefined);
	function accept(next: LocalAgentStatus[]) {
		if (!mounted.current) return;
		setStatuses(next);
		// The model catalog follows connection changes.
		const signature = next.map((s) => `${s.providerId}:${s.connected}:${s.generation}`).join(",");
		if (connected.current && connected.current !== signature) notifySettingsSaved("keys");
		connected.current = signature;
	}
	async function refresh(force = false) {
		const request = ++sequence.current;
		try { const next = await readStatuses(force); if (request === sequence.current) accept(next); }
		catch { if (mounted.current && request === sequence.current && dialog) setError("Connection status is unavailable. Retry when the app is ready."); }
	}
	useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
	// Poll while a dialog is open or a sign-in runs (the runtime finishes it on its own).
	const pending = statuses.some((s) => s.pending);
	useEffect(() => {
		if (!dialog && !pending) return;
		const timer = setInterval(() => { void refresh(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [dialog, pending]);
	async function control(action: LocalAgentAction) {
		if (!dialog || busy) return;
		setBusy(true); setError(null);
		try { accept(await postAction(dialog, action)); }
		catch (err) { if (mounted.current) setError(err instanceof Error && err.message ? err.message : CONTROL_ERROR); }
		finally { if (mounted.current) setBusy(false); }
	}
	function open(providerId: LocalAgentProviderId) { if (busy) return; setError(null); setDialog(providerId); void refresh(true); }
	function close() { if (busy) return; setDialog(null); setError(null); }
	return <Context.Provider value={{ statuses, busy, open }}>
		{children}
		{dialog && descriptor && status && <ConnectionDialog label={`${descriptor.label} connection`} testid="local-agent-dialog" backdropTestid="local-agent-dialog-backdrop" busy={busy} onClose={close}>
			<h2 className="text-sm font-semibold text-foreground">{descriptor.label} <span className="font-normal text-muted-foreground">· via {descriptor.runtime}</span></h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="local-agent-notice">{localAgentNotice(descriptor)}</p>
			<div className="mt-4 space-y-2 text-xs" data-testid="local-agent-status">
				{!status.installed ? <p>{descriptor.runtime} was not found on this computer. <a className="underline" href={descriptor.installUrl} target="_blank" rel="noreferrer">Install it</a>, then Refresh.</p> : <>
					<p className="text-muted-foreground">{descriptor.runtime}{status.version ? ` ${status.version}` : ""} found.</p>
					{status.signedIn
						? <p data-testid="local-agent-account">Signed in{status.account ? <> as <span className="select-text">{status.account}</span></> : ""}{status.plan ? ` · ${status.plan} plan` : ""}.</p>
						: status.pending ? <p role="status">Finish signing in with Google in your browser…</p>
						: descriptor.signInCommand ? <p>Not signed in. Run <code className="select-text font-mono">{descriptor.signInCommand}</code> in a terminal, then Refresh.</p>
						: <p>Not signed in.</p>}
					{status.signedIn && status.usesSubscription === false && <p className="text-amber-400" data-testid="local-agent-billing-warning">{descriptor.runtime} is signed in without a {descriptor.vendor} subscription, so usage is billed to that account.</p>}
				</>}
			</div>
			{status.installed && <div className="mt-4 space-y-3 text-xs text-foreground">
				<div className="flex items-center gap-3">
					<Toggle label={`Use ${descriptor.label} in LearnHarness`} checked={status.enabled} disabled={busy} onChange={(enabled) => void control({ action: "enable", enabled })} />
					<span>Use in LearnHarness</span>
				</div>
				<div className="flex items-center gap-3">
					<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy || !status.enabled} onChange={(allowBackgroundUse) => void control({ action: "consent", allowBackgroundUse })} />
					<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{LOCAL_AGENT_BACKGROUND_HINT}</span></span>
				</div>
			</div>}
			{(error || status.error) && <p role="alert" className="mt-3 text-xs text-red-400">{error || status.error}</p>}
			<ConnectionFooter testid="local-agent-footer" leading={<Button variant="ghost" size="sm" disabled={busy || status.pending} onClick={() => void control({ action: "refresh" })}>Refresh</Button>}>
				{status.installed && !status.signedIn && !descriptor.signInCommand && (status.pending
					? <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ action: "cancelSignIn" })}>Cancel sign-in</Button>
					: <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ action: "signIn" })}>Sign in with Google</Button>)}
				<Button variant="ghost" size="sm" disabled={busy} onClick={close}>Close</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</Context.Provider>;
}

function rowAction(status: LocalAgentStatus): string { return status.enabled ? "Manage…" : "Connect"; }

export function LocalAgentConnection({ providerId }: { providerId: LocalAgentProviderId }) {
	const ui = useContext(Context), descriptor = localAgentDescriptor(providerId)!;
	const status = ui.statuses.find((s) => s.providerId === providerId) ?? emptyLocalAgentStatus(providerId);
	const state = status.connected ? (status.plan ? `${status.plan} plan` : "Connected") : status.enabled ? (!status.installed ? "Not installed" : !status.signedIn ? "Not signed in" : "Unavailable") : undefined;
	return <div className="flex flex-col gap-2" data-testid={`${providerId}-connection`}>
		<ConnectionRow label={`${descriptor.label} (${descriptor.runtime})`} action={rowAction(status)} disabled={ui.busy} onAction={() => ui.open(providerId)}>
			{state && <span className="font-ui text-[11px] text-muted-foreground" data-testid={`${providerId}-state`}>{state}</span>}
		</ConnectionRow>
	</div>;
}

export function LocalAgentConnections() {
	return <div className="space-y-3" data-testid="local-agent-connections">{LOCAL_AGENTS.map((agent) => <LocalAgentConnection key={agent.providerId} providerId={agent.providerId} />)}</div>;
}

export function LocalAgentBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context), descriptor = localAgentDescriptor(provider);
	const status = ui.statuses.find((s) => s.providerId === descriptor?.providerId);
	if (!descriptor || !status?.connected || status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={() => ui.open(descriptor.providerId)}>Enable background use</Button>;
}
