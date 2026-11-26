import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection, CustomEndpointSetup } from "../components/settings/keys-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const etag = { etag: '"fixture"' };
const revision = '"fixture"';
const ENDPOINTS = () => [
	{ id: "custom", name: "Fixture endpoint", baseUrl: "http://fixture.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [] },
	{ id: "custom-1234abcd", name: "Work gateway", baseUrl: "http://work.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "work-model" }], overrides: {}, manualModels: [] },
];
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
async function mount(setup = false) {
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "polish interactions must not save credentials/settings");
		if (String(input).startsWith("/api/custom-provider")) return Response.json({ revision, limit: 20, endpoints: ENDPOINTS() }, { headers: etag });
		return Response.json({ keys: [], providers: [] });
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(<InteractionLayersProvider>{setup ? <CustomEndpointSetup onSaved={() => assert.fail("unexpected save")} /> : <KeysSection />}</InteractionLayersProvider>));
	if (!setup) await click("custom-endpoint-row-btn");
}
function element(id: string) { const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }
async function selectMode(value: string) {
	const select = element("custom-auth-mode");
	Object.defineProperty(select, "value", { value, configurable: true });
	await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });
for (const setup of [false, true]) {
	test(`${setup ? "Setup" : "Settings"} hides key input in Keyless and reveals it only in API key mode`, async () => {
		await mount(setup);
		assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		await selectMode("apiKey"); assert.equal(element("custom-key-input").getAttribute("type"), "password");
		await selectMode("keyless"); assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		assert.ok(element("custom-save"));
	});
}
test("model controls use approved effort labels, right-align Save limits, and group help below", async () => {
	await mount();
	const select = element("custom-pin-reasoning-fixture-model");
	assert.equal(select.getAttribute("aria-label"), "fixture-model reasoning effort support");
	assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Reasoning effort: Use reported", "Reasoning effort: Supported", "Reasoning effort: Not supported"]);
	assert.deepEqual(Array.from(select.children).map(option => option.getAttribute("value")), ["", "on", "off"], "capability values unchanged");
	const save = element("custom-pins-save"); assert.ok(save.classList.contains("ml-auto")); assert.equal(save.parentElement!.lastElementChild, save);
	const help = element("custom-help"); assert.equal(element("custom-budget-help").parentElement, help); assert.equal(element("custom-reasoning-help").parentElement, help);
	const children = Array.from(element("custom-endpoint-editor").children); assert.ok(children.indexOf(help) > children.indexOf(element("custom-pins")));
	assert.match(help.textContent ?? "", /do not resize backend context/); assert.match(help.textContent ?? "", /Off may not disable/);
});

test("every endpoint is its own named row, and the editor edits the one you opened", async () => {
	await mount();
	const rows = document.querySelectorAll('[data-testid="custom-endpoint-row"]');
	assert.equal(rows.length, 2, "one row per stored endpoint");
	assert.deepEqual(
		Array.from(document.querySelectorAll('[data-testid="custom-endpoint-name"]')).map((node) => node.textContent),
		["Fixture endpoint", "Work gateway"],
		"the name is what tells them apart",
	);
	const name = element("custom-name-input") as HTMLInputElement;
	assert.equal(name.value, "Fixture endpoint", "the open editor is seeded from the row you clicked");
	const url = element("custom-baseurl-input") as HTMLInputElement;
	assert.equal(url.value, "http://fixture.invalid/v1");
	assert.ok(element("custom-endpoint-editor"));
});