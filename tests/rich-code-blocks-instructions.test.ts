import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import type { PluginInference, PluginLearningData } from "../src/core/plugins.ts";
import { FAMILIES, INSTRUCTIONS, type Family } from "../plugins/rich-code-blocks/src/contract.ts";

// Redirect storage before importing the host/agents. No provider or user data is used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-instructions-"));
process.env.LH_DATA_DIR = path.join(root, "app-data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in Rich code blocks instruction tests"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
const { createPluginHost } = await import("../src/server/plugin-host.ts");
const { createProberAgent, createTeacherAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");

test("actual Rich code blocks backend appends enabled-family instructions to every lesson role, including probing", async t => {
  const directory = path.join(root, "plugins");
  const dist = path.join(directory, "rich-code-blocks", "dist");
  fs.mkdirSync(dist, { recursive: true });
  const source = path.resolve("plugins/rich-code-blocks");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  // Import the actual backend source through the test's TS loader, not an old dist build.
  fs.writeFileSync(path.join(dist, "backend.cjs"), `exports.activate = async ctx => (await import(${JSON.stringify(pathToFileURL(path.join(source, "src/backend.ts")).href)})).activate(ctx);`);
  fs.writeFileSync(path.join(dist, "main.js"), "export function activate() {}");
  fs.copyFileSync(path.join(source, "src/styles.css"), path.join(dist, "styles.css"));
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  const host = createPluginHost({ directory, appVersion: manifest.minAppVersion, createServices: () => ({
    learning: {} as PluginLearningData, inference: {} as PluginInference,
    agents: { dispose: async () => {} } as PluginAgentService,
    workers: { dispose: async () => {} } as PluginWorkerService,
    createBackgroundTool() { throw new Error("Unexpected background tool"); },
  }) });
  t.after(() => host.dispose());
  await host.initialize();
  await host.setEnabled("rich-code-blocks", true);
  assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
  const faux = createFauxCore({});
  const builders = {
    prober: (opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId } as never, opts),
    teacher: (opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
    practice: (opts: AgentBuildOptions) => createPracticeAgent({ chatId: opts.chatId, chatStore: { getChat: () => null } } as never, opts),
  };
  function assertPrompts(enabled: readonly Family[]) {
    for (const [role, build] of Object.entries(builders)) {
      const opts: AgentBuildOptions = { chatId: `synthetic-${role}`, engine: { model: faux.getModel(), streamFn: faux.streamSimple }, toolToggles: { research: false, pdf: false } };
      const builtin = build(opts), extended = build({ ...opts, pluginContributions: host.agentContributions });
      assert.equal(extended.state.systemPrompt, [builtin.state.systemPrompt, ...enabled.map(family => INSTRUCTIONS[family])].join("\n\n---\n\n"), role);
      assert.deepEqual(extended.state.tools.map(tool => tool.name), builtin.state.tools.map(tool => tool.name), `${role}: renderer instructions do not change native tools`);
      for (const family of FAMILIES) assert.equal(extended.state.systemPrompt.includes(INSTRUCTIONS[family]), enabled.includes(family), `${role}: ${family}`);
    }
  }
  assertPrompts([]);
  for (const family of FAMILIES) await host.call("rich-code-blocks", "set-family", { family, enabled: true });
  assertPrompts(FAMILIES);
  const running = createProberAgent({ chatId: "already-running" } as never, { chatId: "already-running", engine: { model: faux.getModel(), streamFn: faux.streamSimple }, pluginContributions: host.agentContributions });
  const capturedPrompt = running.state.systemPrompt;
  for (let index = 0; index < FAMILIES.length; index++) {
    await host.call("rich-code-blocks", "set-family", { family: FAMILIES[index], enabled: false });
    assertPrompts(FAMILIES.slice(index + 1));
    assert.equal(running.state.systemPrompt, capturedPrompt, "Settings changes affect future turns, not an already-built agent");
  }
  await host.call("rich-code-blocks", "set-family", { family: "technicalDiagrams", enabled: true });
  await host.setEnabled("rich-code-blocks", false);
  assertPrompts([]);
  await host.setEnabled("rich-code-blocks", true);
  assertPrompts(["technicalDiagrams"]);
  assert.equal(faux.state.callCount, 0, "Prompt construction and activation never call a model");
});
