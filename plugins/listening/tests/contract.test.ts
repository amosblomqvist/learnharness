import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { answerSchema, definition, listeningInstructions, questionSchema } from "../src/contract.ts";
import { answerState, shuffleOptions } from "../src/editor.ts";
import { createPlaybackStore, failed, finished, startedAt } from "../src/playback-state.ts";

const question = Compile(questionSchema);
const answer = Compile(answerSchema);
const audio = { text: "Quiero un café.", language: "es" };

test("question schema: required audio/format/correctAnswer, choice options shape, language code format", () => {
  for (const value of [
    { audio, format: "recall", correctAnswer: "I want a coffee." },
    { audio, format: "choice", options: [{ label: "Coffee", value: "coffee" }, { label: "Tea" }], explanation: "café", correctAnswer: "coffee" },
    { audio: { text: "Olá", language: "pt-BR" }, format: "recall", correctAnswer: "Hello" },
  ]) assert.equal(question.Check(value), true, JSON.stringify(value));
  for (const value of [
    {}, { audio, format: "recall" }, { audio, format: "dictation", correctAnswer: "x" },
    { audio: { text: " ", language: "es" }, format: "recall", correctAnswer: "x" },
    { audio: { text: "x", language: "Spanish" }, format: "recall", correctAnswer: "x" },
    { audio: { text: "x" }, format: "recall", correctAnswer: "x" },
    { audio, format: "choice", options: [{ label: "Only one" }], correctAnswer: "Only one" },
    { audio, format: "choice", options: [{ label: " " }, { label: "B" }], correctAnswer: "B" },
    { audio, format: "recall", correctAnswer: " \n" },
    { audio, format: "recall", correctAnswer: "x", transcript: "leak" },
  ]) assert.equal(question.Check(value), false, JSON.stringify(value));
});

test("answer schema: answered choice or text with started speeds, or audio unavailable", () => {
  for (const value of [
    { status: "answered", choice: "coffee", playbackRates: [1] },
    { status: "answered", text: "a coffee", playbackRates: [0.75, 1] },
    { status: "audio_unavailable" },
  ]) assert.equal(answer.Check(value), true, JSON.stringify(value));
  for (const value of [
    { status: "answered", choice: "coffee", playbackRates: [] },
    { status: "answered", choice: "coffee", playbackRates: [1, 1] },
    { status: "answered", choice: "coffee", playbackRates: [1.5] },
    { status: "answered", text: " ", playbackRates: [1] },
    { status: "answered", choice: "a", text: "b", playbackRates: [1] },
    { status: "audio_unavailable", playbackRates: [1] },
    { status: "skipped" },
  ]) assert.equal(answer.Check(value), false, JSON.stringify(value));
});

test("both variants, thinking, and language-neutral instructions that name the model's limits", () => {
  assert.equal(definition.probe.toolName, "listening_probe");
  assert.equal(definition.teach.toolName, "listening_question");
  assert.equal(definition.showThinking, true);
  const text = listeningInstructions({ id: "m", label: "Flash v2.5", maxTextLength: 40000, languages: ["en", "zh"] });
  assert.match(text, /Flash v2\.5/);
  assert.match(text, /en, zh/);
  assert.match(text, /40,000 characters/);
  assert.match(text, /audio_unavailable/);
  assert.doesNotMatch(text, /Mandarin|Chinese/);
});

test("options shuffle deterministically per question", () => {
  const options = ["a", "b", "c", "d", "e"];
  assert.deepEqual(shuffleOptions(options, "question-1"), shuffleOptions(options, "question-1"));
  assert.deepEqual([...shuffleOptions(options, "question-1")].sort(), options);
  const orders = new Set(["q1", "q2", "q3", "q4", "q5", "q6"].map(seed => shuffleOptions(options, seed).join("")));
  assert.ok(orders.size > 1, "different questions get different orders");
});

test("submit is gated on one full playback; drafts are kept while unready", () => {
  const store = createPlaybackStore();
  const id = "q";
  assert.deepEqual(answerState("choice", {}, store.get(id)), { status: "empty" });
  assert.deepEqual(answerState("choice", { choice: "coffee" }, store.get(id)), { status: "unready", value: { status: "answered", choice: "coffee", playbackRates: [] } });
  store.update(id, record => startedAt(record, 0.75));
  store.update(id, record => startedAt(record, 0.75));
  store.update(id, record => startedAt(record, 1));
  assert.deepEqual(answerState("choice", { choice: "coffee" }, store.get(id)).status, "unready", "starting is not finishing");
  store.update(id, finished);
  assert.deepEqual(answerState("choice", { choice: "coffee" }, store.get(id)), { status: "ready", value: { status: "answered", choice: "coffee", playbackRates: [0.75, 1] } });
  assert.deepEqual(answerState("recall", { text: "" }, store.get(id)), { status: "empty" });
  assert.equal(answerState("recall", { text: "  " }, store.get(id)).status, "unready", "whitespace is a draft, not an answer");
  assert.deepEqual(answerState("recall", { text: " a coffee " }, store.get(id)), { status: "ready", value: { status: "answered", text: " a coffee ", playbackRates: [0.75, 1] } }, "never trimmed");
});

test("Continue another way makes audio unavailable ready; a later full playback undoes it", () => {
  const store = createPlaybackStore();
  const seen: number[] = [];
  const unsubscribe = store.subscribe("q", record => seen.push(record.failures));
  store.update("q", failed);
  store.update("q", failed);
  store.update("q", record => ({ ...record, audioUnavailable: true }));
  assert.deepEqual(answerState("recall", { text: "x" }, store.get("q")), { status: "ready", value: { status: "audio_unavailable" } });
  store.update("q", finished);
  assert.equal(answerState("recall", { text: "x" }, store.get("q")).status, "unready", "no playback started, so no rates to submit");
  assert.deepEqual(seen, [1, 2, 2, 2]);
  unsubscribe();
  store.update("q", failed);
  assert.equal(seen.length, 4);
  assert.equal(store.get("other").completed, false, "questions are independent");
});
