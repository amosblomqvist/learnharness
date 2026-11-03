import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { definition, instructions, isReady, normalizeLineEndings } from "../src/contract.ts";
import { findLanguage } from "../src/editor.ts";

const question = Compile(definition.questionSchema);
const answer = Compile(definition.answerSchema);

test("teacher only, thinking enabled, public native-question registration and cleanup", () => {
  const calls: unknown[] = [];
  const cleanup = activate({
    registerQuestionType(value) { calls.push(value); return () => { calls.push("question disposed"); }; },
    registerInstructions(value) { calls.push(value); return () => { calls.push("instructions disposed"); }; },
  } as PluginBackendContext);
  assert.deepEqual(calls, [definition, { agents: ["teacher"], text: instructions }]);
  assert.equal(definition.teach.toolName, "coding_question");
  assert.equal("probe" in definition, false);
  assert.equal("execute" in definition, false);
  assert.equal(definition.showThinking, true);
  assert.equal("validateAnswer" in definition, false);
  cleanup();
  assert.deepEqual(calls.slice(2), ["instructions disposed", "question disposed"]);
});

test("optional/empty starter code and arbitrary language, not a restricted language enum", () => {
  for (const value of [{ language: "Python" }, { language: "unknown-language", starterCode: "" }, { language: "C++", starterCode: "  int x;\r\n" }]) assert.equal(question.Check(value), true);
  for (const value of [{}, { language: " \n" }, { language: 4 }, { language: "js", starterCode: null }, { language: "js", hiddenReference: "no" }]) assert.equal(question.Check(value), false);
});

test("readiness and saved answer schema agree; never trim code", () => {
  for (const code of ["", " ", "\t\n\r", "\u00a0"]) {
    assert.equal(isReady(code), false); assert.equal(answer.Check(code), false);
  }
  for (const code of ["0", "  x  \n", "\treturn false;\n\n", "<script>literal text</script>"]) {
    assert.equal(isReady(code), true); assert.equal(answer.Check(code), true);
    assert.equal(normalizeLineEndings(code), code);
  }
  for (const value of [null, false, {}, ["code"], 0]) assert.equal(answer.Check(value), false);
  assert.equal(normalizeLineEndings("  a\r\nb\rc\n\n"), "  a\nb\nc\n\n");
});

test("full standard catalog resolves language names and aliases without fuzzy guessing", () => {
  for (const name of ["python", " JAVASCRIPT ", "TypeScript", "C", "C++", "cpp", "sql", "Rust", "yaml", "shell", "LaTeX"]) assert.ok(findLanguage(name), name);
  assert.equal(findLanguage("not-a-known-language"), null);
  assert.equal(findLanguage("python-maybe"), null);
});

test("every standard language module can load locally", async () => {
  const { languages } = await import("@codemirror/language-data");
  assert.ok(languages.length > 100);
  for (const language of languages) assert.ok(await language.load(), language.name);
});
