import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { preparePluginProblemType, createPluginProblemParameters, validatePluginProblemInput, validatePluginProblemSubmission, readPluginProblemSnapshot } from "../src/core/plugin-problems.ts";
import { validatePluginSchema } from "../src/core/plugin-validation.ts";

const definition = () => preparePluginProblemType({ id: "code", label: "Coding problem", contractVersion: 1,
  tool: { toolName: "coding_problem", description: "Pose a coding practice problem." },
  problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String(),
});
const input = { statement: "Write a function.", mode: "composition", modelSolution: "function f() { return 1; }", payload: { starter: "function f() {}" } };
const snapshot = () => ({ protocolVersion: 1 as const, problemId: "problem-one", pluginId: "coding", typeId: "code", label: "Coding problem", contractVersion: 1,
  input, problemSchema: definition().problemSchema, submissionSchema: definition().submissionSchema, requiresSubmissionRefinement: false, requiresProcessing: false });

test("plugin problems keep native common fields and independently validate their payload", () => {
  const d = definition(), schema = validatePluginSchema(createPluginProblemParameters(d));
  assert.equal(schema.Check(input), true);
  for (const bad of [{ ...input, modelSolution: undefined }, { ...input, mode: "code" }, { ...input, payload: { starter: 1 } }, { ...input, target: [1] }, { ...input, extra: true }]) assert.equal(schema.Check(bad), false);
  const accepted = validatePluginProblemInput(d, { chatId: "chat", input });
  assert.equal(accepted.ok, true);
  if (accepted.ok) { assert.notEqual(accepted.value, input); assert.ok(Object.isFrozen(accepted.value.payload)); }
});

test("problem definitions freeze schemas, validate tool identities and reject async refinements", () => {
  const d = definition(); assert.ok(Object.isFrozen(d)); assert.ok(Object.isFrozen(d.problemSchema));
  assert.throws(() => preparePluginProblemType({ ...d, tool: { toolName: "bad.name", description: "D" } }));
  assert.throws(() => preparePluginProblemType({ ...d, validateSubmission: (async () => undefined) as never }));
  assert.throws(() => preparePluginProblemType({ ...d, contractVersion: 0 }));
});

test("saved problem contracts preserve finite JSON and freeze per-submission requirements", () => {
  const saved = readPluginProblemSnapshot(snapshot()); assert.ok(saved); assert.ok(Object.isFrozen(saved.input));
  assert.equal(readPluginProblemSnapshot({ ...snapshot(), protocolVersion: 2 }), null);
  assert.equal(readPluginProblemSnapshot({ ...snapshot(), input: { ...input, modelSolution: undefined } }), null);
  const exact = "  function f() {}\n\n";
  assert.deepEqual(validatePluginProblemSubmission(saved, { chatId: "chat", submission: exact }), { ok: true, value: exact });
  const boolean = readPluginProblemSnapshot({ ...snapshot(), submissionSchema: Type.Union([Type.Boolean(), Type.Null()]) })!;
  for (const value of [false, null]) assert.deepEqual(validatePluginProblemSubmission(boolean, { chatId: "chat", submission: value }), { ok: true, value });
  assert.equal(validatePluginProblemSubmission(saved, { chatId: "chat", submission: Infinity }).ok, false);
});

test("required submission refinements cannot be bypassed or retroactively added", () => {
  const d = preparePluginProblemType({ ...definition(), validateSubmission: ({ submission }) => submission === "allowed" ? undefined : ["Rejected"] });
  const saved = readPluginProblemSnapshot({ ...snapshot(), requiresSubmissionRefinement: true })!;
  assert.equal(validatePluginProblemSubmission(saved, { chatId: "chat", submission: "allowed" }).ok, false);
  assert.equal(validatePluginProblemSubmission(saved, { chatId: "chat", submission: "allowed" }, d).ok, true);
  assert.equal(validatePluginProblemSubmission(saved, { chatId: "chat", submission: "other" }, d).ok, false);
  assert.equal(validatePluginProblemSubmission(readPluginProblemSnapshot(snapshot())!, { chatId: "chat", submission: "other" }, d).ok, true);
});
