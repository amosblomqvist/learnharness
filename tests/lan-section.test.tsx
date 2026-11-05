/** LAN access settings section: bridge gating and controls, with a stub preload bridge. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LanSection, NO_PASSWORD_WARNING } from "../components/settings/lan-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { LanState } from "../components/sidebar.tsx";

const dom = parseHTML("<html><body></body></html>");
// React feature-detects input events through `oninput in document`.
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, HTMLInputElement: dom.window.HTMLInputElement });
// react-dom/client reads `document` at load, so it is imported after the DOM exists.
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

const base: LanState = { enabled: true, port: 4747, hasPassword: false, running: true, error: null, urls: ["http://192.168.1.20:4747"] };

function stub(initial: LanState) {
	let state = initial;
	const calls: [string, unknown][] = [];
	const reply = (name: string, arg: unknown, patch: Partial<LanState>) => { calls.push([name, arg]); state = { ...state, ...patch }; return Promise.resolve(state); };
	window.lh = {
		expandWindow() {},
		lan: {
			get: () => Promise.resolve(state),
			setEnabled: (on) => reply("setEnabled", on, { enabled: on, running: on }),
			setPort: (port) => reply("setPort", port, { port }),
			setPassword: (pw) => reply("setPassword", pw, { hasPassword: pw !== null }),
		},
	};
	return calls;
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function type(el: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
	delete window.lh;
	globalThis.fetch = originalFetch;
});

describe("LAN access section", () => {
	it("renders nothing without the desktop bridge, on the server or in a browser", async () => {
		assert.equal(renderToStaticMarkup(<LanSection />), "");
		const host = await mount(<LanSection />);
		assert.equal(host.innerHTML, "");
	});

	it("shows the switch, urls and the no-password warning, and each control calls the bridge", async () => {
		const calls = stub(base);
		const host = await mount(<LanSection />);
		assert.equal(q(host, "toggle-lan-access")?.getAttribute("aria-checked"), "true");
		assert.ok(q(host, "lan-urls")?.textContent?.includes("http://192.168.1.20:4747"));
		assert.equal(q(host, "lan-warning")?.textContent, NO_PASSWORD_WARNING);
		assert.ok(q(host, "lan-warning")?.textContent?.includes("read files on this computer"));
		assert.ok(host.textContent?.includes("docs/lan-access.md"));

		await act(async () => { q(host, "toggle-lan-access")!.click(); });
		assert.deepEqual(calls.at(-1), ["setEnabled", false]);

		const port = q(host, "lan-port") as HTMLInputElement;
		await type(port, "5050");
		await act(async () => { q(host, "lan-port-save")!.click(); });
		assert.deepEqual(calls.at(-1), ["setPort", 5050]);

		const pw = q(host, "lan-password") as HTMLInputElement;
		await type(pw, "hunter2");
		await act(async () => { q(host, "lan-password-save")!.click(); });
		assert.deepEqual(calls.at(-1), ["setPassword", "hunter2"]);
		assert.equal(q(host, "lan-warning"), null, "warning goes away once a password is set");

		await act(async () => { q(host, "lan-password-remove")!.click(); });
		assert.deepEqual(calls.at(-1), ["setPassword", null]);
		assert.ok(q(host, "lan-warning") === null, "disabled by the earlier toggle, so still no warning");
	});

	it("shows the bind error inline and no urls while off", async () => {
		stub({ ...base, enabled: false, running: false, urls: [], error: "Port 4747 is already in use." });
		const host = await mount(<LanSection />);
		assert.equal(q(host, "lan-error")?.textContent, "Port 4747 is already in use.");
		assert.equal(q(host, "lan-urls"), null);
		assert.equal(q(host, "lan-warning"), null);
	});

	it("the dialog adds the LAN nav entry only with the bridge; the other sections are unchanged", async () => {
		globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
		let host = await mount(<SettingsDialogBody onClose={() => {}} />);
		assert.equal(q(host, "settings-nav-lan"), null);
		for (const id of ["keys", "agent", "appearance", "graph", "keyboard", "general"]) assert.ok(q(host, `settings-nav-${id}`), id);
		stub(base);
		host = await mount(<SettingsDialogBody onClose={() => {}} />);
		assert.equal(q(host, "settings-nav-lan")?.textContent, "LAN access");
	});
});
