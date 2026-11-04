import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { flushParkedSideQuestions, handleSideClose, handleSideTell } from "../src/server/side-questions.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const route = await import("../app/api/chats/[id]/side-question/tell/route.ts");

const created: string[] = [];
after(() => { for (const id of created) chatStore.deleteChat(id); });

function chat(): string {
	const c = chatStore.createChat("side question tell");
	created.push(c.id);
	chatStore.saveMessages(c.id, [newUserMessage("hi") as LhMessage]);
	return c.id;
}
const pair = (tell: boolean) => ({ question: "Why?", answer: "Because.", tell, note: "NOTE-why" });
const close = (id: string, threadId: string, tell: boolean) => handleSideClose(id, { threadId, thread: [pair(tell)], learnerTell: null });
const ids = (id: string) => chatStore.getChat(id)!.messages.map((m) => m.id);

describe("POST /api/chats/[id]/side-question/tell", () => {
	it("tells the tutor about a thread kept private, once", async () => {
		const id = chat();
		await close(id, "side_p", false);
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, newUserMessage("later") as LhMessage]);
		const res = await route.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ threadId: "side_p" }) }), { params: Promise.resolve({ id }) });
		assert.equal(res.status, 200);
		const last = chatStore.getChat(id)!.messages.at(-1)!;
		assert.equal(last.id, "side_p_told");
		assert.equal((last as { content: string }).content, "NOTE-why");
		assert.equal((await handleSideTell(id, { threadId: "side_p" })).status, 200);
		assert.equal(ids(id).filter((m) => m === "side_p_told").length, 1);
	});

	it("does nothing for a thread already told", async () => {
		const id = chat();
		await close(id, "side_t", true);
		assert.equal((await handleSideTell(id, { threadId: "side_t" })).status, 200);
		assert.ok(!ids(id).includes("side_t_told"));
	});

	it("404s an unknown chat or thread and 400s a bad body", async () => {
		const id = chat();
		assert.equal((await handleSideTell("nope", { threadId: "x" })).status, 404);
		assert.equal((await handleSideTell(id, { threadId: "side_none" })).status, 404);
		assert.equal((await handleSideTell(id, {})).status, 400);
	});

	it("parks behind a running turn, after a thread that is itself parked", async () => {
		const id = chat();
		assert.ok(beginTurn(id));
		await close(id, "side_mid", false);
		const res = await handleSideTell(id, { threadId: "side_mid" });
		assert.equal(res.status, 202);
		assert.ok(!ids(id).includes("side_mid_told"));
		endTurn(id);
		flushParkedSideQuestions(chatStore, id);
		assert.deepEqual(ids(id).slice(-2), ["side_mid", "side_mid_told"]);
	});
});
