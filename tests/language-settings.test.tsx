/** Settings → General → Language: save first, then relaunch (fake preload bridge). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LanguageSettings } from "../components/settings/language-settings.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
after(() => { delete (window as { lh?: unknown }).lh; });

async function mount(save: (next: "zh" | "en") => Promise<boolean>) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<LanguageSettings language="zh" save={save} />));
	return { host, unmount: () => act(async () => root.unmount()) };
}

describe("LanguageSettings", () => {
	it("saves the choice and relaunches the desktop app", async () => {
		const order: string[] = [];
		window.lh = { expandWindow() {}, relaunch: async () => { order.push("relaunch"); } };
		const { host, unmount } = await mount(async (next) => { order.push(`save:${next}`); return true; });
		await act(async () => host.querySelector<HTMLElement>("[data-testid='language-en']")!.click());
		assert.deepEqual(order, ["save:en", "relaunch"]);
		assert.equal(host.querySelector("[data-testid='language-en']")!.getAttribute("aria-checked"), "true");
		await unmount();
	});

	it("does not relaunch when the save fails, nor for the current language", async () => {
		const order: string[] = [];
		window.lh = { expandWindow() {}, relaunch: async () => { order.push("relaunch"); } };
		const { host, unmount } = await mount(async (next) => { order.push(`save:${next}`); return false; });
		await act(async () => host.querySelector<HTMLElement>("[data-testid='language-zh']")!.click());
		await act(async () => host.querySelector<HTMLElement>("[data-testid='language-en']")!.click());
		assert.deepEqual(order, ["save:en"]);
		await unmount();
	});

	it("without a desktop bridge, tells the user to restart the server", async () => {
		window.lh = undefined;
		const { host, unmount } = await mount(async () => true);
		await act(async () => host.querySelector<HTMLElement>("[data-testid='language-en']")!.click());
		assert.match(host.textContent ?? "", /重启服务器后生效/);
		await unmount();
	});
});
