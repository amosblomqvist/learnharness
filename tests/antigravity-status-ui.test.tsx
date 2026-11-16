import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
	AntigravityInstallationStatus,
	antigravitySourceLabel,
	antigravityStatusLabel,
} from "../components/settings/antigravity-status.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import type { AntigravityStatus } from "../src/core/contracts/antigravity.ts";

const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function makeStatus(overrides: Partial<AntigravityStatus> = {}): AntigravityStatus {
	return {
		enabled: true,
		binaryPath: null,
		state: "not-installed",
		source: null,
		version: null,
		minimumCliVersion: "1.5.0",
		managedInstalled: false,
		busy: false,
		install: { phase: "idle" },
		auth: { signedIn: false, phase: "idle", attemptId: null, authUrl: null, error: null },
		error: null,
		...overrides,
	};
}

const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-installation"] [role="switch"]')!;
const statusLabel = () => document.querySelector('[data-testid="antigravity-installation"] [role="status"]')?.textContent;
const sourceBadge = () => document.querySelector('[data-testid="antigravity-source-badge"]')?.textContent;
const checkAgainBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-check-again"]');
const installBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-install"]');
const installManagedBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-install-managed"]');
const removeBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-remove"]');
const pathInput = () => document.querySelector<HTMLInputElement>('[data-testid="antigravity-binary-path"]');
const pathSaveBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-binary-save"]');
const pathClearBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-binary-clear"]');
const signInBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-sign-in"]');
const signOutBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-sign-out"]');
const authStatusText = () => document.querySelector('[data-testid="antigravity-auth-status"]')?.textContent;
const copyLinkBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-auth-copy"]');
const cancelAuthBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-auth-cancel"]');
const callbackInput = () => document.querySelector<HTMLInputElement>('[data-testid="antigravity-auth-callback-input"]');
const callbackSubmitBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-auth-callback-submit"]');

function fixture(
	handlers: {
		getStatus?: (init?: RequestInit) => Promise<Response>;
		postInstall?: (init?: RequestInit) => Promise<Response>;
		deleteInstall?: (init?: RequestInit) => Promise<Response>;
		postAuth?: (body: Record<string, unknown>, init?: RequestInit) => Promise<Response>;
		postModels?: (init?: RequestInit) => Promise<Response>;
	} = {},
	initial: { enabled?: boolean; binaryPath?: string } = { enabled: true },
) {
	const calls: string[] = [];
	let on = initial.enabled ?? true;
	let binaryPath = initial.binaryPath;

	globalThis.fetch = (async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url === "/api/settings") {
			return Response.json({
				settings: {
					version: 1,
					antigravity: { enabled: on, ...(binaryPath ? { binaryPath } : {}) },
				},
			});
		}
		if (url === "/api/settings/antigravity") {
			assert.equal(method, "PUT");
			const body = JSON.parse(String(init?.body)) as { enabled?: boolean; binaryPath?: string };
			on = body.enabled === true;
			binaryPath = body.binaryPath;
			return Response.json({
				settings: {
					version: 1,
					antigravity: { enabled: on, ...(binaryPath ? { binaryPath } : {}) },
				},
			});
		}
		if (url === "/api/antigravity") {
			assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
			return handlers.getStatus ? handlers.getStatus(init) : Response.json(makeStatus());
		}
		if (url === "/api/antigravity/install") {
			assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
			if (method === "POST") {
				return handlers.postInstall
					? handlers.postInstall(init)
					: Response.json(makeStatus({ busy: true, install: { phase: "downloading", downloadedBytes: 0 } }), {
							status: 202,
						});
			}
			if (method === "DELETE") {
				return handlers.deleteInstall
					? handlers.deleteInstall(init)
					: Response.json({ ...makeStatus(), removed: true });
			}
		}
		if (url === "/api/antigravity/auth") {
			assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return handlers.postAuth ? handlers.postAuth(body, init) : Response.json(makeStatus());
		}
		if (url === "/api/antigravity/models") {
			assert.equal(method, "POST");
			assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
			return handlers.postModels ? handlers.postModels(init) : Response.json(makeStatus());
		}
		if (url === "/api/keys") {
			return Response.json({ keys: [], providers: [] });
		}
		if (url === "/api/custom-provider") {
			return Response.json({});
		}
		if (url === "/api/subscriptions") {
			return Response.json({ providers: [] });
		}
		if (url === "/api/claude-code") {
			return Response.json({ state: "not-found", version: null, minimumVersion: "2.1.259" });
		}
		throw new Error(`Unexpected fetch: ${method} ${String(url)}`);
	}) as typeof fetch;

	return calls;
}

async function mount(node: React.ReactNode = <AntigravityInstallationStatus />) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial SSR render is collapsed and off with no status probe or install controls", () => {
	const html = renderToStaticMarkup(<AntigravityInstallationStatus />);
	assert.match(html, /Antigravity/);
	assert.match(html, /aria-checked="false"/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Install runtime"));
	assert(!html.includes("Check again"));
});

test("enabling persists before probing, and disabling collapses details without extra probes", async () => {
	const calls = fixture(
		{ getStatus: async () => Response.json(makeStatus()) },
		{ enabled: false },
	);
	await mount();
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert.equal(checkAgainBtn(), null);
	assert.deepEqual(calls, ["GET /api/settings"]);

	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "true");
	assert.equal(statusLabel(), "Not installed");
	assert(calls.indexOf("PUT /api/settings/antigravity") < calls.indexOf("GET /api/antigravity"));
	assert(installBtn());

	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert.equal(checkAgainBtn(), null);
	assert.equal(calls.filter((c) => c === "GET /api/antigravity").length, 1);
});

test("source badges and status labels format all runtime sources accurately", () => {
	assert.equal(antigravitySourceLabel("managed"), "Managed");
	assert.equal(antigravitySourceLabel("cli"), "System CLI");
	assert.equal(antigravitySourceLabel("custom"), "Custom path");
	assert.equal(antigravitySourceLabel("t3-external"), "T3 Code (read-only)");
	assert.equal(antigravitySourceLabel("env"), "Env override");

	assert.equal(antigravityStatusLabel(makeStatus({ state: "ready", version: "1.4.5" })), "Ready · v1.4.5");
	assert.equal(
		antigravityStatusLabel(makeStatus({ state: "update-required", version: "1.4.0" })),
		"Version 1.4.0 · update required (v1.5.0+)",
	);
	assert.equal(antigravityStatusLabel(makeStatus({ state: "error" })), "Runtime unavailable");
});

test("T3 external fallback shows read-only badge, offers Install managed copy, and keeps Remove disabled", async () => {
	fixture({
		getStatus: async () =>
			Response.json(
				makeStatus({
					state: "ready",
					source: "t3-external",
					version: "1.4.5",
					managedInstalled: false,
				}),
			),
	});
	await mount();
	assert.equal(sourceBadge(), "T3 Code (read-only)");
	assert.equal(statusLabel(), "Ready · v1.4.5");
	assert(installManagedBtn(), "should offer Install managed copy when on T3 fallback");
	assert(removeBtn());
	assert.equal(removeBtn()!.disabled, true, "Remove must be disabled for external fallback");
});

test("managed runtime enables Remove and sends DELETE to /api/antigravity/install", async () => {
	let removed = false;
	const calls = fixture({
		getStatus: async () =>
			Response.json(
				makeStatus({
					state: removed ? "not-installed" : "ready",
					source: removed ? null : "managed",
					version: removed ? null : "1.4.5",
					managedInstalled: !removed,
				}),
			),
		deleteInstall: async () => {
			removed = true;
			return Response.json({ ...makeStatus(), removed: true });
		},
	});
	await mount();
	assert.equal(sourceBadge(), "Managed");
	assert.equal(installManagedBtn(), null);
	assert.equal(removeBtn()!.disabled, false);

	await act(async () => removeBtn()!.click());
	assert(calls.includes("DELETE /api/antigravity/install"));
	assert.equal(statusLabel(), "Not installed");
	assert.equal(sourceBadge(), undefined);
});

test("Install runtime triggers POST and shows download progress percentage", async () => {
	const calls = fixture({
		getStatus: async () => Response.json(makeStatus()),
		postInstall: async () =>
			Response.json(
				makeStatus({
					busy: true,
					install: { phase: "downloading", downloadedBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 },
				}),
				{ status: 202 },
			),
	});
	await mount();
	await act(async () => installBtn()!.click());
	assert(calls.includes("POST /api/antigravity/install"));
	const progressText = document.querySelector('[data-testid="antigravity-install-progress"]')?.textContent ?? "";
	assert.match(progressText, /Downloading… 5\.0 MB \/ 10\.0 MB \(50%\)/);
	assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "50");
});

test("custom binary path can be saved and cleared cleanly", async () => {
	const calls = fixture(
		{
			getStatus: async () =>
				Response.json(
					makeStatus({
						state: "ready",
						source: "custom",
						version: null,
					}),
				),
		},
		{ enabled: true, binaryPath: "/opt/agy/bin/agy" },
	);
	await mount();
	assert.equal(pathInput()!.value, "/opt/agy/bin/agy");
	assert.equal(pathSaveBtn()!.disabled, true);
	assert(pathClearBtn());

	await act(async () => pathClearBtn()!.click());
	assert(calls.includes("PUT /api/settings/antigravity"));
	assert.equal(pathInput()!.value, "");
});

test("KeysSection renders Antigravity under Settings -> External CLI group", async () => {
	fixture({}, { enabled: false });
	await mount(
		<InteractionLayersProvider>
			<KeysSection />
		</InteractionLayersProvider>,
	);
	const agyEl = document.querySelector('[data-testid="antigravity-installation"]');
	assert(agyEl);
	assert.equal(agyEl.closest('[data-testid="group-external-cli"]')?.getAttribute("data-testid"), "group-external-cli");
});

test("Sign in with Google auto-opens OAuth URL, supports Copy link and Paste redirect URL fallback, and Sign out", async () => {
	const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2F";
	const opened: string[] = [];
	const copied: string[] = [];
	const originalOpen = window.open;
	const originalClipboard = navigator.clipboard;
	(window as unknown as { open: typeof window.open }).open = ((url: string) => {
		opened.push(url);
		return null;
	}) as typeof window.open;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				copied.push(text);
			},
		},
	});

	try {
		let authState: AntigravityStatus["auth"] = {
			signedIn: false,
			phase: "idle",
			attemptId: null,
			authUrl: null,
			error: null,
		};
		const authPayloads: Array<Record<string, unknown>> = [];
		fixture({
			getStatus: async () =>
				Response.json(
					makeStatus({
						state: "ready",
						source: "managed",
						version: "1.4.5",
						managedInstalled: true,
						auth: authState,
					}),
				),
			postAuth: async (body) => {
				authPayloads.push(body);
				if (body.action === "start") {
					authState = {
						signedIn: false,
						phase: "waiting",
						attemptId: "att-1",
						authUrl,
						error: null,
					};
					return Response.json(
						makeStatus({
							state: "ready",
							source: "managed",
							version: "1.4.5",
							managedInstalled: true,
							auth: authState,
						}),
						{ status: 202 },
					);
				}
				if (body.action === "callback") {
					authState = {
						signedIn: true,
						phase: "succeeded",
						attemptId: "att-1",
						authUrl: null,
						error: null,
					};
					return Response.json(
						makeStatus({
							state: "ready",
							source: "managed",
							version: "1.4.5",
							managedInstalled: true,
							auth: authState,
						}),
					);
				}
				if (body.action === "logout") {
					authState = {
						signedIn: false,
						phase: "idle",
						attemptId: null,
						authUrl: null,
						error: null,
					};
					return Response.json(
						makeStatus({
							state: "ready",
							source: "managed",
							version: "1.4.5",
							managedInstalled: true,
							auth: authState,
						}),
					);
				}
				return Response.json(makeStatus());
			},
		});

		await mount();
		assert(signInBtn());
		assert.equal(authStatusText(), "Not signed in");

		await act(async () => signInBtn()!.click());
		assert.deepEqual(authPayloads[0], { action: "start" });
		assert.deepEqual(opened, [authUrl]);
		assert.equal(authStatusText(), "Waiting for Google sign-in…");
		assert(copyLinkBtn());
		assert(cancelAuthBtn());
		assert(callbackInput());

		await act(async () => copyLinkBtn()!.click());
		assert.deepEqual(copied, [authUrl]);
		assert.equal(copyLinkBtn()!.textContent, "Copied");

		const input = callbackInput()!;
		const pasted = "http://127.0.0.1:45678/?state=abc&code=4%2Fxyz";
		await act(async () => {
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, pasted);
			input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(authPayloads[1], {
			action: "callback",
			callbackUrl: pasted,
			attemptId: "att-1",
		});
		assert.equal(authStatusText(), "Signed in with Google");
		assert(signOutBtn());

		await act(async () => signOutBtn()!.click());
		assert.deepEqual(authPayloads[2], { action: "logout" });
		assert.equal(authStatusText(), "Not signed in");
		assert(signInBtn());
	} finally {
		(window as unknown as { open: typeof window.open }).open = originalOpen;
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
	}
});

test("Cancel button sends cancel action during active Google sign-in", async () => {
	const authPayloads: Array<Record<string, unknown>> = [];
	fixture({
		getStatus: async () =>
			Response.json(
				makeStatus({
					state: "ready",
					source: "cli",
					version: "1.5.0",
					auth: {
						signedIn: false,
						phase: "waiting",
						attemptId: "att-cancel",
						authUrl: "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A23456%2F",
						error: null,
					},
				}),
			),
		postAuth: async (body) => {
			authPayloads.push(body);
			return Response.json(
				makeStatus({
					state: "ready",
					source: "cli",
					version: "1.5.0",
					auth: {
						signedIn: false,
						phase: "cancelled",
						attemptId: "att-cancel",
						authUrl: null,
						error: null,
					},
				}),
			);
		},
	});

	await mount();
	assert(cancelAuthBtn());
	await act(async () => cancelAuthBtn()!.click());
	assert.deepEqual(authPayloads, [{ action: "cancel", attemptId: "att-cancel" }]);
	assert(signInBtn());
});

test("Refresh models button posts to /api/antigravity/models when signed in and updates model summary", async () => {
	let modelCount = 1;
	const calls = fixture({
		getStatus: async () =>
			Response.json(
				makeStatus({
					state: "ready",
					source: "managed",
					version: "1.5.2",
					managedInstalled: true,
					auth: { signedIn: true, phase: "succeeded", attemptId: "att-1", authUrl: null, error: null },
					models: { count: modelCount, updatedAt: "2026-11-15T00:00:00.000Z", discovering: false, error: null },
				}),
			),
		postModels: async () => {
			modelCount = 4;
			return Response.json(
				makeStatus({
					state: "ready",
					source: "managed",
					version: "1.5.2",
					managedInstalled: true,
					auth: { signedIn: true, phase: "succeeded", attemptId: "att-1", authUrl: null, error: null },
					models: { count: modelCount, updatedAt: "2026-11-15T00:05:00.000Z", discovering: false, error: null },
				}),
			);
		},
	});

	await mount();
	const summary = () => document.querySelector('[data-testid="antigravity-models-summary"]')?.textContent;
	const refreshBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-refresh-models"]');
	assert.equal(summary(), "1 model available");
	assert(refreshBtn());

	await act(async () => refreshBtn()!.click());
	assert(calls.includes("POST /api/antigravity/models"));
	assert.equal(summary(), "4 models available");
});
