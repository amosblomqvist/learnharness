import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DictationBar, type Dictation } from "../components/dictation.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider, SubscriptionConnections } from "../components/settings/subscription-connections.tsx";
import { resetSubscriptionRouteMissing } from "../components/settings/subscription-client.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const NOTICE = "Manage subscription sign-in from the LearnHarness desktop app.";
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
function secure(value: boolean) { Object.defineProperty(window, "isSecureContext", { value, configurable: true }); }
async function mount(node: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => { root!.render(node); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	return host;
}
afterEach(async () => {
	await act(async () => { root?.unmount(); }); host?.remove(); root = host = undefined;
	globalThis.fetch = originalFetch; delete window.lh; resetSubscriptionRouteMissing();
});
const dictation: Dictation = { phase: "idle", error: null, levelRef: { current: 0 }, active: false, toggle() {}, stop() {}, clearError() {} } as unknown as Dictation;

test("mic button is hidden in an insecure context", async () => {
	secure(false);
	const el = await mount(<DictationBar dictation={dictation} />);
	assert.equal(el.querySelector('[data-testid="dictation-toggle"]'), null);
});

test("mic button is present in a secure context", async () => {
	secure(true);
	const el = await mount(<DictationBar dictation={dictation} />);
	assert.ok(el.querySelector('[data-testid="dictation-toggle"]'));
});

test("server render still contains the mic button", () => {
	secure(false);
	assert.match(renderToStaticMarkup(<DictationBar dictation={dictation} />), /data-testid="dictation-toggle"/);
});

const providers = (node: React.ReactNode) => <ChatGPTUIProvider><NativeSubscriptionUIProvider>{node}</NativeSubscriptionUIProvider></ChatGPTUIProvider>;

test("browser subscription UI shows the desktop-only notice when the route answers 404", async () => {
	globalThis.fetch = async () => new Response(null, { status: 404 });
	const el = await mount(providers(<SubscriptionConnections />));
	assert.match(el.textContent ?? "", new RegExp(NOTICE.replace(/\./g, "\\.")));
	assert.equal(el.querySelector('[data-testid="chatgpt-connection"]'), null);
	assert.equal(el.querySelector("button"), null);
});

test("dev web mode, where the route answers, keeps the connection rows", async () => {
	const chatgpt = { available: true, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	globalThis.fetch = async () => Response.json({ chatgpt, native: [] });
	const el = await mount(providers(<SubscriptionConnections />));
	assert.ok(el.querySelector('[data-testid="chatgpt-connection"]'));
	assert.doesNotMatch(el.textContent ?? "", /Manage subscription sign-in/);
});

test("the desktop bridge path never probes the route and keeps the rows", async () => {
	const chatgpt = { available: true, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	window.lh = { chatgpt: { status: async () => chatgpt, onChange: () => () => {} }, subscriptions: { status: async () => [], onChange: () => () => {} } } as unknown as typeof window.lh;
	globalThis.fetch = async () => assert.fail("bridge path must not fetch");
	const el = await mount(providers(<SubscriptionConnections />));
	assert.ok(el.querySelector('[data-testid="chatgpt-connection"]'));
	assert.doesNotMatch(el.textContent ?? "", /Manage subscription sign-in/);
});
