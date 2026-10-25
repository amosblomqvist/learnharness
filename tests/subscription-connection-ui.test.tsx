import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NativeSubscriptionConnection, NativeSubscriptionUIProvider, SubscriptionConnections, COPILOT_POLICY_NOTICE, emptySubscriptionStatus } from "../components/settings/subscription-connections.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import type { NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "../src/core/contracts/subscriptions.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(connected = false) {
	let statuses: NativeSubscriptionStatus[] = ["github-copilot", "xai"].map((id) => ({ ...emptySubscriptionStatus(id as NativeSubscriptionProviderId), available: true, connected, connectionId: connected ? `local-${id}` : null }));
	const listeners = new Set<() => void>(), login = deferred();
	const calls = { login: [] as unknown[][], cancel: 0, open: [] as unknown[][], consent: [] as unknown[][], disconnect: [] as string[], retry: [] as string[] };
	function push(id: NativeSubscriptionProviderId, next: Partial<NativeSubscriptionStatus>) {
		statuses = statuses.map((s) => s.providerId === id ? { ...s, revision: s.revision + 1, ...next } : s); for (const listener of listeners) listener();
	}
	const bridge: NativeSubscriptionControlBridge = {
		status: async () => structuredClone(statuses),
		login: async (id, enabled) => { calls.login.push([id, enabled]); push(id, { pending: true, interaction: { attemptId: "attempt", userCode: "PUBLIC-CODE", browser: { id: "opaque-action", url: "https://auth.example/device" }, progress: "Complete sign-in in your browser." } }); await login.promise; },
		cancel: async (id) => { calls.cancel++; push(id, { pending: false, interaction: undefined }); },
		respond: async () => {}, open: async (...args) => { calls.open.push(args); }, retry: async (id) => { calls.retry.push(id); },
		disconnect: async (id) => { calls.disconnect.push(id); push(id, { connected: false, connectionId: null }); },
		consent: async (id, enabled) => { calls.consent.push([id, enabled]); push(id, { allowBackgroundUse: enabled }); },
		onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	window.lh = { expandWindow() {}, subscriptions: bridge };
	return { bridge, calls, login, push, get statuses() { return statuses; } };
}
async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<NativeSubscriptionUIProvider><NativeSubscriptionConnection providerId="github-copilot" /><NativeSubscriptionConnection providerId="xai" /></NativeSubscriptionUIProvider>));
}
function maybeButton(text: string, scope: ParentNode = document) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text); }
function button(text: string, scope: ParentNode = document) { const found = maybeButton(text, scope); assert(found, `missing button ${text}`); return found; }
const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}-connection"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[data-testid="subscription-connection-dialog"]')!;
const toggle = () => dialog().querySelector<HTMLElement>('[role="switch"]')!;
const footer = () => dialog().querySelector<HTMLElement>('[data-testid="subscription-connection-footer"]')!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
async function connectionStep(id: string) { await click(button("Connect", row(id))); await click(button("Continue", dialog())); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; });

test("three compact rows render in approved order with no browser-only sign-in or fabricated identities", () => {
	const html = renderToStaticMarkup(<ChatGPTUIProvider><NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider></ChatGPTUIProvider>);
	assert(html.indexOf('data-testid="chatgpt-connection"') < html.indexOf('data-testid="github-copilot-connection"'));
	assert(html.indexOf('data-testid="github-copilot-connection"') < html.indexOf('data-testid="xai-connection"'));
	assert.equal((html.match(/>Connect<\/button>/g) ?? []).length, 3);
	assert(!html.includes("@")); assert(!html.includes("Add accounts"));
});
for (const [id, label] of [["github-copilot", "GitHub Copilot"], ["xai", "Grok"]] as const) test(`${id}: disclosure and connection are separate steps with no duplicated content or early authorization`, async () => {
	const f = fixture(); await mount(); await click(button("Connect", row(id)));
	assert.equal(dialog().querySelector("h2")?.textContent, label);
	assert(dialog().querySelector('[data-testid="subscription-privacy-notice"]')); assert(!toggle());
	assert.equal(!!dialog().querySelector('[data-testid="copilot-policy-notice"]'), id === "github-copilot");
	if (id === "github-copilot") assert(dialog().textContent?.includes(COPILOT_POLICY_NOTICE));
	assert(!maybeButton("Connect", dialog())); assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.consent, []);
	await click(button("Continue", dialog()));
	assert.equal(dialog().querySelector("h2")?.textContent, label); assert.equal(toggle().getAttribute("aria-checked"), "true");
	assert(!dialog().querySelector('[data-testid="subscription-privacy-notice"], [data-testid="copilot-policy-notice"]'));
	assert.equal(f.calls.login.length, 0); await click(toggle()); assert.deepEqual(f.calls.consent, []);
	await click(button("Connect", dialog())); assert.deepEqual(f.calls.login, [[id, false]]);
	assert(dialog().textContent?.includes("PUBLIC-CODE")); assert(!dialog().querySelector('[data-testid="subscription-privacy-notice"]'));
	await click(button("Open browser", dialog())); assert.deepEqual(f.calls.open, [[id, "attempt", "opaque-action"]]);
	await click(button("Cancel", dialog())); assert.equal(f.calls.cancel, 1); assert(!dialog());
	await click(button("Connect", row(id === "xai" ? "github-copilot" : "xai"))); const newer = dialog(); await act(async () => f.login.resolve());
	assert(dialog() === newer, "old completion cannot close another provider dialog");
});
for (const phase of ["notice", "connection"] as const) test(`cancelling the native ${phase} step starts no OAuth and saves no draft preference`, async () => {
	const f = fixture(); await mount(); await click(button("Connect", row("xai")));
	if (phase === "connection") { await click(button("Continue", dialog())); await click(toggle()); }
	await click(button("Cancel", dialog())); assert(!dialog()); assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
	await connectionStep("xai"); assert.equal(toggle().getAttribute("aria-checked"), "true");
});
test("native step transition moves keyboard focus into the new connection controls", async () => {
	const original = HTMLElement.prototype.focus, focused: HTMLElement[] = [];
	HTMLElement.prototype.focus = function () { focused.push(this); };
	try { fixture(); await mount(); await connectionStep("xai"); assert.equal(focused.at(-1), toggle()); }
	finally { HTMLElement.prototype.focus = original; }
});
test("healthy management has only controls, quiet Manage, destructive action left and Close right", async () => {
	const f = fixture(true); await mount();
	assert(!row("xai").textContent?.includes("Connected")); assert.match(button("Manage…", row("xai")).className, /text-muted-foreground/);
	await click(button("Manage…", row("xai")));
	assert.equal(dialog().querySelector("h2")?.textContent, "Grok");
	assert(!dialog().querySelector("select")); assert(!dialog().textContent?.includes("Add accounts"));
	assert(!dialog().querySelector('[data-testid="subscription-privacy-notice"]')); assert(!maybeButton("Reconnect", dialog())); assert(!maybeButton("Sign in again", dialog()));
	assert.equal(footer().firstElementChild, button("Disconnect", dialog())); assert.match(button("Disconnect", dialog()).className, /text-red/);
	assert.equal(footer().lastElementChild?.lastElementChild, button("Close", dialog()));
	await click(toggle()); assert.deepEqual(f.calls.consent, [["xai", false]]); assert.equal(f.statuses.find((s) => s.providerId === "github-copilot")!.allowBackgroundUse, true);
	await click(button("Disconnect", dialog())); assert.equal(f.calls.disconnect.length, 0);
	assert.equal(dialog().querySelector("h2")?.textContent, "Grok"); assert(dialog().textContent?.includes("does not cancel your subscription or revoke access"));
	await click(button("Cancel", dialog())); assert(toggle()); assert(!maybeButton("Reconnect", dialog()));
	await click(button("Disconnect", dialog())); await click(button("Disconnect", dialog())); assert.deepEqual(f.calls.disconnect, ["xai"]); assert(!dialog());
});
test("authorization trouble offers Retry and staged Sign in again without removing the saved connection", async () => {
	const f = fixture(true); f.push("xai", { connected: false, allowBackgroundUse: false, error: "The connection could not be refreshed." });
	await mount(); await click(button("Manage…", row("xai"))); await click(button("Retry", dialog())); assert.deepEqual(f.calls.retry, ["xai"]);
	await click(button("Sign in again", dialog())); assert(dialog().querySelector('[data-testid="subscription-privacy-notice"]')); assert(!toggle());
	assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.disconnect, []); assert.equal(f.statuses.find((s) => s.providerId === "xai")!.connectionId, "local-xai");
	await click(button("Continue", dialog())); assert.equal(toggle().getAttribute("aria-checked"), "false");
	await click(toggle()); await click(button("Connect", dialog())); assert.deepEqual(f.calls.login, [["xai", true]]); assert.deepEqual(f.calls.consent, []);
	await click(button("Cancel", dialog())); assert.equal(f.calls.cancel, 1); assert.deepEqual(f.calls.disconnect, []); assert.equal(f.statuses.find((s) => s.providerId === "xai")!.allowBackgroundUse, false);
	await act(async () => f.login.resolve());
});
test("a non-authority error on a still-working connection does not expose a healthy reauthorization action", async () => {
	const f = fixture(true); f.push("xai", { error: "The replacement sign-in did not complete." });
	await mount(); await click(button("Manage…", row("xai"))); assert(!maybeButton("Sign in again", dialog())); assert(!maybeButton("Retry", dialog()));
});
test("storage/desktop unavailability is not presented as an authorization repair action", async () => {
 const f = fixture(true); await mount(); await click(button("Manage…", row("xai")));
 await act(async () => f.push("xai", { available: false, connected: false, error: "The saved connection could not be read or written safely." }));
 assert(!maybeButton("Sign in again", dialog())); assert(!maybeButton("Retry", dialog())); assert(button("Close", dialog()));
});
test("required native prompts render and commit cannot be cancelled through button, Escape or backdrop", async () => {
	const f = fixture(); await mount(); await connectionStep("github-copilot"); await click(button("Connect", dialog()));
	await act(async () => f.push("github-copilot", { interaction: { attemptId: "attempt", prompt: { id: "enterprise", type: "text", message: "Enterprise domain (leave blank for github.com)", placeholder: "company.ghe.com" } } }));
	assert.equal(dialog().querySelector("input")?.getAttribute("placeholder"), "company.ghe.com"); assert(button("Continue", dialog()));
	assert(!dialog().querySelector('[data-testid="subscription-privacy-notice"]'));
	await act(async () => f.push("github-copilot", { committing: true, interaction: undefined }));
	assert(button("Cancel", dialog()).disabled); await click(button("Cancel", dialog())); assert.equal(f.calls.cancel, 0); assert(dialog());
	await act(async () => { const event = new window.Event("keydown", { bubbles: true }); Object.defineProperty(event, "key", { value: "Escape" }); document.dispatchEvent(event); });
	assert(dialog()); assert.equal(f.calls.cancel, 0);
	await act(async () => {
		const backdrop = document.querySelector<HTMLElement>('[data-testid="subscription-dialog-backdrop"]')!;
		for (const type of ["pointerdown", "pointerup", "click"]) { const event = new window.Event(type, { bubbles: true }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, button: { value: 0 } }); backdrop.dispatchEvent(event); }
	});
	assert(dialog()); assert.equal(f.calls.cancel, 0); await act(async () => f.login.resolve());
});
