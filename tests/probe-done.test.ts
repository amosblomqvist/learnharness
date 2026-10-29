/**
 * probe_done — the probe→planning seam tool (docs/probe-teach-split.md §2).
 * Server-side; three outcomes: refusal while a question is open, refusal
 * after the probe is already concluded, ok + handoff queued. The handoff
 * rides the wake pipeline (deliver injected here — no server seam import).
 * Wave B: the record is native history — fixtures are pi messages, the
 * pending-question gate is the dangling-question scan, and the handoff is
 * a native marker (customType probe-handoff, HANDOFF_TEXT content).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import type { SteerMessage } from "../src/core/contracts.ts";
import { hasProbeDone, type LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";
import { HANDOFF_TEXT } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const dataDir = PATHS.data;
fs.mkdirSync(dataDir, { recursive: true });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

const ASSESSMENT = {
	strands: [
		{ strand: "the derivative as a limit", assessment: "Floor: slope intuition. Ceiling: formal ε–δ." },
	],
	summary: "Enter at the formal definition.",
};

/** A native assistant message carrying one tool call (the minimal fixture
 *  shape the scans read — role assistant, content blocks). */
function assistantWithCall(id: string, toolName: string, args: unknown): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${id}`, name: toolName, arguments: args as never }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

async function execute(tools: ReturnType<typeof probeDoneTool>, input: unknown) {
	const t = tools.probe_done!;
	assert.ok(typeof t.execute === "function");
	return t.execute("test", input).then((r) => r.details as { ok: boolean; error?: string });
}

describe("probe_done: the probe→planning seam", () => {
	it("ok path: records the assessment and queues the handoff steer (deterministic id)", async () => {
		const chatId = newChat("Probe: ok");
		const delivered: SteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		assert.equal(delivered.length, 1, "the handoff is queued exactly once");
		assert.equal(delivered[0]!.id, `steer_probe_${chatId}`);
		// Native marker (Wave B): the model-facing HANDOFF_TEXT rides content;
		// the UI keys off customType; the chat id rides details.
		assert.equal(delivered[0]!.customType, "probe-handoff");
		assert.equal(delivered[0]!.content, HANDOFF_TEXT);
		assert.equal((delivered[0]!.details as { chatId: string }).chatId, chatId);
	});

	it("REFUSES while a question is still open — resolve it first", async () => {
		const chatId = newChat("Probe: open question");
		chatStore.saveMessages(chatId, [
			assistantWithCall("m1", "quiz", { question: "q?", options: [{ label: "a" }], correctAnswer: "a" }),
		]);
		const delivered: SteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /question is still open/i);
		assert.equal(delivered.length, 0, "nothing queued on refusal");
	});

	it("REFUSES a second conclusion — probe_done fires exactly once", async () => {
		const chatId = newChat("Probe: twice");
		chatStore.saveMessages(chatId, [
			assistantWithCall("m1", "probe_done", { assessment: ASSESSMENT }),
			{
				id: "m1r",
				role: "toolResult",
				toolCallId: "call_m1",
				toolName: "probe_done",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			} as never,
		]);
		const delivered: SteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /already concluded/i);
		assert.equal(delivered.length, 0);
	});

	it("REFUSES an unknown chat defensively", async () => {
		const tools = probeDoneTool({ chatId: "chat_nonexistent", chatStore, deliver: () => {} });
		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /not found/i);
	});

	it("a deliver failure never fails the call — the assessment records; the wake is recoverable-by-design", async () => {
		const chatId = newChat("Probe: deliver crash");
		const tools = probeDoneTool({
			chatId,
			chatStore,
			deliver: () => {
				throw new Error("queue exploded");
			},
		});
		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, true, "ok:true even when the queue is lost — the next client message constructs the teacher off the transcript seam");
	});
});

/** A real record result, distinct from the calling assistant message. */
function probeResult(overrides: Partial<Extract<LhMessage, { role: "toolResult" }>> = {}): LhMessage {
	return {
		id: "probe-result", role: "toolResult", toolCallId: "call_probe", toolName: "probe_done",
		content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1,
		...overrides,
	};
}

const probeCall = () => assistantWithCall("probe", "probe_done", { assessment: ASSESSMENT });
const failedProbeCall = (stopReason: "error" | "aborted"): LhMessage => ({ ...probeCall(), stopReason } as LhMessage);
const incompleteProbes: Array<[string, () => LhMessage[]]> = [
	["unmatched call", () => [probeCall()]],
	["errored result", () => [probeCall(), probeResult({ isError: true })]],
	["explicit refusal without isError", () => [probeCall(), probeResult({ details: { ok: false, error: "refused" } })]],
	["result without a call", () => [probeResult()]],
	["wrong call id", () => [probeCall(), probeResult({ toolCallId: "other" })]],
	["wrong result tool name", () => [probeCall(), probeResult({ toolName: "plan_init" })]],
	["wrong call tool name", () => [assistantWithCall("probe", "plan_init", {}), probeResult()]],
	["result before the call", () => [probeResult(), probeCall()]],
	["failed calling generation", () => [failedProbeCall("error"), probeResult({ details: { ok: true } })]],
	["aborted calling generation", () => [failedProbeCall("aborted"), probeResult({ details: { ok: true } })]],
];

describe("probe completion: matched successful results only (PR130 foundation)", () => {
	for (const [name, messages] of incompleteProbes) {
		it(`${name} keeps probing open and allows a fresh conclusion`, async () => {
			const chatId = newChat(`Probe recovery: ${name}`);
			const before = messages();
			const snapshot = structuredClone(before);
			chatStore.saveMessages(chatId, before);
			assert.equal(hasProbeDone(before), false);
			assert.equal(phaseAt3Lh(before), "probe");
			const delivered: SteerMessage[] = [];
			const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });
			assert.equal((await execute(tools, { assessment: ASSESSMENT })).ok, true);
			assert.equal(delivered.length, 1, "only the fresh invocation queues a handoff");
			assert.deepEqual(before, snapshot, "the scans never mutate history");
			assert.deepEqual(chatStore.getChat(chatId)!.messages, snapshot, "the tool does not delete or replay saved attempts");
		});
	}

	for (const [name, result] of [
		["current acknowledgment", probeResult({ details: { ok: true } })],
		["older clean acknowledgment without details", probeResult()],
		["older clean acknowledgment without ok", probeResult({ details: { assessment: ASSESSMENT } })],
	] as const) {
		it(`${name} concludes exactly at the matching result`, () => {
			const messages = [probeCall(), result];
			const before = structuredClone(messages);
			assert.equal(hasProbeDone(messages), true);
			assert.equal(phaseAt3Lh(messages, 0), "probe", "a future result cannot conclude an earlier prefix");
			assert.equal(phaseAt3Lh(messages, 1), "plan");
			assert.deepEqual(messages, before);
		});
	}
});
