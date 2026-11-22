import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-list-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("chatStore.listChats summary cache", () => {
	it("reflects local mutations (rename, saveMessages, delete) immediately", () => {
		const chat = chatStore.createChat("Initial title");
		const first = chatStore.listChats();
		assert.equal(first.length, 1);
		assert.equal(first[0]?.title, "Initial title");
		assert.equal(first[0]?.messageCount, 0);

		// Mutating returned summary must not corrupt cached entry.
		if (first[0]) first[0].title = "Mutated by caller";
		assert.equal(chatStore.listChats()[0]?.title, "Initial title");

		chatStore.renameChat(chat.id, "Updated title");
		assert.equal(chatStore.listChats()[0]?.title, "Updated title");

		chatStore.saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never,
		]);
		assert.equal(chatStore.listChats()[0]?.messageCount, 1);

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(chatStore.listChats().length, 0);
	});

	it("invalidates when a chat file is modified or removed externally", () => {
		const chat = chatStore.createChat("External edit test");
		assert.equal(chatStore.listChats()[0]?.title, "External edit test");

		const file = path.join(TMP_DATA, "chats", `${chat.id}.json`);
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { title: string };
		raw.title = "Edited externally with different size";
		fs.writeFileSync(file, JSON.stringify(raw, null, "\t"));

		assert.equal(chatStore.listChats()[0]?.title, "Edited externally with different size");

		fs.unlinkSync(file);
		assert.equal(chatStore.listChats().length, 0);
	});
});
