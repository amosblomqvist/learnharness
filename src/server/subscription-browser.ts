/**
 * Narrow browser OAuth adapter for the OpenAI Codex subscription.
 *
 * This mirrors the public-client constants, PKCE parameters, and token request
 * used by pi-ai's installed OpenAI Codex flow, but owns the loopback listener
 * so the LearnHarness service can report a reliable `callbackListening` signal.
 * The listener is intentionally fixed to 127.0.0.1:1455 and never consults
 * PI_OAUTH_CALLBACK_HOST; the redirect URI stays http://localhost:1455/...
 * because that exact value is registered by the provider.
 *
 * Nothing in this module logs, returns, or attaches provider error bodies,
 * authorization codes, or tokens to an error. Failures use SubscriptionError's
 * fixed, sanitized messages and stable codes.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { SubscriptionError } from "../core/subscription.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const LOGIN_TIMEOUT_MS = 15 * 60_000;

const HTML_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
} as const;

interface CallbackResult {
	code: string;
}

interface CallbackListener {
	readonly wait: Promise<CallbackResult>;
	close(): void;
}

function invalidInput(): never {
	throw new SubscriptionError("subscription_invalid_input");
}

function safeAbortReason(signal: AbortSignal): SubscriptionError {
	const reason: unknown = signal.reason;
	return reason instanceof SubscriptionError ? reason : new SubscriptionError("subscription_cancelled");
}

function sendPage(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, HTML_HEADERS);
	response.end(
		`<!doctype html><html><head><meta charset="utf-8"><title>Authorization</title></head>` +
			`<body><p>${message}</p></body></html>`,
	);
}

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function authorizationUrl(state: string, challenge: string): string {
	const url = new URL(AUTHORIZE_URL);
	const params: ReadonlyArray<readonly [string, string]> = [
		["response_type", "code"],
		["client_id", CLIENT_ID],
		["redirect_uri", REDIRECT_URI],
		["scope", SCOPE],
		["code_challenge", challenge],
		["code_challenge_method", "S256"],
		["state", state],
		["id_token_add_organizations", "true"],
		["codex_cli_simplified_flow", "true"],
		["originator", "pi"],
	];
	for (const [key, value] of params) url.searchParams.set(key, value);
	return url.toString();
}

/**
 * Validate a complete callback URL pasted by the user. Bare authorization
 * codes are deliberately rejected: the redirect URL carries the state that
 * binds the code to this login attempt.
 *
 * The host must be exactly localhost or 127.0.0.1, with the fixed port and
 * path. `code` and `state` must each occur exactly once and be non-empty; the
 * state must match `expectedState`. A callback `error` is rejected without
 * exposing the provider's error text.
 */
export function validateBrowserCallback(input: string, expectedState: string): { code: string } {
	if (typeof input !== "string" || typeof expectedState !== "string" || expectedState.length === 0) invalidInput();
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		invalidInput();
	}
	if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.hash !== "") invalidInput();
	if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") invalidInput();
	if (url.port !== String(CALLBACK_PORT) || url.pathname !== CALLBACK_PATH) invalidInput();
	if (url.searchParams.has("error") || url.searchParams.has("error_description")) invalidInput();

	const codes = url.searchParams.getAll("code");
	const states = url.searchParams.getAll("state");
	if (codes.length !== 1 || states.length !== 1) invalidInput();
	const code = codes[0];
	const state = states[0];
	if (!code || !state || state !== expectedState) invalidInput();
	return { code };
}

function startCallbackListener(expectedState: string): Promise<CallbackListener> {
	return new Promise((resolve, reject) => {
		let claimed = false;
		let settled = false;
		let closed = false;
		let resolveWait: (result: CallbackResult) => void = () => {};
		let rejectWait: (error: SubscriptionError) => void = () => {};
		const wait = new Promise<CallbackResult>((resolvePromise, rejectPromise) => {
			resolveWait = resolvePromise;
			rejectWait = rejectPromise;
		});
		// A listener can be closed by the manual-input branch before anyone
		// observes its rejection; that is not an unhandled login failure.
		void wait.catch(() => {});

		const finish = (result: CallbackResult | { error: SubscriptionError }): void => {
			if (settled) return;
			settled = true;
			if ("error" in result) rejectWait(result.error);
			else resolveWait(result);
		};

		const closeServer = (): void => {
			if (closed) return;
			closed = true;
			try {
				server.close();
				server.closeAllConnections();
			} catch {
				// Closing is best-effort; the login already has a safe outcome.
			}
		};

		const server = createServer((request: IncomingMessage, response: ServerResponse) => {
			void (async () => {
				const requestUrl = new URL(request.url ?? "/", "http://localhost");
				if (request.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH) {
					sendPage(response, 404, "Not found.");
					return;
				}
				if (claimed || settled) {
					sendPage(response, 409, "This authorization callback was already used.");
					return;
				}
				if (requestUrl.searchParams.has("error") || requestUrl.searchParams.has("error_description")) {
					sendPage(response, 400, "Authorization was not completed. Return to the app and try again.");
					finish({ error: new SubscriptionError("subscription_unknown") });
					return;
				}
				let result: CallbackResult;
				try {
					// Rebuild against the fixed redirect URI: the request target may
					// be origin-form, and the host header is never trusted.
					result = validateBrowserCallback(`${REDIRECT_URI}${requestUrl.search}`, expectedState);
				} catch {
					sendPage(response, 400, "Invalid authorization callback. Return to the app and try again.");
					return;
				}
				claimed = true;
				sendPage(response, 200, "Authorization received. You may close this window.");
				finish(result);
			})().catch(() => {
				try {
					sendPage(response, 400, "Invalid authorization callback. Return to the app and try again.");
				} catch {
					// The response may already be closed.
				}
			});
		});

		server.once("error", () => {
			closeServer();
			reject(new SubscriptionError("subscription_unknown"));
		});
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			server.removeAllListeners("error");
			server.on("error", () => {
				finish({ error: new SubscriptionError("subscription_unknown") });
				closeServer();
			});
			resolve({
				wait,
				close: () => {
					finish({ error: new SubscriptionError("subscription_cancelled") });
					closeServer();
				},
			});
		});
	});
}

function requireTokenString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new SubscriptionError("subscription_unknown");
	return value;
}

function accountIdFromAccessToken(access: string): string {
	const parts = access.split(".");
	if (parts.length !== 3) throw new SubscriptionError("subscription_unknown");
	const payloadPart = parts[1];
	if (!payloadPart) throw new SubscriptionError("subscription_unknown");
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
	} catch {
		throw new SubscriptionError("subscription_unknown");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SubscriptionError("subscription_unknown");
	const auth = (payload as Record<string, unknown>)[JWT_CLAIM_PATH];
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new SubscriptionError("subscription_unknown");
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) throw new SubscriptionError("subscription_unknown");
	return accountId;
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				code_verifier: verifier,
				redirect_uri: REDIRECT_URI,
			}),
			signal,
		});
	} catch {
		if (signal.aborted) throw safeAbortReason(signal);
		throw new SubscriptionError("subscription_network");
	}
	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {
			// The body is intentionally discarded without exposing it.
		}
		throw new SubscriptionError("subscription_unknown");
	}
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw new SubscriptionError("subscription_unknown");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SubscriptionError("subscription_unknown");
	const token = raw as Record<string, unknown>;
	const access = requireTokenString(token.access_token);
	const refresh = requireTokenString(token.refresh_token);
	const expiresIn = token.expires_in;
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new SubscriptionError("subscription_unknown");
	}
	const expires = Date.now() + expiresIn * 1000;
	if (!Number.isSafeInteger(expires) || expires <= Date.now()) throw new SubscriptionError("subscription_unknown");
	return {
		type: "oauth",
		access,
		refresh,
		expires,
		accountId: accountIdFromAccessToken(access),
	};
}

/**
 * Run the browser half of the Codex login. The callback listener is optional:
 * if 127.0.0.1:1455 cannot be bound, `onListening(false)` is reported and the
 * user can still paste the complete redirect URL through manual_code.
 *
 * `onListening` receives true after the listener binds, or false when the
 * fixed port cannot be bound so the caller can enable the manual fallback.
 * Abort, timeout, manual input, and callback all share one cleanup path that
 * closes the listener and cancels the pending prompt.
 */
export async function browserOAuthLogin(
	interaction: AuthInteraction,
	onListening: (listening: boolean) => void,
): Promise<OAuthCredential> {
	if (interaction.signal?.aborted) throw safeAbortReason(interaction.signal);

	const { verifier, challenge } = generatePkce();
	const state = randomBytes(16).toString("hex");
	const url = authorizationUrl(state, challenge);
	const flowAbort = new AbortController();
	const onInteractionAbort = (): void => flowAbort.abort(new SubscriptionError("subscription_cancelled"));
	interaction.signal?.addEventListener("abort", onInteractionAbort, { once: true });
	const timeout = setTimeout(() => flowAbort.abort(new SubscriptionError("subscription_expired")), LOGIN_TIMEOUT_MS);
	timeout.unref();
	const promptAbort = new AbortController();
	let listener: CallbackListener | undefined;
	let abortListener: (() => void) | undefined;

	try {
		if (flowAbort.signal.aborted) throw safeAbortReason(flowAbort.signal);
		try {
			listener = await startCallbackListener(state);
		} catch {
			if (flowAbort.signal.aborted) throw safeAbortReason(flowAbort.signal);
			onListening(false);
		}
		if (listener) {
			if (flowAbort.signal.aborted) {
				onListening(false);
				throw safeAbortReason(flowAbort.signal);
			}
			onListening(true);
		}

		interaction.notify({
			type: "auth_url",
			url,
			instructions:
				"A browser window should open. Complete login to finish. If the callback cannot reach this machine, paste the complete redirect URL here.",
		});

		const promptSignal = AbortSignal.any([flowAbort.signal, promptAbort.signal]);
		const manual = Promise.resolve()
			.then(() =>
				interaction.prompt({
					type: "manual_code",
					message: "Complete login in your browser, or paste the final redirect URL here:",
					placeholder: REDIRECT_URI,
					signal: promptSignal,
				}),
			)
			.then((input) => validateBrowserCallback(input, state));
		void manual.catch(() => {});

		const callback = listener?.wait ?? new Promise<CallbackResult>(() => {});
		void callback.catch(() => {});

		const aborted = new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(safeAbortReason(flowAbort.signal));
			if (flowAbort.signal.aborted) abortListener();
			else flowAbort.signal.addEventListener("abort", abortListener, { once: true });
		});

		const result = await Promise.race([manual, callback, aborted]);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const credential = await exchangeAuthorizationCode(result.code, verifier, flowAbort.signal);
		if (flowAbort.signal.aborted) throw safeAbortReason(flowAbort.signal);
		return credential;
	} catch (error) {
		if (flowAbort.signal.aborted) throw safeAbortReason(flowAbort.signal);
		if (error instanceof SubscriptionError) throw error;
		throw new SubscriptionError("subscription_unknown");
	} finally {
		clearTimeout(timeout);
		if (abortListener) flowAbort.signal.removeEventListener("abort", abortListener);
		interaction.signal?.removeEventListener("abort", onInteractionAbort);
		promptAbort.abort();
		listener?.close();
	}
}
