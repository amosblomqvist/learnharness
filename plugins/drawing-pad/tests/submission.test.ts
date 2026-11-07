import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginSubmission } from "learnharness-plugin-api";
import { appendDrawing } from "../src/submission.ts";
const existing = { type: "image" as const, mimeType: "image/png", data: "existing" };
const drawing = { type: "image" as const, mimeType: "image/png" as const, data: "drawing" };
const content = { text: "  exact learner text  ", images: [existing] };
const inputs: PluginSubmission[] = [
  { type: "text", content }, { type: "thinking", content },
  { type: "answer", answer: { values: ["stable-b"], confidence: 30, images: [existing] }, thinking: content, readingThinking: content },
  { type: "plugin-question-answer", answer: false, answerImages: [existing], thinking: content, readingThinking: content },
  { type: "plugin-problem-submission", submission: 0, submissionImages: [existing], thinking: content },
];
for (const input of inputs) it(`appends a native image without mutating ${input.type} learner values`, () => {
  const before = JSON.stringify(input), result = appendDrawing(input, drawing);
  assert.equal(JSON.stringify(input), before); assert.notEqual(result, input); assert.equal(result.type, input.type);
  if (result.type === "text" || result.type === "thinking") {
    assert.equal(result.content.text, content.text); assert.deepEqual(result.content.images, [existing, drawing]);
  } else if (result.type === "answer") {
    assert.deepEqual(result.answer.values, ["stable-b"]); assert.equal(result.answer.confidence, 30);
    assert.deepEqual(result.answer.images, [existing, drawing]); assert.equal(result.thinking, content); assert.equal(result.readingThinking, content);
  } else if (result.type === "plugin-question-answer") {
    assert.equal(result.answer, false); assert.deepEqual(result.answerImages, [existing, drawing]); assert.equal(result.thinking, content);
  } else { assert.equal(result.submission, 0); assert.deepEqual(result.submissionImages, [existing, drawing]); assert.equal(result.thinking, content); }
});
