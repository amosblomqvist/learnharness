import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import type { PluginBackendContext, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { definition, instructions, isReady, normalizeLineEndings, readTests } from "../src/contract.ts";
import { findLanguage } from "../src/editor.ts";

const question = Compile(definition.questionSchema);
const answer = Compile(definition.answerSchema);
const tests = { program: "node", args: ["-"], code: "process.exit(0);" };

test("teacher only, thinking enabled, public native-question registration and cleanup", () => {
  const calls: unknown[] = [];
  const cleanup = activate({
    registerQuestionType(value) { calls.push(value); return () => { calls.push("question disposed"); }; },
    registerInstructions(value) { calls.push(value); return () => { calls.push("instructions disposed"); }; },
  } as PluginBackendContext);
  const registered = calls[0] as PluginQuestionTypeDefinition;
  assert.equal(typeof registered.gradeAnswer, "function");
  const { gradeAnswer: _grader, ...rest } = registered;
  assert.deepEqual(rest, definition);
  assert.deepEqual(calls[1], { agents: ["teacher"], text: instructions });
  assert.equal(definition.teach.toolName, "coding_question");
  assert.equal("probe" in definition, false);
  assert.equal("execute" in definition, false);
  assert.equal(definition.showThinking, true);
  assert.equal("validateAnswer" in definition, false);
  cleanup();
  assert.deepEqual(calls.slice(2), ["instructions disposed", "question disposed"]);
});

test("optional/empty starter code and arbitrary language, not a restricted language enum", () => {
  for (const value of [{ language: "Python", tests }, { language: "unknown-language", starterCode: "", tests }, { language: "C++", starterCode: "  int x;\r\n", tests }]) assert.equal(question.Check(value), true);
  for (const value of [{}, { language: " \n", tests }, { language: 4, tests }, { language: "js", starterCode: null, tests }, { language: "js", hiddenReference: "no", tests }]) assert.equal(question.Check(value), false);
});

test("new questions require a literal program/args/code test recipe, without adding a runtime catalog", () => {
  for (const recipe of [tests, { program: "/path with spaces/custom-runtime", args: ["--stdin", "a b", "$(literal)"], code: "some test program" }]) {
    assert.equal(question.Check({ language: "any-language", tests: recipe }), true);
  }
  for (const recipe of [undefined, null, {}, { args: [], code: "test" }, { program: " \n", args: [], code: "test" }, { program: "node", code: "test" }, { program: "node", args: [1], code: "test" }, { program: "node", args: [], code: " \n" }, { ...tests, install: "something" }]) {
    assert.equal(question.Check({ language: "Python", tests: recipe }), false);
  }
  assert.match(instructions, /answer\.txt/);
  assert.match(instructions, /standard input/);
  assert.doesNotMatch(instructions, /version.check.*tool/i);
});

test("grader recipe narrowing preserves literal strings/arguments and rejects unavailable input", () => {
  const recipe = { program: "/a path/runtime", args: ["-", "$literal", ""], code: "  exact test\r\n\n" };
  Object.freeze(recipe.args);
  Object.freeze(recipe);
  assert.deepEqual(readTests({ language: "anything", tests: recipe }), recipe);
  for (const payload of [undefined, null, [], {}, { tests: null }, { tests: false }, { tests: {} }, { tests: { ...recipe, program: " \n" } }, { tests: { ...recipe, args: [1] } }, { tests: { ...recipe, code: " \n" } }]) assert.throws(() => readTests(payload), /unavailable|invalid/);
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
