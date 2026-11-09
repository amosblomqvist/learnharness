import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(document, { oninput: null });
Object.assign(dom.window.HTMLElement.prototype, {
	showModal(this: HTMLElement) { this.setAttribute("open", ""); },
	close(this: HTMLElement) { this.removeAttribute("open"); },
});

const originalFetch = globalThis.fetch;
const editorIds = ["common", "prober", "teacher", "practice", "proberTeacherShared"] as const;

test("unmount flushes the latest prompt edit after a prior debounce interval", async (t) => {
	const [{ createRoot }, { PromptEditors }] = await Promise.all([
		import("react-dom/client"),
		import("../components/settings/prompt-editors.tsx"),
	]);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const writes: Array<{ editor: string; text: string }> = [];
	globalThis.fetch = async (input, init) => {
		if (String(input) !== "/api/settings/prompts") throw new Error(`Unexpected request ${input}`);
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body)) as { editor: string; text: string };
			writes.push(body);
			return Response.json({ ...body, versionId: "version-1", savedAt: "2026-11-09T00:00:00.000Z" });
		}
		return Response.json({
			editors: Object.fromEntries(editorIds.map((id) => [id, { text: "default", defaultText: "default" }])),
			history: [],
			migrationNotice: false,
		});
	};

	try {
		await act(async () => { root.render(<PromptEditors />); await Promise.resolve(); });
		await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Common instructions"]')!.click(); });
		const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
		const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		const edit = async (text: string) => act(async () => {
			setValue.call(textarea, text);
			textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		await edit("first edit");
		assert.match(host.textContent ?? "", /Unsaved changes/);
		await act(async () => { t.mock.timers.tick(300); });
		await edit("latest edit");
		await act(async () => { t.mock.timers.tick(300); });
		await act(async () => { root.unmount(); await Promise.resolve(); await Promise.resolve(); });
		assert.deepEqual(writes, [{ editor: "common", text: "latest edit" }]);
	} finally {
		await act(async () => { root.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});
