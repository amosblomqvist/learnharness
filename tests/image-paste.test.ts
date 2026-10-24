/**
 * COMPOSER IMAGE PASTE tests (images.ts + its seams): the learner's pasted
 * screenshot must survive the whole record pipeline — the input event, the
 * native user message, the transcript projection, the optimistic-tail
 * absorption, and the model-facing conversion. These pins are the ones the
 * plan's Review Focus names: no silent drop, no double bubble, no unbounded
 * payload, and text-only records read exactly as before.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	IMAGE_MIME_TYPES,
	MAX_IMAGES,
	MAX_IMAGE_BYTES,
	imageBytes,
	imageUrl,
	parseComposerImages,
	ImageInputError,
} from "../src/core/images.ts";
import { ChatInputError, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newUserMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { serializeForSummary } from "../src/core/compaction.ts";
import { absorbed } from "../components/session-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

/** A tiny valid PNG payload (the base64 is what the wire carries). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const image = (over: Record<string, unknown> = {}) => ({ type: "image", mimeType: "image/png", data: PNG, ...over });
/** base64 of `bytes` bytes (padding-safe enough for the limit checks). */
const b64Of = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4);
/** assert.throws predicate: the error is ours AND says the thing. */
const fails = (re: RegExp) => (e: unknown) => e instanceof Error && re.test(e.message);

describe("images.ts — the payload limits", () => {
	it("accepts the four configured formats and normalizes to the native shape", () => {
		assert.deepEqual(IMAGE_MIME_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
		assert.deepEqual(parseComposerImages([image()]), [{ type: "image", mimeType: "image/png", data: PNG }]);
	});

	it("strips unknown fields — the draft's client id never reaches the wire", () => {
		const [parsed] = parseComposerImages([image({ id: "img_local" })]);
		assert.deepEqual(Object.keys(parsed!).sort(), ["data", "mimeType", "type"]);
	});

	it("refuses a foreign format, bad base64, and a non-array", () => {
		assert.throws(() => parseComposerImages([image({ mimeType: "image/tiff" })]), fails(/PNG, JPEG/));
		assert.throws(() => parseComposerImages([image({ data: "not base64!" })]), ImageInputError);
		assert.throws(() => parseComposerImages([image({ data: "" })]), ImageInputError);
		assert.throws(() => parseComposerImages("png"), ImageInputError);
	});

	it("refuses too many images and an oversized single image", () => {
		const many = Array.from({ length: MAX_IMAGES + 1 }, () => image());
		assert.throws(() => parseComposerImages(many), fails(/up to 4 images/));
		assert.throws(() => parseComposerImages([image({ data: b64Of(MAX_IMAGE_BYTES + 3) })]), fails(/MB or smaller/));
	});

	it("base64 length → decoded bytes, padding included", () => {
		assert.equal(imageBytes(PNG), Buffer.from(PNG, "base64").length);
		assert.equal(imageBytes("TQ=="), 1);
		assert.equal(imageUrl({ type: "image", mimeType: "image/png", data: PNG }), `data:image/png;base64,${PNG}`);
	});
});

describe("input events — text may be empty when an image rides", () => {
	it("parses text + images, and an image-only send", () => {
		const both = parseChatInput({ type: "text", text: "what is wrong here?", images: [image()] });
		assert.equal(both.type, "text");
		assert.equal(both.type === "text" && both.images?.length, 1);
		const alone = parseChatInput({ type: "text", text: "", images: [image()] });
		assert.equal(alone.type, "text");
		assert.equal(alone.type === "text" && alone.text, "");
	});

	it("still refuses an empty send (no text, no image)", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "   " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "", images: [] }), ChatInputError);
	});

	it("an invalid image is an honest 400, never a partial append", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "hi", images: [image({ mimeType: "image/bmp" })] }), ChatInputError);
	});

	it("appends ONE native user message carrying the ordered blocks", () => {
		const [appended] = inputAppends({ messages: [], kind: "teach" }, parseChatInput({ type: "text", text: "explain", images: [image()] }));
		assert.equal(appended!.role, "user");
		assert.deepEqual((appended as { content: unknown }).content, [
			{ type: "text", text: "explain" },
			{ type: "image", mimeType: "image/png", data: PNG },
		]);
	});

	it("an image-only input appends no empty text block", () => {
		const [appended] = inputAppends({ messages: [], kind: "teach" }, parseChatInput({ type: "text", text: "", images: [image()] }));
		assert.deepEqual((appended as { content: unknown }).content, [{ type: "image", mimeType: "image/png", data: PNG }]);
	});

	it("text-only records keep the plain string content (no migration)", () => {
		const m = newUserMessage("plain words");
		assert.equal(typeof m.content, "string");
		assert.equal(m.content, "plain words");
	});
});

describe("projectView — the transcript shows the picture", () => {
	it("projects image blocks as data-URL parts, in record order", () => {
		const message = newUserMessage("look", [{ type: "image", mimeType: "image/png", data: PNG }]) as LhMessage;
		const [view] = projectView([message]);
		assert.deepEqual(
			view!.parts.map((p) => p.type),
			["text", "image"],
		);
		assert.equal(view!.parts[1]!.url, `data:image/png;base64,${PNG}`);
		assert.equal(view!.parts[1]!.alt, "Pasted image");
		assert.equal(view!.parts[0]!.text, "look");
	});

	it("an image-only message projects no text part, and legacy text still reads", () => {
		const bare = projectView([newUserMessage("", [{ type: "image", mimeType: "image/png", data: PNG }]) as LhMessage]);
		assert.deepEqual(bare[0]!.parts.map((p) => p.type), ["image"]);
		const legacy = projectView([{ id: "m1", role: "user", content: "old text", timestamp: 1 } as LhMessage]);
		assert.deepEqual(legacy[0]!.parts.map((p) => p.text), ["old text"]);
	});
});

describe("the settle seam — no double bubble, no lost image", () => {
	it("the optimistic image message is absorbed by the write-ahead's copy", () => {
		const optimistic = { ...newUserMessage("look", [{ type: "image", mimeType: "image/png", data: PNG }]), id: "c_1" } as LhMessage;
		const persisted = { ...newUserMessage("look", [{ type: "image", mimeType: "image/png", data: PNG }]), id: "msg_server" } as LhMessage;
		assert.equal(absorbed(optimistic, [persisted]), true);
		assert.equal(absorbed({ ...newUserMessage("other", [{ type: "image", mimeType: "image/png", data: PNG }]), id: "c_2" } as LhMessage, [persisted]), false);
		// A text-only optimistic entry keeps the old string-identity law.
		const text = { ...newUserMessage("hi"), id: "c_3" } as LhMessage;
		assert.equal(absorbed(text, [{ id: "m", role: "user", content: "hi", timestamp: 1 } as LhMessage]), true);
	});

	it("the model context carries the image block (display only, id stripped)", () => {
		const record = [{ ...newUserMessage("look", [{ type: "image", mimeType: "image/png", data: PNG }]), id: "m1" } as LhMessage];
		const wire = toLlmMessages(record as never);
		assert.deepEqual(wire, [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", mimeType: "image/png", data: PNG },
				],
				timestamp: record[0]!.timestamp,
			},
		]);
	});
});

describe("compaction — the summary never eats the picture's record", () => {
	it("a native image message summarizes as the words plus a named image", () => {
		const message = newUserMessage("look", [{ type: "image", mimeType: "image/png", data: PNG }]) as LhMessage;
		const text = serializeForSummary([message]);
		assert.match(text, /\[LEARNER\] look\n\[image: image\/png\]/);
		assert.ok(!text.includes(PNG), "the base64 never enters the summary prompt");
	});

	it("an image-only message still reads as something (never [object Object])", () => {
		const message = newUserMessage("", [{ type: "image", mimeType: "image/png", data: PNG }]) as LhMessage;
		assert.equal(serializeForSummary([message]), "[LEARNER] [image: image/png]");
	});
});
