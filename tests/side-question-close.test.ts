import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { handleSideClose } from "../src/server/side-questions.ts";
import { chatStore } from "../src/store/chats.ts";
import { newUserMessage, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";

const route = await import("../app/api/chats/[id]/side-question/close/route.ts");

const created: string[] = [];
after(() => { for (const id of created) chatStore.deleteChat(id); });

function chat(): string {
	const c = chatStore.createChat("side question close");
	created.push(c.id);
	chatStore.saveMessages(c.id, [newUserMessage("hi") as LhMessage]);
	return c.id;
}

const pair = (question: string, tell: boolean, note = `note for ${question}`) => ({ question, answer: `answer to ${question}`, tell, note });
const markerOf = (chatId: string, threadId: string) =>
	chatStore.getChat(chatId)!.messages.find((m) => m.id === threadId) as LhMarkerMessage | undefined;

describe("POST /api/chats/[id]/side-question/close", () => {
	it("404s an unknown chat and 400s a bad body", async () => {
		assert.equal((await handleSideClose("nope", { threadId: "t", thread: [], learnerTell: null })).status, 404);
		assert.equal((await handleSideClose(chat(), { threadId: "t" })).status, 400);
	});

	it("saves nothing for an empty thread (204)", async () => {
		const id = chat();
		const res = await handleSideClose(id, { threadId: "side_empty", thread: [], learnerTell: null, pending: { question: "never answered" } });
		assert.equal(res.status, 204);
		assert.equal(chatStore.getChat(id)!.messages.length, 1);
	});

	it("commits one marker; the note is model-facing only when told", async () => {
		const id = chat();
		const res = await handleSideClose(id, { threadId: "side_told", thread: [pair("a?", false), pair("b?", true)], learnerTell: null });
		assert.equal(res.status, 200);
		const told = markerOf(id, "side_told")!;
		assert.equal(told.customType, "side-question");
		assert.equal(told.content, "note for b?");
		assert.deepEqual(told.details, {
			thread: [{ question: "a?", answer: "answer to a?" }, { question: "b?", answer: "answer to b?" }],
			note: "note for b?",
			toldTutor: true,
		});
		await handleSideClose(id, { threadId: "side_quiet", thread: [pair("c?", false)], learnerTell: null });
		assert.equal(markerOf(id, "side_quiet")!.content, "");
	});

	it("lets the learner's last setting win over the recommendation (F10)", async () => {
		const id = chat();
		await handleSideClose(id, { threadId: "side_off", thread: [pair("a?", true)], learnerTell: false });
		assert.equal(markerOf(id, "side_off")!.content, "");
		assert.equal((markerOf(id, "side_off")!.details as { toldTutor: boolean }).toldTutor, false);
		await handleSideClose(id, { threadId: "side_on", thread: [pair("a?", false)], learnerTell: true });
		assert.equal(markerOf(id, "side_on")!.content, "note for a?");
	});

	it("waits for an answer still streaming, then saves it with its note (202)", async () => {
		const id = chat();
		let resolve!: (p: unknown) => void;
		const answer = new Promise((r) => { resolve = r; });
		const g = globalThis as typeof globalThis & { __lhSideAnswers?: Map<string, unknown> };
		(g.__lhSideAnswers ??= new Map()).set("side_late", { question: "late?", answer });
		const res = await handleSideClose(id, { threadId: "side_late", thread: [pair("a?", false)], learnerTell: null, pending: { question: "late?", passage: "p" } });
		assert.equal(res.status, 202);
		assert.equal(markerOf(id, "side_late"), undefined, "nothing saved before the answer lands");
		const repeat = await handleSideClose(id, { threadId: "side_late", thread: [pair("a?", false)], learnerTell: null, pending: { question: "late?" } });
		assert.equal(repeat.status, 200, "a repeated close while waiting is a no-op");
		resolve({ ...pair("late?", true, "the late note"), passage: "p" });
		await new Promise((r) => setTimeout(r, 20));
		const saved = markerOf(id, "side_late")!;
		assert.equal(saved.content, "the late note");
		assert.deepEqual((saved.details as { thread: unknown[] }).thread.at(-1), { question: "late?", answer: "answer to late?", passage: "p" });
		assert.equal(chatStore.getChat(id)!.messages.filter((m) => m.id === "side_late").length, 1);
	});

	it("records which thread a continuation continues", async () => {
		const id = chat();
		await handleSideClose(id, { threadId: "side_cont", thread: [pair("a?", false), pair("b?", true)], learnerTell: null, continues: "side_orig" });
		assert.equal((markerOf(id, "side_cont")!.details as { continues?: string }).continues, "side_orig");
		assert.equal((await handleSideClose(id, { threadId: "side_bad", thread: [pair("a?", false)], learnerTell: null, continues: 3 })).status, 400);
	});

	it("is a no-op for a thread already saved", async () => {
		const id = chat();
		await handleSideClose(id, { threadId: "side_dup", thread: [pair("a?", true)], learnerTell: null });
		const res = await handleSideClose(id, { threadId: "side_dup", thread: [pair("a?", true), pair("b?", true)], learnerTell: null });
		assert.equal(res.status, 200);
		assert.equal(chatStore.getChat(id)!.messages.filter((m) => m.id === "side_dup").length, 1);
		assert.equal((markerOf(id, "side_dup")!.details as { thread: unknown[] }).thread.length, 1);
	});

	it("accepts a keepalive body sent as plain text", async () => {
		const id = chat();
		const res = await route.POST(
			new Request("http://x", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ threadId: "side_keep", thread: [pair("a?", true)], learnerTell: null }) }),
			{ params: Promise.resolve({ id }) },
		);
		assert.equal(res.status, 200);
		assert.ok(markerOf(id, "side_keep"));
		const bad = await route.POST(new Request("http://x", { method: "POST", body: "{" }), { params: Promise.resolve({ id }) });
		assert.equal(bad.status, 400);
	});
});
