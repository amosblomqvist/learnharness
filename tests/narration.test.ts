import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownNarration, narrationSentences, completeMarkdownPrefix } from "../src/core/narration.ts";
import { NarrationController, type NarrationSource } from "../src/core/narration-controller.ts";
import { teacherNarrationSources } from "../src/core/narration-sources.ts";
import { questionNarration, visibleQuestionOptions } from "../src/core/visible-question.ts";
import { normalizeOptions, seededRandom, shuffleOptions } from "../src/core/question-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

test("Markdown narration retains visible labels and descriptions, skips code/math, and labels table rows", () => {
	const spoken = markdownNarration("# Title\n\nRead [the label](https://secret.invalid). `danger()` $x+1$\n\n![A red apple](private.png)\n\n| Name | Value |\n| --- | --- |\n| Speed | Fast |\n\n```js\nsecret()\n```\n");
	assert.match(spoken, /Title/);
	assert.match(spoken, /Read the label/);
	assert.match(spoken, /Code omitted/);
	assert.match(spoken, /Equation omitted/);
	assert.match(spoken, /Image: A red apple/);
	assert.match(spoken, /Name: Speed\. Value: Fast/);
	assert.doesNotMatch(spoken, /secret|danger|private|https/);
});

test("unfinished code, math and link syntax remains buffered", () => {
	for (const incomplete of ["```js\nprivate", "$unfinished", "$$unfinished", "[a secret. word", "[label](private"]) {
		assert.equal(completeMarkdownPrefix(`Visible.\n${incomplete}`), "Visible.\n");
	}
	assert.equal(markdownNarration("Visible.\n```js\nprivate", false), "Visible.");
	assert.match(markdownNarration("```js\nprice$\n```\n\nVisible.", false), /Visible/);
	assert.doesNotMatch(markdownNarration("Visible. \\(hidden+equation\\)"), /hidden/);
});

test("sentence boundaries preserve decimals, abbreviations and uncompleted tails", () => {
	const text = "Dr. Smith measured 3.14 metres. It worked! Unfinished";
	assert.deepEqual(narrationSentences(text, false).map(x => x.text), ["Dr. Smith measured 3.14 metres.", "It worked!"]);
	assert.equal(narrationSentences(text, true).at(-1)?.text, "Unfinished");
	assert.equal(narrationSentences("A final sentence.", false).length, 1, "a finished sentence is spoken even while streaming");
	assert.equal(narrationSentences("A final sentence.", true).length, 1);
	assert.ok(narrationSentences("🙂".repeat(3000), true).every(x => Buffer.byteLength(x.text) < 16384));
});

test("question projection shares shuffled display order and excludes hidden answer fields", () => {
	const options = [{ label: "First", value: "one", description: "Visible detail" }, { label: "Second", value: "two" }];
	const displayed = visibleQuestionOptions("quiz", "call-1", options);
	assert.deepEqual(displayed, shuffleOptions(normalizeOptions(options), seededRandom("call-1")));
	const question = { question: "Pick one", context: "Visible context", kind: "quiz" as const, mode: "single-select" as const, options: displayed,
		correctIndices: [1], committedAnswer: "hidden commitment", explanation: "hidden explanation" };
	const spoken = questionNarration(question);
	assert.ok(spoken.indexOf(displayed[0]!.label) < spoken.indexOf(displayed[1]!.label));
	assert.match(spoken, /Visible detail/);
	assert.doesNotMatch(spoken, /hidden|correctIndices|commitment/);
});

function harness() {
	const spoken: string[] = [];
	const synthesized: string[] = [];
	let pauseCount = 0;
	let resumeCount = 0;
	const controller = new NarrationController<string>({
		async synthesize(text) { synthesized.push(text); return text; },
		async play(audio) { spoken.push(audio); },
		pause() { pauseCount++; }, resume() { resumeCount++; }, stop() {},
	});
	return { controller, spoken, synthesized, paused: () => pauseCount, resumed: () => resumeCount };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const source = (markdown: string, complete = true, id = "native:0"): NarrationSource => ({ id, markdown, complete });

test("opening baseline never autoplays; subsequent streamed text and completion tails read once", async () => {
	const { controller, spoken } = harness();
	controller.baseline([source("Existing. ", false)]);
	controller.setAutomatic(true);
	controller.update([source("Existing. New sentence. Tail", false)]);
	await settle();
	assert.deepEqual(spoken, ["New sentence."]);
	controller.update([source("Existing. New sentence. Tail", false)]);
	controller.update([source("Existing. New sentence. Tail")]);
	await settle();
	assert.deepEqual(spoken, ["New sentence.", "Tail"]);
});

test("rewriting a consumed prefix stops automatic narration and offers Read again", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	controller.update([source("First. Tail", false)]);
	await settle();
	controller.update([source("Changed. Tail", true)]);
	await settle();
	assert.deepEqual(spoken, ["First."]);
	assert.deepEqual(controller.getSnapshot().readAgain, ["native:0"]);
	controller.manual(source("Changed. Tail"));
	await settle();
	assert.deepEqual(spoken, ["First.", "Changed.", "Tail"]);
});

test("stop suppresses later generated text including new blocks of the current native response", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	controller.update([source("First. Tail", false)]);
	await settle();
	controller.stop();
	controller.update([source("First. Tail has arrived."), source("Another block.", true, "native:1")]);
	await settle();
	assert.deepEqual(spoken, ["First."]);
	controller.update([source("A new response.", true, "next-native:0")]);
	await settle();
	assert.deepEqual(spoken, ["First.", "A new response."]);
});

test("a revealed question queues after explanation and duplicate reveal/collapse updates never replay", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	controller.update([source("Explanation.")]);
	controller.updateSource(source("A question?", true, "question:call"));
	controller.update([source("Explanation.")]);
	controller.updateSource(source("A question?", true, "question:call"));
	await settle();
	assert.deepEqual(spoken, ["Explanation.", "A question?"]);
});

test("dictation cancels inference, retains text only, and rejects stale synthesis completions", async () => {
	const pending: { text: string; resolve: (value: string) => void }[] = [];
	const spoken: string[] = [];
	const controller = new NarrationController<string>({
		synthesize(text) { return new Promise(resolve => pending.push({ text, resolve })); },
		async play(text) { spoken.push(text); }, pause() {}, resume() {}, stop() {},
	});
	controller.setAutomatic(true);
	controller.update([source("First. Tail", false)]);
	controller.setDictating(true);
	controller.update([source("First. Tail finished.")]);
	pending[0]!.resolve("stale audio");
	await settle();
	assert.deepEqual(spoken, []);
	assert.equal(pending.length, 1);
	controller.setDictating(false);
	// Every request made after resume is answered in order, however many the look-ahead issues.
	for (let i = 1; i < pending.length; i++) { pending[i]!.resolve(pending[i]!.text); await settle(); }
	assert.deepEqual(spoken, ["First.", "Tail finished."]);
});

test("manual interruption and question removal invalidate stale asynchronous work", async () => {
	let resolve!: (value: string) => void;
	const spoken: string[] = [];
	const controller = new NarrationController<string>({ synthesize: () => new Promise(r => { resolve = r; }), async play(text) { spoken.push(text); }, pause() {}, resume() {}, stop() {} });
	controller.manual(source("Question?", true, "question:call"));
	controller.remove("question:call");
	resolve("stale question");
	await settle();
	assert.deepEqual(spoken, []);
});

test("dictation pauses playing audio without restarting it, and explicit stop cancels resume intent", async () => {
	let completePlayback!: () => void;
	let paused = 0;
	let resumed = 0;
	let plays = 0;
	const controller = new NarrationController<string>({
		async synthesize(text) { return text; },
		play() { plays++; return new Promise<void>(resolve => { completePlayback = resolve; }); },
		pause() { paused++; }, resume() { resumed++; }, stop() {},
	});
	controller.manual(source("Keep my place."));
	await settle();
	controller.setDictating(true);
	assert.equal(paused, 1);
	assert.equal(plays, 1);
	controller.setDictating(false);
	assert.equal(resumed, 1);
	assert.equal(plays, 1);
	completePlayback();
	await settle();
	assert.equal(controller.getSnapshot().status, "idle");
	controller.setDictating(true);
	controller.stop();
	controller.setDictating(false);
	assert.equal(resumed, 1);
});

test("stop suppresses later native messages within the running response and resets at settlement", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	controller.update([source("First explanation.")], true);
	await settle();
	controller.stop();
	controller.update([source("First explanation."), source("Later step.", true, "next-step:0")], true);
	controller.update([source("First explanation."), source("Later step.", true, "next-step:0")], false);
	await settle();
	assert.deepEqual(spoken, ["First explanation."]);
	controller.update([source("New response.", true, "another:0")], true);
	await settle();
	assert.deepEqual(spoken, ["First explanation.", "New response."]);
});

test("retired questions do not automatically replay when restored after a failed submission", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	const question = source("Question?", true, "question:call");
	controller.updateSource(question);
	await settle();
	controller.retire(question.id);
	controller.updateSource(question);
	await settle();
	assert.deepEqual(spoken, ["Question?"]);
});

test("failed responses stop automatic speech but remain manually readable", async () => {
	const { controller, spoken } = harness();
	controller.setAutomatic(true);
	controller.update([{ ...source("Visible partial response."), failed: true }]);
	await settle();
	assert.deepEqual(spoken, []);
	controller.manual({ ...source("Visible partial response."), failed: true });
	await settle();
	assert.deepEqual(spoken, ["Visible partial response."]);
});

test("native projection excludes thinking, tool arguments, hidden quiz data and learner text", () => {
	const messages = [{ id: "learner", role: "user", content: "Private learner text" }, { id: "teacher", role: "assistant", stopReason: "stop", content: [
		{ type: "thinking", thinking: "Hidden reasoning" }, { type: "text", text: "Visible prose." },
		{ type: "toolCall", id: "question", name: "quiz", arguments: { question: "Hidden until reveal", correctAnswer: "secret" } },
	] }] as unknown as LhMessage[];
	assert.deepEqual(teacherNarrationSources(messages, false).map(({ id, markdown, viewPartId }) => ({ id, markdown, viewPartId })), [{ id: "teacher:1", markdown: "Visible prose.", viewPartId: "teacher-t0" }]);
});

test("artifact narration reads only an available visible title, excluding HTML and builder notes", () => {
	const messages = [{ id: "artifact", role: "custom", customType: "subagent-steer", details: { kind: "demo", result: { title: "Orbit demonstration", html: "<script>hiddenCode()</script>", notes: "private builder notes" } }, content: "private model-facing steer" }] as unknown as LhMessage[];
	const sources = teacherNarrationSources(messages, false);
	assert.equal(sources.length, 1);
	assert.equal(markdownNarration(sources[0]!.markdown), "Orbit demonstration");
	assert.doesNotMatch(JSON.stringify(sources), /hiddenCode|private/);
});

test("rewriting an audible prefix suppresses sibling native blocks and future blocks in that response", async () => {
 const {controller,spoken}=harness();controller.setAutomatic(true);
 controller.update([source("First. Tail",false,"native:0")],true);await settle();
 controller.pause();
 controller.update([source("First. Tail",false,"native:0"),source("Queued sibling.",true,"native:1")],true);
 controller.update([source("Changed. Tail",false,"native:0"),source("Queued sibling.",true,"native:1"),source("Future sibling.",true,"native:2")],true);
 controller.resume();await settle();assert.deepEqual(spoken,["First."]);assert.deepEqual(controller.getSnapshot().readAgain,["native:0"]);
});
test("rewriting text that is still synthesizing replaces it without Read again", async () => {
 const spoken:string[]=[];let first=true;let release!:(value:string)=>void;
 const controller=new NarrationController<string>({synthesize(text){if(first){first=false;return new Promise(resolve=>{release=resolve;});}return Promise.resolve(text);},async play(text){spoken.push(text);},pause(){},resume(){},stop(){}});
 controller.setAutomatic(true);controller.update([source("Old queued sentence.")]);
 controller.update([source("Replacement sentence.")]);await settle();release("Old queued sentence.");await settle();
 assert.deepEqual(spoken,["Replacement sentence."]);assert.deepEqual(controller.getSnapshot().readAgain,[]);controller.dispose();
});
test("rewriting historical baseline content never autoplays or offers Read again", async () => {
 const {controller,spoken}=harness();controller.baseline([source("Historical text.",false)]);controller.setAutomatic(true);
 controller.update([source("Revised historical text.",false)]);await settle();
 assert.deepEqual(spoken,[]);assert.deepEqual(controller.getSnapshot().readAgain,[]);
 controller.update([source("Revised historical text. New sentence.")]);await settle();assert.deepEqual(spoken,["New sentence."]);
});

test("the next sentence synthesizes while the current one plays, so playback runs without a synthesis gap", async () => {
    const synthesized: string[] = [];
    const finishers: Array<() => void> = [];
    const controller = new NarrationController<string>({
        async synthesize(text) { synthesized.push(text); return text; },
        play(_audio, signal) {
            return new Promise<void>((resolve) => { finishers.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
        },
        pause() {}, resume() {}, stop() {},
    });
    controller.setAutomatic(true);
    controller.update([source("One sentence. Two sentence. Three sentence.")]);
    await settle();
    // Sentence one is audible; the next two are already requested (the plan's look-ahead of two).
    assert.equal(finishers.length, 1);
    assert.deepEqual(synthesized, ["One sentence.", "Two sentence.", "Three sentence."]);
    finishers.shift()!();
    await settle();
    assert.deepEqual(synthesized, ["One sentence.", "Two sentence.", "Three sentence."]);
    controller.dispose();
});

test("simple inline math reads as itself, complex math is announced, and punctuation-only fragments are never queued", () => {
	assert.equal(markdownNarration("Records at positions $0$ to $4$. Then record $F$ is written.", true), "Records at positions 0 to 4. Then record F is written.");
	assert.match(markdownNarration("Compute $\\frac{a}{b}$ now.", true), /Equation omitted/);
	assert.ok(narrationSentences("Visible. . . . ", true).every(sentence => /[\p{L}\p{N}]/u.test(sentence.text)));
});

test("a failed sentence is skipped and the rest of the response still plays", async () => {
	const spoken: string[] = [];
	const controller = new NarrationController<string>({
		async synthesize(text) { if (text.startsWith("Broken")) throw new Error("Speech produced no audio"); return text; },
		async play(audio) { spoken.push(audio); },
		pause() {}, resume() {}, stop() {},
	});
	controller.setAutomatic(true);
	controller.update([source("First sentence. Broken sentence. Last sentence.")]);
	await settle();
	assert.deepEqual(spoken, ["First sentence.", "Last sentence."]);
	controller.dispose();
});

test("an interruption (voice change) keeps unspoken text and lets a question that arrives in the same response read", async () => {
	const { controller, spoken } = harness();
	controller.baseline([]);
	controller.setAutomatic(true);
	const teacher = (complete: boolean): NarrationSource => ({ id: "m1:0", markdown: "Teacher text. More.", complete });
	controller.update([teacher(false)], true);
	await settle();
	controller.halt();
	controller.update([teacher(false)], true);
	controller.update([teacher(true), { id: "question:call1", markdown: "Pick one.", complete: true }], false);
	await settle();
	assert.ok(spoken.includes("More."), `teacher tail lost: ${JSON.stringify(spoken)}`);
	assert.ok(spoken.includes("Pick one."), `question not read: ${JSON.stringify(spoken)}`);
	controller.dispose();
});

test("the learner's Stop suppresses the rest of that response, and the next response reads normally", async () => {
	const { controller, spoken } = harness();
	controller.baseline([]);
	controller.setAutomatic(true);
	controller.update([source("First. Second.", false, "m1:0")], true);
	await settle();
	controller.stop();
	controller.update([source("First. Second. Third.", false, "m1:0"), { id: "question:late", markdown: "Late question.", complete: true }], true);
	controller.update([source("First. Second. Third.", true, "m1:0")], false);
	await settle();
	assert.ok(!spoken.includes("Late question."), "explicit Stop must suppress later text of that response");
	controller.update([source("First. Second. Third.", true, "m1:0"), source("Next response.", true, "m2:0")], false);
	await settle();
	assert.ok(spoken.includes("Next response."), `next response must read: ${JSON.stringify(spoken)}`);
	controller.dispose();
});

test("reading an older message aloud silences playback without suppressing the streaming reply", async () => {
	const { controller, spoken } = harness();
	controller.baseline([]);
	controller.setAutomatic(true);
	controller.update([source("Streaming one. Streaming two.", false, "m1:0")], true);
	await settle();
	controller.manual(source("Older message.", true, "m0:0"));
	await settle();
	controller.update([source("Streaming one. Streaming two. Streaming three. Partial", false, "m1:0")], true);
	await settle();
	assert.ok(spoken.includes("Streaming three."), `streaming reply must keep reading: ${JSON.stringify(spoken)}`);
	controller.dispose();
});

test("an interruption never replays history that was already in the transcript", async () => {
	const { controller, spoken } = harness();
	controller.baseline([source("Old history. Old tail.", true, "m0:0")]);
	controller.setAutomatic(true);
	controller.halt();
	await settle();
	assert.deepEqual(spoken, []);
	controller.dispose();
});

test("a question already waiting at open is read on its first reveal, after the teacher text that precedes it", async () => {
	const { controller, spoken } = harness();
	controller.baseline([source("Teacher context.", true, "m0:0")]);
	controller.setAutomatic(true);
	controller.update([source("Teacher context.", true, "m0:0")], false);
	controller.updateSource({ id: "question:waiting", markdown: "Which is true?", complete: true });
	await settle();
	assert.deepEqual(spoken, ["Which is true?"]);
	controller.dispose();
});

test("words written as inline code or as text math are spoken; real code and formulas are still omitted", () => {
	assert.equal(markdownNarration("Events are *created*, `deposited`, and $\\text{withdrawn}$."), "Events are created, deposited, and withdrawn.");
	assert.equal(markdownNarration("Compute $\\frac{a}{b}$ and call `danger()`."), "Compute Equation omitted and call Code omitted.");
	assert.equal(markdownNarration("Positions $0$ to $4$."), "Positions 0 to 4.");
});

test("question text and choices read through the same Markdown projection as teacher prose", () => {
	const spoken = questionNarration({ question: "Events `created` and *deposited* are $\\text{withdrawn}$ later.", kind: "quiz", mode: "single-select",
		options: [{ label: "Nothing: `withdrawn` may come first" }] } as never);
	assert.match(spoken, /Events created and deposited are withdrawn later\./);
	assert.match(spoken, /Choice 1\. Nothing: withdrawn may come first/);
	assert.doesNotMatch(spoken, /`/);
});

test("GitHub alert markers are not spoken", () => {
	assert.equal(markdownNarration("> [!IMPORTANT]\n> Kafka guarantees order only within a partition."), "Kafka guarantees order only within a partition.");
	assert.equal(markdownNarration("> [!NOTE] Keys decide the partition."), "Keys decide the partition.");
});

test("a finished sentence is spoken while the reply still streams, but a number that may continue is held", () => {
	assert.deepEqual(narrationSentences("Hello there.", false).map(x => x.text), ["Hello there."]);
	assert.deepEqual(narrationSentences("It costs 3.", false).map(x => x.text), []);
	assert.deepEqual(narrationSentences("Done!", false).map(x => x.text), ["Done!"]);
});

test("the final period before a pending question is spoken while the turn is still running", async () => {
	const { controller, spoken } = harness();
	controller.baseline([]);
	controller.setAutomatic(true);
	controller.update([source("Before the question. This is the end.", false, "m1:0")], true);
	await settle();
	assert.ok(spoken.includes("This is the end."), `final sentence held: ${JSON.stringify(spoken)}`);
	controller.dispose();
});

test("a single-letter list label after a line break ends its sentence, while an initial does not", () => {
	assert.deepEqual(narrationSentences("First line here\nB. Choice three", true).map(x => x.text), ["First line here", "B. Choice three"]);
	assert.deepEqual(narrationSentences("J. R. Tolkien wrote it.", true).map(x => x.text), ["J. R. Tolkien wrote it."]);
});

test("a sentence whose synthesis fails once is retried and still spoken, in order", async () => {
	const spoken: string[] = [];
	const attempts = new Map<string, number>();
	const controller = new NarrationController<string>({
		async synthesize(text) {
			const n = (attempts.get(text) ?? 0) + 1; attempts.set(text, n);
			if (text === "Second sentence." && n === 1) throw new Error("Speech is busy");
			return text;
		},
		async play(audio) { spoken.push(audio); },
		pause() {}, resume() {}, stop() {},
	});
	controller.setAutomatic(true);
	controller.update([source("First sentence. Second sentence. Third sentence.")]);
	await settle();
	assert.deepEqual(spoken, ["First sentence.", "Second sentence.", "Third sentence."]);
	controller.dispose();
});
