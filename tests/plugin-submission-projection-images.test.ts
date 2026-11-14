import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { nativeAnswerContent, nativeInlineImageContent, newAnswerResult, newUserMessage, newThinkingMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { answerForPresentation } from "../src/core/answer-presentation.ts";
import { compactAnswerForModel, dismissedAnswer } from "../src/core/question-core.ts";
import { readPluginQuestionAnswer, type PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";

const image = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });
const answerImage = image("YWJj"), thinkingImage = image("ZGVm"), readingImage = image("Z2hp");
const images = { answer: [answerImage], thinking: [thinkingImage], readingThinking: [readingImage] };
const snapshot: PluginQuestionSnapshot = {
	protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach", questionId: "question-1", contractVersion: 1,
	occurrence: { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "plugin_code" },
	input: { question: "What?", payload: {}, type: "check", nodeId: "node" }, questionSchema: { type: "object" }, answerSchema: { type: "boolean" }, showThinking: true, requiresAnswerRefinement: false,
};
const pluginAnswer = { kind: "plugin-question", questionId: "question-1", pluginId: "fixture", typeId: "code", contractVersion: 1, answer: false, thinking: "question words", readingThinking: "reading words", answeredAt: "2026-11-02T12:00:00Z" };

test("user image parts preserve native ordering, legacy text and paths without inference", () => {
	assert.equal(nativeInlineImageContent("./diagram.png"), "./diagram.png");
	assert.equal(nativeInlineImageContent("legacy", []), "legacy");
	const message = newUserMessage("./diagram.png", [answerImage]);
	assert.deepEqual(projectView([message])[0]!.parts, [{ type: "text", text: "./diagram.png", state: "done" }, answerImage]);
	assert.deepEqual(projectView([newUserMessage("", [answerImage])])[0]!.parts, [answerImage]);
	assert.deepEqual(projectView([newUserMessage("legacy")])[0]!.parts, [{ type: "text", text: "legacy", state: "done" }]);
});

test("practice thinking images persist in marker details and reach both UI and model", () => {
	const marker = newThinkingMessage("problem", "", [thinkingImage]);
	assert.deepEqual((projectView([marker])[0]!.parts[0]!.data as { images: unknown }).images, [thinkingImage]);
	assert.deepEqual(toLlmMessages([marker])[0]!.content, [{ type: "text", text: marker.content }, thinkingImage]);
});

test("builtin answer model content carries labelled image bytes in channel order without duplicated thinking text", () => {
	const answer = { ...dismissedAnswer("ask", "What?"), dismissed: false, text: "answer words", thinking: "question words", readingThinking: "reading words", images };
	const result = newAnswerResult("call", "ask", answer);
	assert.deepEqual(result.content, [
		{ type: "text", text: JSON.stringify(compactAnswerForModel(answer)) },
		{ type: "text", text: "Answer images:" }, answerImage,
		{ type: "text", text: "Question thinking images:" }, thinkingImage,
		{ type: "text", text: "Reading thinking images:" }, readingImage,
	]);
	const model = JSON.stringify(toLlmMessages([result])[0]!.content);
	assert.equal(model.split("question words").length - 1, 1);
	assert.equal(model.split("reading words").length - 1, 1);
	assert.deepEqual(answerForPresentation(answer, { question: "Presented?", mode: "text" }).images, images);
	assert(!("images" in compactAnswerForModel(answer)), "image bytes are native content, not compact JSON");
});

test("plugin host answer envelope retains independent images outside arbitrary JSON schema", () => {
	const saved = readPluginQuestionAnswer({ ...pluginAnswer, images }, snapshot)!;
	assert(saved);
	assert.equal(saved.answer, false);
	assert.deepEqual(saved.images, images);
	assert(Object.isFrozen(saved.images?.answer));
	const content = nativeAnswerContent(JSON.stringify(pluginAnswer), saved.images);
	assert.deepEqual(content.filter(block => block.type === "image"), [answerImage, thinkingImage, readingImage]);
	assert.deepEqual(readPluginQuestionAnswer({ ...pluginAnswer, images: { answer: [] } }, snapshot), pluginAnswer);
	assert.equal(readPluginQuestionAnswer({ ...pluginAnswer, images: { answer: ["drawing.png"] } }, snapshot), null);
	assert.equal(readPluginQuestionAnswer({ ...pluginAnswer, images }, { ...snapshot, protocolVersion: 99 } as never), null);
	assert.equal(readPluginQuestionAnswer({ ...pluginAnswer, images }, { ...snapshot, showThinking: false }), null);
	const { readingThinking: _reading, ...withoutReading } = pluginAnswer;
	assert.equal(readPluginQuestionAnswer({ ...withoutReading, images: { readingThinking: [readingImage] } }, { ...snapshot, variant: "probe", input: { question: "What?", payload: {} } }), null);
	assert.deepEqual(readPluginQuestionAnswer(pluginAnswer, snapshot), pluginAnswer, "legacy absent channels stay absent");
});
