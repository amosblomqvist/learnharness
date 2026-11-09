/**
 * The composer's image affordances (issue #96): paste interception, the
 * attach-image picker button, the chips row, and the send lane. Same
 * linkedom shims as composer-attach.test.tsx (no native Selection there).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, ChatSessionComposer } from "../components/composer.tsx";
import { composerImagesSendable, pastedImageFiles, type ComposerImage } from "../components/composer-images.tsx";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture() {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 600, left: 200, right: 240, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const attached: File[][] = [];
	const removed: string[] = [];
	let value = "";
	let pickerClicks = 0;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", { configurable: true, value: undefined });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	let images: ComposerImage[] = [];
	function draw() {
		root.render(
			<ChatSessionComposer
				busy={false}
				value={value}
				revision={0}
				onChange={(next) => { value = next; draw(); }}
				onSend={() => {}}
				onStop={() => {}}
				sendAllowed
				dictationActive={false}
				images={images}
				onAttachImages={(files) => { attached.push(files); }}
				onRemoveImage={(key) => { removed.push(key); }}
			/>,
		);
	}
	await act(async () => { draw(); });
	const picker = doc.querySelector<HTMLInputElement>('[data-testid="attach-image-input"]')!;
	picker.click = () => { pickerClicks++; };
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		doc, win, editor, picker,
		get images() { return images; },
		/** Swap the chip list and redraw (wrap calls in act at the site). */
		setImages(next: ComposerImage[]) { images = next; draw(); },
		get value() { return value; },
		get attached() { return attached; },
		get removed() { return removed; },
		get pickerClicks() { return pickerClicks; },
		async pick(files: File[]) {
			Object.defineProperty(picker, "files", { configurable: true, value: files });
			await act(async () => { picker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
		async paste(files: File[], text = "") {
			const clipboardData = {
				items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
				files,
				getData: (type: string) => (type === "text/plain" ? text : ""),
			};
			const event = Object.assign(new win.Event("paste", { bubbles: true, cancelable: true }), { clipboardData });
			await act(async () => { editor.dispatchEvent(event); });
		},
	};
}

function imageFile(name = "shot.png", type = "image/png"): File {
	return new File(["synthetic"], name, { type });
}

describe("pastedImageFiles (pure)", () => {
	it("takes image file items, skips non-image kinds, and falls back to the file list", () => {
		const image = imageFile();
		const pdf = new File(["x"], "doc.pdf", { type: "application/pdf" });
		const viaItems = pastedImageFiles({
			items: [
				{ kind: "string", type: "text/plain", getAsFile: () => null },
				{ kind: "file", type: "image/png", getAsFile: () => image },
				{ kind: "file", type: "application/pdf", getAsFile: () => pdf },
			],
		});
		assert.deepEqual(viaItems, [image]);
		const viaFiles = pastedImageFiles({ items: [], files: [image, pdf] });
		assert.deepEqual(viaFiles, [image]);
		assert.deepEqual(pastedImageFiles(null), []);
	});
});

describe("composerImagesSendable (pure)", () => {
	const uploaded: ComposerImage = { key: "k1", name: "a.png", state: { phase: "uploaded", snapshotId: "a".repeat(64) } };
	it("sends on uploaded pictures, holds while any upload runs, ignores failed-only drafts", () => {
		assert.equal(composerImagesSendable([uploaded]), true);
		assert.equal(composerImagesSendable([uploaded, { key: "k2", name: "b.png", state: { phase: "uploading" } }]), false);
		assert.equal(composerImagesSendable([{ key: "k3", name: "c.png", state: { phase: "failed", error: "x" } }]), false);
		assert.equal(composerImagesSendable([]), false);
	});
});

describe("composer image affordances", () => {
	it("server render: the image button appears only where uploads are possible", () => {
		const bare = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.ok(!bare.includes('data-testid="attach-image"'), "the new-session composer stays text-only");
		const withUploads = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} onAttachImages={() => {}} />);
		assert.ok(withUploads.includes('data-testid="attach-image"'));
		assert.ok(withUploads.includes('accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"'));
	});

	it("paste hands image files upward without touching the draft text", async () => {
		const f = await fixture();
		await f.paste([imageFile()], "also text");
		assert.equal(f.attached.length, 1);
		assert.equal(f.attached[0]!.length, 1);
		assert.equal(f.attached[0]![0]!.name, "shot.png");
	});

	it("a text-only paste attaches nothing", async () => {
		const f = await fixture();
		await f.paste([], "plain words");
		assert.equal(f.attached.length, 0);
	});

	it("the picker button forwards picked image files and never reads them", async () => {
		const f = await fixture();
		const button = f.doc.querySelector<HTMLButtonElement>('[data-testid="attach-image"]')!;
		await act(async () => { button.click(); });
		assert.equal(f.pickerClicks, 1);
		const file = imageFile("cam.jpg", "image/jpeg");
		await f.pick([file, new File(["x"], "notes.txt", { type: "text/plain" })]);
		assert.equal(f.attached.length, 1);
		assert.deepEqual(f.attached[0], [file]);
	});

	it("chips render per state and the remove button reports its key", async () => {
		const f = await fixture();
		await act(async () => {
			f.setImages([
				{ key: "k1", name: "done.png", state: { phase: "uploaded", snapshotId: "a".repeat(64) } },
				{ key: "k2", name: "busy.png", state: { phase: "uploading" } },
				{ key: "k3", name: "bad.png", state: { phase: "failed", error: "Unsupported" } },
			]);
		});
		const chips = f.doc.querySelectorAll('[data-testid="composer-image-chip"]');
		assert.equal(chips.length, 3, `chips render (got ${chips.length})`);
		const removes = f.doc.querySelectorAll<HTMLButtonElement>('[data-testid="composer-image-remove"]');
		assert.equal(removes.length, 3);
		assert.equal(removes[0]!.getAttribute("aria-label"), "Remove image done.png");
		await act(async () => { removes[1]!.click(); });
		assert.deepEqual(f.removed, ["k2"]);
	});

	it("the send lane opens for an uploaded image with empty text (Enter sends)", async () => {
		const f = await fixture();
		await act(async () => {
			f.setImages([{ key: "k1", name: "done.png", state: { phase: "uploaded", snapshotId: "a".repeat(64) } }]);
		});
		const send = f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
		assert.equal(send.disabled, false);
		// While an upload is pending the lane stays closed.
		await act(async () => {
			f.setImages([{ key: "k2", name: "busy.png", state: { phase: "uploading" } }]);
		});
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, true);
	});
});
