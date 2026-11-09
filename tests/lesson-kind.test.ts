/**
 * LESSON-KIND PINS (lesson mode): the contract/store/route analog of
 * chat-kind.test.ts. ChatRecord.kind stays ABSENT-BY-DEFAULT for teach;
 * "lesson" marks a lesson-mode session — the lesson agent from turn 1
 * (no prober phase), a section-structured syllabus via plan_init, one
 * exit-ticket check per section. The store normalizes at the summary
 * projection; createChat stamps the marker for lesson exactly as it does
 * for practice. Route pins drive the actual POST /api/chats handler
 * (framework-free Request/Response — the chat-birth-stamp discipline).
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading
 * import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("session kind (lesson mode)", () => {
	it("createChat(kind: 'lesson') stamps the marker on record + list", () => {
		const chat = chatStore.createChat("lesson session", "lesson");
		assert.equal(chat.kind, "lesson");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "lesson");
	});

	it("createChat default still carries NO kind field — teach stays absent (the chat-kind pin, restated for the lesson union)", () => {
		const chat = chatStore.createChat("plain session");
		assert.equal("kind" in chat, false);
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "teach");
	});

	it("practice stamping is untouched by the widened union", () => {
		const chat = chatStore.createChat("practice session", "practice");
		assert.equal(chat.kind, "practice");
	});

	it("a lesson summary never manufactures a practice waiting-problem", () => {
		const chat = chatStore.createChat("lesson with messages", "lesson");
		chatStore.saveMessages(chat.id, [newUserMessage("Teach me Fourier analysis")]);
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.pendingProblem, false);
		assert.equal(listed?.pendingQuestion, false);
	});
});

describe("POST /api/chats — kind parsing (lesson mode)", () => {
	it("kind 'lesson' creates a lesson record", async () => {
		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Teach me the chain rule", kind: "lesson" }),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.kind, "lesson");
	});

	it("kind 'practice' still creates a practice record (additive, not replaced)", async () => {
		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Group theory problems", kind: "practice" }),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		assert.equal(chatStore.getChat(id)?.kind, "practice");
	});

	it("an unknown kind reads as teach (absent marker — nothing else is accepted)", async () => {
		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "junk kind", kind: "lecture" }),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal("kind" in record, false, "unknown kinds never stamp a marker");
	});
});
