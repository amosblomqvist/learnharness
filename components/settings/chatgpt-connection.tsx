"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChatGPTStatus } from "@/src/core";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";
import { connectionErrorText, useChatGPTBridge } from "./subscription-client";
import { tr } from "@/src/core";
import type { CloseOutcome } from "@/components/interaction-layers";

export const CHATGPT_NOTICE = tr("LearnHarness 会将你的 ChatGPT 账号信息和凭据以未加密形式保存在此设备上的本地文件中。使用此连接时，相关的对话上下文、学习资料和工具结果会直接发送给 OpenAI。ChatGPT 套餐的使用限制同样适用；任何额外额度都在 ChatGPT 中授权和管理，而不是在 LearnHarness 中。", "LearnHarness stores your ChatGPT account details and credentials in an unencrypted local file on this device. When this connection is used, relevant conversation context, learning material, and tool results are sent directly to OpenAI. ChatGPT plan limits apply; any additional credits are authorized and managed in ChatGPT, not LearnHarness.");
export function chatGPTNotice(web = false): string { return web ? tr(`${CHATGPT_NOTICE.replace("此设备上", "运行 LearnHarness 的机器上")}请在同一台机器上的浏览器中完成 ChatGPT 登录。`, `${CHATGPT_NOTICE.replace("on this device", "on the machine running LearnHarness")} Complete ChatGPT sign-in in a browser on that same machine.`) : CHATGPT_NOTICE; }
export const CHATGPT_BACKGROUND_HINT = tr("后台任务会计入你的 ChatGPT 套餐用量。", "Background work counts toward your ChatGPT plan usage.");
const BACKGROUND_LABEL = tr("允许所有 ChatGPT 账号在后台使用", "Allow background use for all ChatGPT accounts");
// Protocol text: must stay byte-identical to electron/chatgpt.cjs (compared below).
const REVOCATION_WARNING = "Account disconnected locally. Remote revocation could not be confirmed.";
const REVOCATION_WARNING_TEXT = "已在本地断开账号连接，但无法确认远程撤销是否成功。";
export const CHATGPT_DISCONNECT_COPY = { title: tr("断开账号连接？", "Disconnect account?"), body: tr("这会从此设备上移除已保存的账号及其凭据。", "This removes the saved account and its credentials from this device.") };
const empty: ChatGPTStatus = { available: false, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
type Account = ChatGPTStatus["accounts"][number];
type Dialog = { kind: "connect" } | { kind: "manage"; accountId: string; account: Account; confirm?: boolean } | { kind: "warning" };
type LoginAttempt = { generation: number; dialog: Dialog; registration: string; background: boolean; backgroundDirty: boolean; pending: boolean; accountId?: string; phase: "starting" | "pending" | "consent" };
const CONTROL_ERROR = tr("无法更改 ChatGPT 连接，请重试。", "The ChatGPT connection could not be changed. Try again.");
function isStatus(value: unknown): value is ChatGPTStatus {
	if (!value || typeof value !== "object") return false;
	const s = value as ChatGPTStatus;
	return typeof s.available === "boolean" && typeof s.pending === "boolean" && typeof s.allowBackgroundUse === "boolean" && (s.activeId === null || typeof s.activeId === "string") &&
		(s.error === null || typeof s.error === "string") && (s.catalogError == null || typeof s.catalogError === "string") && Array.isArray(s.accounts) &&
		s.accounts.every((a) => a && typeof a.id === "string" && typeof a.email === "string" && typeof a.registration === "string" && typeof a.connected === "boolean" && (a.planEnabled === undefined || typeof a.planEnabled === "boolean") && (a.canSignInAgain === undefined || typeof a.canSignInAgain === "boolean"));
}
function replyError(value: unknown): string {
	return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : CONTROL_ERROR;
}
const Context = createContext({
	status: empty,
	busy: false,
	error: null as string | null,
	inlineError: null as string | null,
	warning: null as string | null,
	connect: () => {},
	manage: (_id: string) => {},
	select: (_id: string) => {},
	dismissWarning: () => {},
});

/** UI lifetime spans setup's keys → models transition. Only existing safe controls
 * are used; account IDs remain control values, never displayed account labels. */
export function ChatGPTUIProvider({ children }: { children: React.ReactNode }) {
	const bridge = useChatGPTBridge();
	const web = typeof window !== "undefined" && bridge !== window.lh?.chatgpt;
	const [status, setStatus] = useState<ChatGPTStatus>(empty);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissedError, setDismissedError] = useState<string | null>(null);
	const [background, setBackground] = useState(true);
	const [backgroundDirty, setBackgroundDirty] = useState(false);
	const [registration, setRegistration] = useState("");
	const operation = useRef<"login" | "cancel" | "change" | "disconnect" | null>(null);
	const generation = useRef(0);
	const statusSequence = useRef(0);
	const mounted = useRef(false);
	const dialogRef = useRef<Dialog | null>(null);
	const statusRef = useRef(status);
	const loginAttempt = useRef<LoginAttempt | null>(null);
	const receive = useRef<(value: unknown) => void>(() => {});
	function showDialog(next: Dialog | null) { dialogRef.current = next; setDialog(next); }
	function publishStatus(value: unknown): ChatGPTStatus | null {
		if (!isStatus(value)) { setError(replyError(value)); return null; }
		statusSequence.current++; statusRef.current = value; setStatus(value);
		return value;
	}
	function owns(attempt: LoginAttempt) { return mounted.current && loginAttempt.current === attempt && generation.current === attempt.generation; }
	function finish(attempt: LoginAttempt) {
		if (!owns(attempt)) return;
		loginAttempt.current = null; operation.current = null; setBusy(false);
	}
	async function complete(attempt: LoginAttempt, next: ChatGPTStatus) {
		const account = next.accounts.find((a) => a.id === next.activeId && a.connected);
		if (next.error || !next.available || !account || (attempt.registration && account.id !== attempt.registration)) {
			finish(attempt); setError(next.error || CONTROL_ERROR); return;
		}
		attempt.phase = "consent"; attempt.accountId = account.id;
		let replyFailure: string | null = null;
		try {
			if (attempt.backgroundDirty && next.allowBackgroundUse !== attempt.background) {
				operation.current = "change";
				const request = ++statusSequence.current;
				const result: unknown = await bridge!.consent(attempt.background);
				if (!owns(attempt)) return;
				if (!isStatus(result)) { setError(replyError(result)); finish(attempt); return; }
				replyFailure = result.error;
				let saved: ChatGPTStatus | null;
				if (request !== statusSequence.current) {
					const refresh = ++statusSequence.current;
					const value: unknown = await bridge!.status();
					if (!owns(attempt)) return;
					saved = refresh === statusSequence.current ? publishStatus(value) : statusRef.current;
				} else saved = publishStatus(result);
				if (!saved) { finish(attempt); return; }
				next = saved;
			}
			if (!owns(attempt)) return;
			const current = next.accounts.find((a) => a.id === account.id && a.id === next.activeId && a.connected);
			if (replyFailure || next.error || next.pending || !next.available || !current || (attempt.backgroundDirty && next.allowBackgroundUse !== attempt.background)) setError(replyFailure || next.error || CONTROL_ERROR);
			else if (dialogRef.current === attempt.dialog) showDialog(null);
		} catch { if (owns(attempt)) setError(CONTROL_ERROR); }
		finally { finish(attempt); }
	}
	function reconcile(next: ChatGPTStatus, loginReply = false) {
		const attempt = loginAttempt.current;
		if (!attempt || !owns(attempt)) return;
		if (attempt.phase === "consent") {
			if (next.pending || next.error || !next.available || next.activeId !== attempt.accountId || !next.accounts.some((a) => a.id === attempt.accountId && a.connected)) {
				finish(attempt); setError(next.error || CONTROL_ERROR);
			}
			return;
		}
		if (next.pending) { attempt.pending = true; attempt.phase = "pending"; return; }
		// login() normally acknowledges pending immediately; verified completion is
		// a later status notification. The acknowledgement itself is not success.
		if (attempt.pending || loginReply) void complete(attempt, next);
	}
	receive.current = (value) => {
		const next = publishStatus(value);
		if (next) reconcile(next);
	};
	useEffect(() => {
		mounted.current = true;
		const refresh = async () => {
			const request = ++statusSequence.current;
			try {
				const next: unknown = await bridge?.status();
				if (next && mounted.current && request === statusSequence.current) receive.current(next);
			} catch { if (mounted.current && request === statusSequence.current) setError(tr("桌面端连接不可用，请在应用就绪后重试。", "The desktop connection is unavailable. Retry when the app is ready.")); }
		};
		void refresh();
		const off = bridge?.onChange(() => void refresh());
		return () => { mounted.current = false; generation.current++; loginAttempt.current = null; off?.(); };
	}, [bridge]);

	const managed = dialog?.kind === "manage" ? status.accounts.find((a) => a.id === dialog.accountId) ?? dialog.account : undefined;
	const managedPresent = !!managed && status.accounts.some((a) => a.id === managed.id);
	const visibleError = error || (status.error !== dismissedError ? status.error : null) || status.catalogError || null;
	const warning = visibleError === REVOCATION_WARNING ? visibleError : null;
	function openConnect(accountId = "") {
		if (operation.current) return;
		setBackground(statusRef.current.allowBackgroundUse);
		setBackgroundDirty(false);
		setRegistration(accountId);
		setError(null);
		setDismissedError(status.error);
		showDialog({ kind: "connect" });
	}
	function close(): CloseOutcome {
		if (operation.current === "disconnect" || operation.current === "change" || operation.current === "cancel") return "blocked";
		const current = dialogRef.current;
		if (current?.kind === "manage" && current.confirm) { showDialog({ ...current, confirm: false }); setError(null); return "handled-without-close"; }
		const cancel = loginAttempt.current !== null || statusRef.current.pending;
		const intent = ++generation.current;
		const owner = dialogRef.current;
		loginAttempt.current = null;
		if (!cancel) showDialog(null);
		setError(null);
		setDismissedError(status.error);
		if (cancel) {
			// Keep cancellation serialized even after login's pending IPC reply.
			operation.current = "cancel"; setBusy(true);
			const request = ++statusSequence.current;
			void bridge?.cancel().then(async (value: unknown) => {
				if (!mounted.current || generation.current !== intent) return;
				if (!isStatus(value)) { setError(replyError(value)); return; }
				let next: ChatGPTStatus | null;
				if (request !== statusSequence.current) {
					const refresh = ++statusSequence.current;
					const current: unknown = await bridge!.status();
					if (!mounted.current || generation.current !== intent) return;
					next = refresh === statusSequence.current ? publishStatus(current) : statusRef.current;
				} else next = publishStatus(value);
				if (next && !next.pending) {
					setDismissedError(value.error); // Dismiss only this cancellation's error, not a newer failure.
					if (dialogRef.current === owner) showDialog(null);
				} else if (next) setError(CONTROL_ERROR);
			}).catch(() => { if (mounted.current && generation.current === intent) setError(CONTROL_ERROR); }).finally(() => {
				if (mounted.current && generation.current === intent) { operation.current = null; setBusy(false); }
			});
			return "pending";
		}
		return "closed";
	}
	async function control(kind: "change" | "disconnect", action: () => Promise<ChatGPTStatus>, target?: string) {
		if (operation.current) return;
		const intent = ++generation.current;
		const request = ++statusSequence.current;
		const owner = dialogRef.current;
		operation.current = kind;
		setBusy(true); setError(null);
		if (kind === "disconnect") setDismissedError(null);
		try {
			const value: unknown = await action();
			if (!mounted.current || intent !== generation.current) return;
			if (!isStatus(value)) { setError(replyError(value)); return; }
			let next: ChatGPTStatus | null;
			if (request !== statusSequence.current) {
				const refresh = ++statusSequence.current;
				const current: unknown = await bridge!.status();
				if (!mounted.current || intent !== generation.current) return;
				next = refresh === statusSequence.current ? publishStatus(current) : statusRef.current;
			} else next = publishStatus(value);
			if (!next) return;
			// Dismissed status warnings belong to an earlier action. Only a new
			// disconnect outcome (or an explicit IPC error envelope above) reopens one.
			const failure = [value.error, next.error].find((message) => message && (kind === "disconnect" || message !== dismissedError)) ?? null;
			if (kind === "disconnect" && !next.accounts.some((a) => a.id === target)) {
				if (dialogRef.current === owner) {
					if (failure === REVOCATION_WARNING) showDialog({ kind: "warning" });
					else if (!failure) showDialog(null);
				}
				setError(failure);
			} else setError(failure || (kind === "disconnect" ? CONTROL_ERROR : null));
		} catch { if (mounted.current && intent === generation.current) setError(CONTROL_ERROR); }
		finally { if (intent === generation.current) { operation.current = null; if (mounted.current) setBusy(false); } }
	}
	async function login() {
		const owner = dialogRef.current;
		if (!bridge || operation.current || !status.available || status.pending || owner?.kind !== "connect") return;
		const attempt: LoginAttempt = { generation: ++generation.current, dialog: owner, registration, background, backgroundDirty, pending: false, phase: "starting" };
		loginAttempt.current = attempt; operation.current = "login";
		const request = ++statusSequence.current;
		setBusy(true); setError(null); setDismissedError(null);
		try {
			let value: unknown = await bridge.login(registration || undefined);
			if (!owns(attempt) || attempt.phase === "consent") return;
			// Never publish an old acknowledgement over a newer event. If events
			// coalesced past pending before the acknowledgement arrived, read the
			// current backend state after it rather than losing that completion.
			if (request !== statusSequence.current && isStatus(value)) {
				if (value.error) { setError(value.error); finish(attempt); return; }
				attempt.pending = true; attempt.phase = "pending";
				const refresh = ++statusSequence.current;
				value = await bridge.status();
				if (!owns(attempt) || loginAttempt.current?.phase === "consent" || refresh !== statusSequence.current) return;
			}
			const next = publishStatus(value);
			if (!next) { finish(attempt); return; }
			reconcile(next, true);
		} catch { if (owns(attempt)) { setError(CONTROL_ERROR); finish(attempt); } }
		// No finally: pending OAuth outlives this IPC promise. Only its status
		// completion, failure, or explicit cancellation releases the attempt.
	}
	const context = {
		status, busy, error: warning ? null : tr(connectionErrorText(visibleError), visibleError), inlineError: dialog || warning ? null : tr(connectionErrorText(visibleError), visibleError), warning: dialog?.kind === "warning" ? null : warning,
		connect: openConnect,
		manage: (id: string) => {
			const account = statusRef.current.accounts.find((a) => a.id === id);
			if (!operation.current && account) { setError(null); showDialog({ kind: "manage", accountId: id, account }); }
		},
		select: (id: string) => { if (bridge) void control("change", () => bridge.select(id)); },
		dismissWarning: () => { setDismissedError(REVOCATION_WARNING); setError(null); },
	};
	return <Context.Provider value={context}>
		{children}
		{dialog && <AccountDialog key={`${dialog.kind}:${dialog.kind === "manage" && !!dialog.confirm}`} onClose={close} busy={busy && operation.current !== "login"}>
			<h2 className="text-sm font-semibold text-foreground">ChatGPT</h2>
			{dialog.kind === "warning" ? <>
				<p role="alert" className="rounded-sm border border-border px-3 py-2 text-xs text-foreground" data-testid="chatgpt-revocation-warning">{tr(REVOCATION_WARNING_TEXT, REVOCATION_WARNING)}</p>
				<div className="mt-4 flex justify-end"><Button variant="outline" size="sm" onClick={() => { context.dismissWarning(); showDialog(null); }}>{tr("忽略", "Dismiss")}</Button></div>
			</> : dialog.kind === "manage" && dialog.confirm ? <div data-testid="chatgpt-disconnect-confirmation">
				<p className="mt-3 text-sm font-semibold text-error">{CHATGPT_DISCONNECT_COPY.title}</p>
				<p className="mt-3 text-xs text-foreground">{managed?.email || tr("ChatGPT 账号", "ChatGPT account")}</p>
				<p className="mt-3 text-xs text-muted-foreground">{web ? tr(CHATGPT_DISCONNECT_COPY.body.replace("从此设备上", "从运行 LearnHarness 的机器上"), CHATGPT_DISCONNECT_COPY.body.replace("from this device", "from the machine running LearnHarness")) : CHATGPT_DISCONNECT_COPY.body}</p>
				{context.error && <p role="alert" className="mt-3 text-xs text-error">{context.error}</p>}
				<div className="mt-4 flex items-center justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={close}>{tr("取消", "Cancel")}</Button>
					<Button variant="destructive" size="sm" data-testid="chatgpt-confirm-disconnect" disabled={busy || !managedPresent} onClick={() => bridge && managed && void control("disconnect", () => bridge.disconnect(managed.id), managed.id)}>{tr("断开账号连接", "Disconnect account")}</Button>
				</div>
			</div> : <>
				{dialog.kind === "connect" ? <>
					{status.accounts.length > 0 && <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
						<select aria-label={tr("已保存的 ChatGPT 账号", "Saved ChatGPT account")} value={registration} onChange={(event) => setRegistration(event.target.value)} disabled={busy || status.pending} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5 text-foreground">
							<option value="">{tr("添加其他账号或工作区", "Add another account or workspace")}</option>
							{status.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || tr("ChatGPT 账号", "ChatGPT account")}</option>)}
						</select>
						{registration && <Button variant="ghost" size="xs" disabled={busy} onClick={() => context.manage(registration)}>{tr("管理…", "Manage…")}</Button>}
					</div>}
					<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="chatgpt-privacy-notice">{chatGPTNotice(web)}</p>
				</> : null}
				<div className={`mt-4 flex items-center gap-3 text-xs text-foreground ${busy && operation.current === "change" && status.available && !status.pending ? "[&>button:disabled]:cursor-auto" : ""}`} data-testid="chatgpt-global-background">
					<Toggle label={BACKGROUND_LABEL} testid="toggle-allow-background-use-for-all-chatgpt-accounts" checked={dialog.kind === "connect" ? background : status.allowBackgroundUse} disabled={busy || status.pending || !status.available} onChange={(enabled) => {
						if (dialog.kind === "connect") { setBackground(enabled); setBackgroundDirty(true); }
						else if (bridge) void control("change", () => bridge.consent(enabled));
					}} />
					<span>{BACKGROUND_LABEL}<span className="mt-1 block leading-relaxed text-muted-foreground">{CHATGPT_BACKGROUND_HINT}</span></span>
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
					<a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer" className="underline underline-offset-2">{tr("OpenAI 隐私政策", "OpenAI privacy")}</a>
					<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">{tr("管理用量", "Manage usage")}</a>
				</div>
				{!status.available && <p className="mt-3 text-xs text-muted-foreground">{tr("ChatGPT 登录仅在桌面应用中可用。此处仍可使用 API 密钥连接。", "ChatGPT sign-in is available only in the desktop app. API-key connections remain available here.")}</p>}
				{status.pending && <p role="status" className="mt-3 text-xs text-muted-foreground">{tr("正在等待浏览器登录…", "Waiting for browser sign-in…")}</p>}
				{context.error && <p role="alert" className="mt-3 text-xs text-error">{context.error}</p>}
				{dialog.kind === "manage" && managed && <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="chatgpt-account-strip">
					<div data-testid="chatgpt-managed-identity" className="flex min-w-0 items-center gap-2 text-xs text-foreground">
						{status.accounts.length > 1 && managedPresent && !busy ? <select aria-label={tr("管理 ChatGPT 账号", "Manage ChatGPT account")} value={managed.id} onChange={(event) => context.manage(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5">
							{status.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || tr("ChatGPT 账号", "ChatGPT account")}</option>)}
						</select> : <span className="break-all">{managed.email || tr("ChatGPT 账号", "ChatGPT account")}</span>}
					</div>
					<Button variant="ghost" size="sm" data-testid="chatgpt-add-accounts" className="cursor-pointer text-muted-foreground disabled:cursor-not-allowed" onClick={() => openConnect()} disabled={busy || status.pending || !status.available}>{tr("添加账号", "Add accounts")}</Button>
				</div>}
				<ConnectionFooter testid="chatgpt-account-footer" leading={dialog.kind === "manage" && <div data-testid="chatgpt-account-actions">
					<Button variant="ghost" size="sm" className="cursor-pointer text-error hover:bg-error/10 hover:text-error" data-testid="chatgpt-disconnect" disabled={busy || status.pending || !managedPresent} onClick={() => showDialog({ ...dialog, confirm: true })}>{tr("断开连接", "Disconnect")}</Button>
				</div>}>
					{dialog.kind === "manage" && managedPresent && managed && !managed.connected && managed.canSignInAgain === true && status.available && <Button variant="outline" size="sm" disabled={busy || status.pending || !status.available} onClick={() => openConnect(managed.id)}>{tr("重新登录", "Sign in again")}</Button>}
					<Button variant={dialog.kind === "manage" ? "outline" : "ghost"} size="sm" onClick={close} disabled={busy && operation.current !== "login"}>{dialog.kind === "connect" ? tr("取消", "Cancel") : tr("关闭", "Close")}</Button>
					{dialog.kind === "connect" && <ContinueButton onClick={() => void login()} disabled={!status.available || busy || status.pending} testid="chatgpt-proceed" />}
				</ConnectionFooter>
			</>}
		</AccountDialog>}
	</Context.Provider>;
}

function ContinueButton({ onClick, disabled, testid = "chatgpt-login" }: { onClick: () => void; disabled: boolean; testid?: string }) {
	return <Button type="button" variant="outline" size="sm" data-testid={testid} onClick={onClick} disabled={disabled} className="cursor-pointer disabled:cursor-not-allowed">
		{/* Official unmodified mark; existing secondary button hover/focus treatment. */}
		{/* eslint-disable-next-line @next/next/no-img-element */}
		<img src="/siwc/chatgpt-logo-white.svg" width="16" height="16" alt="" aria-hidden="true" />
		{tr("使用 ChatGPT 继续", "Continue with ChatGPT")}
	</Button>;
}

function AccountDialog({ children, onClose, busy }: { children: React.ReactNode; onClose: () => CloseOutcome; busy: boolean }) {
	return <ConnectionDialog label={tr("ChatGPT 账号", "ChatGPT account")} testid="chatgpt-account-dialog" backdropTestid="chatgpt-dialog-backdrop" onClose={onClose} busy={busy}>{children}</ConnectionDialog>;
}

/** Shared compact settings/setup row; account selection precedes the quiet action. */
export function ChatGPTConnection({ labelClassName }: { setup?: boolean; labelClassName?: string } = {}) {
	const ui = useContext(Context);
	const active = ui.status.accounts.find((a) => a.id === ui.status.activeId && a.connected);
	const accounts = ui.status.accounts.filter((a) => a.connected);
	return <div className="flex flex-col gap-2" data-testid="chatgpt-connection">
		<ConnectionRow label="ChatGPT" labelClassName={labelClassName} actionTestid={active ? undefined : "chatgpt-login"} action={active ? tr("管理…", "Manage…") : tr("连接", "Connect")} actionVariant={active ? "ghost" : "outline"} disabled={!ui.status.available || ui.busy || ui.status.pending} onAction={() => active ? ui.manage(active.id) : ui.connect()}>
			{active && <select aria-label={tr("ChatGPT 账号", "ChatGPT account")} value={active.id} disabled={ui.busy || ui.status.pending} onChange={(event) => ui.select(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground">
				{accounts.map((a) => <option key={a.id} value={a.id}>{a.email || tr("ChatGPT 账号", "ChatGPT account")}</option>)}
			</select>}
		</ConnectionRow>
		{ui.inlineError && <p role="alert" className="text-xs text-error">{ui.inlineError}</p>}
		{ui.warning && <div role="alert" data-testid="chatgpt-revocation-warning" className="rounded-sm border border-border px-3 py-2 text-xs text-muted-foreground">{tr(REVOCATION_WARNING_TEXT, ui.warning)}<button type="button" className="ml-2 cursor-pointer underline underline-offset-2" onClick={ui.dismissWarning}>{tr("忽略", "Dismiss")}</button></div>}
	</div>;
}

/** Contextual consent discovery belongs beside background model choices only. */
export function ChatGPTBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	const account: Account | undefined = ui.status.accounts.find((a) => a.id === ui.status.activeId && a.connected);
	if (provider !== "chatgpt" || !account || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={ui.busy} onClick={() => ui.manage(account.id)}>{tr("启用后台使用", "Enable background use")}</Button>;
}
