import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginQuestionGradingContext, PluginQuestionTypeDefinition, JsonValue } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { CodingQuestionPayload } from "../src/contract.ts";
import { readTestResult } from "../src/test-result.ts";

type SavedPayload = Omit<CodingQuestionPayload, "modelSolution"> & { modelSolution?: string };

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const testCode = `
const fs = require('node:fs');
const vm = require('node:vm');
const scope = {};
vm.runInNewContext(fs.readFileSync('answer.txt', 'utf8'), scope);
if (scope.square(3) !== 9) { console.error('Expected square(3) to equal 9'); process.exitCode = 1; }
else console.log('Supplied test passed');
`;

test("public registered grader executes the supplied recipe after submission, returns observations and honors the host signal", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "coding-backend-test-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let grade!: (context: PluginQuestionGradingContext<SavedPayload, string>) => JsonValue | Promise<JsonValue>;
  let disposed = 0;
  const cleanup = activate({
    dataDirectory,
    registerQuestionType(value: PluginQuestionTypeDefinition) { assert.equal(typeof value.gradeAnswer, "function"); grade = value.gradeAnswer!; return () => { disposed++; }; },
    registerProblemType() { return () => { disposed++; }; },
    registerInstructions() { return () => { disposed++; }; },
  } as unknown as PluginBackendContext);
  const controller = new AbortController();
  // Existing pending snapshots without a model solution must still grade.
  const payload: SavedPayload = { language: "JavaScript", tests: { program: process.execPath, args: ["-"], code: testCode } };
  const context: PluginQuestionGradingContext<SavedPayload, string> = {
    chatId: "fixture", questionId: "question-backend", variant: "teach", contractVersion: 1,
    input: freeze({ type: "predict", nodeId: "fixture-node", question: "Implement square", payload }),
    answer: "  function square(x) { return x * x; }  \n\n", signal: controller.signal,
  };
  const passed = readTestResult(await grade(context));
  assert.equal(passed?.status, "passed");
  assert.equal(passed?.exitCode, 0);
  assert.equal(passed?.stdout, "Supplied test passed\n");
  assert.equal(context.answer, "  function square(x) { return x * x; }  \n\n");
  assert.deepEqual(await readdir(path.join(dataDirectory, "test-runs", context.questionId)), []);

  const withSolution = readTestResult(await grade({ ...context, input: { ...context.input, payload: { ...payload, modelSolution: "```js\nthrow new Error('Model solution must never run');\n```" } } }));
  assert.equal(withSolution?.status, "passed");
  assert.equal(withSolution?.stdout, passed.stdout);

  const failed = readTestResult(await grade({ ...context, answer: "function square(x) { return x; }" }));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.exitCode, 1);
  assert.match(failed!.stderr, /Expected square\(3\) to equal 9/);

  const unavailable = readTestResult(await grade({ ...context, input: { ...context.input, payload: { ...payload, tests: { ...payload.tests, program: "coding-missing-program-backend-fixture" } } } }));
  assert.equal(unavailable?.status, "error");
  assert.equal(unavailable?.exitCode, null);
  assert.match(unavailable!.message!, /launch/i);

  controller.abort();
  await assert.rejects(Promise.resolve().then(() => grade(context)), { name: "AbortError" });
  cleanup();
  assert.equal(disposed, 4);
});
