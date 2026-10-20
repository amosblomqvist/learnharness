/**
 * Subscription settings surface (issue #8, settings wave 2026-10-19).
 *
 * The section's only transport seam is global fetch: every request must
 * carry the subscription guard header, mutations must be JSON, and no
 * credential material may enter browser storage. The tests mount real
 * React handlers against an isolated DOM (the setup-dialog pattern) and
 * stub fetch wholly, so no request leaves the process.
 *
 * First slice (TDD): the status read and the disconnected surface.
 * Event coverage for the browser/device/manual flows lives below as the
 * component grows; SSR pins the loading frame because effects never run
 * under renderToStaticMarkup.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";

import {
	SubscriptionSection,
	expiryLabel,
	manualCallbackProblem,
	sanitizeSubscriptionStatus,
	subscriptionLink,
} from "../components/settings/subscription-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { SubscriptionStatus } from "../src/core/subscription.ts";

// As in setup-dialog-interaction: linkedom supplies the DOM, fetch is
// wholly stubbed. linkedom has no Storage, so recording stores below make
// a stray write observable; the section must leave both untouched.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });

// linkedom ships no Storage; install recording stores so a stray write is
// observable instead of throwing. The section must leave both untouched.
const storageWrites: string[] = [];
function recordingStorage(): Storage {
	return {
		get length() {
			return 0;
		},
		clear() {},
		getItem() {
			return null;
		},
		key() {
			return null;
		},
		removeItem() {},
		setItem(key: string) {
			storageWrites.push(key);
		},
	};
}
for (const name of ["localStorage", "sessionStorage"] as const) {
	(dom.window as unknown as Record<string, unknown>)[name] = recordingStorage();
}

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let respond: () => Response | Promise<Response> = () => Response.json({ state: "disconnected" });
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function headerOf(init: RequestInit, name: string): string | null {
	return new Headers(init.headers).get(name);
}

function element(selector: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(selector);
	assert.ok(node, `expected ${selector}`);
	return node;
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function click(selector: string): Promise<void> {
	const node = element(selector);
	await act(async () => {
		const dispatched = new dom.window.Event("click", {
			bubbles: true,
			cancelable: true,
		});
		Object.assign(dispatched, { button: 0, detail: 1 });
		node.dispatchEvent(dispatched);
	});
	await settle();
}

async function fill(selector: string, value: string): Promise<void> {
	const input = element(selector) as HTMLInputElement;
	const setValue =
		Object.getOwnPropertyDescriptor(input, "value")?.set ??
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	assert.ok(setValue, "native input value setter");
	await act(async () => {
		setValue.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

async function submit(selector: string): Promise<void> {
	await act(async () => {
		element(selector).dispatchEvent(
			new dom.window.Event("submit", { bubbles: true, cancelable: true }),
		);
	});
	await settle();
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await settle();
	}
	assert.fail("condition was not met before the timeout");
}

async function mount(pollIntervalMs = 60_000): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<SubscriptionSection pollIntervalMs={pollIntervalMs} />);
	});
	await settle();
}

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
}

const STATUS_PATH = "/api/subscription";
const ATTEMPTS_PATH = "/api/subscription/attempts";
const AUTH_URL =
	"https://auth.openai.com/oauth/authorize?state=state-1&code_challenge=challenge-1";
const CALLBACK_URL =
	"http://localhost:1455/auth/callback?code=code-1&state=state-1";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const RAW_PROVIDER_DETAIL = "RAW provider detail sk-live-secret";

type Attempt = NonNullable<SubscriptionStatus["attempt"]>;

function jsonStatus(
	status: SubscriptionStatus,
	init?: ResponseInit,
): Response {
	return Response.json(status, init);
}

function jsonError(code: string, status = 409): Response {
	return Response.json(
		{ error: { code, message: RAW_PROVIDER_DETAIL } },
		{ status },
	);
}

function browserAttempt(overrides: Partial<Attempt> = {}): Attempt {
	return {
		id: "att-1",
		method: "browser",
		// A hair under ten minutes, so the rounded label is deterministic.
		expiresAt: Date.now() + 9 * 60_000 + 30_000,
		authorizationUrl: AUTH_URL,
		promptId: "prompt-1",
		manualAvailable: true,
		callbackListening: true,
		ownedHere: true,
		...overrides,
	};
}

function deviceAttempt(overrides: Partial<Attempt> = {}): Attempt {
	return {
		id: "att-device",
		method: "device_code",
		expiresAt: Date.now() + 9 * 60_000 + 30_000,
		verificationUri: DEVICE_URL,
		userCode: "ABCD-EFGH",
		ownedHere: true,
		...overrides,
	};
}

function authorizing(attempt: Attempt = browserAttempt()): SubscriptionStatus {
	return { state: "authorizing", attempt };
}

function connected(account = "learner@example.test"): SubscriptionStatus {
	return { state: "connected", account };
}

beforeEach(() => {
	calls = [];
	storageWrites.length = 0;
	respond = () => jsonStatus({ state: "disconnected" });
	globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return respond();
	};
});

afterEach(async () => {
	await unmount();
	globalThis.fetch = originalFetch;
});

describe("subscriptionLink", () => {
	it("allows only HTTPS auth.openai.com links", () => {
		assert.equal(
			subscriptionLink("https://auth.openai.com/oauth/authorize?state=s1"),
			"https://auth.openai.com/oauth/authorize?state=s1",
		);
		assert.equal(
			subscriptionLink("https://auth.openai.com/codex/device"),
			"https://auth.openai.com/codex/device",
		);
		for (const rejected of [
			undefined,
			"",
			"http://auth.openai.com/oauth/authorize",
			"https://auth.openai.com.evil.example/oauth/authorize",
			"https://evil.example/oauth/authorize",
			"javascript:alert(1)",
			"https://user:pass@auth.openai.com/oauth/authorize",
			"https://auth.openai.com:8443/oauth/authorize",
			"https://auth.openai.com/account",
			"https://auth.openai.com/oauth/authorize#fragment",
		]) {
			assert.equal(subscriptionLink(rejected), null, String(rejected));
		}
	});
});

describe("manualCallbackProblem", () => {
	const callback = "http://localhost:1455/auth/callback?code=code-1&state=state-1";

	it("accepts a complete loopback callback URL whose state matches the attempt", () => {
		assert.equal(manualCallbackProblem(callback, "https://auth.openai.com/oauth/authorize?state=state-1"), null);
		assert.equal(manualCallbackProblem(`${callback.replace("localhost", "127.0.0.1")}`), null);
	});

	it("rejects bare codes, incomplete URLs, wrong origins, and state mismatches without echoing values", () => {
		for (const bad of [
			"code-1",
			"",
			"http://localhost:1455/auth/callback?code=code-1",
			"http://localhost:1455/auth/callback?state=state-1",
			"http://localhost:1455/auth/callback?code=a&code=b&state=state-1",
			"http://localhost:1455/auth/callback?code=code-1&state=a&state=b",
			"http://example.com:1455/auth/callback?code=code-1&state=state-1",
			"http://localhost:1455/not-the-callback?code=code-1&state=state-1",
			"https://localhost:1455/auth/callback?code=code-1&state=state-1",
			"http://[::1]:1455/auth/callback?code=code-1&state=state-1",
			"http://localhost:1456/auth/callback?code=code-1&state=state-1",
			"http://localhost:1455/auth/callback?code=code-1&state=state-1#fragment",
			"http://localhost:1455/auth/callback?error=access_denied&state=state-1",
		]) {
			const problem = manualCallbackProblem(bad);
			assert.ok(problem, bad);
			assert.ok(!problem.includes("code-1"), "the value is never echoed");
		}
		const mismatch = manualCallbackProblem(
			callback,
			"https://auth.openai.com/oauth/authorize?state=other-state",
		);
		assert.ok(mismatch);
		assert.ok(!mismatch.includes("state-1"));
	});
});

describe("SubscriptionSection — first slice", () => {
	it("SSR pins the loading frame", () => {
		const html = renderToStaticMarkup(<SubscriptionSection />);
		assert.match(html, /data-testid="subscription-section"/);
		assert.match(html, /Loading subscription…/);
	});

	it("reads status with the guard header and renders the disconnected surface", async () => {
		await mount();

		assert.equal(calls.length, 1, "one status read on mount");
		assert.equal(calls[0]!.url, "/api/subscription");
		assert.equal(calls[0]!.init.method ?? "GET", "GET");
		assert.equal(headerOf(calls[0]!.init, "X-LearnHarness-Subscription"), "1");
		assert.equal(calls[0]!.init.cache, "no-store");
		assert.equal(calls[0]!.init.credentials, "same-origin");

		assert.match(element('[data-testid="subscription-state"]').textContent ?? "", /Not connected/);
		assert.ok(document.querySelector('[data-testid="subscription-start-browser"]'));
		assert.ok(document.querySelector('[data-testid="subscription-start-device"]'));
		assert.ok(document.querySelector('[data-testid="subscription-legacy-warning"]'));
		assert.ok(document.querySelector('[data-testid="subscription-plaintext-warning"]'));

		// No browser persistence, no session store, no local record.
		assert.equal(storageWrites.length, 0);
	});
});

describe("status sanitization and expiry", () => {
	it("pins milliseconds, never seconds, and drops unknown states and fields", () => {
		assert.equal(expiryLabel(Date.now() - 1), "This attempt has expired.");
		// 1_700_000_000 is a seconds epoch; reading it as milliseconds must
		// be expired rather than silently guessing a unit.
		assert.equal(expiryLabel(1_700_000_000), "This attempt has expired.");
		assert.equal(
			expiryLabel(Date.now() + 60_000, Date.now()),
			"Expires in 1 minute.",
		);

		const sanitized = sanitizeSubscriptionStatus({
			state: "authorizing",
			attempt: {
				id: "att-1",
				method: "browser",
				expiresAt: 123,
				ownedHere: false,
				promptId: "prompt-1",
				manualAvailable: true,
				callbackListening: false,
				authorizationUrl: AUTH_URL,
				extra: "drop me",
			},
		});
		assert.ok(sanitized?.attempt);
		assert.equal(sanitized.attempt.ownedHere, false);
		assert.equal(sanitized.attempt.promptId, "prompt-1");
		assert.equal("extra" in sanitized.attempt, false);

		assert.equal(sanitizeSubscriptionStatus({ state: "weird" }), null);
		const dropped = sanitizeSubscriptionStatus({
			state: "authorizing",
			attempt: { id: "x", method: "other", expiresAt: 1 },
		});
		assert.equal(dropped?.attempt, undefined);

		const unknown = sanitizeSubscriptionStatus({
			state: "error",
			error: { code: "raw", message: "raw" },
		});
		assert.equal(unknown?.error?.code, "subscription_unknown");
	});
});

describe("SubscriptionSection — browser authorization", () => {
	it("starts a browser attempt, validates the full callback URL, and clears the draft on submit", async () => {
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				return jsonStatus({ state: "disconnected" });
			}
			if (call.url === ATTEMPTS_PATH && method === "POST") {
				return jsonStatus(authorizing(), { status: 202 });
			}
			if (call.url === `${ATTEMPTS_PATH}/att-1/input` && method === "POST") {
				return jsonStatus(authorizing());
			}
			if (call.url === `${ATTEMPTS_PATH}/att-1` && method === "DELETE") {
				return jsonStatus({ state: "disconnected" });
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await click('[data-testid="subscription-start-browser"]');

		const start = calls.find((call) => call.url === ATTEMPTS_PATH)!;
		assert.equal(start.init.method, "POST");
		assert.equal(headerOf(start.init, "content-type"), "application/json");
		assert.equal(
			headerOf(start.init, "X-LearnHarness-Subscription"),
			"1",
		);
		assert.deepEqual(JSON.parse(String(start.init.body)), {
			method: "browser",
		});

		assert.match(
			element('[data-testid="subscription-state"]').textContent ?? "",
			/Waiting for authorization/,
		);
		assert.equal(
			element('[data-testid="subscription-expiry"]').textContent,
			"Expires in 10 minutes.",
		);
		const link = element(
			'[data-testid="subscription-browser-link"]',
		) as HTMLAnchorElement;
		assert.equal(link.getAttribute("href"), AUTH_URL);
		assert.equal(link.getAttribute("target"), "_blank");
		assert.equal(link.getAttribute("rel"), "noreferrer");
		assert.match(
			element('[data-testid="subscription-listener-active"]').textContent ?? "",
			/local callback/,
		);

		const input = element(
			'[data-testid="subscription-prompt-input"]',
		) as HTMLInputElement;
		// linkedom does not reflect React's autoComplete prop; the attribute
		// is present in the JSX and is verified by source review, not here.
		assert.equal(input.disabled, false);

		await fill('[data-testid="subscription-prompt-input"]', "code-1");
		await submit('[data-testid="subscription-prompt-form"]');
		assert.match(
			element('[data-testid="subscription-prompt-error"]').textContent ?? "",
			/complete callback URL/,
		);
		assert.equal(
			calls.filter((call) => call.url.endsWith("/input")).length,
			0,
			"a bare code never reaches the server",
		);

		await fill('[data-testid="subscription-prompt-input"]', CALLBACK_URL);
		await submit('[data-testid="subscription-prompt-form"]');
		const submitCall = calls.find((call) => call.url.endsWith("/input"))!;
		assert.equal(submitCall.init.method, "POST");
		assert.equal(headerOf(submitCall.init, "content-type"), "application/json");
		assert.deepEqual(JSON.parse(String(submitCall.init.body)), {
			promptId: "prompt-1",
			value: CALLBACK_URL,
		});
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.value,
			"",
			"the draft is ephemeral",
		);

		await click('[data-testid="subscription-cancel"]');
		assert.equal(
			document.querySelector('[data-testid="subscription-prompt-form"]'),
			null,
		);
		assert.match(
			element('[data-testid="subscription-state"]').textContent ?? "",
			/Not connected/,
		);
		assert.equal(storageWrites.length, 0);
	});
});

describe("SubscriptionSection — device authorization", () => {
	it("starts a device attempt and shows the code plus an allowlisted verification link", async () => {
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				return jsonStatus({ state: "disconnected" });
			}
			if (call.url === ATTEMPTS_PATH && method === "POST") {
				return jsonStatus(authorizing(deviceAttempt()), { status: 202 });
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await click('[data-testid="subscription-start-device"]');

		const start = calls.find((call) => call.url === ATTEMPTS_PATH)!;
		assert.equal(start.init.method, "POST");
		assert.deepEqual(JSON.parse(String(start.init.body)), {
			method: "device_code",
		});
		assert.equal(
			element('[data-testid="subscription-user-code"]').textContent,
			"ABCD-EFGH",
		);
		const link = element(
			'[data-testid="subscription-verification-link"]',
		) as HTMLAnchorElement;
		assert.equal(link.getAttribute("href"), DEVICE_URL);
		assert.equal(link.getAttribute("target"), "_blank");
		assert.equal(link.getAttribute("rel"), "noreferrer");
		assert.equal(
			document.querySelector('[data-testid="subscription-browser-link"]'),
			null,
		);
		assert.equal(storageWrites.length, 0);
	});
});

describe("SubscriptionSection — provider link allowlist", () => {
	it("does not render a browser URL off the supplier host", async () => {
		respond = () =>
			jsonStatus(
				authorizing(
					browserAttempt({
						authorizationUrl: "https://auth.openai.com.evil.example/oauth",
						promptId: undefined,
						manualAvailable: false,
						callbackListening: true,
					}),
				),
			);

		await mount();
		assert.equal(
			document.querySelector('[data-testid="subscription-browser-link"]'),
			null,
		);
		assert.match(
			element('[data-testid="subscription-browser-link-blocked"]').textContent ??
				"",
			/outside the allowed HTTPS host/,
		);
		assert.ok(
			!document.body.innerHTML.includes("auth.openai.com.evil.example"),
			"the rejected URL never reaches the DOM",
		);
	});

	it("does not render a verification URL off the supplier host", async () => {
		respond = () =>
			jsonStatus(
				authorizing(
					deviceAttempt({
						verificationUri: "https://evil.example/codex/device",
					}),
				),
			);

		await mount();
		assert.equal(
			document.querySelector('[data-testid="subscription-verification-link"]'),
			null,
		);
		assert.match(
			element(
				'[data-testid="subscription-verification-link-blocked"]',
			).textContent ?? "",
			/outside the allowed HTTPS host/,
		);
		assert.equal(
			element('[data-testid="subscription-user-code"]').textContent,
			"ABCD-EFGH",
		);
		assert.ok(!document.body.innerHTML.includes("evil.example"));
	});
});

describe("SubscriptionSection — attempt ownership and manual fallback", () => {
	it("disables manual input for an attempt owned by another process", async () => {
		respond = () =>
			jsonStatus(
				authorizing(
					browserAttempt({ ownedHere: false, callbackListening: false }),
				),
			);

		await mount();
		assert.match(
			element('[data-testid="subscription-wrong-owner"]').textContent ?? "",
			/another LearnHarness service process/,
		);
		assert.match(
			element('[data-testid="subscription-listener-unavailable"]')
				.textContent ?? "",
			/owned by another process/,
		);
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.disabled,
			true,
		);
		assert.equal(
			(element('[data-testid="subscription-prompt-submit"]') as HTMLButtonElement)
				.disabled,
			true,
		);
		assert.equal(
			(element('[data-testid="subscription-switch-device"]') as HTMLButtonElement)
				.disabled,
			true,
		);
		assert.equal(
			(element('[data-testid="subscription-cancel"]') as HTMLButtonElement)
				.disabled,
			true,
		);
		assert.equal(
			document.querySelector('[data-testid="subscription-browser-link"]'),
			null,
		);
	});

	it("shows the port-unavailable warning with manual input when the listener did not start", async () => {
		respond = () =>
			jsonStatus(authorizing(browserAttempt({ callbackListening: false })));

		await mount();
		const warning =
			element('[data-testid="subscription-listener-unavailable"]').textContent ??
			"";
		assert.match(warning, /port 1455/);
		assert.match(warning, /Paste the complete callback URL/);
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.disabled,
			false,
		);
		assert.ok(
			document.querySelector('[data-testid="subscription-switch-device"]'),
		);
	});

	it("offers the device alternative when manual input is unavailable", async () => {
		respond = () =>
			jsonStatus(
				authorizing(
					browserAttempt({
						callbackListening: false,
						manualAvailable: false,
						promptId: undefined,
					}),
				),
			);

		await mount();
		assert.match(
			element('[data-testid="subscription-listener-unavailable"]').textContent ??
				"",
			/device-code/,
		);
		assert.equal(
			document.querySelector('[data-testid="subscription-prompt-form"]'),
			null,
		);
		assert.equal(
			(element('[data-testid="subscription-switch-device"]') as HTMLButtonElement)
				.disabled,
			false,
		);
	});

	it("cancels the browser attempt before starting a device attempt", async () => {
		let cancelled = false;
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				return jsonStatus(
					authorizing(
						browserAttempt({
							callbackListening: false,
							manualAvailable: false,
							promptId: undefined,
						}),
					),
				);
			}
			if (call.url === `${ATTEMPTS_PATH}/att-1` && method === "DELETE") {
				cancelled = true;
				return jsonStatus({ state: "disconnected" });
			}
			if (call.url === ATTEMPTS_PATH && method === "POST" && cancelled) {
				return jsonStatus(authorizing(deviceAttempt()), { status: 202 });
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await click('[data-testid="subscription-switch-device"]');

		assert.equal(cancelled, true);
		const start = calls
			.filter((call) => call.url === ATTEMPTS_PATH)
			.pop()!;
		assert.deepEqual(JSON.parse(String(start.init.body)), {
			method: "device_code",
		});
		assert.equal(
			element('[data-testid="subscription-user-code"]').textContent,
			"ABCD-EFGH",
		);
	});
});

describe("SubscriptionSection — safe errors", () => {
	it("maps mutation failure codes and never displays the server message", async () => {
		respond = () => {
			const call = calls[calls.length - 1]!;
			if (call.url === STATUS_PATH) {
				return jsonStatus({ state: "disconnected" });
			}
			if (call.url === ATTEMPTS_PATH) {
				return jsonError("subscription_conflict");
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await click('[data-testid="subscription-start-browser"]');

		const alert = element('[data-testid="subscription-error"]');
		assert.equal(alert.getAttribute("role"), "alert");
		assert.match(
			alert.textContent ?? "",
			/An account or authorization attempt already exists/,
		);
		assert.ok(!(alert.textContent ?? "").includes(RAW_PROVIDER_DETAIL));
		assert.ok(!document.body.innerHTML.includes(RAW_PROVIDER_DETAIL));
		assert.equal(storageWrites.length, 0);
	});

	it("shows an unknown failure when status cannot be reached and retries cleanly", async () => {
		respond = () => {
			throw new Error("ECONNREFUSED secret");
		};

		await mount();
		assert.match(
			element('[data-testid="subscription-error"]').textContent ?? "",
			/could not be confirmed/,
		);
		assert.ok(!document.body.innerHTML.includes("secret"));
		assert.ok(document.querySelector('[data-testid="subscription-retry"]'));

		respond = () => jsonStatus({ state: "disconnected" });
		await click('[data-testid="subscription-retry"]');
		assert.match(
			element('[data-testid="subscription-state"]').textContent ?? "",
			/Not connected/,
		);
	});
});

describe("SubscriptionSection — disconnect", () => {
	it("does not let a pending focus read restore connected status after disconnect", async () => {
		await mount();
		respond = () => jsonStatus(connected());
		await click('[data-testid="subscription-refresh"]');
		let finishRead!: (response: Response) => void;
		respond = () => new Promise<Response>((resolve) => { finishRead = resolve; });
		await act(async () => {
			window.dispatchEvent(new dom.window.Event("focus"));
		});
		respond = () => jsonStatus({ state: "disconnected" });
		await click('[data-testid="subscription-disconnect"]');
		await click('[data-testid="subscription-disconnect-confirm-button"]');
		await act(async () => { finishRead(jsonStatus(connected())); });
		await settle();
		assert.match(element('[data-testid="subscription-state"]').textContent ?? "", /Not connected/);
		assert.equal(element('[data-testid="subscription-refresh"]').hasAttribute("disabled"), false);
	});
	it("confirms, deletes only the local authorization, and states the provider-side caveat", async () => {
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				return jsonStatus(connected());
			}
			if (call.url === STATUS_PATH && method === "DELETE") {
				return jsonStatus({ state: "disconnected" });
			}
			return jsonStatus(connected());
		};

		await mount();
		assert.equal(
			element('[data-testid="subscription-account"]').textContent,
			"learner@example.test",
		);
		const entitlementNote =
			element('[data-testid="subscription-entitlement-note"]').textContent ?? "";
		assert.match(entitlementNote, /saved session, not a live entitlement/);
		assert.match(entitlementNote, /confirms only that this access worked/);
		assert.match(entitlementNote, /remaining quota cannot be inferred/);
		assert.doesNotMatch(entitlementNote, /remaining usage/);
		assert.match(
			element('[data-testid="subscription-plaintext-warning"]').textContent ?? "",
			/plaintext/,
		);
		const legacyWarning =
			element('[data-testid="subscription-legacy-warning"]').textContent ?? "";
		assert.match(legacyWarning, /uses a legacy third-party route/);
		assert.match(
			legacyWarning,
			/availability and policy support are not guaranteed/,
		);
		assert.match(legacyWarning, /not an official third-party permission/);
		assert.doesNotMatch(legacyWarning, /may still exist/);
		assert.doesNotMatch(legacyWarning, /revoke/);
		const sectionText = element('[data-testid="subscription-section"]').textContent ?? "";
		assert.match(sectionText, /remaining quota cannot be inferred/);
		assert.doesNotMatch(sectionText, /remaining usage/);
		assert.match(
			element('[data-testid="subscription-disconnect-warning"]').textContent ??
				"",
			/does not revoke/,
		);

		await click('[data-testid="subscription-disconnect"]');
		assert.ok(
			element('[data-testid="subscription-disconnect-confirm"]'),
		);
		assert.equal(
			calls.filter((call) => call.init.method === "DELETE").length,
			0,
			"nothing is deleted before confirmation",
		);

		await click('[data-testid="subscription-disconnect-confirm-button"]');
		const deleted = calls.find((call) => call.init.method === "DELETE")!;
		assert.equal(deleted.url, STATUS_PATH);
		assert.equal(headerOf(deleted.init, "content-type"), "application/json");
		assert.equal(
			headerOf(deleted.init, "X-LearnHarness-Subscription"),
			"1",
		);
		assert.equal(deleted.init.body, undefined);

		assert.match(
			element('[data-testid="subscription-state"]').textContent ?? "",
			/Not connected/,
		);
		const notice = element('[data-testid="subscription-notice"]').textContent ?? "";
		assert.match(notice, /removed here only/);
		assert.match(notice, /already issued/);
		assert.equal(
			document.querySelector('[data-testid="subscription-disconnect-confirm"]'),
			null,
		);
		assert.equal(storageWrites.length, 0);
	});
});

describe("SubscriptionSection — recovery states", () => {
	it("requires removing the saved authorization before reconnect", async () => {
		const reconnect: SubscriptionStatus = {
			state: "reconnect_required",
			account: "learner@example.test",
		};
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "DELETE") {
				return jsonStatus({ state: "disconnected" });
			}
			return jsonStatus(reconnect);
		};

		await mount();
		assert.ok(
			!document.querySelector('[data-testid="subscription-start-browser"]'),
		);
		assert.ok(
			!document.querySelector('[data-testid="subscription-start-device"]'),
		);
		assert.match(
			element('[data-testid="subscription-section"]').textContent ?? "",
			/Remove the saved authorization first, then sign in again/,
		);
		assert.equal(
			element('[data-testid="subscription-disconnect"]').textContent,
			"Remove saved authorization",
		);

		await click('[data-testid="subscription-disconnect"]');
		await click('[data-testid="subscription-disconnect-confirm-button"]');
		assert.match(
			element('[data-testid="subscription-state"]').textContent ?? "",
			/Not connected/,
		);
		assert.ok(
			document.querySelector('[data-testid="subscription-start-browser"]'),
		);
	});

	it("does not offer a new sign-in on an authorization error", async () => {
		const failed: SubscriptionStatus = {
			state: "error",
			error: { code: "subscription_unknown", message: RAW_PROVIDER_DETAIL },
		};
		respond = () => jsonStatus(failed);

		await mount();
		assert.ok(
			!document.querySelector('[data-testid="subscription-start-browser"]'),
		);
		assert.ok(
			!document.querySelector('[data-testid="subscription-start-device"]'),
		);
		assert.match(
			element('[data-testid="subscription-section"]').textContent ?? "",
			/Remove the saved authorization, then refresh status/,
		);
		assert.ok(
			element('[data-testid="subscription-disconnect"]'),
		);
		assert.ok(!document.body.innerHTML.includes(RAW_PROVIDER_DETAIL));

		respond = () => jsonStatus({ state: "disconnected" });
		await click('[data-testid="subscription-refresh"]');
		assert.ok(
			document.querySelector('[data-testid="subscription-start-browser"]'),
		);
	});
});

describe("SubscriptionSection — polling", () => {
	it("polls only while authorizing and stops after unmount", async () => {
		let reads = 0;
		respond = () => {
			const call = calls[calls.length - 1]!;
			if (call.url === STATUS_PATH && (call.init.method ?? "GET") === "GET") {
				reads += 1;
				return reads === 1
					? jsonStatus(authorizing())
					: jsonStatus(connected());
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount(5);
		await waitFor(() =>
			(element('[data-testid="subscription-state"]').textContent ?? "").includes(
				"Connected",
			),
		);
		assert.ok(reads >= 2, "the attempt was polled at least once");
		const before = reads;
		await unmount();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(reads, before, "unmount clears the poll timer");
	});

	it("keeps polling when an action lands during an in-flight read", async () => {
		let reads = 0;
		let release = () => {};
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				reads += 1;
				if (reads === 1) return jsonStatus(authorizing());
				if (reads === 2) {
					return new Promise<Response>((resolve) => {
						release = () => resolve(jsonStatus(authorizing()));
					});
				}
				return jsonStatus(authorizing());
			}
			if (call.url === `${ATTEMPTS_PATH}/att-1/input` && method === "POST") {
				return jsonStatus(authorizing());
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount(5);
		await waitFor(() => reads === 2);
		await fill('[data-testid="subscription-prompt-input"]', CALLBACK_URL);
		await submit('[data-testid="subscription-prompt-form"]');
		release();
		await waitFor(() => reads >= 3);
	});

	it("does not poll a stable disconnected status", async () => {
		await mount(5);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(
			calls.filter((call) => call.url === STATUS_PATH).length,
			1,
		);
	});
});

describe("settings entry", () => {
	it("exposes Subscription in the nav and renders it before the settings record loads", () => {
		const html = renderToStaticMarkup(
			<SettingsDialogBody onClose={() => {}} initialSection="subscription" />,
		);
		assert.match(html, /settings-nav-subscription/);
		assert.match(html, /section-subscription/);
		assert.match(html, /data-testid="subscription-section"/);
		assert.match(html, /Loading subscription…/);
	});
});

describe("prompt draft lifetime", () => {
	it("drops the draft when the server moves to a new prompt", async () => {
		let reads = 0;
		respond = () => {
			const call = calls[calls.length - 1]!;
			if (call.url === STATUS_PATH && (call.init.method ?? "GET") === "GET") {
				reads += 1;
				return jsonStatus(
					authorizing(
						browserAttempt({
							promptId: reads === 1 ? "prompt-1" : "prompt-2",
							callbackListening: false,
						}),
					),
				);
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await fill(
			'[data-testid="subscription-prompt-input"]',
			"typed-but-not-submitted",
		);
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.value,
			"typed-but-not-submitted",
		);

		await click('[data-testid="subscription-refresh-inline"]');
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.value,
			"",
		);
	});

	it("clears the draft on cancel so a later status read cannot revive it", async () => {
		respond = () => {
			const call = calls[calls.length - 1]!;
			const method = call.init.method ?? "GET";
			if (call.url === STATUS_PATH && method === "GET") {
				return jsonStatus(authorizing());
			}
			if (call.url === `${ATTEMPTS_PATH}/att-1` && method === "DELETE") {
				return jsonStatus({ state: "disconnected" });
			}
			return jsonStatus({ state: "disconnected" });
		};

		await mount();
		await fill(
			'[data-testid="subscription-prompt-input"]',
			"must-not-survive-cancel",
		);
		await click('[data-testid="subscription-cancel"]');
		assert.equal(
			document.querySelector('[data-testid="subscription-prompt-form"]'),
			null,
		);

		await click('[data-testid="subscription-refresh"]');
		assert.equal(
			(element('[data-testid="subscription-prompt-input"]') as HTMLInputElement)
				.value,
			"",
		);
	});
});
