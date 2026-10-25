import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Composer } from "../components/composer.tsx";
import {
	handleImagePaste,
	imagePasteAllowed,
	handlePickedFiles,
	ImageDraftController,
	imageDropHandlers,
	normalizeImageFile,
	type RasterDeps,
} from "../components/draft-images.ts";
import { IMAGE_ERRORS, type DraftImage } from "../src/core/index.ts";

/** A PNG header (signature + IHDR) for w x h: what inspectImageBytes reads. */
function pngBytes(w: number, h: number, pad = 0): Uint8Array {
	const b = new Uint8Array(33 + pad);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, w);
	new DataView(b.buffer).setUint32(20, h);
	return b;
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const file = (type: string, bytes: Uint8Array, name = "x") => new File([bytes as BlobPart], name, { type });

const fakeDeps = (over: Partial<RasterDeps> & { w?: number; h?: number; pngSize?: (scale: number) => number } = {}): RasterDeps & { scales: number[] } => {
	const scales: number[] = [];
	return {
		scales,
		head: over.head ?? (async (f) => new Uint8Array(await f.arrayBuffer())),
		toBase64: async (blob) => Buffer.from(await blob.arrayBuffer()).toString("base64"),
		decode:
			over.decode ??
			(async () => ({
				width: over.w ?? 100,
				height: over.h ?? 50,
				close() {},
				async encodePng(scale: number) {
					scales.push(scale);
					return new Blob([pngBytes(10, 10, over.pngSize ? over.pngSize(scale) : 0) as BlobPart], { type: "image/png" });
				},
			})),
	};
};

describe("normalizeImageFile", () => {
	it("keeps PNG bytes that already fit, byte for byte", async () => {
		const bytes = pngBytes(100, 50, 40);
		const out = await normalizeImageFile(file("image/png", bytes), fakeDeps());
		assert.equal(out.mimeType, "image/png");
		assert.equal(out.data, b64(bytes));
	});

	it("resizes a 4000px image to the 2048 bound and re-encodes it as PNG", async () => {
		const deps = fakeDeps({ w: 4000, h: 2000 });
		const out = await normalizeImageFile(file("image/png", pngBytes(4000, 2000)), deps);
		assert.equal(out.mimeType, "image/png");
		assert.deepEqual(deps.scales, [2048 / 4000]);
	});

	it("re-encodes GIF (first frame) as PNG", async () => {
		const gif = new Uint8Array([...Buffer.from("GIF89a"), 10, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		const out = await normalizeImageFile(file("image/gif", gif), fakeDeps({ w: 10, h: 10 }));
		assert.equal(out.mimeType, "image/png");
	});

	it("shrinks until the PNG fits 5 MiB, or refuses", async () => {
		const deps = fakeDeps({ w: 3000, h: 3000, pngSize: (s) => (s < 0.5 ? 100 : 6 * 1024 * 1024) });
		const big = file("image/png", pngBytes(3000, 3000, 100));
		const out = await normalizeImageFile(big, deps);
		assert.equal(out.mimeType, "image/png");
		assert.ok(deps.scales.length > 1 && deps.scales.at(-1)! < 0.5);
		await assert.rejects(() => normalizeImageFile(big, fakeDeps({ w: 3000, h: 3000, pngSize: () => 6 * 1024 * 1024 })), { message: IMAGE_ERRORS.size });
	});

	it("refuses unsupported types, >25MP headers, spoofed content and undecodable files with friendly text", async () => {
		await assert.rejects(() => normalizeImageFile(file("application/pdf", new Uint8Array(4)), fakeDeps()), { message: IMAGE_ERRORS.format });
		await assert.rejects(() => normalizeImageFile(file("image/png", pngBytes(6000, 6000)), fakeDeps()), { message: IMAGE_ERRORS.dimensions });
		await assert.rejects(() => normalizeImageFile(file("image/png", new Uint8Array(40)), fakeDeps()), { message: IMAGE_ERRORS.content });
		await assert.rejects(
			() => normalizeImageFile(file("image/png", pngBytes(10, 10)), fakeDeps({ decode: async () => Promise.reject(new Error("bad")) })),
			{ message: IMAGE_ERRORS.unreadable },
		);
	});
});

/** A controller whose normalize completes when we say so. */
function gated() {
	const gates: Array<() => void> = [];
	const c = new ImageDraftController(async (f) => {
		await new Promise<void>((r) => gates.push(r));
		return { mimeType: "image/png", data: b64(pngBytes(10 + f.size, 10, 20)) };
	});
	// Normalization starts lazily (sequential queue), so wait for the gate to exist.
	const release = async (i: number) => {
		for (let n = 0; n < 5 && !gates[i]; n++) await new Promise((r) => setTimeout(r, 0));
		gates[i]?.();
	};
	return { c, release };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const f = (size: number) => file("image/png", new Uint8Array(size));

describe("ImageDraftController (the one hook's state machine)", () => {
	it("keeps file order and awaitReads waits for every read (paste then Enter)", async () => {
		const { c, release } = gated();
		c.addFiles([f(1), f(2)]);
		assert.equal(c.getState().reading, 2);
		let settled = false;
		const waiting = c.awaitReads().then(() => (settled = true));
		await tick();
		assert.equal(settled, false);
		await release(0);
		await tick();
		await release(1);
		await waiting;
		assert.equal(c.images.length, 2);
		assert.equal(c.getState().reading, 0);
		assert.ok(c.images[0]!.data !== c.images[1]!.data);
	});

	it("a decode finishing after clear() cannot resurrect the draft", async () => {
		const { c, release } = gated();
		c.addFiles([f(1)]);
		c.clear();
		await release(0);
		await c.awaitReads();
		await tick();
		assert.equal(c.images.length, 0);
		assert.equal(c.getState().reading, 0);
	});

	it("a decode finishing after unmount touches nothing; revive re-arms", async () => {
		const { c, release } = gated();
		let notified = 0;
		c.subscribe(() => notified++);
		c.addFiles([f(1)]);
		const before = notified;
		c.dispose();
		await release(0);
		await c.awaitReads();
		assert.equal(c.images.length, 0);
		assert.equal(notified, before);
		c.revive();
		c.addFiles([f(2)]);
		await release(0); // the stale batch never started a decode, so this is gate 0
		await c.awaitReads();
		assert.equal(c.images.length, 1);
	});

	it("restoreSent puts the sent images first and keeps ones added since", async () => {
		const { c, release } = gated();
		c.addFiles([f(1)]);
		await release(0);
		await c.awaitReads();
		const sent = [...c.images];
		c.clear();
		c.addFiles([f(2)]);
		await release(1);
		await c.awaitReads();
		const later = c.images[0]!;
		c.restoreSent(sent);
		assert.deepEqual(c.images.map((i: DraftImage) => i.id), [sent[0]!.id, later.id]);
	});

	it("ACK removes only the sent ids; images added after the snapshot stay", async () => {
		const { c, release } = gated();
		c.addFiles([f(1)]);
		await release(0);
		await c.awaitReads();
		const sent = [...c.images];
		c.addFiles([f(2)]); // pasted while the POST was in flight
		await release(1);
		await c.awaitReads();
		const later = c.images[1]!;
		c.removeImages(sent.map((i) => i.id)); // the onAccepted callback
		assert.deepEqual(c.images.map((i) => i.id), [later.id]);
		c.restoreSent(sent); // a late/duplicate restore dedupes by id
		c.restoreSent(sent);
		assert.deepEqual(c.images.map((i) => i.id), [sent[0]!.id, later.id]);
	});

	it("the same file can be added again after it was removed", async () => {
		const { c, release } = gated();
		const same = f(3);
		c.addFiles([same]);
		await release(0);
		await c.awaitReads();
		c.setImages([]);
		c.addFiles([same]);
		await release(1);
		await c.awaitReads();
		assert.equal(c.images.length, 1);
	});

	it("unsupported types show a friendly error and add nothing; errors clear on the next add", async () => {
		const c = new ImageDraftController(); // the real normalizer refuses before any decode
		c.addFiles([file("application/pdf", new Uint8Array(4))]);
		await c.awaitReads();
		assert.equal(c.getState().error, IMAGE_ERRORS.format);
		assert.equal(c.images.length, 0);
	});

	it("refuses a fifth image with the count error", async () => {
		const c = new ImageDraftController(async (x) => ({ mimeType: "image/png", data: b64(pngBytes(10 + x.size, 10, 20)) }));
		c.addFiles([f(1), f(2), f(3), f(4), f(5)]);
		await c.awaitReads();
		assert.equal(c.images.length, 4);
		assert.equal(c.getState().error, IMAGE_ERRORS.count);
	});
});

describe("DOM handlers", () => {
	const dt = (types: string[], files: File[] = []) => ({ types, files, items: [], getData: () => "" }) as unknown as DataTransfer;

	it("drop: claims every file drop (no browser navigation) and routes files to the draft", () => {
		const got: File[][] = [];
		const h = imageDropHandlers((files) => got.push(files));
		let prevented = 0;
		const ev = (data: DataTransfer) => ({ dataTransfer: data, preventDefault: () => prevented++ }) as unknown as React.DragEvent;
		h.onDragOver(ev(dt(["Files"])));
		const pdf = file("application/pdf", new Uint8Array(2));
		h.onDrop(ev(dt(["Files"], [pdf])));
		assert.equal(prevented, 2);
		assert.deepEqual(got, [[pdf]]);
		h.onDrop(ev(dt(["text/plain"])));
		assert.equal(prevented, 2, "non-file drops are left alone");
	});

	it("picker: hands files over and resets the input so the same file refires", () => {
		const got: File[][] = [];
		const input = { files: [f(1)] as unknown as FileList, value: "C:\\a.png" };
		handlePickedFiles(input, (files) => got.push(files));
		assert.equal(input.value, "");
		assert.equal(got[0]!.length, 1);
	});

	it("paste: an image-only clipboard is claimed, a text+image clipboard keeps its text", () => {
		const img = f(1);
		let prevented = 0;
		const got: File[][] = [];
		const ev = (text: string) =>
			({ clipboardData: { files: [img], items: [], getData: () => text }, preventDefault: () => prevented++ }) as unknown as React.ClipboardEvent;
		handleImagePaste(ev(""), (x) => got.push(x));
		handleImagePaste(ev("hello"), (x) => got.push(x));
		assert.equal(prevented, 1);
		assert.equal(got.length, 2);
	});
});

describe("Composer image surface", () => {
	it("renders the picker (multi, image types only), the strip and the error", () => {
		const html = renderToStaticMarkup(
			<Composer
				busy={false}
				value=""
				onChange={() => {}}
				onSend={() => {}}
				onStop={() => {}}
				canSend
				imageDraft={{
					images: [{ id: "img_1", type: "image", mimeType: "image/png", data: "AAAA" }],
					hasImages: true,
					error: IMAGE_ERRORS.format,
					onChange: () => {},
					onPaste: () => {},
				}}
			/>,
		);
		assert.match(html, /data-testid="composer-image-input"/);
		assert.match(html, /accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
		assert.match(html, /multiple/);
		assert.match(html, /aria-label="Remove image"/);
		assert.match(html, /Images must be PNG, JPEG, WebP, or GIF\./);
	});

	it("without a draft there is no picker", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />);
		assert.ok(!html.includes("composer-image-input"));
	});
});


describe("page-level clipboard routing", () => {
 const element = ({ field = false, composer = false, dialog = false } = {}) => ({
  closest(selector: string) {
   if (selector.includes('role=')) return dialog ? this : null;
   if (selector === "[data-image-composer]") return composer ? this : null;
   return field ? this : null;
  },
 }) as unknown as Element;
 it("accepts page and attachment-button focus as well as the composer field", () => {
  assert.ok(imagePasteAllowed(element(), element()));
  assert.ok(imagePasteAllowed(element(), element({ field: true, composer: true })));
  assert.ok(imagePasteAllowed(element({ field: true, composer: true }), element({ field: true, composer: true })));
 });
 it("leaves other inputs/editors and dialogs alone, even when the event targets body", () => {
  assert.equal(imagePasteAllowed(element({ field: true }), element()), false);
  assert.equal(imagePasteAllowed(element(), element({ field: true })), false);
  assert.equal(imagePasteAllowed(element(), element({ dialog: true })), false);
 });
 it("does not duplicate mixed text/image events across React and document listeners", () => {
  const image = file("image/png", pngBytes(1, 1)); let calls = 0, prevented = 0;
  const native = { clipboardData: { files: [image], items: [], getData: () => "caption" }, defaultPrevented: false, preventDefault() { prevented++; } } as unknown as ClipboardEvent;
  handleImagePaste({ ...native, nativeEvent: native }, () => calls++);
  handleImagePaste(native, () => calls++);
  assert.equal(calls, 1); assert.equal(prevented, 0);
 });
});
