import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginProblemProcessingContext, PluginProblemTypeDefinition, JsonValue } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { CodingPayload } from "../src/contract.ts";
import { readTestResult } from "../src/test-result.ts";

test("practice processor observes repeated submissions, keeps thinking/solution separate, and cooperates with cancellation", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "coding-practice-test-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let processSubmission!: (context: PluginProblemProcessingContext<CodingPayload, string>) => JsonValue | Promise<JsonValue>;
  let disposed = 0;
  const cleanup = activate({
    dataDirectory,
    registerQuestionType() { return () => { disposed++; }; },
    registerProblemType(value: PluginProblemTypeDefinition) { processSubmission = value.processSubmission!; return () => { disposed++; }; },
    registerInstructions() { return () => { disposed++; }; },
  } as unknown as PluginBackendContext);
  t.after(() => { if (!disposed) cleanup(); });
  const payload: CodingPayload = {
    language: "JavaScript", starterCode: "function square(x) {}",
    tests: { program: process.execPath, args: ["-"], code: `const fs=require('node:fs'),vm=require('node:vm'),scope={};
const code=fs.readFileSync('answer.txt','utf8');
if(code.includes('PRIVATE_THINKING')||code.includes('PRIVATE_SOLUTION'))throw Error('Mixed input channels');
vm.runInNewContext(code,scope);
if(scope.square(3)!==9){console.error('Expected 9');process.exitCode=1;}else console.log('Test passed');` },
  };
  const input = Object.freeze({ statement: "Implement square", mode: "composition" as const, modelSolution: "```js\nthrow Error('PRIVATE_SOLUTION must never run');\n```", payload });
  const controller = new AbortController();
  const context: PluginProblemProcessingContext<CodingPayload, string> = {
    chatId: "fixture", problemId: "practice-same-problem", contractVersion: 1, input,
    submission: "  function square(x) { return x; }  \n\n", thinking: "PRIVATE_THINKING", signal: controller.signal,
  };
  const failed = readTestResult(await processSubmission(context));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.exitCode, 1);
  assert.match(failed!.stderr, /Expected 9/);
  const revised = "  function square(x) { return x * x; }  \n\n";
  const passed = readTestResult(await processSubmission({ ...context, submission: revised }));
  assert.equal(passed?.status, "passed");
  assert.equal(passed?.stdout, "Test passed\n");
  assert.equal(context.thinking, "PRIVATE_THINKING");
  assert.equal(context.submission, "  function square(x) { return x; }  \n\n");
  assert.equal("assessment" in passed!, false);
  assert.equal("correct" in passed!, false);
  const unavailable = readTestResult(await processSubmission({ ...context, input: { ...input, payload: { ...payload, tests: { ...payload.tests, program: "coding-practice-missing-program-fixture" } } } }));
  assert.equal(unavailable?.status, "error");
  assert.equal(unavailable?.exitCode, null);
  assert.match(unavailable!.message!, /launch/i);
  const pending = Promise.resolve(processSubmission({ ...context, input: { ...input, payload: { ...payload, tests: { ...payload.tests, code: "setInterval(()=>{},1000);" } } } }));
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, { name: "AbortError" }); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await readdir(path.join(dataDirectory, "test-runs", context.problemId)), []);
  await assert.rejects(Promise.resolve().then(() => processSubmission(context)), { name: "AbortError" });
  cleanup();
  assert.equal(disposed, 4);
});
