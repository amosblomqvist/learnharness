/**
 * Session context attachments (2026-10-29) — the server path end to end
 * with zero tokens: files go through the real upload route, the learner's
 * message goes through handleChatRequest, and a scripted pi engine plays
 * the model — recording the system prompt, tool registry and messages it
 * was given, and calling the attachment readers like a real model would.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep, type ModelImageResizeOptions, type SystemMessage } from "@earendil-works/pi-ai";
import { createCanvas } from "@napi-rs/canvas";
import * as photon from "@silvia-odwyer/photon-node";
import type { AttachmentRecord } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { makeEpub } from "./fixtures/make-epub.ts";

// Hermetic: LH_DATA_DIR → a temp dir, set BEFORE the first app-module import
// (the seam is env-at-module-load), so every app-module import is dynamic.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { attachmentsRoot } = await import("../src/store/attachments.ts");
const { newCompactionMarker } = await import("../src/core/compaction.ts");
const { PATHS } = await import("../config.ts");
const attachmentsRoute = await import("../app/api/chats/[id]/attachments/route.ts");
const attachmentRoute = await import("../app/api/chats/[id]/attachments/[attachmentId]/route.ts");

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const PDF = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

interface Seen {
	systemPrompt: string;
	tools: string[];
	messages: Array<{ role: string; content: unknown }>;
}

/** Scripted model: each step sees the request context and returns a reply. */
function scripted(
	steps: ((seen: Seen) => ReturnType<typeof fauxAssistantMessage>)[],
	opts: { vision?: boolean; imageResize?: ModelImageResizeOptions } = {},
) {
	const seen: Seen[] = [];
	const faux = createFauxCore(
		opts.vision === false
			? { models: [{ id: "text-only", input: ["text"] }] }
			: opts.imageResize
				? { models: [{ id: "small-vision", input: ["text", "image"], inputLimits: { images: { resize: opts.imageResize } } }] }
				: {},
	);
	faux.setResponses(
		steps.map((step): FauxResponseStep => (context) => {
			// The agent declares its prompt and loadout in leading system messages.
			const system = context.messages.filter((m): m is SystemMessage => m.role === "system");
			const s: Seen = {
				systemPrompt: system
					.flatMap((m) => [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""), ...Object.values(m.sections ?? {})])
					.join("\n"),
				tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
				messages: context.messages.filter((m) => m.role !== "system") as Seen["messages"],
			};
			seen.push(s);
			return step(s);
		}),
	);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, seen };
}

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** The blob store's contents (every session's attached files, stored once). */
function blobs(): string[] {
	try {
		return fs.readdirSync(attachmentsRoot()).sort();
	} catch {
		return [];
	}
}

function newChat(): string {
	const chat = chatStore.createChat("Test: attachments");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat.id;
}

async function upload(chatId: string, name: string, bytes: Uint8Array) {
	const form = new FormData();
	form.append("file", new File([Buffer.from(bytes)], name));
	const res = await attachmentsRoute.POST(new Request(`http://local/api/chats/${chatId}/attachments`, { method: "POST", body: form }), {
		params: Promise.resolve({ id: chatId }),
	});
	assert.ok(res.status === 200 || res.status === 422, `unexpected HTTP ${res.status}`);
	return { ok: res.status === 200, ...(await res.json()) } as { ok: boolean; attachment?: AttachmentRecord; error?: string };
}

async function attach(chatId: string, name: string, bytes: Uint8Array): Promise<{ record: AttachmentRecord; path: string }> {
	const result = await upload(chatId, name, bytes);
	assert.ok(result.ok, result.error);
	return { record: result.attachment!, path: path.join(attachmentsRoot(), result.attachment!.file) };
}

function patchRequest(chatId: string, attachmentId: string, body: unknown): Promise<Response> {
	return attachmentRoute.PATCH(
		new Request(`http://local/api/chats/${chatId}/attachments/${attachmentId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: chatId, attachmentId }) },
	);
}

async function detach(chatId: string, attachmentId: string, detached: boolean): Promise<AttachmentRecord> {
	const res = await patchRequest(chatId, attachmentId, { detached });
	assert.equal(res.status, 200);
	return ((await res.json()) as { attachment: AttachmentRecord }).attachment;
}

/** Send one learner message and run the turn to completion. */
async function send(chatId: string, engine: PiEngine, text: string, attachmentIds?: string[]): Promise<void> {
	const req = new Request("http://local/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text, ...(attachmentIds ? { attachmentIds } : {}) } }),
	});
	const ack = await handleChatRequest(req, (opts) => createTeacherAgent(undefined, { ...opts, engine }));
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

/** The text of the most recent tool result the model was handed. */
function lastToolResult(s: Seen): string {
	const result = [...s.messages].reverse().find((m) => m.role === "toolResult");
	return ((result?.content ?? []) as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
}

describe("session attachments (upload route → turn)", () => {
	it("lists an attached PDF in the system prompt and reads it page by page, scoped to the session", async () => {
		const chatId = newChat();
		const pdf = await attach(chatId, "physics notes.pdf", PDF);
		assert.equal(pdf.record.pages, 3);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("pdf_search", { path: pdf.path, query: "force" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: pdf.path, pages: "2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: "/etc/passwd", pages: "1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Page 2 covers force.")]),
		]);
		await send(chatId, engine, "explain the force section of my notes");

		assert.match(seen[0]!.systemPrompt, /## Session attachments/);
		assert.match(seen[0]!.systemPrompt, /physics notes\.pdf — PDF, 3 pages/);
		assert.ok(["pdf_info", "pdf_extract", "pdf_search"].every((t) => seen[0]!.tools.includes(t)));
		assert.ok(!seen[0]!.tools.some((t) => t.startsWith("epub_")), "no EPUB attached, no EPUB tools");
		assert.match(lastToolResult(seen[1]!), /"page":2/);
		assert.match(lastToolResult(seen[2]!), /--- Page 2 ---/);
		assert.doesNotMatch(lastToolResult(seen[2]!), /--- Page 1 ---/);
		assert.match(lastToolResult(seen[3]!), /must be one of this session's attachments/);
	});

	it("reads an attached EPUB by structure, chapter slice and search; refuses DRM at upload", async () => {
		const chatId = newChat();
		const book = await attach(
			chatId,
			"mechanics.epub",
			makeEpub({
				title: "Mechanics Primer",
				chapters: [
					{ title: "Cover", body: "<p>Mechanics</p>" },
					{ title: "Kinematics", body: "<h1>Kinematics</h1><p>Velocity is the rate of change of position.</p>" },
					{ title: "Forces", body: "<h1>Forces</h1>" + Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1} on force.</p>`).join("") },
				],
			}),
		);
		const drm = await upload(chatId, "locked.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		assert.equal(drm.ok, false);
		assert.match(drm.error!, /DRM/);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_info", { path: book.path })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: book.path, chapter: 3, limit: 4 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_search", { path: book.path, query: "velocity" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(chatId, engine, "what does my book say about forces?");

		assert.match(seen[0]!.systemPrompt, /mechanics\.epub — EPUB "Mechanics Primer", 3 chapters/);
		assert.doesNotMatch(seen[0]!.systemPrompt, /locked\.epub/, "a refused upload is not an attachment");
		assert.match(lastToolResult(seen[1]!), /Kinematics/);
		const chapter = lastToolResult(seen[2]!);
		assert.match(chapter, /# Forces/);
		assert.doesNotMatch(chapter, /Velocity/);
		assert.match(chapter, /Use offset=5 to continue/);
		assert.match(lastToolResult(seen[3]!), /ch 2 \(Kinematics/);
	});

	it("shows an attached image to a vision model on its message, without storing the bytes in the record", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("A single pixel.")])]);
		await send(chatId, engine, "what is in this diagram?", [image.record.id]);

		const user = seen[0]!.messages.find((m) => m.role === "user")!;
		assert.ok(Array.isArray(user.content));
		assert.deepEqual((user.content as Array<{ type: string }>).map((p) => p.type), ["text", "image"]);
		const stored = fs.readFileSync(path.join(PATHS.chats, `${chatId}.json`), "utf-8");
		assert.ok(!stored.includes(PNG.toString("base64")), "no image bytes in the chat record");
		assert.ok(stored.includes(image.record.id), "the message keeps the attachment id");
	});

	it("resizes an attached image to the model's image limits before sending it", async () => {
		const chatId = newChat();
		const canvas = createCanvas(64, 48);
		const context = canvas.getContext("2d");
		context.fillStyle = "#33aadd";
		context.fillRect(0, 0, 64, 48);
		const image = await attach(chatId, "photo.png", canvas.toBuffer("image/png"));
		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("A blue field.")])], { imageResize: { maxWidth: 16, maxHeight: 16 } });
		await send(chatId, engine, "what is this?", [image.record.id]);

		const parts = seen[0]!.messages.find((m) => m.role === "user")!.content as Array<{ type: string; data?: string; text?: string }>;
		const sent = parts.find((p) => p.type === "image")!;
		const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(sent.data!, "base64"));
		try {
			assert.ok(decoded.get_width() <= 16 && decoded.get_height() <= 16, `sent ${decoded.get_width()}×${decoded.get_height()}`);
		} finally {
			decoded.free();
		}
		assert.ok(parts.some((p) => p.type === "text" && /64x48/.test(p.text ?? "")), "the model is told the original size");
	});

	it("keeps a text-only model working: the image is named in the manifest, not sent", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("I can't see images.")])], { vision: false });
		await send(chatId, engine, "what is in this diagram?", [image.record.id]);

		assert.equal(seen[0]!.messages.find((m) => m.role === "user")!.content, "what is in this diagram?");
		assert.match(seen[0]!.systemPrompt, /diagram\.png — image/);
	});

	it("rejects a message naming an attachment the session doesn't have", async () => {
		const chatId = newChat();
		const req = new Request("http://local/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "hi", attachmentIds: ["att_nope"] } }),
		});
		const res = await handleChatRequest(req, () => assert.fail("no turn should run"));
		assert.equal(res.status, 400);
	});

	it("survives compaction and resume; deleting the session removes the files only it held", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const book = await attach(chatId, "mechanics.epub", makeEpub({ chapters: [{ title: "Only", body: "<p>x</p>" }] }));
		const first = scripted([() => fauxAssistantMessage([fauxText("Seen.")])]);
		await send(chatId, first.engine, "look at this", [image.record.id]);

		// Compact everything up to the teacher's reply (the image message falls before the cut).
		const record = chatStore.getChat(chatId)!;
		const reply = record.messages.at(-1)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			newCompactionMarker("The learner shared a diagram.", { firstKeptMessageId: reply.id, tokensBefore: 1000, at: new Date().toISOString() }),
		]);

		const second = scripted([() => fauxAssistantMessage([fauxText("Continuing.")])]);
		await send(chatId, second.engine, "continue");
		const ctx = second.seen[0]!;
		assert.match(ctx.systemPrompt, /diagram\.png — image/);
		assert.match(ctx.systemPrompt, /mechanics\.epub — EPUB/);
		assert.ok(ctx.tools.includes("epub_read"));
		assert.ok(
			!JSON.stringify(ctx.messages).includes(PNG.toString("base64")),
			"a compacted-away message does not re-inject its image",
		);

		assert.ok(fs.existsSync(book.path));
		const outcome = await deleteChatSession(chatId, "preserve-graph");
		assert.ok(outcome.ok);
		assert.equal(fs.existsSync(book.path), false);
	});

	it("stores a file attached to two sessions once, and frees it only when the last session goes", async () => {
		const bytes = makeEpub({ title: `Shared ${Date.now()}`, chapters: [{ title: "Waves", body: "<h1>Waves</h1><p>A wave carries energy.</p>" }] });
		const before = blobs();
		const a = newChat();
		const b = newChat();
		const inA = await attach(a, "waves.epub", bytes);
		const inB = await attach(b, "waves (copy).epub", bytes);
		assert.equal(inA.path, inB.path, "both sessions point at the same stored file");
		assert.equal(blobs().length, before.length + 1, "the bytes are stored once");

		const again = await attach(a, "waves.epub", bytes);
		assert.equal(again.record.id, inA.record.id, "re-attaching to the same session returns the existing attachment");
		assert.equal(chatStore.getChat(a)!.attachments!.length, 1);

		const readIn = async (chatId: string, filePath: string) => {
			const { engine, seen } = scripted([
				() => fauxAssistantMessage([fauxToolCall("epub_read", { path: filePath, chapter: 1 })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Read.")]),
			]);
			await send(chatId, engine, "read my book");
			return lastToolResult(seen[1]!);
		};
		assert.match(await readIn(a, inA.path), /A wave carries energy/);
		assert.ok((await deleteChatSession(a, "preserve-graph")).ok);
		assert.ok(fs.existsSync(inB.path), "the other session still holds the file");
		assert.match(await readIn(b, inB.path), /A wave carries energy/);
		assert.ok((await deleteChatSession(b, "preserve-graph")).ok);
		assert.equal(fs.existsSync(inB.path), false, "no session holds it any more");
		assert.deepEqual(blobs(), before);
	});

	it("keeps each session's readers to its own files, even though the store is shared", async () => {
		const mine = newChat();
		const theirs = newChat();
		const own = await attach(mine, "own.epub", makeEpub({ title: `Own ${Date.now()}`, chapters: [{ title: "A", body: "<p>own</p>" }] }));
		const other = await attach(theirs, "private.epub", makeEpub({ title: `Private ${Date.now()}`, chapters: [{ title: "B", body: "<p>secret</p>" }] }));

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: other.path, chapter: 1 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(mine, engine, "read");
		assert.match(lastToolResult(seen[1]!), /must be one of this session's attachments/);
		assert.doesNotMatch(lastToolResult(seen[1]!), /secret/);
		assert.ok(seen[0]!.systemPrompt.includes(`own.epub — EPUB`) && seen[0]!.systemPrompt.includes(`path: ${own.path}`));
		assert.doesNotMatch(seen[0]!.systemPrompt, /private\.epub/);
		assert.ok(!seen[0]!.systemPrompt.includes(other.record.file), "another session's file is not in the manifest");
	});

	it("leaves nothing stored when a file is refused at the door", async () => {
		const chatId = newChat();
		const before = blobs();
		const drm = await upload(chatId, "locked.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		assert.equal(drm.ok, false);
		assert.deepEqual(blobs(), before);
		assert.equal(chatStore.getChat(chatId)!.attachments, undefined);
	});

	it("still runs the turn when an attached image is missing from disk", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		// A record whose file isn't there (an older layout, or removed by hand).
		const record = chatStore.getChat(chatId)!;
		record.attachments = record.attachments!.map((a) => ({ ...a, file: "att_legacy.png" }));
		fs.writeFileSync(path.join(PATHS.chats, `${chatId}.json`), JSON.stringify(record));

		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("Go ahead and describe it.")])]);
		await send(chatId, engine, "what is in this diagram?", [image.record.id]);
		assert.equal(seen.length, 1, "the turn reached the model");
		assert.match(seen[0]!.systemPrompt, /diagram\.png — image/);
		const user = seen[0]!.messages.find((m) => m.role === "user")!;
		const parts = typeof user.content === "string" ? [{ type: "text" }] : (user.content as Array<{ type: string }>);
		assert.ok(!parts.some((p) => p.type === "image"), "a missing image is skipped, not sent");
		assert.equal(chatStore.getChat(chatId)!.messages.at(-1)!.role, "assistant");
	});

	it("a removed file leaves the next turn's context; Undo brings it back; the stored copy stays until the session goes", async () => {
		const chatId = newChat();
		const book = await attach(
			chatId,
			"mechanics.epub",
			makeEpub({ title: `Detach ${Date.now()}`, chapters: [{ title: "Kinematics", body: "<p>Velocity is the rate of change of position.</p>" }] }),
		);
		const image = await attach(chatId, "diagram.png", PNG);
		const first = scripted([() => fauxAssistantMessage([fauxText("Seen.")])]);
		await send(chatId, first.engine, "look at this", [image.record.id]);

		const removed = await detach(chatId, book.record.id, true);
		assert.ok(removed.detachedAt);
		const afterRemove = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: book.path, chapter: 1 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(chatId, afterRemove.engine, "read my book");
		assert.doesNotMatch(afterRemove.seen[0]!.systemPrompt, /mechanics\.epub/);
		assert.ok(!afterRemove.seen[0]!.tools.includes("epub_read"), "no active EPUB, no EPUB reader");
		assert.match(lastToolResult(afterRemove.seen[1]!), /epub_read/);
		assert.doesNotMatch(lastToolResult(afterRemove.seen[1]!), /Velocity/);
		assert.ok(fs.existsSync(book.path), "a removed file's stored copy stays for Undo");

		await detach(chatId, image.record.id, true);
		const noImage = scripted([() => fauxAssistantMessage([fauxText("Ok.")])]);
		await send(chatId, noImage.engine, "continue");
		const imageMessage = noImage.seen[0]!.messages.find((m) => m.role === "user")!;
		const parts = typeof imageMessage.content === "string" ? [{ type: "text" }] : (imageMessage.content as Array<{ type: string }>);
		assert.ok(!parts.some((p) => p.type === "image"), "a removed image is no longer shown on its message");

		await detach(chatId, book.record.id, false);
		const restored = scripted([() => fauxAssistantMessage([fauxText("Back.")])]);
		await send(chatId, restored.engine, "and now?");
		assert.match(restored.seen[0]!.systemPrompt, /mechanics\.epub — EPUB/);

		assert.ok((await deleteChatSession(chatId, "preserve-graph")).ok);
		assert.equal(fs.existsSync(book.path), false);
	});

	it("attaching the same bytes again restores a removed file under the same id", async () => {
		const chatId = newChat();
		const bytes = makeEpub({ title: `Reattach ${Date.now()}`, chapters: [{ title: "A", body: "<p>x</p>" }] });
		const first = await attach(chatId, "notes.epub", bytes);
		await detach(chatId, first.record.id, true);
		const again = await attach(chatId, "notes.epub", bytes);
		assert.equal(again.record.id, first.record.id);
		assert.equal(again.record.detachedAt, undefined);
		assert.equal(chatStore.getChat(chatId)!.attachments!.length, 1);
		assert.equal(chatStore.getChat(chatId)!.attachments![0]!.detachedAt, undefined);
	});

	it("answers bad attachment requests with the right status", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const post = (id: string, form: FormData) =>
			attachmentsRoute.POST(new Request(`http://local/api/chats/${id}/attachments`, { method: "POST", body: form }), {
				params: Promise.resolve({ id }),
			});
		const textFile = new FormData();
		textFile.append("file", new File(["hello"], "notes.txt"));
		const cases: Array<{ name: string; res: () => Promise<Response>; status: number; error?: RegExp }> = [
			{ name: "unknown attachment", res: () => patchRequest(chatId, "att_nope", { detached: true }), status: 404 },
			{ name: "non-boolean detached", res: () => patchRequest(chatId, image.record.id, { detached: "yes" }), status: 400 },
			{ name: "unknown chat", res: () => patchRequest("chat_nope", image.record.id, { detached: true }), status: 404 },
			{ name: "no file field", res: () => post(chatId, new FormData()), status: 400 },
			{ name: "unsupported type", res: () => post(chatId, textFile), status: 422, error: /Unsupported file type/ },
		];
		for (const c of cases) {
			const res = await c.res();
			assert.equal(res.status, c.status, c.name);
			if (c.error) assert.match(((await res.json()) as { error: string }).error, c.error, c.name);
		}
		assert.equal(chatStore.getChat(chatId)!.attachments![0]!.detachedAt, undefined, "a refused request changes nothing");
	});
});
