/**
 * The auto-read controller (ElevenLabs voice slice 10): fed by what chat.tsx
 * already knows each render (busy, failure, the projected messages), it decides
 * whether the turn that just ended is read aloud. Pure: `play` and `dictating`
 * are the only seams.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutoRead, finalAssistantStop, blockInProgress, pendingQuestionSource, proseBlocks, type AutoReadMessage, type AutoReadObservation } from "../components/auto-read.ts";

const text = (t: string, id?: string) => ({ type: "text", id, text: t });
const user = (id: string): AutoReadMessage => ({ id, role: "user", parts: [text("hi")] });
const reply = (id: string, ...texts: string[]): AutoReadMessage => ({ id, role: "assistant", parts: [{ type: "step-start" }, ...texts.map((t, i) => ({ type: "text", id: `${id}-t${i}`, text: t }))] });

function fixture(opts: { dictating?: boolean } = {}) {
	const played: Array<{ sourceId: string; markdown: string }> = [];
	let dictating = opts.dictating ?? false;
	const auto = createAutoRead({
		play: (sourceId, markdown) => { played.push({ sourceId, markdown }); },
		dictating: () => dictating,
	});
	const base: AutoReadObservation = { busy: false, failed: false, enabled: true, finalStop: "stop", messages: [] };
	const observe = (patch: Partial<AutoReadObservation>) => auto.observe({ ...base, ...patch });
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return { played, observe, flush, setDictating: (d: boolean) => { dictating = d; } };
}

describe("auto-read: when a turn plays", () => {
	it("plays the blocks the turn added once it has finished, each with its own block id and text", async () => {
		const f = fixture();
		const history = [user("u0"), reply("a0", "old")];
		f.observe({ messages: history });
		f.observe({ busy: true, messages: [...history, user("u1")] });
		f.observe({ busy: true, messages: [...history, user("u1"), reply("a1", "Hel")] });
		assert.deepEqual(f.played, [], "never while streaming");
		f.observe({ messages: [...history, user("u1"), reply("a1", "Hello", "World")] });
		await f.flush();
		assert.deepEqual(f.played, [{ sourceId: "a1-t0", markdown: "Hello" }, { sourceId: "a1-t1", markdown: "World" }]);
		f.observe({ messages: [...history, user("u1"), reply("a1", "Hello", "World")] });
		await f.flush();
		assert.equal(f.played.length, 2, "at most once");
	});

	it("falls back to an m-<index>-p<part> id when a message and its part have no id, like the button", () => {
		const f = fixture();
		f.observe({});
		f.observe({ busy: true, messages: [user("u")] });
		f.observe({ messages: [user("u"), { id: "", role: "assistant", parts: [{ type: "step-start" }, text("Yo")] }] });
		assert.deepEqual(f.played, [{ sourceId: "m-1-p1", markdown: "Yo" }]);
	});

	it("history present at open or reload plays nothing, however it arrives", () => {
		const f = fixture();
		f.observe({ messages: [user("u0"), reply("a0", "old")] });
		f.observe({ messages: [user("u0"), reply("a0", "old"), user("u1"), reply("a1", "also old")] }); // adopted record
		assert.deepEqual(f.played, []);
	});

	it("a turn already running when the view opened is not read", () => {
		const f = fixture();
		f.observe({ busy: true, messages: [user("u0")] });
		f.observe({ messages: [user("u0"), reply("a0", "reattached")] });
		assert.deepEqual(f.played, []);
		f.observe({ busy: true, messages: [user("u0"), reply("a0", "reattached"), user("u1")] });
		f.observe({ messages: [user("u0"), reply("a0", "reattached"), user("u1"), reply("a1", "next")] });
		assert.deepEqual((f.played as Array<{ sourceId: string }>).map((p) => p.sourceId), ["a1-t0"], "the next turn is");
	});

	it("is off when the setting is off at the moment the turn finishes", () => {
		const f = fixture();
		f.observe({ enabled: false });
		f.observe({ busy: true, enabled: false, messages: [user("u")] });
		f.observe({ enabled: false, messages: [user("u"), reply("a", "x")] });
		assert.deepEqual(f.played, []);
	});

	it("aborted and failed turns do not play, and do not play later", () => {
		for (const patch of [{ finalStop: "aborted" }, { finalStop: "error" }, { failed: true }] as Array<Partial<AutoReadObservation>>) {
			const f = fixture();
			f.observe({});
			f.observe({ busy: true, messages: [user("u")] });
			f.observe({ ...patch, messages: [user("u"), reply("a", "partial")] });
			f.observe({ messages: [user("u"), reply("a", "partial")] });
			assert.deepEqual(f.played, [], JSON.stringify(patch));
		}
	});

	it("a reply that finishes during dictation is skipped and never played later", () => {
		const f = fixture({ dictating: true });
		f.observe({});
		f.observe({ busy: true, messages: [user("u")] });
		f.observe({ messages: [user("u"), reply("a", "x")] });
		f.setDictating(false);
		f.observe({ messages: [user("u"), reply("a", "x")] });
		f.observe({ messages: [user("u"), reply("a", "x")] });
		assert.deepEqual(f.played, []);
	});

	it("a tool-only final message reads nothing; text blocks around a tool call are separate blocks", async () => {
		const f = fixture();
		f.observe({});
		f.observe({ busy: true, messages: [user("u")] });
		f.observe({ messages: [user("u"), { id: "a", role: "assistant", parts: [{ type: "tool-search" }] }] });
		assert.deepEqual(f.played, []);
		f.observe({ busy: true, messages: [user("u"), user("u2")] });
		f.observe({ messages: [user("u"), user("u2"), { id: "b", role: "assistant", parts: [text("before", "b-t0"), { type: "tool-search" }, text("after", "b-t1")] }] });
		await f.flush();
		assert.deepEqual(f.played, [{ sourceId: "b-t0", markdown: "before" }, { sourceId: "b-t1", markdown: "after" }]);
	});

	it("a turn that produced no new assistant text reads nothing (the previous reply is not repeated)", () => {
		const f = fixture();
		const history = [user("u0"), reply("a0", "old")];
		f.observe({ messages: history });
		f.observe({ busy: true, messages: history });
		f.observe({ messages: history });
		assert.deepEqual(f.played, []);
	});

	it("a retry that adds a block to the same group reads only the new block, once", () => {
		const f = fixture();
		const before = [user("u"), reply("a", "partial")];
		f.observe({ messages: before });
		f.observe({ busy: true, messages: before });
		f.observe({ messages: [user("u"), reply("a", "partial", "full answer")] });
		assert.deepEqual(f.played, [{ sourceId: "a-t1", markdown: "full answer" }]);
	});

	it("a later turn in the same growing group reads only its new blocks, never the earlier ones (the reported bug)", async () => {
		const f = fixture();
		const long = "Long teaching paragraph. ".repeat(40);
		const group = (...texts: string[]): AutoReadMessage[] => [user("u0"), reply("a", ...texts)];
		f.observe({ messages: group(long, long) });
		f.observe({ busy: true, messages: group(long, long) });
		f.observe({ messages: group(long, long, "Fresh follow-up.") });
		await f.flush();
		assert.deepEqual(f.played, [{ sourceId: "a-t2", markdown: "Fresh follow-up." }]);
	});

	it("blocks merged from several native messages play in order, only the new ones", async () => {
		const f = fixture();
		const merged = (...ids: string[]): AutoReadMessage => ({
			id: "n1", role: "assistant",
			parts: [{ type: "step-start" }, ...ids.flatMap((id) => [{ type: "tool-quiz" }, text(`text ${id}`, id)])],
		});
		f.observe({ messages: [user("u"), merged("n1-t0")] });
		f.observe({ busy: true, messages: [user("u"), merged("n1-t0")] });
		f.observe({ messages: [user("u"), merged("n1-t0", "n2-t0", "n3-t0")] });
		await f.flush();
		assert.deepEqual(f.played.map((p) => p.sourceId), ["n2-t0", "n3-t0"]);
	});
});

describe("auto-read helpers", () => {
	it("proseBlocks: one block per text part, in order, keyed by the part id; blanks, reasoning and tools dropped", () => {
		const blocks = proseBlocks({ id: "m", parts: [{ type: "reasoning", id: "m-r0", text: "hm" }, text("  ", "m-t0"), text("a", "m-t1"), { type: "tool-x" }, text("b", "m-t2")] }, 0);
		assert.deepEqual(blocks, [{ sourceId: "m-t1", markdown: "a", partIndex: 2 }, { sourceId: "m-t2", markdown: "b", partIndex: 4 }]);
	});
	it("proseBlocks: ids are unique and stable across re-projection of a longer group", () => {
		const parts = (n: number) => Array.from({ length: n }, (_, i) => text(`block ${i}`, `m${i}-t0`));
		const a = proseBlocks({ id: "g", parts: parts(2) }, 0);
		const b = proseBlocks({ id: "g", parts: parts(4) }, 0);
		assert.deepEqual(b.slice(0, 2), a);
		assert.equal(new Set(b.map((x) => x.sourceId)).size, 4);
	});
	it("proseBlocks: a part without an id falls back to a message-and-position id", () => {
		assert.deepEqual(proseBlocks({ id: "x", parts: [{ type: "step-start" }, text("a")] }, 3), [{ sourceId: "x-p1", markdown: "a", partIndex: 1 }]);
		assert.deepEqual(proseBlocks({ id: "", parts: [text("a")] }, 3), [{ sourceId: "m-3-p0", markdown: "a", partIndex: 0 }]);
	});
	it("proseBlocks: on projected teaching-group parts, each block is its own, not the whole group's text", async () => {
		const { projectView } = await import("../src/core/view.ts");
		const long = "A long teaching explanation. ".repeat(60);
		const asst = (id: string, content: unknown[]) => ({ id, role: "assistant", content, stopReason: "toolUse" });
		const send = (id: string, text: string) => ({ type: "toolCall", id, name: "send_to_user", arguments: { message: text } });
		const messages = [
			{ id: "u", role: "user", content: "teach me" },
			asst("n1", [{ type: "thinking", thinking: "plan" }, send("c1", long)]),
			{ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "send_to_user", content: [], isError: false },
			asst("n2", [{ type: "toolCall", id: "q1", name: "quiz", arguments: {} }]),
			{ id: "r2", role: "toolResult", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "a" }], isError: false },
			asst("n3", [send("c3", "The target paragraph.")]),
		];
		const view = projectView(messages as never);
		const group = view.filter((m) => m.role === "assistant");
		assert.equal(group.length, 1, "merged into one view message");
		const blocks = proseBlocks({ id: group[0]!.id, parts: group[0]!.parts as never }, 0);
		assert.equal(blocks.length, 2);
		assert.equal(blocks[1]!.markdown, "The target paragraph.");
		assert.notEqual(blocks[0]!.sourceId, blocks[1]!.sourceId);
	});
	it("finalAssistantStop reads the last native assistant message", () => {
		assert.equal(finalAssistantStop([]), undefined);
		assert.equal(finalAssistantStop([{ role: "assistant", stopReason: "stop" }, { role: "toolResult" }, { role: "assistant", stopReason: "aborted" }, { role: "custom" }]), "aborted");
	});
});

describe("pendingQuestionSource", () => {
	const quizInput = { question: "Pick one?", options: [{ label: "A-OPT", value: "a" }, { label: "B-OPT", value: "b" }], correctAnswer: "a", explanation: "WHY" };

	it("derives the key, the q-<toolCallId> source id and the prompt-only markdown for every question tool", () => {
		const cases: Array<[string, unknown, string]> = [
			["quiz", quizInput, "Pick one?"],
			["probe", quizInput, "Pick one?"],
			["ask_user_question", { question: "Why?", details: "Be brief." }, "Why?\n\nBe brief."],
			["ask_user_question", { question: "Which?", options: [{ label: "X-OPT" }, { label: "Y-OPT" }], multiSelect: true }, "Which?"],
			["explain", { question: "Explain it.", correctAnswer: "SECRET" }, "Explain it."],
			["recall", { question: "Recall it.", correctAnswer: "SECRET" }, "Recall it."],
		];
		for (const [tool, input, markdown] of cases) {
			assert.deepEqual(pendingQuestionSource({ key: "m1:0", toolCallId: "c1", tool, input }), { key: "m1:0", sourceId: "q-c1", markdown }, tool);
		}
	});

	it("no pending question, or a malformed one, is nothing to read", () => {
		assert.equal(pendingQuestionSource(null), null);
		assert.equal(pendingQuestionSource({ key: "k", toolCallId: "c", tool: "quiz", input: { question: 3 } }), null);
	});
});

describe("auto-read: a new question's prompt (slice 11)", () => {
	const ask = (key: string, markdown = `Prompt ${key}?`) => ({ key, sourceId: `q-${key}`, markdown });

	/** play() returns a promise the test settles: the player's "source ended" (true) or "was cut off" (false). */
	function sequenced(opts: { dictating?: boolean } = {}) {
		const played: Array<{ sourceId: string; markdown: string }> = [];
		const ends: Array<(finished: boolean) => void> = [];
		let dictating = opts.dictating ?? false;
		const auto = createAutoRead({
			play: (sourceId, markdown) => {
				played.push({ sourceId, markdown });
				return new Promise<boolean>((resolve) => ends.push(resolve));
			},
			dictating: () => dictating,
		});
		const base: AutoReadObservation = { busy: false, failed: false, enabled: true, finalStop: "stop", messages: [] };
		const observe = (patch: Partial<AutoReadObservation>) => auto.observe({ ...base, ...patch });
		const ids = () => played.map((p) => p.sourceId);
		const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
		return { played, ends, observe, ids, flush, setDictating: (d: boolean) => { dictating = d; } };
	}

	/** A turn this view watched: idle, busy with the question arriving mid-turn, then finished. */
	function turnWithQuestion(f: ReturnType<typeof sequenced>, key = "k1", replyText: string | null = "Here is a question.") {
		const history = [user("u0"), reply("a0", "old")];
		f.observe({ messages: history });
		f.observe({ busy: true, messages: [...history, user("u1")] });
		f.observe({ busy: true, question: ask(key), messages: [...history, user("u1"), reply("a1", "Here")] });
		const reply1 = replyText === null ? { id: "a1", role: "assistant", parts: [{ type: "tool-quiz" }] } : reply("a1", replyText);
		f.observe({ question: ask(key), messages: [...history, user("u1"), reply1] });
		return [...history, user("u1"), reply1];
	}

	it("plays the reply first and the prompt only once the reply has finished playing", async () => {
		const f = sequenced();
		turnWithQuestion(f);
		assert.deepEqual(f.ids(), ["a1-t0"], "the reply starts; the prompt waits its turn");
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"], "still waiting while the reply plays");
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.played, [
			{ sourceId: "a1-t0", markdown: "Here is a question." },
			{ sourceId: "q-k1", markdown: "Prompt k1?" },
		]);
	});

	it("a tool-only turn plays the prompt alone", () => {
		const f = sequenced();
		turnWithQuestion(f, "k1", null);
		assert.deepEqual(f.played, [{ sourceId: "q-k1", markdown: "Prompt k1?" }]);
	});

	it("a question that arrives with the very observation that ends the turn counts too", async () => {
		const f = sequenced();
		f.observe({});
		f.observe({ busy: true, messages: [user("u")] });
		f.observe({ question: ask("k1"), messages: [user("u"), reply("a", "Look.")] });
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a-t0", "q-k1"]);
	});

	it("a question already pending at mount, or restored with a reopened session, never plays", async () => {
		const f = sequenced();
		f.observe({ question: ask("k0"), messages: [user("u0"), reply("a0", "old")] });
		f.observe({ question: ask("k0"), messages: [user("u0"), reply("a0", "old")] });
		assert.deepEqual(f.played, []);
		// It stays quiet through a later turn too: it is not new.
		f.observe({ busy: true, question: ask("k0"), messages: [user("u0"), reply("a0", "old"), user("u1")] });
		f.observe({ question: ask("k0"), messages: [user("u0"), reply("a0", "old"), user("u1"), reply("a1", "Still there.")] });
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"], "only the reply; the old question is not re-announced");
	});

	it("a turn already running at mount that produces a question is not read", async () => {
		const f = sequenced();
		f.observe({ busy: true, messages: [user("u0")] });
		f.observe({ question: ask("k1"), messages: [user("u0"), reply("a0", "reattached")] });
		await f.flush();
		assert.deepEqual(f.played, []);
	});

	it("a question that shows up outside a turn this view watched (an adopted record) is not read", () => {
		const f = sequenced();
		f.observe({ messages: [user("u0")] });
		f.observe({ question: ask("k1"), messages: [user("u0"), reply("a0", "adopted")] });
		assert.deepEqual(f.played, []);
	});

	it("Stop (or Esc, or another Listen) during the reply cancels the queued prompt", async () => {
		const f = sequenced();
		turnWithQuestion(f);
		f.ends[0]!(false);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"]);
	});

	it("dictation skips the prompt: at the end of the turn, or starting while the reply plays", async () => {
		const atEnd = sequenced({ dictating: true });
		turnWithQuestion(atEnd);
		await atEnd.flush();
		assert.deepEqual(atEnd.played, []);

		const during = sequenced();
		turnWithQuestion(during);
		during.setDictating(true);
		during.ends[0]!(true);
		await during.flush();
		assert.deepEqual(during.ids(), ["a1-t0"]);
	});

	it("is off with the setting off, and after an aborted or failed turn", async () => {
		for (const patch of [{ enabled: false }, { finalStop: "aborted" }, { finalStop: "error" }, { failed: true }] as Array<Partial<AutoReadObservation>>) {
			const f = sequenced();
			f.observe({ ...patch, messages: [user("u0")] });
			f.observe({ ...patch, busy: true, messages: [user("u0"), user("u1")] });
			f.observe({ ...patch, busy: true, question: ask("k1"), messages: [user("u0"), user("u1")] });
			f.observe({ ...patch, question: ask("k1"), messages: [user("u0"), user("u1"), { id: "a", role: "assistant", parts: [{ type: "tool-quiz" }] }] });
			await f.flush();
			assert.deepEqual(f.played, [], JSON.stringify(patch));
		}
	});

	it("plays each question once: re-observing it, or the reply finishing again, replays nothing", async () => {
		const f = sequenced();
		const messages = turnWithQuestion(f);
		f.ends[0]!(true);
		await f.flush();
		f.ends[1]!(true);
		f.observe({ question: ask("k1"), messages });
		f.observe({ question: ask("k1"), messages });
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0", "q-k1"]);
	});

	it("the learner answering before the reply ends drops the prompt", async () => {
		const f = sequenced();
		const messages = turnWithQuestion(f);
		f.observe({ question: null, messages });
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"]);
	});

	it("a new turn starting before the reply ends drops the stale prompt", async () => {
		const f = sequenced();
		const messages = turnWithQuestion(f);
		f.observe({ busy: true, question: null, messages: [...messages, user("u2")] });
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"]);
	});

	it("a later question in a later turn plays again, after its own reply", async () => {
		const f = sequenced();
		turnWithQuestion(f, "k1");
		f.ends[0]!(true);
		await f.flush();
		f.ends[1]!(true);
		f.observe({ busy: true, messages: [user("x")] });
		f.observe({ busy: true, question: ask("k2"), messages: [user("x"), reply("a9", "Next.")] });
		f.observe({ question: ask("k2"), messages: [user("x"), reply("a9", "Next.")] });
		f.ends[2]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0", "q-k1", "a9-t0", "q-k2"]);
	});
	it("a collapsed teach check plays the reply but never its prompt, and revealing it later does not either", async () => {
		const f = sequenced();
		const collapsed = { ...ask("k1"), collapsed: true };
		const history = [user("u0"), reply("a0", "old")];
		f.observe({ messages: history });
		f.observe({ busy: true, messages: [...history, user("u1")] });
		f.observe({ busy: true, question: collapsed, messages: [...history, user("u1"), reply("a1", "Here")] });
		const messages = [...history, user("u1"), reply("a1", "Here is the check.")];
		f.observe({ question: collapsed, messages });
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"], "the reply plays, the hidden prompt does not");
		f.observe({ question: ask("k1"), messages }); // revealed: no longer collapsed
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0"], "revealing never auto-plays it");
	});

	it("a collapsed check that arrives with no reply to play stays silent", () => {
		const f = sequenced();
		const history = [user("u0"), reply("a0", "old")];
		f.observe({ messages: history });
		f.observe({ busy: true, messages: [...history, user("u1")] });
		f.observe({ question: { ...ask("k1"), collapsed: true }, messages: [...history, user("u1"), { id: "a1", role: "assistant", parts: [{ type: "tool-quiz" }] }] });
		assert.deepEqual(f.played, []);
	});

	it("a question that is not collapsed still plays after the reply", async () => {
		const f = sequenced();
		turnWithQuestion(f);
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["a1-t0", "q-k1"]);
	});
});

describe("auto-read: several blocks, then the question", () => {
	const ask = (key: string) => ({ key, sourceId: `q-${key}`, markdown: `Prompt ${key}?` });
	function sequenced() {
		const played: Array<{ sourceId: string; markdown: string }> = [];
		const ends: Array<(finished: boolean) => void> = [];
		const auto = createAutoRead({
			play: (sourceId, markdown) => {
				played.push({ sourceId, markdown });
				return new Promise<boolean>((resolve) => ends.push(resolve));
			},
			dictating: () => false,
		});
		const base: AutoReadObservation = { busy: false, failed: false, enabled: true, finalStop: "stop", messages: [] };
		const observe = (patch: Partial<AutoReadObservation>) => auto.observe({ ...base, ...patch });
		const ids = () => played.map((p) => p.sourceId);
		const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
		return { ends, observe, ids, flush };
	}
	/** An old group that grows by two blocks and a question this turn. */
	function turn(f: ReturnType<typeof sequenced>) {
		const old = [user("u0"), reply("a", "old one", "old two")];
		f.observe({ messages: old });
		f.observe({ busy: true, messages: old });
		const grown: AutoReadMessage[] = [user("u0"), { ...reply("a", "old one", "old two"), parts: [...reply("a", "old one", "old two").parts, text("new one", "b-t0"), text("new two", "c-t0")] }];
		f.observe({ question: ask("k1"), messages: grown });
	}

	it("plays each new block in order, one after the other, then the question; earlier blocks never replay", async () => {
		const f = sequenced();
		turn(f);
		assert.deepEqual(f.ids(), ["b-t0"]);
		f.ends[0]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["b-t0", "c-t0"]);
		f.ends[1]!(true);
		await f.flush();
		assert.deepEqual(f.ids(), ["b-t0", "c-t0", "q-k1"]);
	});

	it("stopping mid-way cancels the rest of the blocks and the question", async () => {
		const f = sequenced();
		turn(f);
		f.ends[0]!(false);
		await f.flush();
		assert.deepEqual(f.ids(), ["b-t0"]);
	});
});

describe("blockInProgress", () => {
	const blocks = [{ sourceId: "x", markdown: "1", partIndex: 0 }, { sourceId: "y", markdown: "2", partIndex: 1 }];
	it("only the newest message's final block, and only while busy", () => {
		assert.equal(blockInProgress(blocks, true, true), "y");
		assert.equal(blockInProgress(blocks, true, false), null);
		assert.equal(blockInProgress(blocks, false, true), null);
		assert.equal(blockInProgress([], true, true), null);
	});
});
