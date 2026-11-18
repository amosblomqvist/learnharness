import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { PluginBackendContext } from "../src/core/plugins.ts";
import { createPluginHost } from "../src/server/plugin-host.ts";
import { pluginProblemTools } from "../src/agent/plugin-problem-tools.ts";
import { problemTool, concludeTool } from "../src/agent/tools/practice.ts";
import { activeProblemOf, type LhMessage } from "../src/core/native-messages.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-problems-")), directory = path.join(root, "plugins"), dist = path.join(directory, "example", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "example", name: "Example", version: "1.0.0", minAppVersion: "0.4.0", backend: "backend.cjs" }));
  fs.writeFileSync(path.join(dist, "backend.cjs"), "exports.activate = ctx => { ctx.handle('context', () => ctx); };");
  const host = createPluginHost({ directory, appVersion: "0.4.1", createServices: () => ({ learning: {}, inference: {}, agents: { dispose: async () => {} }, workers: { dispose: async () => {} }, createBackgroundTool() { throw Error("Unexpected background tool"); } }) as never });
  t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await host.initialize(); await host.setEnabled("example", true);
  return { host, ctx: await host.call("example", "context") as PluginBackendContext };
}
const definition = () => ({ id: "code", label: "Coding problem", contractVersion: 1, tool: { toolName: "code_problem", description: "Pose code" }, problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String() });
const input = { statement: "Implement f", mode: "composition", modelSolution: "return 1", payload: { starter: "function f() {}" } };

test("practice-only registrations preserve package atomicity and reject builtin collisions", async t => {
  const { host, ctx } = await fixture(t);
  const off = ctx.registerProblemType({ ...definition(), tool: { toolName: "problem", description: "Collision" } });
  ctx.registerInstructions({ agents: ["practice"], text: "Do not leak a rejected package" });
  assert.deepEqual(host.agentContributions({ chatId: "chat", agent: "practice" }, ["problem", "conclude"]), { instructions: [], tools: [] });
  assert.match(host.list()[0]!.error!, /collision/); off(); ctx.registerProblemType(definition());
  const contributions = host.agentContributions({ chatId: "chat", agent: "practice" }, ["problem", "conclude"]);
  assert.equal(contributions.problemTypes?.length, 1); assert.equal(host.list()[0]!.error, undefined);
  for (const agent of ["prober", "teacher"] as const) assert.equal(host.agentContributions({ chatId: "chat", agent }, []).problemTypes, undefined);
});

test("unregister aborts exact registration ownership without reviving captured callbacks", async t => {
  const { host, ctx } = await fixture(t), off = ctx.registerProblemType(definition());
  const captured = host.resolveProblemType("example", "code", 1);
  assert.equal(captured.status, "available"); if (captured.status !== "available") return;
  off(); assert.equal(captured.signal.aborted, true); assert.throws(() => captured.requireActive());
  ctx.registerProblemType(definition()); off();
  assert.equal(host.resolveProblemType("example", "code", 1).status, "available");
  assert.throws(() => captured.requireActive());
  assert.equal(host.resolveProblemType("example", "code", 2).status, "unavailable");
  await host.setEnabled("example", false);
  assert.equal(host.resolveProblemType("example", "code", 1).status, "unavailable");
});

test("native and plugin poses atomically share one gate and the existing conclude tool", async t => {
  const { host, ctx } = await fixture(t); ctx.registerProblemType(definition());
  const contributions = host.agentContributions({ chatId: "chat", agent: "practice" }, []), gate = { problemActive: false };
  const plugin = pluginProblemTools(contributions.problemTypes!, "chat", gate)[0]!;
  const result = await plugin.execute("code-call", input);
  assert.equal(gate.problemActive, true); assert.equal((result as { terminate?: boolean }).terminate, true);
  const native = problemTool(gate);
  const refused = await native.execute("native-call", { statement: "Native", mode: "recall", modelSolution: "x" });
  assert.equal(refused.isError, true);
  const messages = [{ id: "pose", role: "assistant", content: [{ type: "toolCall", id: "code-call", name: "code_problem", arguments: input }] },
    { id: "ack", role: "toolResult", toolCallId: "code-call", toolName: "code_problem", ...result }] as unknown as LhMessage[];
  assert.equal(activeProblemOf(messages)?.pluginProblem?.typeId, "code");
  await concludeTool(gate).execute("end", { outcome: "solved", verdict: "Done", rung: null, missClass: null, retest: false });
  assert.equal(gate.problemActive, false);
  assert.equal((await native.execute("native-call", { statement: "Native", mode: "recall", modelSolution: "x" })).isError, undefined);
});

test("bad plugin authoring or graph targets never claim the shared problem gate", async t => {
  const { host, ctx } = await fixture(t); ctx.registerProblemType(definition());
  const gate = { problemActive: false }, contributions = host.agentContributions({ chatId: "chat", agent: "practice" }, []);
  const tool = pluginProblemTools(contributions.problemTypes!, "chat", gate, () => [{ id: "n", name: "Node" }])[0]!;
  assert.equal((await tool.execute("bad", { ...input, payload: { starter: 2 } })).isError, true); assert.equal(gate.problemActive, false);
  assert.equal((await tool.execute("bad-target", { ...input, target: ["absent"] })).isError, true); assert.equal(gate.problemActive, false);
  const prepared = tool.prepareArguments!({ ...input, target: ["Node"] });
  assert.deepEqual((prepared as { target: string[] }).target, ["n"]);
});
