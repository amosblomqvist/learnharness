"use client";
/**
 * The Connections section: the app-owned Codex subscription login.
 *
 * Credentials stay on the server. The browser only starts a login, polls
 * its sanitized view, answers prompts (the answer field clears the moment
 * it is submitted) and opens provider URLs in the user's own browser tab
 * (target _blank, noopener, noreferrer). Nothing here calls out or logs in
 * on its own, and nothing selects a provider or a model by default.
 *
 * API: GET/DELETE /api/connections/subscriptions, POST/GET/DELETE
 * /api/connections/login[/id].
 * Every mutation is JSON with the X-LearnHarness-Connections header.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	SUBSCRIPTION_PROVIDERS,
	type LoginAttemptView,
	type LoginPromptView,
	type SubscriptionStatus,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

const MUTATION_HEADERS = { "Content-Type": "application/json", "X-LearnHarness-Connections": "1" };
const GENERIC_ERROR = "Something went wrong. Try again.";

/** Pure: only http(s) URLs may become links. */
export function safeExternalUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
	} catch {
		return null;
	}
}

/** Pure: the one-line state of a subscription row. A read that has not
 *  landed is "unknown", never "not connected". */
export function subscriptionLine(status: SubscriptionStatus | undefined): string {
	if (!status) return "checking";
	return status.connected ? "connected" : "not connected";
}

/** Pure: ids of attempts still pending. */
export function pendingAttemptIds(attempts: Record<string, LoginAttemptView>): string[] {
	return Object.values(attempts)
		.filter((a) => a.state === "pending")
		.map((a) => a.id);
}

/** Best-effort server-side cancel for the unmount/close path. keepalive
 *  lets the request outlive the page; failures are ignored. */
export function cancelPendingLogins(
	attempts: Record<string, LoginAttemptView>,
	send: (url: string, init: RequestInit) => Promise<unknown> = (url, init) => fetch(url, init),
): string[] {
	const ids = pendingAttemptIds(attempts);
	for (const id of ids) {
		void Promise.resolve(
			send(`/api/connections/login/${encodeURIComponent(id)}`, { method: "DELETE", headers: MUTATION_HEADERS, keepalive: true }),
		).catch(() => {});
	}
	return ids;
}

async function mutate(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error: string | null }> {
	try {
		const res = await fetch(url, {
			method,
			headers: MUTATION_HEADERS,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const data = await res.json().catch(() => null);
		if (res.ok) return { ok: true, data, error: null };
		const msg = (data as { error?: unknown } | null)?.error;
		return { ok: false, data, error: typeof msg === "string" && msg.length > 0 && msg.length <= 200 ? msg : GENERIC_ERROR };
	} catch {
		return { ok: false, data: null, error: "Request failed. Check your connection and try again." };
	}
}

const inputClass =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:opacity-50";
const linkBtn =
	"shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const quietBtn = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

function ExternalLink({ href, children, testid }: { href: string; children: React.ReactNode; testid?: string }) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" data-testid={testid} className="text-xs text-foreground underline underline-offset-2">
			{children}
		</a>
	);
}

/** One login prompt. The answer is cleared as soon as it is submitted. */
export function LoginPromptForm({
	prompt,
	busy,
	onSubmit,
}: {
	prompt: LoginPromptView;
	busy: boolean;
	onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState("");
	function submit(v: string) {
		if (busy || !v.trim()) return;
		setValue("");
		onSubmit(v);
	}
	return (
		<form
			className="flex flex-col gap-1.5"
			data-testid="login-prompt"
			onSubmit={(e) => {
				e.preventDefault();
				submit(value);
			}}
		>
			<label className="text-xs text-muted-foreground" htmlFor={`prompt-${prompt.id}`}>
				{prompt.message}
			</label>
			<div className="flex items-center gap-2">
				{prompt.type === "select" ? (
					<select
						id={`prompt-${prompt.id}`}
						value={value}
						onChange={(e) => submit(e.target.value)}
						disabled={busy}
						className={inputClass}
					>
						<option value="">Choose…</option>
						{(prompt.options ?? []).map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</select>
				) : (
					<>
						<input
							id={`prompt-${prompt.id}`}
							type={prompt.type === "secret" ? "password" : "text"}
							autoComplete="off"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "Paste the code" : "")}
							disabled={busy}
							className={`${inputClass} flex-1 font-mono`}
						/>
						<button type="submit" disabled={busy || !value.trim()} className={linkBtn} data-testid="login-prompt-submit">
							Submit
						</button>
					</>
				)}
			</div>
		</form>
	);
}

/** The attempt panel: links, device code, prompt, error, cancel. */
export function LoginAttemptPanel({
	attempt,
	busy,
	onAnswer,
	onCancel,
}: {
	attempt: LoginAttemptView;
	busy: boolean;
	onAnswer: (promptId: string, value: string) => void;
	onCancel: () => void;
}) {
	const authUrl = attempt.events.map((e) => (e.type === "auth_url" ? safeExternalUrl(e.url) : null)).filter(Boolean).pop() ?? null;
	const device = attempt.events.filter((e) => e.type === "device_code").pop();
	const deviceUrl = safeExternalUrl(device?.verificationUri ?? device?.url);
	const messages = attempt.events.filter((e) => (e.type === "info" || e.type === "progress") && e.message).slice(-2);
	return (
		<div className="flex flex-col gap-1.5 rounded-sm border border-border/60 p-2" data-testid="login-attempt">
			{authUrl && (
				<ExternalLink href={authUrl} testid="login-auth-link">
					Open the sign-in page
				</ExternalLink>
			)}
			{device?.userCode && (
				<p className="text-xs text-muted-foreground">
					Enter code <span className="font-mono text-foreground" data-testid="login-user-code">{device.userCode}</span>
					{deviceUrl && (
						<>
							{" "}
							at{" "}
							<ExternalLink href={deviceUrl} testid="login-device-link">
								the verification page
							</ExternalLink>
						</>
					)}
				</p>
			)}
			{messages.map((m, i) => (
				<p key={i} className="text-xs text-muted-foreground">
					{m.message}
				</p>
			))}
			{attempt.state === "pending" && attempt.prompt && (
				<LoginPromptForm key={attempt.prompt.id} prompt={attempt.prompt} busy={busy} onSubmit={(v) => onAnswer(attempt.prompt!.id, v)} />
			)}
			{attempt.state === "pending" && !attempt.prompt && !authUrl && !device && (
				<p className="text-xs text-muted-foreground">Waiting for the provider…</p>
			)}
			{attempt.state === "failed" && (
				<p role="alert" data-testid="login-error" className="text-xs text-red-400">
					{attempt.error ?? "Sign-in failed."}
				</p>
			)}
			{attempt.state === "cancelled" && <p className="text-xs text-muted-foreground">Sign-in cancelled.</p>}
			{attempt.state === "pending" && (
				<div>
					<button type="button" onClick={onCancel} disabled={busy} className={quietBtn} data-testid="login-cancel">
						Cancel
					</button>
				</div>
			)}
		</div>
	);
}

function SubscriptionsGroup() {
	const [statuses, setStatuses] = useState<SubscriptionStatus[] | null>(null);
	const [readFailed, setReadFailed] = useState(false);
	const [attempts, setAttempts] = useState<Record<string, LoginAttemptView>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [errors, setErrors] = useState<Record<string, string | null>>({});
	// Request generation: a status read started before a disconnect or a
	// login finishing must never overwrite the newer truth.
	const generation = useRef(0);
	const alive = useRef(true);
	const attemptsRef = useRef(attempts);
	attemptsRef.current = attempts;

	// Dialog close / section switch: drop any pending server login so its
	// callback listener does not linger. No state is touched (unmounting).
	useEffect(() => () => void cancelPendingLogins(attemptsRef.current), []);

	const load = useCallback(async () => {
		const gen = ++generation.current;
		try {
			const res = await fetch("/api/connections/subscriptions");
			const body = (await res.json()) as { subscriptions?: SubscriptionStatus[] };
			if (!alive.current || gen !== generation.current) return;
			if (!res.ok || !Array.isArray(body.subscriptions)) throw new Error("bad read");
			setStatuses(body.subscriptions);
			setReadFailed(false);
		} catch {
			if (alive.current && gen === generation.current) setReadFailed(true);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);

	const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));
	const setErrorFor = (id: string, e: string | null) => setErrors((x) => ({ ...x, [id]: e }));

	const finish = useCallback(
		(providerId: string) => {
			setAttempts((a) => {
				const { [providerId]: _gone, ...rest } = a;
				return rest;
			});
			void load();
			notifySettingsSaved("keys");
			notifySettingsSaved("models");
		},
		[load],
	);

	const applyAttempt = useCallback(
		(providerId: string, attempt: LoginAttemptView) => {
			if (attempt.state === "connected") finish(providerId);
			else setAttempts((a) => ({ ...a, [providerId]: attempt }));
		},
		[finish],
	);

	// Poll pending attempts. One timer per pending attempt id.
	const pendingKey = Object.values(attempts)
		.filter((a) => a.state === "pending")
		.map((a) => `${a.providerId}:${a.id}`)
		.join("|");
	useEffect(() => {
		if (!pendingKey) return;
		const timer = setInterval(() => {
			for (const entry of pendingKey.split("|")) {
				const [providerId = "", id = ""] = entry.split(":");
				fetch(`/api/connections/login/${encodeURIComponent(id)}`)
					.then((r) => (r.ok ? (r.json() as Promise<LoginAttemptView>) : Promise.reject(new Error("poll"))))
					.then((view) => alive.current && applyAttempt(providerId, view))
					.catch(() => {});
			}
		}, 1500);
		return () => clearInterval(timer);
	}, [pendingKey, applyAttempt]);

	async function start(providerId: string) {
		setBusyFor(providerId, true);
		setErrorFor(providerId, null);
		const r = await mutate("POST", "/api/connections/login", { providerId });
		setBusyFor(providerId, false);
		if (!r.ok) return setErrorFor(providerId, r.error);
		applyAttempt(providerId, r.data as LoginAttemptView);
	}
	async function answer(attempt: LoginAttemptView, promptId: string, value: string) {
		setBusyFor(attempt.providerId, true);
		const r = await mutate("POST", `/api/connections/login/${encodeURIComponent(attempt.id)}`, { promptId, value });
		setBusyFor(attempt.providerId, false);
		if (!r.ok) return setErrorFor(attempt.providerId, r.error);
		applyAttempt(attempt.providerId, r.data as LoginAttemptView);
	}
	async function cancel(attempt: LoginAttemptView) {
		setBusyFor(attempt.providerId, true);
		await mutate("DELETE", `/api/connections/login/${encodeURIComponent(attempt.id)}`);
		setBusyFor(attempt.providerId, false);
		setAttempts((a) => {
			const { [attempt.providerId]: _gone, ...rest } = a;
			return rest;
		});
	}
	async function disconnect(providerId: string) {
		generation.current++; // invalidates any in-flight status read
		setBusyFor(providerId, true);
		setErrorFor(providerId, null);
		const r = await mutate("DELETE", "/api/connections/subscriptions", { providerId });
		setBusyFor(providerId, false);
		if (!r.ok) setErrorFor(providerId, r.error);
		else {
			setStatuses((s) => (s ? s.map((x) => (x.id === providerId ? { ...x, connected: false, expires: undefined } : x)) : s));
			notifySettingsSaved("keys");
			notifySettingsSaved("models");
		}
		void load();
	}

	return (
		<SettingsGroup label="Subscriptions" testid="connections-subscriptions">
			{readFailed && (
				<p role="alert" className="text-xs text-red-400" data-testid="subscriptions-read-error">
					Could not read subscription status.{" "}
					<button type="button" onClick={() => void load()} className={linkBtn}>
						Retry
					</button>
				</p>
			)}
			{SUBSCRIPTION_PROVIDERS.map((p) => {
				const status = statuses?.find((s) => s.id === p.id);
				const attempt = attempts[p.id];
				const isBusy = !!busy[p.id];
				return (
					<div key={p.id} className="flex flex-col gap-1.5 py-1" data-testid={`subscription-${p.provider}`}>
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 font-ui text-xs text-foreground">{p.name}</span>
							<span className="text-xs text-muted-foreground" data-testid={`subscription-${p.provider}-status`}>
								{readFailed && !status ? "unknown" : subscriptionLine(status)}
							</span>
							{status?.connected ? (
								<button type="button" onClick={() => void disconnect(p.id)} disabled={isBusy} className={quietBtn} data-testid={`subscription-${p.provider}-disconnect`}>
									Disconnect
								</button>
							) : (
								<button
									type="button"
									onClick={() => void start(p.id)}
									disabled={isBusy || !status || attempt?.state === "pending"}
									className={linkBtn}
									data-testid={`subscription-${p.provider}-connect`}
								>
									Connect Codex
								</button>
							)}
						</div>
						{attempt && (
							<LoginAttemptPanel
								attempt={attempt}
								busy={isBusy}
								onAnswer={(pid, v) => void answer(attempt, pid, v)}
								onCancel={() => void cancel(attempt)}
							/>
						)}
						{errors[p.id] && (
							<p role="alert" className="text-xs text-red-400" data-testid={`subscription-${p.provider}-error`}>
								{errors[p.id]}
							</p>
						)}
					</div>
				);
			})}
		</SettingsGroup>
	);
}

export function ConnectionsSection() {
	return <div data-testid="connections-section" className="flex flex-col gap-2"><SubscriptionsGroup /></div>;
}
