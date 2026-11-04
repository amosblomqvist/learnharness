import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { handleSideQuestion, inFlightSideAnswer } from "../src/server/side-questions.ts";
import { chatStore } from "../src/store/chats.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { TUTOR_NOTE_TOOL } from "../src/agent/subagents/side-question.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { EffectiveModelSpec } from "../src/core/settings-resolution.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const route = await import("../app/api/chats/[id]/side-question/route.ts");

const created: string[] = [];
after(() => { for (const id of created) chatStore.deleteChat(id); });

function chat(kind?: "practice", model: { provider: string; id: string } | null = { provider: "openrouter", id: "z-ai/glm-5.3-flash" }) {
	const c = chatStore.createChat("side question test", kind);
	created.push(c.id);
	if (model) chatStore.saveSettings(c.id, { model });
	chatStore.saveMessages(c.id, [newUserMessage("Teach me the chain rule") as LhMessage]);
	return c.id;
}

function scripted(steps: FauxResponseStep[]) {
	const prompts: string[] = [];
	const specs: EffectiveModelSpec[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => (context, ...rest) => {
		prompts.push(JSON.stringify(context.messages.map((m) => (m as { content: unknown }).content)));
		return typeof step === "function" ? step(context, ...rest) : step;
	}));
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engineFor: (spec: EffectiveModelSpec) => { specs.push(spec); return engine; }, prompts, specs };
}

const answered = () => [fauxAssistantMessage([fauxText("Multiply the rates."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: true, note: "Unsure about the chain rule." })], { stopReason: "toolUse" })];

function framesOf(body: string): Array<Record<string, unknown> | "[DONE]"> {
	return body.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => e.slice(6)).map((d) => (d === "[DONE]" ? "[DONE]" : JSON.parse(d)));
}

const body = (threadId: string, extra: Record<string, unknown> = {}) => ({ threadId, thread: [], question: "Why multiply?", ...extra });

describe("POST /api/chats/[id]/side-question", () => {
	it("404s an unknown chat and 400s a practice session or a bad body", async () => {
		const res = await route.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body("t")) }), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
		assert.equal((await handleSideQuestion(chat("practice"), body("t"), scripted([]))).status, 400);
		assert.equal((await handleSideQuestion(chat(), { threadId: "t" }, scripted([]))).status, 400);
		const notJson = await route.POST(new Request("http://x", { method: "POST", body: "{" }), { params: Promise.resolve({ id: chat() }) });
		assert.equal(notJson.status, 400);
	});

	it("refuses with the 503 envelope when no model resolves", async () => {
		const res = await handleSideQuestion(chat(undefined, null), body("t"), scripted([]));
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");
	});

	it("streams text, then the note, and leaves the record's messages alone", async () => {
		const id = chat();
		const before = chatStore.getChat(id)!.messages;
		const s = scripted(answered());
		const res = await handleSideQuestion(id, body("thread_happy", { passage: "the derivatives multiply" }), s);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "text/event-stream");
		const frames = framesOf(await res.text());
		assert.deepEqual(frames.at(-1), "[DONE]");
		assert.equal(frames.filter((f) => f !== "[DONE]" && f.type === "text").map((f) => (f as { delta: string }).delta).join(""), "Multiply the rates.");
		assert.deepEqual(frames.at(-2), { type: "note", tell: true, note: "Unsure about the chain rule." });
		const saved = chatStore.getChat(id)!;
		assert.deepEqual(saved.messages, before);
		const usage = saved.turns?.filter((t) => t.messageId === "thread_happy") ?? [];
		assert.equal(usage.length, 1);
		assert.equal(usage[0]!.steps.length, 1);
		assert.match(s.prompts[0]!, /Teach me the chain rule/);
		assert.match(s.prompts[0]!, /Passage: \\"the derivatives multiply\\"/);
	});

	it("hands the agent its last note to rewrite (F10)", async () => {
		const s = scripted(answered());
		await (await handleSideQuestion(chat(), body("thread_note", { thread: [{ question: "First?", answer: "a" }], note: "EARLIER-NOTE" }), s)).text();
		assert.match(s.prompts[0]!, /Your last note: EARLIER-NOTE/);
	});

	it("uses the chat's own model, not the strong slot", async () => {
		const id = chat(undefined, { provider: "openrouter", id: "chat-own-model" });
		const s = scripted(answered());
		await (await handleSideQuestion(id, body("thread_model"), s)).text();
		assert.equal(s.specs[0]!.id, "chat-own-model");
	});

	it("supplies the fallback note when the agent writes none", async () => {
		const id = chat();
		const res = await handleSideQuestion(id, body("thread_fallback", { thread: [{ question: "First one?", answer: "a" }] }), scripted([fauxAssistantMessage("Plain answer.")]));
		const frames = framesOf(await res.text());
		assert.deepEqual(frames.at(-2), { type: "note", tell: false, note: 'Already clarified in a side question: the learner asked "First one?".' });
	});

	it("waits for a running compaction and reads the record after it", async () => {
		const id = chat();
		let release!: () => void;
		const compaction = new Promise<void>((resolve) => { release = resolve; });
		const g = globalThis as typeof globalThis & { __lhCompaction?: { inFlight: Map<string, Promise<void>> } };
		(g.__lhCompaction ??= { inFlight: new Map() }).inFlight.set(id, compaction);
		const s = scripted(answered());
		const pending = handleSideQuestion(id, body("thread_compaction"), s);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(s.prompts.length, 0, "no model call while compaction runs");
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, newUserMessage("AFTER-COMPACTION") as LhMessage]);
		g.__lhCompaction!.inFlight.delete(id);
		release();
		await (await pending).text();
		assert.match(s.prompts[0]!, /AFTER-COMPACTION/);
	});

	it("keeps the passage's selector on the answered pair", async () => {
		const selector = { start: 4, end: 28, prefix: "and ", suffix: " here" };
		const res = await handleSideQuestion(chat(), body("thread_selector", { passage: "the derivatives multiply", sourceMessageId: "m1", selector }), scripted(answered()));
		await res.text();
		assert.deepEqual((await inFlightSideAnswer("thread_selector")!.answer)?.selector, selector);
	});

	it("keeps answering after the client disconnects", async () => {
		const id = chat();
		const res = await handleSideQuestion(id, body("thread_gone"), scripted(answered()));
		await res.body!.cancel();
		const entry = inFlightSideAnswer("thread_gone");
		assert.ok(entry);
		assert.deepEqual(await entry.answer, { question: "Why multiply?", answer: "Multiply the rates.", tell: true, note: "Unsure about the chain rule." });
	});
});
