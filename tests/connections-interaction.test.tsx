import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ConnectionsSection } from "../components/settings/connections-section.tsx";
import { onSettingsSaved } from "../components/settings-signal.ts";

// Mount real React handlers in an isolated DOM. Every HTTP operation is stubbed.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const ID = "subscription-openai-codex";

function button(testid: string): HTMLButtonElement {
	const element = document.querySelector<HTMLButtonElement>('[data-testid="' + testid + '"]');
	assert.ok(element, "Missing " + testid);
	return element;
}
async function click(testid: string) {
	await act(async () => { button(testid).dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}
async function mount(fetcher: typeof fetch) {
	globalThis.fetch = fetcher;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection />));
}
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	host?.remove();
	host = null;
	globalThis.fetch = originalFetch;
});

describe("Codex connection controls (offline DOM)", () => {
	it("connects, refreshes model availability and disconnects without an API key", async () => {
		let connected = false;
		const signals: string[] = [];
		const stop = onSettingsSaved((section) => signals.push(section));
		try {
			await mount(async (input, init) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (method === "GET") {
					assert.equal(url, "/api/connections/subscriptions");
					return Response.json({ subscriptions: [{ id: ID, name: "Codex subscription", connected }] });
				}
				assert.equal(new Headers(init?.headers).get("X-LearnHarness-Connections"), "1");
				assert.deepEqual(JSON.parse(String(init?.body)), { providerId: ID });
				if (method === "POST") {
					assert.equal(url, "/api/connections/login");
					connected = true;
					return Response.json({ id: "offline-attempt", providerId: ID, state: "connected", events: [] });
				}
				assert.equal(method, "DELETE");
				assert.equal(url, "/api/connections/subscriptions");
				connected = false;
				return Response.json({ subscriptions: [{ id: ID, name: "Codex subscription", connected }] });
			});
			assert.equal(button("subscription-openai-codex-connect").disabled, false);
			await click("subscription-openai-codex-connect");
			assert.ok(button("subscription-openai-codex-disconnect"));
			assert.ok(signals.includes("models") && signals.includes("keys"));
			await click("subscription-openai-codex-disconnect");
			assert.equal(button("subscription-openai-codex-connect").disabled, false);
			assert.ok(host!.textContent!.includes("not connected"));
		} finally { stop(); }
	});

	it("closing Connections cancels a pending sign-in rather than leaving it running", async () => {
		const cancellations: string[] = [];
		await mount(async (input, init) => {
			const url = String(input);
			if (init?.method === "DELETE") {
				cancellations.push(url);
				assert.equal(init.keepalive, true);
				return Response.json({});
			}
			if (init?.method === "POST") return Response.json({ id: "pending-offline", providerId: ID, state: "pending", events: [{ type: "auth_url", url: "https://auth.openai.com/offline-fixture" }] });
			return Response.json({ subscriptions: [{ id: ID, name: "Codex subscription", connected: false }] });
		});
		await click("subscription-openai-codex-connect");
		assert.ok(document.querySelector('[data-testid="login-auth-link"]'));
		await act(async () => root!.unmount());
		root = null;
		assert.deepEqual(cancellations, ["/api/connections/login/pending-offline"]);
	});

	it("a failed status read offers retry and cannot start sign-in", async () => {
		let fail = true;
		await mount(async (_input, init) => {
			assert.equal(init?.method ?? "GET", "GET");
			return fail ? Response.json({ error: "fixture" }, { status: 500 }) : Response.json({ subscriptions: [{ id: ID, name: "Codex subscription", connected: false }] });
		});
		assert.ok(document.querySelector('[data-testid="subscriptions-read-error"]'));
		assert.equal(button("subscription-openai-codex-connect").disabled, true);
		fail = false;
		const retry = document.querySelector<HTMLButtonElement>('[data-testid="subscriptions-read-error"] button');
		assert.ok(retry);
		await act(async () => retry.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(button("subscription-openai-codex-connect").disabled, false);
	});
});
