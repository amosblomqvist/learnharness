"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LegacySubscriptionProviderId, LegacySubscriptionStatus } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

type Provider = Extract<LegacySubscriptionProviderId, "subscription-anthropic">;
type Account = LegacySubscriptionStatus["accounts"][number];

export const CLAUDE_POLICY_NOTICE = "Anthropic does not permit third-party Claude.ai login. If you continue anyway, LearnHarness stores your Claude account details and credentials in an unencrypted private file on this device, and relevant conversation context, learning material, and tool results are sent directly to Anthropic. Claude plan limits apply.";
const META: Record<Provider, { name: string; short: string; company: string; notice: string; usage: string; privacy: string; usageUrl: string }> = {
	"subscription-anthropic": {
		name: "Claude", short: "claude", company: "Anthropic",
		notice: CLAUDE_POLICY_NOTICE,
		usage: "Background work counts toward your Claude plan usage.",
		privacy: "https://www.anthropic.com/legal/privacy", usageUrl: "https://claude.ai/settings/usage",
	},
};
const PROVIDERS = Object.keys(META) as Provider[];
export const REVOCATION_WARNING = "Account disconnected locally. Remote revocation could not be confirmed.";
export const NATIVE_DISCONNECT_COPY = { title: "Disconnect account?", body: "This removes the saved account and its credentials from this device." };
const UNAVAILABLE_HINT = "Sign-in is available only in the desktop app. API-key connections remain available here.";
/** Fixed UI text for known main-process messages; unknown text is never rendered. */
function friendlyError(message: string | null | undefined, name: string, fallback: string): string {
	const m = message ?? "";
	if (/credentials could not be read or saved/i.test(m)) return `${name} credentials could not be read or saved. Check local file access, then restart LearnHarness before reconnecting.`;
	if (/could not open your browser/i.test(m)) return `${name} sign-in could not open your browser. Check your default browser, then try again.`;
	if (/timed out/i.test(m)) return "Sign-in timed out. Start sign-in again.";
	if (/not trusted/i.test(m)) return `${name} sign-in returned a link that was not trusted, so it was not opened. Try again.`;
	if (/already pending/i.test(m)) return `A ${name} sign-in is already pending.`;
	if (/no longer saved/i.test(m)) return `That ${name} account is no longer saved.`;
	if (/session could not be refreshed|is disconnected/i.test(m)) return `The ${name} session needs to be reconnected.`;
	return fallback;
}
const empty: LegacySubscriptionStatus = { available: false, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null };

type Dialog = { kind: "connect"; reconnect?: string } | { kind: "manage"; accountId: string; account: Account; confirm?: boolean } | { kind: "warning" };
type Attempt = { gen: number; dialog: Dialog; background: boolean; dirty: boolean; reconnect?: string; pending: boolean; phase: "starting" | "pending" | "consent"; accountId?: string };

function isStatus(value: unknown): value is LegacySubscriptionStatus {
	if (!value || typeof value !== "object") return false;
	const s = value as LegacySubscriptionStatus;
	return typeof s.available === "boolean" && typeof s.pending === "boolean" && typeof s.allowBackgroundUse === "boolean" && (s.activeId === null || typeof s.activeId === "string") &&
		(s.error === null || typeof s.error === "string") && (s.catalogError == null || typeof s.catalogError === "string") && Array.isArray(s.accounts) &&
		s.accounts.every((a) => a && typeof a.id === "string" && typeof a.label === "string" && typeof a.connected === "boolean");
}
const accountLabel = (a: Account | undefined, name: string) => a?.label || `${name} account`;

interface Ctl {
	provider: Provider;
	status: LegacySubscriptionStatus;
	busy: boolean;
	bridgePresent: boolean;
	inlineError: string | null;
	warning: string | null;
	connect: () => void;
	manage: (id: string) => void;
	select: (id: string) => void;
	dismissWarning: () => void;
}
const idle = (provider: Provider): Ctl => ({ provider, status: empty, busy: false, bridgePresent: false, inlineError: null, warning: null, connect() {}, manage() {}, select() {}, dismissWarning() {} });
const Context = createContext<Record<Provider, Ctl>>({ "subscription-anthropic": idle("subscription-anthropic") });

function useController(provider: Provider): { ctl: Ctl; dialogNode: React.ReactNode } {
	const meta = META[provider];
	const generic = `The ${meta.name} connection could not be changed. Try again.`;
	const [status, setStatus] = useState(empty);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const [background, setBackground] = useState(true);
	const [dirty, setDirty] = useState(false);
	const [reconnect, setReconnect] = useState("");
	const op = useRef<"login" | "cancel" | "change" | "disconnect" | null>(null);
	const gen = useRef(0);
	const seq = useRef(0);
	const mounted = useRef(false);
	const dialogRef = useRef<Dialog | null>(null);
	const statusRef = useRef(status);
	const attemptRef = useRef<Attempt | null>(null);
	const receive = useRef<(v: unknown) => void>(() => {});
	const bridge = () => (typeof window !== "undefined" ? window.lh?.legacySubscriptions : undefined);

	function show(next: Dialog | null) { dialogRef.current = next; setDialog(next); }
	function publish(value: unknown): LegacySubscriptionStatus | null {
		if (!isStatus(value)) { setError(generic); return null; }
		seq.current++; statusRef.current = value; setStatus(value);
		return value;
	}
	const owns = (a: Attempt) => mounted.current && attemptRef.current === a && gen.current === a.gen;
	function finish(a: Attempt) { if (owns(a)) { attemptRef.current = null; op.current = null; setBusy(false); } }
	function failure(next: LegacySubscriptionStatus) { return next.error ? friendlyError(next.error, meta.name, "Sign-in could not be completed. Try again.") : generic; }
	async function complete(a: Attempt, next: LegacySubscriptionStatus) {
		const account = next.accounts.find((x) => x.id === next.activeId && x.connected);
		if (next.error || !next.available || !account || (a.reconnect && account.id !== a.reconnect)) { finish(a); setError(failure(next)); return; }
		a.phase = "consent"; a.accountId = account.id;
		try {
			if (a.dirty && next.allowBackgroundUse !== a.background) {
				op.current = "change";
				const request = ++seq.current;
				const result: unknown = await bridge()!.consent(provider, a.background);
				if (!owns(a)) return;
				let saved: LegacySubscriptionStatus | null;
				if (request !== seq.current) {
					const refresh = ++seq.current;
					const value: unknown = await bridge()!.status(provider);
					if (!owns(a)) return;
					saved = refresh === seq.current ? publish(value) : statusRef.current;
				} else saved = publish(result);
				if (!saved) { finish(a); return; }
				next = saved;
			}
			if (!owns(a)) return;
			const ok = next.accounts.some((x) => x.id === account.id && x.connected) && !next.error && !next.pending && next.available && (!a.dirty || next.allowBackgroundUse === a.background);
			if (!ok) setError(friendlyError(next.error, meta.name, "Background use could not be saved. Try again."));
			else if (dialogRef.current === a.dialog) show(null);
		} catch { if (owns(a)) setError("Background use could not be saved. Try again."); }
		finally { finish(a); }
	}
	function reconcile(next: LegacySubscriptionStatus, reply = false) {
		const a = attemptRef.current;
		if (!a || !owns(a)) return;
		if (a.phase === "consent") {
			if (next.pending || next.error || !next.available || next.activeId !== a.accountId) { finish(a); setError(failure(next)); }
			return;
		}
		if (next.pending) { a.pending = true; a.phase = "pending"; return; }
		if (a.pending || reply) void complete(a, next);
	}
	receive.current = (v) => { const next = publish(v); if (next) reconcile(next); };

	useEffect(() => {
		mounted.current = true;
		const b = window.lh?.legacySubscriptions;
		const refresh = async () => {
			const request = ++seq.current;
			try {
				const next: unknown = await b?.status(provider);
				if (next && mounted.current && request === seq.current) receive.current(next);
			} catch { if (mounted.current && request === seq.current) setError("The desktop connection is unavailable. Retry when the app is ready."); }
		};
		void refresh();
		const off = b?.onChange(() => void refresh());
		return () => { mounted.current = false; gen.current++; attemptRef.current = null; off?.(); };
	// Intentionally mount-only: the bridge subscription and the provider are fixed for this controller's lifetime.
	}, []);

	const managed = dialog?.kind === "manage" ? status.accounts.find((a) => a.id === dialog.accountId) ?? dialog.account : undefined;
	const managedPresent = !!managed && status.accounts.some((a) => a.id === managed.id);
	const statusMessage = status.error ? (status.error === REVOCATION_WARNING ? REVOCATION_WARNING : friendlyError(status.error, meta.name, generic)) : status.catalogError ? "The model list could not be refreshed." : null;
	const visible = error || (dismissed ? null : statusMessage);
	const warning = visible === REVOCATION_WARNING ? visible : null;

	function openConnect(reconnectId = "") {
		if (op.current) return;
		setBackground(statusRef.current.allowBackgroundUse); setDirty(false); setReconnect(reconnectId); setError(null); setDismissed(true);
		show({ kind: "connect", reconnect: reconnectId || undefined });
	}
	function close() {
		if (op.current === "disconnect" || op.current === "change" || op.current === "cancel") return;
		const current = dialogRef.current;
		if (current?.kind === "manage" && current.confirm) { show({ ...current, confirm: false }); setError(null); return; }
		const cancel = attemptRef.current !== null || statusRef.current.pending;
		const intent = ++gen.current;
		const owner = dialogRef.current;
		attemptRef.current = null;
		setError(null); setDismissed(true);
		if (!cancel) { show(null); return; }
		op.current = "cancel"; setBusy(true);
		const request = ++seq.current;
		const b = bridge();
		void Promise.resolve(b?.cancel(provider)).then(async (value: unknown) => {
			if (!mounted.current || gen.current !== intent) return;
			let next: LegacySubscriptionStatus | null;
			if (request !== seq.current) {
				const refresh = ++seq.current;
				const current: unknown = await b!.status(provider);
				if (!mounted.current || gen.current !== intent) return;
				next = refresh === seq.current ? publish(current) : statusRef.current;
			} else next = publish(value);
			if (next && !next.pending) { if (dialogRef.current === owner) show(null); }
			else if (next) setError(generic);
		}).catch(() => { if (mounted.current && gen.current === intent) setError(generic); }).finally(() => {
			if (mounted.current && gen.current === intent) { op.current = null; setBusy(false); }
		});
	}
	async function control(kind: "change" | "disconnect", action: () => Promise<unknown>, verify: (s: LegacySubscriptionStatus) => boolean, message = generic) {
		if (op.current) return;
		const intent = ++gen.current;
		const request = ++seq.current;
		const owner = dialogRef.current;
		op.current = kind; setBusy(true); setError(null);
		try {
			const value: unknown = await action();
			if (!mounted.current || intent !== gen.current) return;
			if (!isStatus(value)) { setError(message); return; }
			let next: LegacySubscriptionStatus | null;
			if (request !== seq.current) {
				const refresh = ++seq.current;
				const current: unknown = await bridge()!.status(provider);
				if (!mounted.current || intent !== gen.current) return;
				next = refresh === seq.current ? publish(current) : statusRef.current;
			} else next = publish(value);
			if (!next) return;
			const revoked = kind === "disconnect" && [value.error, next.error].includes(REVOCATION_WARNING);
			if (verify(next)) {
				if (kind === "disconnect" && dialogRef.current === owner) show(revoked ? { kind: "warning" } : null);
				if (kind === "disconnect") setDismissed(!revoked);
			} else setError(message);
		} catch { if (mounted.current && intent === gen.current) setError(message); }
		finally { if (intent === gen.current) { op.current = null; if (mounted.current) setBusy(false); } }
	}
	async function login() {
		const b = bridge();
		const owner = dialogRef.current;
		if (!b || op.current || !status.available || status.pending || owner?.kind !== "connect") return;
		const a: Attempt = { gen: ++gen.current, dialog: owner, background, dirty, reconnect: reconnect || undefined, pending: false, phase: "starting" };
		attemptRef.current = a; op.current = "login";
		const request = ++seq.current;
		setBusy(true); setError(null); setDismissed(true);
		try {
			let value: unknown = await b.login(provider, reconnect || undefined, background);
			if (!owns(a) || a.phase === "consent") return;
			if (request !== seq.current && isStatus(value)) {
				if (value.error) { setError(failure(value)); finish(a); return; }
				a.pending = true; a.phase = "pending";
				const refresh = ++seq.current;
				value = await b.status(provider);
				if (!owns(a) || attemptRef.current?.phase === "consent" || refresh !== seq.current) return;
			}
			const next = publish(value);
			if (!next) { finish(a); return; }
			reconcile(next, true);
		} catch { if (owns(a)) { setError(generic); finish(a); } }
		// Pending browser sign-in outlives this call; status events or cancel release it.
	}

	const b = bridge();
	const ctl: Ctl = {
		provider, status, busy, bridgePresent: !!b,
		inlineError: dialog || warning ? null : visible, warning: dialog?.kind === "warning" ? null : warning,
		connect: () => openConnect(),
		manage: (id) => { const account = statusRef.current.accounts.find((a) => a.id === id); if (!op.current && account) { setError(null); show({ kind: "manage", accountId: id, account }); } },
		select: (id) => { if (b) void control("change", () => b.select(provider, id), (s) => s.activeId === id && !s.error); },
		dismissWarning: () => { setDismissed(true); setError(null); },
	};
	const key = meta.short;
	const dialogError = warning ? null : visible;
	const dialogNode = dialog && <AccountDialog key={`${provider}-${dialog.kind}`} name={meta.name} testid={`native-${key}`} onClose={close} busy={busy && op.current !== "login"}>
		{dialog.kind === "warning" ? <>
			<p role="alert" className="rounded-sm border border-border px-3 py-2 text-xs text-foreground" data-testid={`native-${key}-revocation-warning`}>{REVOCATION_WARNING}</p>
			<div className="mt-4 flex justify-end"><Button variant="outline" size="sm" onClick={() => { ctl.dismissWarning(); show(null); }}>Dismiss</Button></div>
		</> : dialog.kind === "manage" && dialog.confirm ? <div data-testid={`native-${key}-disconnect-confirmation`}>
			<h2 className="text-sm font-semibold text-red-400">{NATIVE_DISCONNECT_COPY.title}</h2>
			<p className="mt-3 text-xs text-foreground">{accountLabel(managed, meta.name)}</p>
			<p className="mt-3 text-xs text-muted-foreground">{NATIVE_DISCONNECT_COPY.body} {meta.company} may not be notified, so the sign-in could remain active on their side.</p>
			{dialogError && <p role="alert" className="mt-3 text-xs text-red-400">{dialogError}</p>}
			<div className="mt-4 flex items-center justify-end gap-2">
				<Button variant="ghost" size="sm" disabled={busy} onClick={close}>Cancel</Button>
				<Button variant="destructive" size="sm" data-testid={`native-${key}-confirm-disconnect`} disabled={busy || !managedPresent} onClick={() => b && managed && void control("disconnect", () => b.disconnect(provider, managed.id), (s) => !s.accounts.some((a) => a.id === managed.id))}>Disconnect account</Button>
			</div>
		</div> : <>
			{dialog.kind === "connect" ? <>
				<h2 className="text-sm font-semibold text-foreground">Continue with {meta.name}</h2>
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid={`native-${key}-privacy-notice`}>{meta.notice}</p>
			</> : managed && <>
				<div data-testid={`native-${key}-managed-identity`} className="flex items-center gap-2 text-xs text-foreground">
					{status.accounts.length > 1 && managedPresent && !busy ? <select aria-label={`Manage ${meta.name} account`} value={managed.id} onChange={(e) => ctl.manage(e.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5">
						{status.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, meta.name)}</option>)}
					</select> : <span>{accountLabel(managed, meta.name)}</span>}
				</div>
				<div className="mt-2 flex items-center gap-1">
					<Button variant="ghost" size="xs" data-testid={`native-${key}-reconnect`} disabled={busy || status.pending || !status.available || !managedPresent} onClick={() => openConnect(managed.id)}>Reconnect</Button>
					<Button variant="ghost" size="xs" className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-300" data-testid={`native-${key}-disconnect`} disabled={busy || status.pending || !managedPresent} onClick={() => show({ ...dialog, confirm: true })}>Disconnect account</Button>
				</div>
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid={`native-${key}-privacy-notice`}>{meta.notice}</p>
			</>}
			<div className="mt-4 flex items-center gap-3 text-xs text-foreground" data-testid={`native-${key}-global-background`}>
				<Toggle label={`Allow background use for all ${meta.name} accounts`} checked={dialog.kind === "connect" ? background : status.allowBackgroundUse} disabled={busy || status.pending || !status.available} onChange={(enabled) => {
					if (dialog.kind === "connect") { setBackground(enabled); setDirty(true); }
					else if (b) void control("change", () => b.consent(provider, enabled), (s) => s.allowBackgroundUse === enabled && !s.error, "Background use could not be saved. Try again.");
				}} />
				<span>Allow background use for all {meta.name} accounts<span className="mt-1 block leading-relaxed text-muted-foreground">{meta.usage}</span></span>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				<a href={meta.privacy} target="_blank" rel="noreferrer" className="underline underline-offset-2">{meta.company} privacy</a>
				<a href={meta.usageUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Manage usage</a>
			</div>
			{!status.available && <p className="mt-3 text-xs text-muted-foreground">{UNAVAILABLE_HINT}</p>}
			{status.pending && <p role="status" className="mt-3 text-xs text-muted-foreground">Waiting for browser sign-in…</p>}
			{dialogError && <p role="alert" className="mt-3 text-xs text-red-400">{dialogError}</p>}
			<div className="mt-4 flex items-center justify-end gap-2" data-testid={`native-${key}-account-footer`}>
				{dialog.kind === "manage" && <Button variant="outline" size="sm" data-testid={`native-${key}-add-account`} onClick={() => openConnect()} disabled={busy || status.pending || !status.available}>Add account</Button>}
				<Button variant="ghost" size="sm" onClick={close} disabled={busy && op.current !== "login"}>{dialog.kind === "connect" ? "Cancel" : "Close"}</Button>
				{dialog.kind === "connect" && <ContinueButton name={meta.name} testid={`native-${key}-proceed`} onClick={() => void login()} disabled={!status.available || busy || status.pending} />}
			</div>
		</>}
	</AccountDialog>;
	return { ctl, dialogNode };
}

/** Shared lifetime for Claude and Grok, spanning setup's keys → models transition. Account IDs stay control values. */
export function LegacySubscriptionsUIProvider({ children }: { children: React.ReactNode }) {
	const claude = useController("subscription-anthropic");
	return <Context.Provider value={{ "subscription-anthropic": claude.ctl }}>
		{children}{claude.dialogNode}
	</Context.Provider>;
}

function ContinueButton({ name, onClick, disabled, testid }: { name: string; onClick: () => void; disabled: boolean; testid: string }) {
	return <Button type="button" variant="outline" size="sm" data-testid={testid} onClick={onClick} disabled={disabled} className="cursor-pointer disabled:cursor-not-allowed">Continue with {name}</Button>;
}

function AccountDialog({ children, onClose, busy, name, testid }: { children: React.ReactNode; onClose: () => void; busy: boolean; name: string; testid: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const backdropDismiss = useBackdropDismiss(onClose);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])') ?? [])];
		focusable()[0]?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
			else if (event.key === "Tab") {
				const items = focusable(), first = items[0], last = items.at(-1);
				if (!first) { event.preventDefault(); return; }
				if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80" data-testid={`${testid}-dialog-backdrop`} {...backdropDismiss}>
		<div ref={ref} role="dialog" aria-modal="true" aria-label={`${name} account`} aria-busy={busy} data-testid={`${testid}-account-dialog`} onClick={(e) => e.stopPropagation()} className="settings-dialog-pop mx-4 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl">{children}</div>
	</div>, document.body);
}

/** Compact settings row, or setup's secondary action only. */
export function LegacySubscriptionConnection({ provider = "subscription-anthropic", setup = false }: { provider?: Provider; setup?: boolean }) {
	const ui = useContext(Context)[provider];
	const meta = META[provider];
	const accounts = ui.status.accounts.filter((a) => a.connected);
	const active = accounts.find((a) => a.id === ui.status.activeId);
	const disabled = !ui.status.available || ui.busy || ui.status.pending;
	return <div className="flex flex-col gap-2" data-testid={`native-${meta.short}-connection`}>
		<div className="flex flex-wrap items-center gap-3">
			{!setup && active && <span className="font-ui text-xs text-foreground">{meta.name}</span>}
			{active && !setup ? <>
				{accounts.length > 1 ? <select aria-label={`${meta.name} account`} value={active.id} disabled={ui.busy || ui.status.pending} onChange={(e) => ui.select(e.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground">
					{accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, meta.name)}</option>)}
				</select> : <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid={`native-${meta.short}-account`}>{accountLabel(active, meta.name)}</span>}
				<Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={() => ui.manage(active.id)}>Manage…</Button>
			</> : <>
				{accounts.length > 0 && <select aria-label={`${meta.name} account`} value="" disabled={ui.busy || ui.status.pending} onChange={(e) => e.target.value && ui.select(e.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground">
					<option value="">Choose a {meta.name} account</option>
					{accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, meta.name)}</option>)}
				</select>}
				<ContinueButton name={meta.name} testid={`native-${meta.short}-login`} onClick={ui.connect} disabled={disabled} />
			</>}
			{!ui.status.available && !ui.busy && <span className="text-xs text-muted-foreground" data-testid={`native-${meta.short}-hint`}>{ui.bridgePresent ? "Sign-in is unavailable right now." : "Use the desktop app to continue."}</span>}
		</div>
		{ui.inlineError && <p role="alert" className="text-xs text-red-400">{ui.inlineError}</p>}
		{ui.warning && <div role="alert" data-testid={`native-${meta.short}-revocation-warning`} className="rounded-sm border border-border px-3 py-2 text-xs text-muted-foreground">{ui.warning}<button type="button" className="ml-2 cursor-pointer underline underline-offset-2" onClick={ui.dismissWarning}>Dismiss</button></div>}
	</div>;
}

/** Contextual consent discovery beside background model choices only; maps logical provider ids. */
export function LegacySubscriptionBackgroundAccess({ provider }: { provider?: string }) {
	const all = useContext(Context);
	const id = PROVIDERS.find((p) => p === provider);
	const ui = id ? all[id] : undefined;
	const account = ui?.status.accounts.find((a) => a.id === ui.status.activeId && a.connected);
	if (!ui || !account || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={ui.busy} onClick={() => ui.manage(account.id)}>Enable background use</Button>;
}
