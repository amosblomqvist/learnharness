import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { NOTES_MAX_CHARS, NotesInputError, parseNotesInput } = await import("../src/core/notes.ts");
const { readChatNotes } = await import("../src/server/chats.ts");
const notesRoute = await import("../app/api/chats/[id]/notes/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("notes input", () => {
	it("accepts text untrimmed", () => assert.equal(parseNotesInput({ text: "  a\n" }), "  a\n"));
	it("refuses bad shapes and oversize", () => {
		assert.throws(() => parseNotesInput(null), NotesInputError);
		assert.throws(() => parseNotesInput({ text: 1 }), NotesInputError);
		assert.throws(() => parseNotesInput({ text: "x".repeat(NOTES_MAX_CHARS + 1) }), NotesInputError);
	});
});

describe("notes store seam", () => {
	it("saves without touching updatedAt or messages; empty deletes; list omits notes", () => {
		const chat = chatStore.createChat("n");
		chatStore.saveMessages(chat.id, [newUserMessage("hi")]);
		const before = chatStore.getChat(chat.id)!;
		assert.equal(chatStore.saveNotes(chat.id, "pull ≠ overwrite"), true);
		const after = chatStore.getChat(chat.id)!;
		assert.equal(after.notes, "pull ≠ overwrite");
		assert.equal(after.updatedAt, before.updatedAt);
		assert.deepEqual(after.messages, before.messages);
		assert.equal("notes" in chatStore.listChats().find((c) => c.id === chat.id)!, false);
		chatStore.saveNotes(chat.id, "  ");
		assert.equal("notes" in chatStore.getChat(chat.id)!, false);
	});
	it("a later saveMessages keeps the notes", () => {
		const chat = chatStore.createChat("n2");
		chatStore.saveNotes(chat.id, "$A^\\tau$");
		chatStore.saveMessages(chat.id, [newUserMessage("more")]);
		assert.equal(chatStore.getChat(chat.id)!.notes, "$A^\\tau$");
	});
	it("unknown chat → false", () => assert.equal(chatStore.saveNotes("chat_missing", "x"), false));
});

describe("GET /api/chats/:id/notes", () => {
	const get = (id: string) => notesRoute.GET(new Request(`http://test/api/chats/${id}/notes`), { params: Promise.resolve({ id }) });
	it("returns the saved text, empty when none, 404 for an unknown chat", async () => {
		const chat = chatStore.createChat("n3");
		assert.deepEqual(await (await get(chat.id)).json(), { text: "" });
		chatStore.saveNotes(chat.id, "> quoted");
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "> quoted" });
		assert.equal(readChatNotes("chat_missing"), null);
		const missing = await get("chat_missing");
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "Unknown chat" });
	});
});
