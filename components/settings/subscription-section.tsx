"use client";
/**
 * SUBSCRIPTION SETTINGS (issue #8, settings wave 2026-10-19): authorizes
 * this LearnHarness instance against the user's Codex subscription and
 * shows the stored result. This surface never proves entitlement: a saved
 * session can connect, but a successful model request confirms only that
 * this access worked at that moment; remaining quota cannot be inferred.
 *
 * The server owns the OAuth browser flow, the PKCE state, device polling,
 * and the token file. This component only:
 * - reads the sanitized status DTO and renders it;
 * - starts/cancels attempts through the instance API;
 * - hands the browser back a complete loopback callback URL when the
 *   local listener could not be reached (manual fallback);
 * - shows short-lived provider codes/URLs. Nothing is persisted here.
 *
 * Threat notes: tokens and callback codes never enter localStorage,
 * IndexedDB, sessionStorage, the URL, console output, or the error copy.
 * Provider links render only after `subscriptionLink` proves HTTPS on
 * auth.openai.com; the Electron shell sends those to the system browser.
 * User-entered callback URLs stay in React state and are cleared after
 * submit/cancel/unmount.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import {
	subscriptionFailure,
	type SubscriptionErrorCode,
	type SubscriptionFailure,
	type SubscriptionMethod,
	type SubscriptionStatus,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

const STATUS_PATH = "/api/subscription";
const ATTEMPTS_PATH = "/api/subscription/attempts";
/** The API's same-origin guard requires this header on every request. */
export const SUBSCRIPTION_REQUEST_HEADER = "X-LearnHarness-Subscription";
/** Attempt status changes are provider-driven; polling is cheap and local. */
export const SUBSCRIPTION_POLL_INTERVAL_MS = 2_000;
const SUPPLIER_HOST = "auth.openai.com";
const SUPPLIER_PATHS = new Set(["/oauth/authorize", "/codex/device"]);
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_PORT = "1455";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

const ERROR_CODES: readonly SubscriptionErrorCode[] = [
	"subscription_needs_login",
	"subscription_limit",
	"subscription_model_unavailable",
	"subscription_network",
	"subscription_unknown",
	"subscription_storage_error",
	"subscription_recovery_required",
	"subscription_cancelled",
	"subscription_expired",
	"subscription_conflict",
	"subscription_wrong_owner",
	"subscription_invalid_input",
	"subscription_device_unsupported",
];
const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES);
const STATUS_STATES = new Set<string>([
	"disconnected",
	"authorizing",
	"connected",
	"reconnect_required",
	"error",
]);

const STATE_LABELS: Record<SubscriptionStatus["state"], string> = {
	disconnected: "Not connected",
	authorizing: "Waiting for authorization",
	connected: "Connected",
	reconnect_required: "Reconnect required",
	error: "Authorization error",
};

const METHOD_LABELS: Record<SubscriptionMethod, string> = {
	browser: "browser sign-in",
	device_code: "device code",
};

const PRIMARY_BUTTON =
	"w-fit rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
const QUIET_BUTTON =
	"w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-40";
const DANGER_BUTTON =
	"w-fit text-xs text-muted-foreground underline-offset-2 hover:text-red-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40";
const LINK =
	"w-fit text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground";

type Attempt = NonNullable<SubscriptionStatus["attempt"]>;

type Outcome =
	| { ok: true; status: SubscriptionStatus }
	| { ok: false; failure: SubscriptionFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sanitizeFailure(value: unknown): SubscriptionFailure | null {
	if (!isRecord(value)) return null;
	const code = value.code;
	if (typeof code !== "string" || !KNOWN_ERROR_CODES.has(code)) return null;
	return subscriptionFailure(code as SubscriptionErrorCode);
}

function sanitizeAttempt(value: unknown): Attempt | null {
	if (!isRecord(value)) return null;
	const { id, method, expiresAt } = value;
	if (typeof id !== "string" || id.length === 0) return null;
	if (method !== "browser" && method !== "device_code") return null;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;

	const attempt: Attempt = {
		id,
		method,
		expiresAt,
		// Fail closed: an attempt without an explicit owner is not ours.
		ownedHere: value.ownedHere === true,
	};
	if (typeof value.authorizationUrl === "string" && value.authorizationUrl.length > 0) {
		attempt.authorizationUrl = value.authorizationUrl;
	}
	if (typeof value.verificationUri === "string" && value.verificationUri.length > 0) {
		attempt.verificationUri = value.verificationUri;
	}
	if (typeof value.userCode === "string" && value.userCode.length > 0) {
		attempt.userCode = value.userCode;
	}
	if (typeof value.promptId === "string" && value.promptId.length > 0) {
		attempt.promptId = value.promptId;
	}
	if (typeof value.manualAvailable === "boolean") {
		attempt.manualAvailable = value.manualAvailable;
	}
	if (typeof value.callbackListening === "boolean") {
		attempt.callbackListening = value.callbackListening;
	}
	return attempt;
}

/**
 * Keep only the fields the UI knows. The server owns the full DTO; this
 * boundary prevents a proxy or a future server change from smuggling
 * unexpected provider data into rendered copy.
 */
export function sanitizeSubscriptionStatus(value: unknown): SubscriptionStatus | null {
	if (!isRecord(value)) return null;
	const state = value.state;
	if (typeof state !== "string" || !STATUS_STATES.has(state)) return null;

	const status: SubscriptionStatus = {
		state: state as SubscriptionStatus["state"],
	};
	if (typeof value.account === "string" && value.account.trim().length > 0) {
		status.account = value.account;
	}
	const attempt = sanitizeAttempt(value.attempt);
	if (attempt) status.attempt = attempt;
	if (value.error !== undefined) {
		const failure = sanitizeFailure(value.error);
		if (failure) status.error = failure;
		else if (status.state === "error") {
			status.error = subscriptionFailure("subscription_unknown");
		}
	} else if (status.state === "error") {
		status.error = subscriptionFailure("subscription_unknown");
	}
	return status;
}

/**
 * The only clickable provider address. `URL` normalizes the host, so
 * `auth.openai.com.evil` and userinfo URLs never pass; :443 normalizes to
 * an empty port, any other explicit port is refused.
 */
export function subscriptionLink(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:") return null;
		if (url.hostname !== SUPPLIER_HOST) return null;
		if (url.username !== "" || url.password !== "") return null;
		if (url.port !== "") return null;
		if (!SUPPLIER_PATHS.has(url.pathname)) return null;
		if (url.hash !== "") return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * The manual fallback takes the complete loopback callback URL, never a
 * bare code: the URL carries the state that binds the response to this
 * attempt. The server still validates the configured origin; this check
 * only rejects obviously incomplete or foreign input before a round trip.
 */
export function manualCallbackProblem(
	value: string,
	authorizationUrl?: string,
): string | null {
	const trimmed = value.trim();
	if (!trimmed) return "Paste the complete callback URL from your browser.";

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return "That is not a complete callback URL.";
	}
	if (url.protocol !== "http:") {
		return "The callback URL must start with http://; the local listener is HTTP only.";
	}
	if (!LOOPBACK_HOSTS.has(url.hostname)) {
		return "The callback URL must point at localhost or 127.0.0.1 on this machine.";
	}
	if (url.port !== CALLBACK_PORT) {
		return `The callback URL must use the local listener port ${CALLBACK_PORT}.`;
	}
	if (url.pathname !== CALLBACK_PATH) {
		return `The callback URL must end at ${CALLBACK_PATH}.`;
	}
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		return "The callback URL contains unexpected credentials or a fragment.";
	}
	if (url.searchParams.has("error") || url.searchParams.has("error_description")) {
		return "The callback URL reports a provider error; start a new sign-in.";
	}

	const codes = url.searchParams.getAll("code");
	const states = url.searchParams.getAll("state");
	if (codes.length !== 1 || (codes[0] ?? "").length === 0) {
		return "The callback URL must contain exactly one authorization code.";
	}
	if (states.length !== 1 || (states[0] ?? "").length === 0) {
		return "The callback URL must contain exactly one authorization state.";
	}
	if (authorizationUrl) {
		try {
			const expectedState = new URL(authorizationUrl).searchParams.get("state");
			if (expectedState && expectedState !== states[0]) {
				return "The callback URL does not belong to this authorization attempt.";
			}
		} catch {
			// The server validates the stored authorization URL.
		}
	}
	return null;
}

/** The attempt DTO pins milliseconds; never guess a seconds convention. */
export function expiryLabel(expiresAt: number, now = Date.now()): string {
	const remaining = expiresAt - now;
	if (!Number.isFinite(remaining) || remaining <= 0) {
		return "This attempt has expired.";
	}
	const minutes = Math.max(1, Math.ceil(remaining / 60_000));
	return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** Manual input exists only for a browser prompt the server marked usable. */
function manualPromptId(attempt: Attempt): string | null {
	return attempt.method === "browser" &&
		attempt.manualAvailable === true &&
		typeof attempt.promptId === "string" &&
		attempt.promptId.length > 0
		? attempt.promptId
		: null;
}

function failureFromBody(body: unknown): SubscriptionFailure {
	const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
	return subscriptionFailure(
		typeof code === "string" && KNOWN_ERROR_CODES.has(code)
			? (code as SubscriptionErrorCode)
			: "subscription_unknown",
	);
}

/**
 * One transport seam. The response body is parsed exactly once; a
 * non-JSON success is an unknown failure rather than a fabricated state.
 */
async function requestStatus(path: string, init: RequestInit): Promise<Outcome> {
	const headers = new Headers(init.headers);
	headers.set(SUBSCRIPTION_REQUEST_HEADER, "1");

	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers,
			cache: "no-store",
			credentials: "same-origin",
		});
	} catch {
		return { ok: false, failure: subscriptionFailure("subscription_unknown") };
	}

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		return { ok: false, failure: failureFromBody(body) };
	}
	const status = sanitizeSubscriptionStatus(body);
	return status
		? { ok: true, status }
		: { ok: false, failure: subscriptionFailure("subscription_unknown") };
}

function requestJson(
	path: string,
	method: "POST" | "DELETE",
	body?: unknown,
): Promise<Outcome> {
	return requestStatus(path, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function ConnectActions({
	disabled,
	onStart,
}: {
	disabled: boolean;
	onStart: (method: SubscriptionMethod) => void;
}) {
	return (
		<div className="flex flex-wrap gap-2">
			<button
				type="button"
				data-testid="subscription-start-browser"
				onClick={() => onStart("browser")}
				disabled={disabled}
				className={PRIMARY_BUTTON}
			>
				Sign in with browser
			</button>
			<button
				type="button"
				data-testid="subscription-start-device"
				onClick={() => onStart("device_code")}
				disabled={disabled}
				className={PRIMARY_BUTTON}
			>
				Use a device code
			</button>
		</div>
	);
}

/**
 * The disconnect action is local and destructive only to the saved
 * authorization, so it asks once and keeps the provider-side caveat next
 * to the buttons in every state that offers it.
 */
function DisconnectControl({
	busy,
	confirming,
	askLabel,
	onAsk,
	onCancel,
	onConfirm,
}: {
	busy: boolean;
	confirming: boolean;
	askLabel: string;
	onAsk: () => void;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			{confirming ? (
				<div
					data-testid="subscription-disconnect-confirm"
					role="group"
					aria-label="Confirm disconnect"
					className="rounded-sm border border-border bg-background px-3 py-2"
				>
					<p className="text-xs text-foreground">
						Disconnect this instance?
					</p>
					<div className="mt-2 flex flex-wrap gap-3">
						<button
							type="button"
							data-testid="subscription-disconnect-confirm-button"
							onClick={onConfirm}
							disabled={busy}
							className={DANGER_BUTTON}
						>
							Disconnect this instance
						</button>
						<button
							type="button"
							data-testid="subscription-disconnect-cancel"
							onClick={onCancel}
							disabled={busy}
							className={QUIET_BUTTON}
						>
							Keep connected
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					data-testid="subscription-disconnect"
					onClick={onAsk}
					disabled={busy}
					className={DANGER_BUTTON}
				>
					{askLabel}
				</button>
			)}
			<p
				data-testid="subscription-disconnect-warning"
				className="text-xs text-muted-foreground"
			>
				Disconnecting removes the saved authorization from this
				instance only. It does not revoke the provider sign-in; requests
				already issued may still consume subscription quota.
			</p>
		</div>
	);
}

export function SubscriptionSection({
	pollIntervalMs = SUBSCRIPTION_POLL_INTERVAL_MS,
}: {
	/** Test seam; production uses the exported default. */
	pollIntervalMs?: number;
}) {
	const [status, setStatus] = useState<SubscriptionStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<SubscriptionFailure | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const [draft, setDraft] = useState<{ owner: string | null; value: string }>({
		owner: null,
		value: "",
	});
	const [inputProblem, setInputProblem] = useState<string | null>(null);

	const mountedRef = useRef(true);
	const busyRef = useRef(false);
	const statusRef = useRef<HTMLSpanElement | null>(null);
	const lastStateRef = useRef<SubscriptionStatus["state"] | null>(null);
	// Bumped by every user mutation so an in-flight poll cannot overwrite
	// the result of an action that started later.
	const epochRef = useRef(0);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const applyOutcome = useCallback((outcome: Outcome) => {
		if (!mountedRef.current) return;
		if (outcome.ok) {
			setStatus(outcome.status);
			setFailure(null);
			setConfirmDisconnect(false);
		} else {
			setFailure(outcome.failure);
		}
	}, []);

	const runAction = useCallback(
		async (key: string, task: () => Promise<Outcome>): Promise<Outcome | null> => {
			if (busyRef.current) return null;
			busyRef.current = true;
			epochRef.current += 1;
			setLoading(false);
			setBusy(key);
			setFailure(null);
			setInputProblem(null);
			setNotice(null);
			try {
				const outcome = await task();
				applyOutcome(outcome);
				return outcome;
			} finally {
				busyRef.current = false;
				if (mountedRef.current) setBusy(null);
			}
		},
		[applyOutcome],
	);

	const refresh = useCallback(async () => {
		// A manual refresh outranks any poll already in flight; the poll
		// reschedules instead of applying a possibly older read.
		if (busyRef.current) return;
		const epoch = ++epochRef.current;
		setLoading(true);
		const outcome = await requestStatus(STATUS_PATH, { method: "GET" });
		if (!mountedRef.current || epoch !== epochRef.current) return;
		if (outcome.ok) {
			setStatus(outcome.status);
			setFailure(null);
		} else {
			setFailure(outcome.failure);
		}
		setLoading(false);
	}, []);

	// Window focus / visibility return re-reads the saved status: another
	// client may connect or disconnect without this tab writing anything.
	// `refresh` increments the epoch, so a slower in-flight read cannot
	// overwrite the newer answer.
	useEffect(() => {
		const onFocus = () => void refresh();
		const onVisibility = () => {
			if (document.visibilityState !== "hidden") void refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [refresh]);

	useEffect(() => {
		let cancelled = false;
		const epoch = epochRef.current;
		void (async () => {
			const outcome = await requestStatus(STATUS_PATH, { method: "GET" });
			if (cancelled || !mountedRef.current || epoch !== epochRef.current) return;
			if (outcome.ok) {
				setStatus(outcome.status);
				setFailure(null);
			} else {
				setFailure(outcome.failure);
			}
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Poll only while an attempt is authorizing. The cleanup clears the
	// timer on state change, cancellation, and unmount.
	useEffect(() => {
		if (status?.state !== "authorizing") return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const tick = async () => {
			const epoch = epochRef.current;
			const outcome = await requestStatus(STATUS_PATH, { method: "GET" });
			if (cancelled || !mountedRef.current) return;
			if (epoch !== epochRef.current) {
				// A user action landed while this read was in flight. Its
				// result was already applied; keep polling rather than
				// letting the stale read end the timer.
				timer = setTimeout(tick, pollIntervalMs);
				return;
			}
			if (outcome.ok) {
				setStatus(outcome.status);
				setFailure(null);
				if (outcome.status.state === "authorizing") {
					timer = setTimeout(tick, pollIntervalMs);
				}
			} else {
				setFailure(outcome.failure);
				timer = setTimeout(tick, pollIntervalMs);
			}
		};

		timer = setTimeout(tick, pollIntervalMs);
		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, [status?.state, pollIntervalMs]);

	const state = status?.state ?? null;

	// Publish a real state transition (connect completed, attempt
	// cancelled, disconnect, or an externally observed change). The initial
	// mount read is not a transition; "authorizing" is not an outcome.
	// Composer gates listen for the "subscription" signal and re-read the
	// live status instead of caching the previous decision.
	const lastNotifiedStateRef = useRef<SubscriptionStatus["state"] | null>(null);
	useEffect(() => {
		const previous = lastNotifiedStateRef.current;
		lastNotifiedStateRef.current = state;
		if (previous === null || state === null || previous === state) return;
		if (state === "authorizing") return;
		notifySettingsSaved("subscription");
	}, [state]);

	// Move focus to the status badge only when an existing state changes.
	// The initial read must not steal focus from the settings dialog; later
	// transitions (start, cancel, disconnect, polling) would otherwise drop
	// focus when the clicked control unmounts.
	useEffect(() => {
		const previous = lastStateRef.current;
		lastStateRef.current = state;
		if (previous !== null && state !== null && state !== previous) {
			statusRef.current?.focus();
		}
	}, [state]);

	const attempt = state === "authorizing" ? status?.attempt : undefined;
	const promptId = attempt ? manualPromptId(attempt) : null;
	const manualValue = promptId !== null && draft.owner === promptId ? draft.value : "";
	// A validation message belongs to the prompt it was raised for; a new
	// prompt must not inherit the previous prompt's error.
	const promptProblem =
		promptId !== null && draft.owner === promptId ? inputProblem : null;
	const authHref = attempt ? subscriptionLink(attempt.authorizationUrl) : null;
	const verificationHref = attempt
		? subscriptionLink(attempt.verificationUri)
		: null;
	const activeFailure = failure ?? status?.error ?? null;
	const stateLabel = status
		? STATE_LABELS[status.state]
		: loading
			? "Checking status"
			: "Status unavailable";

	const start = (method: SubscriptionMethod) => {
		setDraft({ owner: null, value: "" });
		setInputProblem(null);
		setConfirmDisconnect(false);
		void runAction(`start-${method}`, () =>
			requestJson(ATTEMPTS_PATH, "POST", { method }),
		);
	};

	const cancelAttempt = async () => {
		if (!attempt) return;
		const outcome = await runAction("cancel", () =>
			requestJson(`${ATTEMPTS_PATH}/${encodeURIComponent(attempt.id)}`, "DELETE"),
		);
		if (!mountedRef.current) return outcome;
		setDraft({ owner: null, value: "" });
		setInputProblem(null);
		return outcome;
	};

	const switchToDevice = async () => {
		if (!attempt) return;
		const cancelled = await runAction("cancel", () =>
			requestJson(`${ATTEMPTS_PATH}/${encodeURIComponent(attempt.id)}`, "DELETE"),
		);
		if (!cancelled?.ok || !mountedRef.current) return;
		// Only chain a new attempt after the old one is gone; a still-active
		// or connected status means the server did not cancel it.
		if (
			cancelled.status.state === "authorizing" ||
			cancelled.status.state === "connected"
		) {
			return;
		}
		setDraft({ owner: null, value: "" });
		setInputProblem(null);
		await runAction("start-device_code", () =>
			requestJson(ATTEMPTS_PATH, "POST", { method: "device_code" }),
		);
	};

	const submitPrompt = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!attempt || !promptId) return;
		const problem = manualCallbackProblem(manualValue, attempt.authorizationUrl);
		if (problem) {
			setInputProblem(problem);
			return;
		}
		const value = manualValue.trim();
		const outcome = await runAction("input", () =>
			requestJson(
				`${ATTEMPTS_PATH}/${encodeURIComponent(attempt.id)}/input`,
				"POST",
				{ promptId, value },
			),
		);
		if (!mountedRef.current) return;
		if (outcome) {
			setDraft({ owner: null, value: "" });
			setInputProblem(null);
		}
	};

	const disconnect = async () => {
		const outcome = await runAction("disconnect", () =>
			requestJson(STATUS_PATH, "DELETE"),
		);
		if (!mountedRef.current) return;
		setConfirmDisconnect(false);
		setDraft({ owner: null, value: "" });
		setInputProblem(null);
		if (outcome?.ok) {
			setNotice(
				"Disconnected on this instance. The saved authorization was removed here only; it was not revoked at the provider. Requests already issued may still consume subscription quota.",
			);
		}
	};

	return (
		<div data-testid="subscription-section" className="flex flex-col gap-5">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex flex-col gap-1.5">
					<span
						ref={statusRef}
						role="status"
						aria-live="polite"
						tabIndex={-1}
						data-testid="subscription-state"
						className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground focus-visible:ring-1 focus-visible:ring-border"
					>
						<span
							aria-hidden="true"
							className={`size-1.5 rounded-full ${
								state === "connected"
									? "bg-emerald-500"
									: state === "authorizing"
										? "bg-amber-500"
										: state === "error" || state === "reconnect_required"
											? "bg-red-500"
											: "bg-muted-foreground/40"
							}`}
						/>
						{stateLabel}
					</span>
					<p className="max-w-[58ch] text-xs text-muted-foreground">
						Authorize this LearnHarness instance with your Codex
						subscription. The saved authorization belongs to this
						instance only.
					</p>
				</div>
				<button
					type="button"
					data-testid="subscription-refresh"
					onClick={() => void refresh()}
					disabled={busy !== null || loading}
					className={QUIET_BUTTON}
				>
					{loading ? "Refreshing…" : "Refresh status"}
				</button>
			</div>

			{notice && (
				<p
					role="status"
					data-testid="subscription-notice"
					className="rounded-sm border border-border bg-accent/40 px-3 py-2 text-xs text-foreground"
				>
					{notice}
				</p>
			)}

			{activeFailure && (
				<p
					role="alert"
					data-testid="subscription-error"
					className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500"
				>
					{activeFailure.message}
				</p>
			)}

			{loading && !status && (
				<p
					data-testid="subscription-loading"
					className="text-xs text-muted-foreground/70"
				>
					Loading subscription…
				</p>
			)}

			{!loading && !status && (
				<SettingsGroup label="Status unavailable">
					<p className="text-xs text-muted-foreground">
						The subscription status could not be read from this
						instance. No authorization state is assumed.
					</p>
					<button
						type="button"
						data-testid="subscription-retry"
						onClick={() => void refresh()}
						disabled={busy !== null}
						className={PRIMARY_BUTTON}
					>
						Try again
					</button>
				</SettingsGroup>
			)}

			{status?.state === "disconnected" && (
				<SettingsGroup label="Connect">
					<p className="text-xs text-muted-foreground">
						Start a browser sign-in or a device-code sign-in. Both
						finish on the provider's page in your system browser.
					</p>
					<ConnectActions disabled={busy !== null} onStart={start} />
				</SettingsGroup>
			)}

			{status?.state === "connected" && (
				<SettingsGroup label="Saved authorization">
					<div className="flex flex-col gap-1">
						<p className="text-xs text-muted-foreground">
							{status.account ? (
								<>
									Connected as{" "}
									<span
										data-testid="subscription-account"
										className="break-all font-mono text-foreground"
									>
										{status.account}
									</span>
									.
								</>
							) : (
								"Connected, but the saved authorization did not include an account identity."
							)}
						</p>
						<p
							data-testid="subscription-entitlement-note"
							className="text-xs text-muted-foreground"
						>
							This is the saved session, not a live entitlement
							check. A successful model request confirms only
							that this access worked at that moment; remaining
							quota cannot be inferred.
						</p>
					</div>
					<DisconnectControl
						busy={busy !== null}
						confirming={confirmDisconnect}
						askLabel="Disconnect…"
						onAsk={() => setConfirmDisconnect(true)}
						onCancel={() => setConfirmDisconnect(false)}
						onConfirm={() => void disconnect()}
					/>
				</SettingsGroup>
			)}

			{status?.state === "authorizing" && (
				<SettingsGroup label="Authorization in progress">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{attempt ? (
							<>
								<span className="font-mono text-[11px] text-muted-foreground">
									{METHOD_LABELS[attempt.method]}
								</span>
								<span
									data-testid="subscription-expiry"
									className="text-xs text-muted-foreground"
								>
									{expiryLabel(attempt.expiresAt)}
								</span>
								{!attempt.ownedHere && (
									<span className="text-xs text-red-500">
										Owned by another process
									</span>
								)}
							</>
						) : (
							<span className="text-xs text-muted-foreground">
								Waiting for this instance to report the attempt
								details…
							</span>
						)}
					</div>

					{attempt && !attempt.ownedHere && (
						<p
							role="alert"
							data-testid="subscription-wrong-owner"
							className="text-xs text-red-500"
						>
							This authorization belongs to another LearnHarness
							service process. Finish it in the service that
							started it; input is disabled here.
						</p>
					)}

					{attempt?.method === "browser" && (
						<div className="flex flex-col gap-2">
							{attempt.ownedHere && (
								<p className="text-xs text-muted-foreground">
									Complete the sign-in in your browser. This
									page waits for the local callback.
								</p>
							)}
							{attempt.ownedHere &&
								(authHref ? (
									<a
										data-testid="subscription-browser-link"
										href={authHref}
										target="_blank"
										rel="noreferrer"
										className={LINK}
									>
										Open the sign-in page
									</a>
								) : attempt.authorizationUrl ? (
									<p
										role="alert"
										data-testid="subscription-browser-link-blocked"
										className="text-xs text-red-500"
									>
										The provider returned a sign-in address
										outside the allowed HTTPS host, so it was
										not opened.
									</p>
								) : (
									<p className="text-xs text-muted-foreground">
										The sign-in address is not available yet.
									</p>
								))}

							{attempt.callbackListening === false ? (
								<p
									role="alert"
									data-testid="subscription-listener-unavailable"
									className="rounded-sm border border-amber-500/40 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400"
								>
									The local callback listener did not start,
									usually because port 1455 is already in use.{" "}
									{!attempt.ownedHere
										? "This attempt is owned by another process; finish it there."
										: promptId
											? "Paste the complete callback URL below after signing in, or cancel and use a device code."
											: "Cancel this attempt and start a device-code sign-in instead."}
								</p>
							) : attempt.callbackListening === true ? (
								<p
									data-testid="subscription-listener-active"
									className="text-xs text-muted-foreground"
								>
									Waiting for the browser to return to the
									local callback listener.
								</p>
							) : null}

							{promptId && (
								<form
									data-testid="subscription-prompt-form"
									onSubmit={(event) => void submitPrompt(event)}
									className="flex flex-col gap-1.5"
									noValidate
								>
									<label
										htmlFor="subscription-callback"
										className="text-xs text-foreground"
									>
										Complete callback URL
									</label>
									<p
										id="subscription-callback-hint"
										className="text-xs text-muted-foreground"
									>
										Paste the full address from the
										browser's address bar, including the
										code and state. A bare code is not
										accepted.
									</p>
									<input
										id="subscription-callback"
										data-testid="subscription-prompt-input"
										type="text"
										inputMode="url"
										autoComplete="off"
										spellCheck={false}
										value={manualValue}
										// onInput (not onChange): linkedom's React
										// adapter delivers input events but not
										// change events; the browser semantics for
										// this controlled field are identical.
										onInput={(event) => {
											setDraft({
												owner: promptId,
												value: event.currentTarget.value,
											});
											setInputProblem(null);
										}}
										disabled={busy !== null || !attempt.ownedHere}
										aria-invalid={promptProblem !== null}
										aria-describedby={
											promptProblem
												? "subscription-callback-hint subscription-callback-error"
												: "subscription-callback-hint"
										}
										placeholder="http://localhost:1455/auth/callback?..."
										className="h-7 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
									/>
									{promptProblem && (
										<p
											id="subscription-callback-error"
											role="alert"
											data-testid="subscription-prompt-error"
											className="text-xs text-red-500"
										>
											{promptProblem}
										</p>
									)}
									<button
										type="submit"
										data-testid="subscription-prompt-submit"
										disabled={
											busy !== null ||
											!attempt.ownedHere ||
											manualValue.trim().length === 0
										}
										className={PRIMARY_BUTTON}
									>
										Submit callback URL
									</button>
								</form>
							)}

							{attempt.callbackListening === false && (
								<button
									type="button"
									data-testid="subscription-switch-device"
									onClick={() => void switchToDevice()}
									disabled={busy !== null || !attempt.ownedHere}
									className={QUIET_BUTTON}
								>
									Cancel and use a device code
								</button>
							)}
						</div>
					)}

					{attempt?.method === "device_code" && (
						<div className="flex flex-col gap-2">
							{attempt.ownedHere && (
								<p className="text-xs text-muted-foreground">
									Enter this one-time code on the provider's
									verification page.
								</p>
							)}
							{attempt.ownedHere && (
								<>
									{attempt.userCode ? (
										<code
											data-testid="subscription-user-code"
											aria-label="Device code"
											className="w-fit rounded-sm border border-border bg-background px-2 py-1 font-mono text-sm tracking-widest text-foreground"
										>
											{attempt.userCode}
										</code>
									) : (
										<p className="text-xs text-muted-foreground">
											The device code is not available
											yet.
										</p>
									)}
									{verificationHref ? (
										<a
											data-testid="subscription-verification-link"
											href={verificationHref}
											target="_blank"
											rel="noreferrer"
											className={LINK}
										>
											Open the verification page
										</a>
									) : attempt.verificationUri ? (
										<p
											role="alert"
											data-testid="subscription-verification-link-blocked"
											className="text-xs text-red-500"
										>
											The provider returned a verification
											address outside the allowed HTTPS
											host, so it was not opened.
										</p>
									) : null}
									<p className="text-xs text-muted-foreground">
										This page checks the attempt
										automatically until it expires.
									</p>
								</>
							)}
						</div>
					)}

					<div className="flex flex-wrap gap-3 pt-1">
						<button
							type="button"
							data-testid="subscription-cancel"
							onClick={() => void cancelAttempt()}
							disabled={busy !== null || !attempt || !attempt.ownedHere}
							className={QUIET_BUTTON}
						>
							Cancel authorization
						</button>
						<button
							type="button"
							data-testid="subscription-refresh-inline"
							onClick={() => void refresh()}
							disabled={busy !== null || loading}
							className={QUIET_BUTTON}
						>
							Refresh status
						</button>
					</div>
				</SettingsGroup>
			)}

			{status?.state === "reconnect_required" && (
				<SettingsGroup label="Reconnect">
					<p className="text-xs text-muted-foreground">
						The saved authorization can no longer be used. Remove
						the saved authorization first, then sign in again.
					</p>
					{status.account && (
						<p className="text-xs text-muted-foreground">
							Previously connected as{" "}
							<span className="font-mono text-foreground">
								{status.account}
							</span>
							.
						</p>
					)}
					<DisconnectControl
						busy={busy !== null}
						confirming={confirmDisconnect}
						askLabel="Remove saved authorization"
						onAsk={() => setConfirmDisconnect(true)}
						onCancel={() => setConfirmDisconnect(false)}
						onConfirm={() => void disconnect()}
					/>
				</SettingsGroup>
			)}

			{status?.state === "error" && (
				<SettingsGroup label="Authorization error">
					<p className="text-xs text-muted-foreground">
						The instance reported an authorization problem. This
						page cannot confirm that sign-in would work. Remove the
						saved authorization, then refresh status.
					</p>
					<DisconnectControl
						busy={busy !== null}
						confirming={confirmDisconnect}
						askLabel="Remove saved authorization"
						onAsk={() => setConfirmDisconnect(true)}
						onCancel={() => setConfirmDisconnect(false)}
						onConfirm={() => void disconnect()}
					/>
				</SettingsGroup>
			)}

			<SettingsGroup label="Storage and limits">
				<p
					data-testid="subscription-plaintext-warning"
					className="text-xs text-muted-foreground"
				>
					When saved, the authorization is stored on this machine in
					plaintext. Anyone who can read this instance's data can use
					it.
				</p>
				<p
					data-testid="subscription-legacy-warning"
					className="text-xs text-muted-foreground"
				>
					This feature uses a legacy third-party route. Its
					availability and policy support are not guaranteed, and it
					is not an official third-party permission. A successful
					authorization or model request does not establish supplier
					permission for this integration.
				</p>
				<p className="text-xs text-muted-foreground">
					This page reports a stored authorization, not a live
					entitlement. A successful model request confirms only that
					this access worked at that moment; remaining quota cannot
					be inferred.
				</p>
			</SettingsGroup>
		</div>
	);
}
