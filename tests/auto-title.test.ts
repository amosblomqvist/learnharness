import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, createAutoTitler, goalOf, titleStageDue } from "../src/server/auto-title.ts";
import type { ChatRecord, ChatTitleSource } from "../src/core/contracts.ts";

const reply = { role: "assistant", content: [{ type: "text", text: "Let's start." }], stopReason: "stop" };
const opening = { role: "user", content: "我想理解反向传播", timestamp: 1 };
const probeDone = [
	{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "pd1", name: "probe_done", arguments: { assessment: { summary: "Goal: backprop as the chain rule", strands: [{ strand: "chain rule", assessment: "solid" }] } } }] },
	{ id: "r1", role: "toolResult", toolCallId: "pd1", toolName: "probe_done", isError: false, details: { ok: true } },
];
const rec = (messages: unknown[], titleSource?: ChatTitleSource): ChatRecord =>
	({ id: "c1", title: "我想理解反向传播", createdAt: "", updatedAt: "", messages: messages as ChatRecord["messages"], ...(titleSource ? { titleSource } : {}) });

describe("auto title stages", () => {
	it("first reply → auto; concluded probe → goal; user and goal are final", () => {
		assert.equal(titleStageDue(rec([opening])), null);
		assert.equal(titleStageDue(rec([opening, reply])), "auto");
		assert.equal(titleStageDue(rec([opening, reply], "auto")), null);
		assert.equal(titleStageDue(rec([opening, reply, ...probeDone], "auto")), "goal");
		assert.equal(titleStageDue(rec([opening, reply, ...probeDone], "goal")), null);
		assert.equal(titleStageDue(rec([opening, reply, ...probeDone], "user")), null);
		assert.match(goalOf(rec([...probeDone]).messages) ?? "", /backprop as the chain rule[\s\S]*Strands: chain rule/);
	});

	it("an untagged record renamed by hand before titleSource existed is left alone", () => {
		assert.equal(titleStageDue({ ...rec([opening, reply]), title: "我的反向传播笔记" }), null);
		assert.equal(titleStageDue({ ...rec([opening, reply, ...probeDone]), title: "我的反向传播笔记" }), null);
		assert.equal(titleStageDue({ ...rec([opening, reply]), title: "未命名会话" }), "auto");
	});

	it("cleans the model's line", () => {
		assert.equal(cleanTitle("标题：《反向传播与链式法则》。\n多余"), "反向传播与链式法则");
		assert.equal(cleanTitle('"Backpropagation basics"'), "Backpropagation basics");
		assert.equal(cleanTitle("  \n "), null);
	});
});

describe("auto titler", () => {
	const engine = (text: string, onCall?: () => void) => ({
		model: { provider: "test", id: "m", api: "test" },
		level: "off",
		streamFn: () => (async function* () {
			onCall?.();
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text }] } };
		})(),
	}) as never;
	const store = (record: ChatRecord) => {
		const renames: Array<[string, ChatTitleSource | undefined]> = [];
		return {
			renames,
			getChat: () => record,
			renameChat(_id: string, title: string, source?: ChatTitleSource) {
				if (source !== "user" && record.titleSource === "user") return record;
				renames.push([title, source]); record.title = title; record.titleSource = source; return record;
			},
		};
	};

	it("names after the first reply, then again from the goal", async () => {
		const r = rec([opening, reply]);
		const s = store(r);
		await createAutoTitler({ chatStore: s, engine: () => engine("反向传播") })("c1");
		r.messages.push(...(probeDone as unknown as ChatRecord["messages"]));
		await createAutoTitler({ chatStore: s, engine: () => engine("反向传播即链式法则") })("c1");
		assert.deepEqual(s.renames, [["反向传播", "auto"], ["反向传播即链式法则", "goal"]]);
	});

	it("a rename made while the model runs wins; no engine = no call", async () => {
		const r = rec([opening, reply]);
		const s = store(r);
		await createAutoTitler({ chatStore: s, engine: () => engine("AI 标题", () => { r.titleSource = "user"; }) })("c1");
		assert.deepEqual(s.renames, []);
		await createAutoTitler({ chatStore: store(rec([opening, reply])), engine: () => undefined })("c1");
	});
});
