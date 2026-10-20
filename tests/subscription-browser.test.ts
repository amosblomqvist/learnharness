/**
 * Browser OAuth adapter for the Codex subscription. These tests exercise the
 * real module and a real 127.0.0.1:1455 loopback listener; only the token
 * endpoint fetch is replaced, so no external network or provider credential is
 * involved. Tests in this file are serialized so the fixed callback port has a
 * single owner.
 */

import assert from "node:assert/strict";
import { createServer, get, type Server } from "node:http";
import { afterEach, describe, it, mock } from "node:test";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { SubscriptionError } from "../src/core/subscription.ts";
import { browserOAuthLogin, validateBrowserCallback } from "../src/server/subscription-browser.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK = "http://localhost:1455/auth/callback";
const JWT_CLAIM = "https://api.openai.com/auth";
const ORIGINAL_FETCH = globalThis.fetch;

interface CallbackResponse {
	status: number;
	body: string;
}

interface InteractionFixture {
	interaction: AuthInteraction;
	authUrl: Promise<string>;
	events: AuthEvent[];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("test wait timed out");
		await delay(10);
	}
}

function fakeJwt(accountId: string | null): string {
	const payload = accountId === null ? {} : { [JWT_CLAIM]: { chatgpt_account_id: accountId } };
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.signature`;
}

function tokenResponse(accountId: string | null = "acct_test", overrides: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			access_token: fakeJwt(accountId),
			refresh_token: "refresh-test",
			expires_in: 3600,
			...overrides,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function interactionFixture(
	promptFactory: (prompt: AuthPrompt, authUrl: string) => Promise<string>,
): InteractionFixture {
	let resolveAuthUrl: (url: string) => void = () => {};
	const authUrl = new Promise<string>((resolve) => {
		resolveAuthUrl = resolve;
	});
	const events: AuthEvent[] = [];
	const interaction: AuthInteraction = {
		notify(event) {
			events.push(event);
			if (event.type === "auth_url") resolveAuthUrl(event.url);
		},
		async prompt(prompt) {
			return promptFactory(prompt, await authUrl);
		},
	};
	return { interaction, authUrl, events };
}

function requestCallback(path: string): Promise<CallbackResponse> {
	return new Promise((resolve, reject) => {
		const request = get(`http://127.0.0.1:1455${path}`, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
	});
}

function redirectPath(state: string, code = "callback-code"): string {
	return `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

function occupyCallbackPort(): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((_request, response) => response.end("occupied"));
		server.once("error", reject);
		server.listen(1455, "127.0.0.1", () => {
			server.removeAllListeners("error");
			resolve(server);
		});
	});
}

function releaseServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function restoreFetch(): void {
	globalThis.fetch = ORIGINAL_FETCH;
}

afterEach(() => {
	restoreFetch();
	mock.timers.reset();
});

describe("validateBrowserCallback", () => {
	const state = "state-123";
	const accepted = [CALLBACK, "http://127.0.0.1:1455/auth/callback"];

	for (const base of accepted) {
		it(`accepts one non-empty code and matching state from ${base}`, () => {
			assert.deepEqual(validateBrowserCallback(`${base}?code=a%2Fb&state=${state}`, state), { code: "a/b" });
		});
	}

	it("allows unrelated callback query parameters", () => {
		assert.deepEqual(validateBrowserCallback(`${CALLBACK}?code=abc&state=${state}&foo=bar`, state), { code: "abc" });
	});

	it("rejects bare codes, wrong hosts, ports, paths, schemes, credentials, and fragments", () => {
		const inputs = [
			"abc",
			"",
			"http://evil.example:1455/auth/callback?code=abc&state=" + state,
			"http://localhost:1456/auth/callback?code=abc&state=" + state,
			"https://localhost:1455/auth/callback?code=abc&state=" + state,
			"/auth/callback?code=abc&state=" + state,
			"http://localhost:1455/auth/other?code=abc&state=" + state,
			"http://user:pass@localhost:1455/auth/callback?code=abc&state=" + state,
			`${CALLBACK}?code=abc&state=${state}#fragment`,
		];
		for (const input of inputs) {
			assert.throws(
				() => validateBrowserCallback(input, state),
				(error: unknown) => error instanceof SubscriptionError && error.code === "subscription_invalid_input",
				input,
			);
		}
	});

	it("rejects missing, empty, duplicated, and mismatched parameters", () => {
		const inputs = [
			`${CALLBACK}?state=${state}`,
			`${CALLBACK}?code=abc`,
			`${CALLBACK}?code=&state=${state}`,
			`${CALLBACK}?code=abc&state=`,
			`${CALLBACK}?code=abc&code=def&state=${state}`,
			`${CALLBACK}?code=abc&state=${state}&state=${state}`,
			`${CALLBACK}?code=abc&state=other`,
			`${CALLBACK}?code=abc&state=${state}&error=access_denied`,
			`${CALLBACK}?code=abc&state=${state}&error_description=denied`,
		];
		for (const input of inputs) {
			assert.throws(
				() => validateBrowserCallback(input, state),
				(error: unknown) => error instanceof SubscriptionError && error.code === "subscription_invalid_input",
				input,
			);
		}
	});
});

describe("browserOAuthLogin", () => {
	it("reports callbackListening=false and completes through a full manual callback when 1455 is busy", async () => {
		const blocker = await occupyCallbackPort();
		const listening: boolean[] = [];
		let tokenBody: URLSearchParams | undefined;
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), TOKEN_URL);
			tokenBody = init?.body as URLSearchParams;
			return tokenResponse("acct_manual", { refresh_token: "refresh-manual" });
		};

		try {
			const { interaction, authUrl, events } = interactionFixture(async (_prompt, url) => {
				const expectedState = new URL(url).searchParams.get("state");
				assert.ok(expectedState);
				return `${CALLBACK}?code=manual-code&state=${expectedState}`;
			});

			const credential = await browserOAuthLogin(interaction, (value) => listening.push(value));

			assert.deepEqual(listening, [false]);
			assert.equal((await authUrl).startsWith("https://auth.openai.com/oauth/authorize?"), true);
			assert.equal(events.some((event) => event.type === "progress"), true);
			assert.equal(tokenBody?.get("grant_type"), "authorization_code");
			assert.equal(tokenBody?.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
			assert.equal(tokenBody?.get("code"), "manual-code");
			assert.equal(tokenBody?.get("redirect_uri"), CALLBACK);
			assert.ok((tokenBody?.get("code_verifier") ?? "").length > 0);

			const auth = new URL(await authUrl);
			assert.equal(auth.searchParams.get("redirect_uri"), CALLBACK);
			assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
			assert.equal(auth.searchParams.get("scope"), "openid profile email offline_access");
			assert.equal(credential.type, "oauth");
			assert.equal(credential.access, fakeJwt("acct_manual"));
			assert.equal(credential.refresh, "refresh-manual");
			assert.equal(credential.accountId, "acct_manual");
			assert.ok(credential.expires > Date.now());
		} finally {
			await releaseServer(blocker);
		}
	});

	it("uses a real 127.0.0.1:1455 listener, claims a callback once, and rejects a replay", async () => {
		const listening: boolean[] = [];
		let releaseToken: () => void = () => {};
		const tokenGate = new Promise<void>((resolve) => {
			releaseToken = resolve;
		});
		let tokenCode: string | undefined;
		globalThis.fetch = async (_input, init) => {
			tokenCode = (init?.body as URLSearchParams).get("code") ?? undefined;
			await tokenGate;
			return tokenResponse("acct_listener");
		};

		const { interaction, authUrl, events } = interactionFixture(
			(prompt) =>
				new Promise<string>((_resolve, reject) => {
					const signal = prompt.signal;
					if (signal?.aborted) {
						reject(new Error("prompt aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
				}),
		);

		const login = browserOAuthLogin(interaction, (value) => listening.push(value));
		try {
			await waitUntil(() => listening.length > 0);
			assert.deepEqual(listening, [true]);
			const auth = new URL(await authUrl);
			const state = auth.searchParams.get("state");
			assert.ok(state);

			const first = await requestCallback(redirectPath(state));
			assert.equal(first.status, 200);
			assert.equal(first.body.includes("Authorization received"), true);

			const replay = await requestCallback(redirectPath(state, "replayed-code"));
			assert.equal(replay.status, 409);
			assert.equal(replay.body.includes("already used"), true);

			releaseToken();
			const credential = await login;
			assert.equal(tokenCode, "callback-code");
			assert.equal(credential.accountId, "acct_listener");
			assert.equal(events.some((event) => event.type === "auth_url"), true);
		} finally {
			releaseToken();
			await login.catch(() => {});
		}

		await waitUntil(() => listening.length > 0);
		await assert.rejects(requestCallback(redirectPath("state-123")), /ECONNREFUSED|socket hang up/);
	});

	it("does not consume the callback for a wrong state and succeeds on the exact state", async () => {
		const listening: boolean[] = [];
		globalThis.fetch = async () => tokenResponse("acct_state");
		const { interaction, authUrl } = interactionFixture(
			(prompt) =>
				new Promise<string>((_resolve, reject) => {
					prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
				}),
		);

		const login = browserOAuthLogin(interaction, (value) => listening.push(value));
		try {
			await waitUntil(() => listening.length > 0);
			const state = new URL(await authUrl).searchParams.get("state");
			assert.ok(state);

			const wrong = await requestCallback(redirectPath(`${state}-wrong`));
			assert.equal(wrong.status, 400);
			assert.equal(wrong.body.includes("Invalid authorization callback"), true);

			const right = await requestCallback(redirectPath(state));
			assert.equal(right.status, 200);
			const credential = await login;
			assert.equal(credential.accountId, "acct_state");
		} finally {
			await login.catch(() => {});
		}
	});

	it("aborts the pending prompt and closes the listener on cancellation", async () => {
		const controller = new AbortController();
		const listening: boolean[] = [];
		let promptAborted = false;
		globalThis.fetch = async () => {
			throw new Error("fetch must not run after cancellation");
		};
		const { interaction, authUrl } = interactionFixture(
			(prompt) =>
				new Promise<string>((_resolve, reject) => {
					const onAbort = (): void => {
						promptAborted = true;
						reject(new Error("prompt aborted"));
					};
					if (prompt.signal?.aborted) onAbort();
					else prompt.signal?.addEventListener("abort", onAbort, { once: true });
				}),
		);
		interaction.signal = controller.signal;

		const login = browserOAuthLogin(interaction, (value) => listening.push(value));
		try {
			await waitUntil(() => listening.length > 0);
			const state = new URL(await authUrl).searchParams.get("state");
			assert.ok(state);
			controller.abort();
			await assert.rejects(
				login,
				(error: unknown) => error instanceof SubscriptionError && error.code === "subscription_cancelled",
			);
			assert.equal(promptAborted, true);
			await delay(20);
			await assert.rejects(requestCallback(redirectPath(state)), /ECONNREFUSED|socket hang up/);
		} finally {
			await login.catch(() => {});
		}
	});


	it("expires the login, closes the listener, and aborts the pending prompt", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const listening: boolean[] = [];
		let promptAborted = false;
		let resolveListening: () => void = () => {};
		const listeningReady = new Promise<void>((resolve) => {
			resolveListening = resolve;
		});
		const { interaction, authUrl } = interactionFixture(
			(prompt) =>
				new Promise<string>((_resolve, reject) => {
					const onAbort = (): void => {
						promptAborted = true;
						reject(new Error("prompt aborted"));
					};
					if (prompt.signal?.aborted) onAbort();
					else prompt.signal?.addEventListener("abort", onAbort, { once: true });
				}),
		);

		const login = browserOAuthLogin(interaction, (value) => {
			listening.push(value);
			if (value) resolveListening();
		});
		try {
			await listeningReady;
			const state = new URL(await authUrl).searchParams.get("state");
			assert.ok(state);
			mock.timers.tick(15 * 60_000);
			await assert.rejects(
				login,
				(error: unknown) => error instanceof SubscriptionError && error.code === "subscription_expired",
			);
			assert.equal(promptAborted, true);
			await assert.rejects(requestCallback(redirectPath(state)), /ECONNREFUSED|socket hang up/);
		} finally {
			await login.catch(() => {});
		}
	});

	it("fails safely when the token has no accountId", async () => {
		const blocker = await occupyCallbackPort();
		globalThis.fetch = async () => tokenResponse(null);
		try {
			const { interaction } = interactionFixture(async (_prompt, url) => {
				const state = new URL(url).searchParams.get("state");
				assert.ok(state);
				return `${CALLBACK}?code=bad-account&state=${state}`;
			});
			await assert.rejects(
				browserOAuthLogin(interaction, () => {}),
				(error: unknown) =>
					error instanceof SubscriptionError &&
					error.code === "subscription_unknown" &&
					!error.message.includes("bad-account") &&
					!error.message.includes(fakeJwt(null)),
			);
		} finally {
			await releaseServer(blocker);
		}
	});

	it("never exposes a provider error body or token in a thrown error", async () => {
		const blocker = await occupyCallbackPort();
		globalThis.fetch = async () =>
			new Response("raw-secret-provider-body", {
				status: 400,
				headers: { "content-type": "text/plain" },
			});
		try {
			const { interaction } = interactionFixture(async (_prompt, url) => {
				const state = new URL(url).searchParams.get("state");
				assert.ok(state);
				return `${CALLBACK}?code=secret-code&state=${state}`;
			});
			await assert.rejects(
				browserOAuthLogin(interaction, () => {}),
				(error: unknown) =>
					error instanceof SubscriptionError &&
					!error.message.includes("raw-secret-provider-body") &&
					!error.message.includes("secret-code"),
			);
		} finally {
			await releaseServer(blocker);
		}
	});
});

