import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import { comparePluginSubmissionInterceptors, copyPluginSubmissionHistory, copyPluginSubmissionTarget, preparePluginSubmission, preparePluginSubmissionImage, preparePluginSubmissionImages, preparePluginSubmissionInterceptor, validatePluginBuiltinSubmissionAnswer, validatePluginSubmissionImageArray, validatePluginSubmissionImages, type PluginSubmissionTarget } from "../src/core/plugin-submissions.ts";
import type { PluginSurfaceTarget } from "../src/core/plugin-ui.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const surfaceTarget = {} as PluginSurfaceTarget;
const occurrence = { messageId: "a", contentIndex: 1, toolCallId: "q", toolName: "quiz" };
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
const empty = () => ({ text: "", images: [] });
const question: QuestionData = { id: "q", kind: "quiz", question: "Choose", mode: "single-select", options: [{ label: "B", value: "b" }, { label: "A", value: "a" }], correctIndices: [2], createdAt: "now" };
const target: PluginSubmissionTarget = { type: "answer", sessionId: "s", sessionKind: "teaching", surfaceTarget, channels: ["answer", "thinking"], question: { id: "q", kind: "quiz", question: "Choose", mode: "single-select", options: question.options, occurrence } };
const answer = <T extends object = Record<never, never>>(extra: T = {} as T) => ({ images: [], ...extra });
const submission = (extra = {}) => ({ type: "answer", answer: answer({ values: ["a"] }), thinking: empty(), readingThinking: empty(), ...extra });

describe("submission immutable boundary", () => {
	it("detaches and recursively freezes hook data without mutating plugin objects", () => {
		const original = submission();
		const prepared = preparePluginSubmission(original, target);
		assert.deepEqual(prepared, original);
		assert.ok(Object.isFrozen(prepared));
		assert.ok(Object.isFrozen(prepared.answer));
		assert.equal(Object.isFrozen(original), false);
		original.answer.values![0] = "b";
		if (prepared.type === "answer") assert.deepEqual(prepared.answer.values, ["a"]);
	});
	it("rejects unknown identity/grading fields, wrong types, accessors and nonfinite JSON", () => {
		for (const invalid of [null, undefined, { ...submission(), sessionId: "other" }, submission({ type: "text" }), submission({ answer: answer({ correct: true }) }), submission({ answer: answer({ confidence: Infinity }) }), submission({ thinking: { text: "", images: [], path: "x.png" } }), submission({ answer: answer({ values: [1] }) }), submission({ answer: answer({ text: undefined }) }), Object.defineProperty(submission(), "secret", { enumerable: true, get() { throw new Error("not invoked"); } })]) assert.throws(() => preparePluginSubmission(invalid, target));
	});
	it("rejects nonempty inapplicable channels but permits explicit empty DTO channels", () => {
		assert.doesNotThrow(() => preparePluginSubmission(submission(), target));
		assert.throws(() => preparePluginSubmission(submission({ readingThinking: { text: "reading", images: [] } }), target), /not applicable/);
		assert.throws(() => preparePluginSubmission(submission({ readingThinking: { text: "", images: [image] } }), target), /not applicable/);
	});
	it("preserves exact plugin JSON/string answers and deep-freezes nested JSON", () => {
		const pluginTarget: PluginSubmissionTarget = { type: "plugin-question-answer", sessionId: "s", sessionKind: "teaching", surfaceTarget, channels: ["answer"], question: { questionId: "q", occurrence, pluginId: "p", typeId: "t", contractVersion: 1, label: "Question", variant: "probe", showThinking: false } };
		for (const value of [false, null, 0, "  code\n\t ", { nested: [false, { source: "  text\n" }] }]) {
			const prepared = preparePluginSubmission({ type: "plugin-question-answer", answer: value, answerImages: [image], thinking: empty(), readingThinking: empty() }, pluginTarget);
			assert.ok(prepared.type === "plugin-question-answer");
			assert.deepEqual(prepared.answer, value);
			if (value && typeof value === "object") assert.notEqual(prepared.answer, value);
			assert.ok(Object.isFrozen(prepared.answerImages));
		}
	});
	it("preserves opaque target identity and snapshots host history including undefined fields", () => {
		const copied = copyPluginSubmissionTarget(target);
		assert.equal(copied.surfaceTarget, surfaceTarget);
		assert.ok(copied.type === "answer");
		assert.notEqual(copied.question, target.question);
		assert.ok(Object.isFrozen(copied.question.options));
		assert.equal(Object.isFrozen(surfaceTarget), false);
		const history = [{ role: "user", id: "u", content: [{ type: "text", text: "draft" }], timestamp: 1, optional: undefined }] as unknown as LhMessage[];
		const snapshot: readonly { content: unknown }[] = copyPluginSubmissionHistory(history);
		assert.deepEqual(snapshot, history);
		assert.notEqual(snapshot[0], history[0]);
		assert.ok(Object.isFrozen(snapshot[0]!.content));
	});
});

describe("browser native image structure (not byte processing)", () => {
	it("accepts only supported MIME/native canonical base64 blocks, preserving bytes", () => {
		for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) assert.deepEqual(preparePluginSubmissionImage({ ...image, mimeType }), { ...image, mimeType });
		for (const invalid of ["drawing.png", { ...image, type: "file" }, { ...image, mimeType: "image/svg+xml" }, { ...image, data: "" }, { ...image, data: "data:image/png;base64,aGVsbG8=" }, { ...image, data: "blob:foo" }, { ...image, data: "aGV sbG8=" }, { ...image, data: "aGVsbG8" }, { ...image, data: "Zh==" }, { ...image, data: "Zm9=" }, { ...image, extra: true }]) assert.throws(() => preparePluginSubmissionImage(invalid));
	});
	it("omits empty image channels, rejects unknown channels, and never interprets paths", () => {
		assert.deepEqual(preparePluginSubmissionImages({ answer: [], thinking: [image] }), { thinking: [image] });
		assert.deepEqual(validatePluginSubmissionImages({ answer: [], thinking: [image] }), { thinking: [image] });
		const transport = validatePluginSubmissionImageArray([image]);
		assert.deepEqual(transport, [image]);
		assert.notEqual(transport[0], image);
		assert.throws(() => validatePluginSubmissionImageArray([, image]));
		assert.throws(() => preparePluginSubmissionImages({ content: [image] }));
		const textTarget = { type: "text", sessionId: "s", sessionKind: "teaching", surfaceTarget, channels: ["content"] } as const;
		assert.deepEqual(preparePluginSubmission({ type: "text", content: { text: "drawing.png", images: [] } }, textTarget), { type: "text", content: { text: "drawing.png", images: [] } });
		assert.doesNotThrow(() => preparePluginSubmission({ type: "text", content: { text: "", images: [image] } }, textTarget));
	});
});

describe("raw builtin answer validation uses existing grader", () => {
	it("regrades transformed stable values against captured display order and normalizes confidence only in buildAnswer", () => {
		const request = validatePluginBuiltinSubmissionAnswer(question, answer({ values: ["a"], confidence: 103.6 }));
		assert.equal(request.confidence, 103.6);
		const graded = buildAnswer(question, request);
		assert.equal(graded.correct, true);
		assert.equal(graded.answers[0]!.index, 2);
		assert.equal(graded.confidence, 100);
		assert.equal(buildAnswer(question, validatePluginBuiltinSubmissionAnswer(question, answer({ dontKnow: true, values: [], confidence: 50 }))).confidence, undefined);
	});
	it("rejects duplicate/unknown values, cardinality, incompatible fields and missing selection even with images", () => {
		for (const invalid of [{ values: ["a", "a"] }, { values: ["missing"] }, { values: ["a", "b"] }, { values: ["a"], dontKnow: true }, { other: "other" }, { text: "answer" }, { images: [image] }, { values: ["a"], confidence: NaN }]) assert.throws(() => validatePluginBuiltinSubmissionAnswer(question, answer(invalid)));
	});
	it("allows empty inapplicable placeholders and answer-image-only text answers, not thinking substitutes", () => {
		assert.doesNotThrow(() => validatePluginBuiltinSubmissionAnswer(question, answer({ values: ["a"], other: "  ", text: "", dontKnow: false })));
		const textQuestion: QuestionData = { ...question, kind: "explain", mode: "text" };
		assert.doesNotThrow(() => validatePluginBuiltinSubmissionAnswer(textQuestion, answer({ text: "", images: [image], values: [], other: " ", dontKnow: false })));
		for (const invalid of [{}, { values: ["a"], text: "x" }, { text: "x", confidence: 20 }, { text: "x", dontKnow: true }]) assert.throws(() => validatePluginBuiltinSubmissionAnswer(textQuestion, answer(invalid)));
	});
	it("preserves ask multi-select Other combinations but rejects single-select combinations", () => {
		const ask = { ...question, kind: "ask" as const, mode: "multi-select" as const };
		assert.doesNotThrow(() => validatePluginBuiltinSubmissionAnswer(ask, answer({ values: ["b"], other: "custom" })));
		assert.throws(() => validatePluginBuiltinSubmissionAnswer({ ...ask, mode: "single-select" }, answer({ values: ["b"], other: "custom" })));
	});
});

describe("interceptor definition capture and deterministic ordering", () => {
	it("validates lowercase-hyphen IDs and finite integer priorities", () => {
		const definition = { id: "drawing-input", intercept() {} };
		const prepared = preparePluginSubmissionInterceptor(definition);
		assert.equal(prepared.priority, 0);
		assert.ok(Object.isFrozen(prepared));
		assert.equal(Object.isFrozen(definition), false);
		for (const extra of [{ id: "Upper" }, { id: "a--b" }, { priority: Infinity }, { priority: 1.5 }, { intercept: null }, { hasPendingInput: true }]) assert.throws(() => preparePluginSubmissionInterceptor({ ...definition, ...extra } as never));
	});
	it("orders higher priority first, then plugin ID and interceptor ID", () => {
		const entry = (pluginId: string, id: string, priority = 0) => ({ pluginId, definition: preparePluginSubmissionInterceptor({ id, priority, intercept() {} }) });
		const entries = [entry("z", "a"), entry("a", "z"), entry("a", "a"), entry("z", "z", 1)];
		assert.deepEqual(entries.sort(comparePluginSubmissionInterceptors).map(item => [item.pluginId, item.definition.id]), [["z", "z"], ["a", "a"], ["a", "z"], ["z", "a"]]);
	});
});
