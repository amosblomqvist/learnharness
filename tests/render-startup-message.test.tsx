import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { StartupMessage, StartupMessageBody, type StartupMessageOffer } from "../components/startup-message.tsx";
import { installModalDom } from "./modal-dom.ts";

const message = { id: "new-message", title: "An update", publishedAt: "2026-11-13T01:01:00Z", bodyMarkdown: "Some **formatted** text." };
let root: Root | undefined, restore: (() => void) | undefined;
function fixture({ dismissSaved = true } = {}) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	Object.defineProperty(dom.document, "hasFocus", { value: () => true });
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	restore = () => {
		delete window.lh;
		restoreModalDom();
		for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
	};
	root = createRoot(document.querySelector("#root")!);
	let resolve!: (offer: StartupMessageOffer | null) => void;
	const request = new Promise<StartupMessageOffer | null>(done => { resolve = done; });
	const dismissals: string[] = [];
	let calls = 0, controller!: InteractionLayersController;
	window.lh = {
		expandWindow() {}, takeStartupMessage: () => { calls++; return request; },
		dismissStartupMessage: async (id: string) => { dismissals.push(id); return dismissSaved; },
	};
	function Probe() { controller = useInteractionLayers(); return null; }
	return {
		dismissals, calls: () => calls, controller: () => controller,
		async render(child: React.ReactNode = null) {
			await act(async () => root!.render(<React.StrictMode><InteractionLayersProvider><Probe />{child}<StartupMessage /></InteractionLayersProvider></React.StrictMode>));
		},
		async offer(deadlineAt = Date.now() + 3000, beforeCommit?: () => void) {
			await act(async () => {
				resolve({ message, deadlineAt });
				await request;
				await Promise.resolve(); // Let the offer's catch/then chain run before React commits.
				beforeCommit?.();
			});
		},
		async input(type: string) { await act(async () => window.dispatchEvent(new dom.window.Event(type))); },
		async backdrop() {
			await act(async () => { controller.requestClose(controller.getActiveModal()!.id, "backdrop"); });
		},
		async escape() {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as unknown as KeyboardEvent); document.dispatchEvent(event); });
		},
	};
}
const dialog = () => document.querySelector('[role="dialog"]');
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; restore?.(); restore = undefined; });

for (const method of ["button", "header button", "escape", "backdrop"]) it(`shows one accessible dialog and persists explicit ${method} dismissal`, async () => {
	const f = fixture();
	await f.render();
	assert.equal(f.calls(), 1);
	assert.equal(dialog(), null);
	await f.offer();
	const heading = dialog()?.querySelector("h2");
	assert.equal(heading?.textContent, message.title);
	assert.equal(dialog()?.getAttribute("aria-labelledby"), heading?.id);
	assert.equal(document.activeElement, heading);
	assert.deepEqual(f.dismissals, [], "showing does not count as dismissal");
	if (method === "button") await act(async () => dialog()?.querySelector<HTMLButtonElement>("footer button")?.click());
	else if (method === "header button") {
		const close = dialog()?.querySelector<HTMLButtonElement>('header button[aria-label="关闭公告"]');
		assert.ok(close);
		await act(async () => close.click());
	} else if (method === "escape") await f.escape();
	else await f.backdrop();
	assert.equal(dialog(), null);
	assert.deepEqual(f.dismissals, [message.id]);
});

it("still closes when its dismissal cannot be persisted", async () => {
	const f = fixture({ dismissSaved: false });
	await f.render();
	await f.offer();
	await act(async () => dialog()?.querySelector("button")?.click());
	assert.equal(dialog(), null);
	assert.deepEqual(f.dismissals, [message.id]);
});

it("skips without dismissal after a conflicting modal", async () => {
	const f = fixture();
	await f.render(<HostDialog open onClose={() => {}}><h2>Setup</h2></HostDialog>);
	assert.equal(dialog()?.textContent, "Setup");
	await f.render();
	await f.offer();
	assert.equal(dialog(), null, "do not queue an announcement behind setup");
	assert.deepEqual(f.dismissals, []);
});

for (const input of ["pointerdown", "keydown", "deadline"]) it(`skips after ${input} without dismissal`, async () => {
	const f = fixture();
	await f.render();
	if (input !== "deadline") await f.input(input);
	await f.offer(input === "deadline" ? Date.now() - 1 : undefined);
	assert.equal(dialog(), null);
	assert.deepEqual(f.dismissals, []);
});

it("does not register or focus a dialog when an eligible offer expires before React commits", async t => {
	const f = fixture();
	await f.render(<button id="existing-focus">Keep focus here</button>);
	const focused = document.querySelector<HTMLElement>("#existing-focus")!;
	focused.focus();
	let registered = false;
	const controller = f.controller();
	const unsubscribe = controller.subscribe(() => { registered ||= !!controller.getActiveModal(); });
	let now = Date.now();
	const deadlineAt = now + 1000;
	let reads = 0;
	const clock = t.mock.method(Date, "now", () => { reads++; return now; });
	try {
		await f.offer(deadlineAt, () => {
			assert.ok(reads >= 2, "the offer handler accepted the offer and set its timer");
			assert.equal(dialog(), null, "React has not committed the modal");
			now = deadlineAt;
		});
		assert.equal(registered, false, "the expired lease never enters the layer stack");
		assert.equal(dialog(), null);
		assert.equal(document.activeElement, focused);
		assert.deepEqual(f.dismissals, []);
	} finally { unsubscribe(); clock.mock.restore(); }
});

it("is inert without the desktop bridge", async () => {
	const f = fixture();
	delete window.lh;
	await f.render();
	assert.equal(f.calls(), 0);
	assert.equal(dialog(), null);
});

it("renders basic Markdown without executable HTML, remote embeds or unsafe links", () => {
	const html = renderToStaticMarkup(<StartupMessageBody markdown={`## Heading\n\n- **Bold**\n\n[Good](https://learnharness.ai/) [Unsafe](javascript:alert%281%29) [Local](//example.test) [Credentials](https://a:b@example.test)\n\n![Remote](https://example.test/remote)\n\n<img src="https://example.test/html" onerror="bad()">\n\n<iframe src="https://example.test/embed"></iframe>\n\n\`\`\`mermaid\na-->b\n\`\`\``} />);
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	assert.equal(document.querySelector("h2")?.textContent, "Heading");
	assert.equal(document.querySelector(".lh-prose ul li strong")?.textContent, "Bold", "use the session prose class and semantic emphasis");
	assert.equal(document.querySelectorAll("a").length, 1);
	assert.equal(document.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
	assert.equal(document.querySelector("a")?.getAttribute("href"), "https://learnharness.ai/");
	assert.equal(document.querySelector("img,iframe,script,svg,button"), null);
	assert.equal(document.querySelector("pre code")?.textContent?.trim(), "a-->b");
});
