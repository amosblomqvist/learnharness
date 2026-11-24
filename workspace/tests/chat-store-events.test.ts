/**
 * CHAT STORE EVENT PINS (push-architecture S6, 2026-10-02): the sidebar's
 * 2.5s poll died — list truth now rides chats-changed. The store's law:
 * list-SHAPE writes (create/rename/delete) announce post-write; content
 * writes (messages/usage/settings/tree) are DELIBERATELY silent — the
 * silence law is pinned here so it reads as law, not oversight. Runs
 * under an isolated LH_DATA_DIR (the chat-birth-stamp discipline: the
 * seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-store-events-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("chat store events (S6: the silence law)", () => {
	it("createChat, renameChat, deleteChat each announce chats-changed", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		const chat = chatStore.createChat("Store events fixture");
		assert.equal(announces, 1, "create announces post-write");

		chatStore.renameChat(chat.id, "Renamed");
		assert.equal(announces, 2, "rename announces (a list-shape write)");

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(announces, 3, "a real delete announces");
		off();
	});

	it("deleteChat on a missing id stays silent", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});
		assert.equal(chatStore.deleteChat("chat_never_existed"), false);
		assert.equal(announces, 0, "nothing was written — nothing announced");
		off();
	});

	it("content writes are DELIBERATELY silent (the law)", () => {
		const chat = chatStore.createChat("Silent content fixture");
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		// saveMessages: fires per turn-persist — would spam the bus during
		// turns; its list-visible effects arrive via turn-started/settled.
		chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never]);
		// usage appends + settings + tree: record CONTENT, not list shape.
		chatStore.appendTurnUsage(chat.id, { id: "t1", messageId: "m1", at: "2026-10-02T00:00:00.000Z", model: "x:y", steps: [] });
		chatStore.appendExtractionUsage(chat.id, { startedAt: 1, at: "2026-10-02T00:00:00.000Z", durationMs: 1, stages: { extractor: { model: "x:y", steps: [] }, auditor: { model: "x:y", steps: [] } } });
		chatStore.saveSettings(chat.id, {});
		chatStore.saveTree(chat.id, { nodes: [], edges: [], version: 1 });

		assert.equal(announces, 0, "the silence law: content writes never announce");
		off();
		chatStore.deleteChat(chat.id);
	});
});
