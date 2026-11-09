/**
 * THE MODEL-FACING IMAGE DELIVERY (issue #96): user messages carry image
 * REFS; toLlmMessages — the ONE model-facing seam — resolves them per the
 * ACTIVE engine's pi-ai metadata: native ImageContent parts on a
 * vision-capable model (pi-ai `Model.input` includes "image"), the honest
 * bracketed note otherwise. This file pins that decision table, the
 * options-less default (text-only — compaction estimates, golden
 * fixtures), the wire strip of the ref field, pi-ai's own acceptance of the
 * produced parts (transformMessages), and projectView's thumbnail part.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
	asAgentMessages,
	imageNoteText,
	newUserMessage,
	toLlmMessages,
	type LhMessage,
	type ToLlmOptions,
	type UserImageAttachment,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { ImageSnapshot } from "../src/core/contracts.ts";

const SNAP_A = "a".repeat(64);
const SNAP_B = "b".repeat(64);
const snapshot = (id: string): ImageSnapshot => ({
	mimeType: id === SNAP_B ? "image/jpeg" : "image/png",
	data: `base64-of-${id.slice(0, 4)}`,
	width: 800,
	height: 600,
});
const snapshots: Record<string, ImageSnapshot> = { [SNAP_A]: snapshot(SNAP_A), [SNAP_B]: snapshot(SNAP_B) };
const refs: UserImageAttachment[] = [
	{ snapshotId: SNAP_A, name: "derivation.png" },
	{ snapshotId: SNAP_B, name: "board photo.jpg" },
];

function imageMessage(text: string): LhMessage {
	return newUserMessage(text, refs);
}

function userWire(out: ReturnType<typeof toLlmMessages>, index = 0) {
	const message = out[index]!;
	assert.equal(message.role, "user");
	return message as { content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
}

describe("toLlmMessages: image refs on a vision-capable model", () => {
	const vision: ToLlmOptions = { vision: true, snapshots };

	it("becomes a text part followed by native ImageContent parts, verbatim bytes", () => {
		const wire = userWire(toLlmMessages(asAgentMessages([imageMessage("check my working")]), vision));
		assert.ok(Array.isArray(wire.content));
		const blocks = wire.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		assert.deepEqual(
			blocks.map((b) => b.type),
			["text", "image", "image"],
		);
		assert.equal(blocks[0]!.text, "check my working");
		assert.deepEqual(
			blocks.slice(1).map((b) => ({ data: b.data, mimeType: b.mimeType })),
			refs.map((ref) => ({ data: snapshots[ref.snapshotId]!.data, mimeType: snapshots[ref.snapshotId]!.mimeType })),
		);
	});

	it("carries an image-only message as image parts with no empty text part", () => {
		const wire = userWire(toLlmMessages(asAgentMessages([imageMessage("")]), vision));
		assert.deepEqual((wire.content as Array<{ type: string }>).map((b) => b.type), ["image", "image"]);
	});

	it("pi-ai's provider transform accepts the produced parts for a vision model", () => {
		// The faux catalog model takes images (input: ["text","image"]) — the
		// same acceptance check the provider boundary applies at stream time.
		const faux = createFauxCore({});
		const converted = toLlmMessages(asAgentMessages([imageMessage("here")]), vision);
		const providerHistory = transformMessages(converted, faux.getModel());
		const user = providerHistory.find((m) => m.role === "user") as { content: Array<{ type: string }> };
		assert.ok(user.content.some((b) => b.type === "image"));
	});
});

describe("toLlmMessages: the honest note when the model cannot see the picture", () => {
	it("flattens every ref to the bracketed note (non-vision model), no image parts", () => {
		const wire = userWire(toLlmMessages(asAgentMessages([imageMessage("check my working")]), { vision: false, snapshots }));
		assert.equal(typeof wire.content, "string");
		assert.equal(wire.content, `check my working\n${refs.map(imageNoteText).join("\n")}`);
	});

	it("notes a resolvable-but-unseen image identically to a missing snapshot", () => {
		const missing: ToLlmOptions = { vision: true, snapshots: {} };
		const wire = userWire(toLlmMessages(asAgentMessages([newUserMessage("hi", [{ snapshotId: "c".repeat(64), name: "ghost.png" }])]), missing));
		assert.equal(wire.content, `hi\n[image attached: ghost.png]`);
	});

	it("the options-less call is deliberately text-only (compaction estimates, fixtures)", () => {
		const wire = userWire(toLlmMessages(asAgentMessages([imageMessage("plain")])) as never);
		assert.equal(wire.content, `plain\n${refs.map(imageNoteText).join("\n")}`);
	});
});

describe("toLlmMessages: the record-only fields strip at the wire", () => {
	it("drops the images ref field itself — the provider sees native content only", () => {
		for (const options of [undefined, { vision: true, snapshots }] as const) {
			const wire = toLlmMessages(asAgentMessages([imageMessage("x")]), options)[0] as Record<string, unknown>;
			assert.ok(!("images" in wire));
			assert.ok(!("id" in wire));
		}
	});
});

describe("projectView: the transcript's thumbnail part", () => {
	it("emits one data-user-images part carrying the refs, after the text parts", () => {
		const [first] = projectView([imageMessage("my derivation")]);
		const view = first!;
		assert.equal(view.role, "user");
		assert.deepEqual(view.parts.map((p) => p.type), ["text", "data-user-images"]);
		assert.deepEqual(view.parts[1]!.data, refs);
	});

	it("plain user messages project exactly as before (no part, no field)", () => {
		const [first] = projectView([newUserMessage("just text")]);
		assert.deepEqual(first!.parts.map((p) => p.type), ["text"]);
	});
});
