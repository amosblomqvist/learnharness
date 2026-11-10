import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { it } from "node:test";

it("generated plugin API declarations are portable and usable as type-only imports", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-types-test-"));
	try {
		const output = path.join(home, "api");
		const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 120_000 });
		assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
		assert.ok(fs.existsSync(path.join(output, "src", "core", "plugins.d.ts")));
		assert.equal(fs.existsSync(path.join(output, "src", "server")), false, "No server implementation is part of the API tree");
		// An author supplies the declared peer dependencies. This symlink is
		// test-local, not a generated SDK reference to the source checkout.
		fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
		const consumer = path.join(home, "consumer.mts");
		fs.writeFileSync(consumer, `
import type { PluginBackendContext, PluginFrontendContext, PluginActionShortcut, PluginAgentTool, PluginMarkdownProps, PluginBadgeProps, GraphNode, GraphSnapshot } from "./api/index.d.ts";
declare const backend: PluginBackendContext;
declare const frontend: PluginFrontendContext;
declare const container: HTMLElement;
const markdownProps: PluginMarkdownProps = { text: "**Host rendering**" };
const markdown = frontend.ui.mountMarkdown(container, markdownProps, { signal: frontend.signal });
markdown.update({ text: "Replacement" });
markdown.dispose();
// @ts-expect-error Markdown source is a string, not a React element or arbitrary data.
frontend.ui.mountMarkdown(container, { text: 123 }, { signal: frontend.signal });
// @ts-expect-error Every renderer requires an explicit mount lifetime.
frontend.ui.mountMarkdown(container, markdownProps);
// @ts-expect-error Static rendering exposes no streaming or interactive-control options.
markdown.update({ streaming: true });
const badgeProps: PluginBadgeProps = { text: "Tests passed", color: "var(--plugin-accent)" };
const badge = frontend.ui.mountBadge(container, badgeProps, { signal: frontend.signal });
badge.update({ text: "Anything", color: "#123456" });
badge.update({ color: undefined });
badge.dispose();
frontend.ui.mountBadge(container, { text: "Neutral" }, { signal: frontend.signal });
// @ts-expect-error Badge text is required.
frontend.ui.mountBadge(container, { color: "red" }, { signal: frontend.signal });
// @ts-expect-error Badge content is plain text.
badge.update({ text: document.createElement("span") });
// @ts-expect-error A badge has one color with an automatic tint, not separate background control.
badge.update({ background: "red" });
// @ts-expect-error Badges do not interpret grades or statuses.
badge.update({ status: "correct" });
// @ts-expect-error Widget mounts require a lifetime.
frontend.ui.mountBadge(container, { text: "Missing lifetime" });
const stop = backend.handle("test", async () => backend.learning.listSessions());
backend.registerInstructions({ agents: ["teacher", "practice"], text: "Use the example tool when asked." });
backend.registerTools({ agents: ["teacher"], create: context => [{
  name: "example_echo", label: "Echo", description: "Echo a fixture", parameters: {type:"object", properties:{}},
  execute: async () => ({content:[{type:"text", text:context.chatId}], details:{agent:context.agent}})
}] });
frontend.registerCodeBlock({ language:"example", mount:(el, block) => { el.textContent=block.source; void block.signal; } });
frontend.registerToolRenderer({ toolName:"example_echo", mount:(el, tool) => { el.textContent=tool.state; void tool.result?.content; void tool.background?.taskId; } });
backend.workers.register({ id:"note", instructions:"Write a note", resultSchema:{type:"string"}, validateResult:(result, task)=>{ void result; void task.input; } });
const task = backend.workers.start("note", {requestId:"source:chunk:1", input:{source:"fixture"}, prompt:"Write it", model:{provider:"fixture", id:"fixture"}, purpose:"background", maxTurns:3});
const outcome = await backend.workers.wait(task.id);
if (outcome.status === "succeeded") {
  // @ts-expect-error result is validated JSON, not an untyped property bag
  outcome.result.foo;
} else outcome.error.code;
backend.registerTools({ agents:["teacher"], create:context=>[backend.createBackgroundTool(context, {
  name:"example_worker", label:"Example", description:"Example", parameters:{type:"object", properties:{}}, workerId:"note",
  prepare:()=>({input:null, prompt:"Write it", model:{provider:"fixture", id:"fixture"}, maxTurns:3}),
  format:outcome=>({text:outcome.status === "succeeded" ? "Ready" : outcome.error.message})
})] });
// @ts-expect-error workers require an explicit model-call turn budget
backend.workers.start("note", {requestId:"missing-budget", input:null, prompt:"Write it", model:{provider:"fixture", id:"fixture"}, purpose:"background"});
const snapshot: GraphSnapshot = backend.learning.graph();
const node: GraphNode | undefined = backend.learning.readGraphFile("nodes.jsonl")[0];
// @ts-expect-error A typed graph ledger is not an unvalidated arbitrary record.
const wrong: number = node?.statement;
void [snapshot, node, wrong];
frontend.registerView({ id: "view", name: "View", mount: (el) => { el.textContent = "Plugin"; return () => el.replaceChildren(); } });
const shortcut: PluginActionShortcut = { scope: { sessions: ["teaching", "practice"], views: ["board"] }, defaultBinding: "mod+shift+d" };
frontend.registerAction({ id:"draw", name:"Draw", shortcut, run(context) {
  if (context.placement === "keyboard") {
    if (context.surface === "session") {
      const draft: string = context.view.composer.text;
      // @ts-expect-error Session view data stays readonly through keyboard invocation.
      context.view.composer.text = "mutated";
      void [draft, context.surfaceTarget, context.kind];
    } else if (context.surface === "plugin-view") void [context.pluginId, context.viewId];
    else {
      const pathname: string = context.pathname;
      // @ts-expect-error Other-page keyboard context must not fabricate a session.
      context.sessionId;
      void pathname;
    }
  }
} });
frontend.registerAction({ id:"global", name:"Global", shortcut: { scope:"app" }, run() {} });
// @ts-expect-error No implicit global scope.
const missingScope: PluginActionShortcut = { defaultBinding:"mod+j" };
// @ts-expect-error Only native session kinds are accepted.
const wrongScope: PluginActionShortcut = { scope:{ sessions:["quiz"] } };
void [missingScope, wrongScope];
const input: PluginAgentTool = { kind: "input", name: "ask", description: "Ask", parameters: {type:"string"} };
// @ts-expect-error Input tools must not silently ignore an execute callback.
const invalid: PluginAgentTool = { kind: "input", name: "ask", description: "Ask", parameters: {type:"string"}, execute: async () => ({content:[], details:null}) };
void [stop, input, invalid];
`);
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--allowImportingTsExtensions", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 120_000 });
		assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
