/**
 * THE COMPOSER IMAGE UPLOAD ROUTE (issue #96): POST /api/chats/:id/images
 * runs one pasted/picked picture through the SHARED learner-image pipeline
 * and stores it in ChatRecord.imageSnapshots under its SHA-256 identity.
 * This file pins the ROUTE contract: 404 unknown chat, 400 for a bad body
 * or unsupported bytes, 413 over the size bound, the response ref shape,
 * snapshot storage + session-scoped dedupe, and the input-event seam's
 * orphan-400 (a text send referencing a snapshot this session lacks).
 *
 * Runs under an isolated LH_DATA_DIR (the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-image-upload-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Post = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Post;
let createChat: () => { id: string };
let getChat: (id: string) => { imageSnapshots?: Record<string, ImageSnapshotLike> } | undefined;
type ImageSnapshotLike = { mimeType: "image/png" | "image/jpeg"; data: string; width: number; height: number };

before(async () => {
	const route = await import("../app/api/chats/[id]/images/route.ts");
	POST = route.POST;
	const server = await import("../src/server/chats.ts");
	createChat = () => server.createChat("Image upload regression");
	getChat = server.getChat as typeof getChat;
});

after(async () => {
	await fs.promises.rm(TMP_DATA, { recursive: true, force: true });
});

function picture(width = 40, height = 30): Buffer {
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

function upload(id: string, bytes: Buffer, name = "derivation.png", type = "image/png"): Promise<Response> {
	const form = new FormData();
	form.append("file", new File([bytes as BlobPart], name, { type }));
	return POST(new Request("http://x/api", { method: "POST", body: form }), { params: Promise.resolve({ id }) });
}

describe("POST /api/chats/:id/images", () => {
	it("404s an unknown chat before touching the body", async () => {
		const res = await upload("nope", picture());
		assert.equal(res.status, 404);
	});

	it("400s a body without a usable file field", async () => {
		const chat = createChat();
		const form = new FormData();
		form.append("file", "a string, not a file");
		const res = await POST(new Request("http://x/api", { method: "POST", body: form }), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 400);
		const empty = await POST(new Request("http://x/api", { method: "POST", body: new FormData() }), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(empty.status, 400);
	});

	it("processes, stores, and returns the ref (SHA-256 identity, shared pipeline output)", async () => {
		const chat = createChat();
		const res = await upload(chat.id, picture(64, 48), "board.png");
		assert.equal(res.status, 200);
		const body = await res.json() as { snapshotId: string; name: string; mimeType: string; width: number; height: number };
		assert.match(body.snapshotId, /^[a-f0-9]{64}$/);
		assert.equal(body.name, "board.png");
		assert.ok(body.mimeType === "image/png" || body.mimeType === "image/jpeg");
		assert.equal(body.width, 64);
		assert.equal(body.height, 48);
		const record = getChat(chat.id)!;
		const snapshot = record.imageSnapshots?.[body.snapshotId];
		assert.ok(snapshot, "the snapshot is stored in ChatRecord.imageSnapshots");
		assert.equal(snapshot!.mimeType, body.mimeType);
		assert.equal(snapshot!.width, 64);
		assert.equal(snapshot!.height, 48);
		// The stored payload is the processed bytes (base64, decodable).
		assert.ok(Buffer.from(snapshot!.data, "base64").byteLength > 0);
	});

	it("dedupes identical uploads per session (same identity, one stored snapshot)", async () => {
		const chat = createChat();
		const bytes = picture(50, 50);
		const a = await (await upload(chat.id, bytes, "one.png")).json() as { snapshotId: string };
		const b = await (await upload(chat.id, bytes, "two.png")).json() as { snapshotId: string };
		assert.equal(a.snapshotId, b.snapshotId);
		assert.equal(Object.keys(getChat(chat.id)!.imageSnapshots!).length, 1);
	});

	it("400s unsupported bytes with the shared pipeline's own wording", async () => {
		const chat = createChat();
		const res = await upload(chat.id, Buffer.from("definitely not an image"), "note.txt", "text/plain");
		assert.equal(res.status, 400);
		const body = await res.json() as { error: string };
		assert.match(body.error, /supported image/);
		assert.equal(getChat(chat.id)!.imageSnapshots, undefined);
	});

	it("refuses over-size images before any processing", async () => {
		const chat = createChat();
		const huge = Buffer.alloc(25 * 1024 * 1024 + 1, 7);
		const res = await upload(chat.id, huge, "huge.png");
		assert.equal(res.status, 413);
		const body = await res.json() as { error: string };
		assert.match(body.error, /25 MiB/);
	});

	it("normalizes an exotic-but-supported source (bmp → stored png)", async () => {
		const chat = createChat();
		const bmp = Buffer.alloc(62);
		bmp.write("BM"); bmp.writeUInt32LE(62, 2); bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(1, 22);
		bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(8, 34);
		const res = await upload(chat.id, bmp, "legacy.bmp", "image/bmp");
		assert.equal(res.status, 200);
		const body = await res.json() as { mimeType: string; width: number; height: number };
		assert.equal(body.mimeType, "image/png");
		assert.equal(body.width, 2);
		assert.equal(body.height, 1);
	});
});

describe("the text input's image refs (input-events seam)", () => {
	it("parseChatInput accepts image refs and an image-only send; rejects malformed ones", async () => {
		const { parseChatInput, ChatInputError } = await import("../src/core/input-events.ts");
		const snapshotId = "a".repeat(64);
		const parsed = parseChatInput({ type: "text", text: "", images: [{ snapshotId, name: "shot.png" }] });
		assert.deepEqual(parsed, { type: "text", text: "", images: [{ snapshotId, name: "shot.png" }] });
		assert.throws(() => parseChatInput({ type: "text", text: "" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "hi", images: [{ snapshotId: "zz", name: "x" }] }), /snapshot id/);
		assert.throws(() => parseChatInput({ type: "text", text: "hi", images: [{ snapshotId, name: "" }] }), /name/);
		const tooMany = Array.from({ length: 9 }, (_, i) => ({ snapshotId: String(i).padStart(64, "0"), name: `i${i}` }));
		assert.throws(() => parseChatInput({ type: "text", text: "hi", images: tooMany }), /more than/);
	});

	it("inputAppends refuses refs this session does not store (the orphan-400)", async () => {
		const { inputAppends, ChatInputError, newUserMessage } = await import("../src/core/index.ts");
		const chat = createChat();
		const stored = await (await upload(chat.id, picture(), "kept.png")).json() as { snapshotId: string };
		const record = getChat(chat.id)!;
		const appended = inputAppends(
			{ messages: [], kind: "teach", imageSnapshots: record.imageSnapshots },
			{ type: "text", text: "my derivation", images: [{ snapshotId: stored.snapshotId, name: "kept.png" }] },
		);
		const message = appended.at(-1)!;
		assert.equal(message.role, "user");
		assert.deepEqual((message as { images?: unknown }).images, [{ snapshotId: stored.snapshotId, name: "kept.png" }]);
		assert.throws(
			() => inputAppends(
				{ messages: [], kind: "teach", imageSnapshots: record.imageSnapshots },
				{ type: "text", text: "hi", images: [{ snapshotId: "b".repeat(64), name: "ghost.png" }] },
			),
			/not stored/,
		);
		// The constructor is additive: a plain text message carries no field at all.
		assert.ok(!("images" in newUserMessage("plain")));
	});
});
