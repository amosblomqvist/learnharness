/** Off-network external-plugin proof for the packaged server smoke. The package
 * is created AFTER the build, outside the source/standalone trees. No provider
 * credentials, real learning data, or source-tree imports are involved. */
import * as fs from "node:fs";
import * as path from "node:path";

export const PLUGIN_KNOWLEDGE_FIXTURE = Object.freeze({
	sourceId: "src_plugin_knowledge_smoke", chainId: "arg_plugin_knowledge_smoke",
	premiseId: "n_plugin_knowledge_premise", conclusionId: "n_plugin_knowledge_conclusion",
	sourceLabel: "Plugin knowledge proof",
});

export const PLUGIN_PICKER_SETTINGS_FIXTURE = Object.freeze({ id: "native-smoke-picker-settings", name: "Picker settings proof" });

export function createPluginSmokeFixture(home) {
	const directory = path.join(home, "data", "plugins", "native-smoke");
	fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
	fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
		apiVersion: 1, id: "native-smoke", name: "Runtime proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js", backend: "backend.cjs",
	}));
	fs.writeFileSync(path.join(directory, "backend.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
exports.activate = async (ctx) => {
  // An activation-owned LOOPBACK provider, never a real account or model.
  // Hold the protocol open without returning any tokens or terminal response.
  const held = new Set();
  const sockets = new Set();
  const counts = { requests: 0, active: 0, peak: 0, aborted: 0, completed: 0, models: 0 };
  const requests = [];
  const taskIds = [];
  let mockBase;
  let cleanupPromise;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      counts.models++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "admission-fixture", object: "model", owned_by: "loopback-fixture" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.once("end", () => {
      const input = JSON.parse(body);
      requests.push({ model: input.model, stream: input.stream, authenticated: Boolean(req.headers.authorization) });
      counts.requests++;
      held.add(res);
      counts.active = held.size;
      counts.peak = Math.max(counts.peak, counts.active);
      res.once("finish", () => { counts.completed++; });
      res.once("close", () => {
        held.delete(res);
        counts.active = held.size;
        if (!res.writableFinished) counts.aborted++;
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  ctx.cleanup(() => cleanupPromise ??= (async () => {
    // Retained handles only: destroy held responses and keep-alive sockets,
    // then await the one close. No process/name killing or leaked listeners.
    for (const response of held) response.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.removeAllListeners();
    fs.writeFileSync(path.join(ctx.dataDirectory, "disabled.txt"), "cleaned");
  })());
  await new Promise((resolve, reject) => {
    const failed = error => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  });
  mockBase = "http://127.0.0.1:" + server.address().port + "/v1";
  ctx.workers.register({
    id: "admission-proof",
    instructions: "Offline admission fixture. Do not use external services. Submit the requested result.",
    resultSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
  });
  const snapshot = () => ({
    mockBase, counts: { ...counts }, requests: requests.slice(),
    tasks: taskIds.map(id => { const task = ctx.workers.get(id); return { id: task.id, definitionId: task.definitionId, status: task.status, turns: task.turns, error: task.error }; })
  });
  ctx.handle("admission-status", snapshot);
  ctx.handle("admission-start", () => {
    if (taskIds.length) throw new Error("Admission fixture starts exactly one explicit batch per activation");
    for (let index = 0; index < 3; index++) {
      const task = ctx.workers.start("admission-proof", {
        requestId: "admission-proof-" + index, input: { index },
        prompt: "Return the fixture value using submit_result.",
        model: { provider: "custom", id: "admission-fixture" }, purpose: "background", maxTurns: 1
      });
      taskIds.push(task.id);
    }
    return snapshot();
  });
  fs.writeFileSync(path.join(ctx.dataDirectory, "activated.txt"), "native-node");
  ctx.registerInstructions({ agents: ["teacher"], text: "Packaged smoke fixture: no automatic model requests." });
  ctx.registerTools({ agents: ["teacher"], create: () => [{
    name: "native_smoke_echo", label: "Native smoke echo", description: "Offline runtime fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (_id, input) => ({ content: [{ type: "text", text: input.value }], details: input })
  }] });
  ctx.handle("proof", (input) => ({ answer: input, node: process.versions.node, data: ctx.dataDirectory, learning: ctx.learning.directory }));
};
`);
	const helper = `
export const message = "External module loaded";
export function mountPickerProof(ctx, container, signal, scope, mountCount) {
  const root = document.createElement("div"); root.dataset.smokePickerScope = scope;
  root.dataset.mountCount = String(mountCount);
  root.dataset.instance = scope + ":" + mountCount;
  root.dataset.signalAborted = String(signal.aborted); root.dataset.cleanupCount = "0";
  signal.addEventListener("abort", () => { root.dataset.signalAborted = "true"; }, { once: true });
  container.append(root);
  const input = document.createElement("input"); input.type = "text";
  input.dataset.smokePickerDraft = scope; input.setAttribute("aria-label", scope + " picker draft"); root.append(input);
  const menuTrigger = document.createElement("button"); menuTrigger.type = "button";
  menuTrigger.dataset.smokePickerMenu = scope; menuTrigger.textContent = "Open owned menu"; root.append(menuTrigger);
  root.dataset.menuCloses = "0";
  menuTrigger.addEventListener("click", () => ctx.ui.openMenu(menuTrigger, {
    label: scope + " owned menu", items: [{ key: "proof", label: "Owned menu item", onSelect() {} }],
    onClose() { root.dataset.menuCloses = String(Number(root.dataset.menuCloses) + 1); }
  }, { signal }));
  const state = document.createElement("p"); state.dataset.smokePickerSelection = scope;
  state.dataset.callbacks = "0"; state.textContent = "[]"; root.append(state);
  let value = [];
  const picker = ctx.ui.mountKnowledgePicker(root, {
    value,
    onChange(ids) {
      value = ids; picker.update({ value }); state.textContent = JSON.stringify(value);
      state.dataset.callbacks = String(Number(state.dataset.callbacks) + 1);
    }
  }, { signal });
  return () => { root.dataset.cleanupCount = String(Number(root.dataset.cleanupCount) + 1); root.remove(); };
}
`;
	fs.writeFileSync(path.join(directory, "assets", "helper.js"), helper);
	fs.writeFileSync(path.join(directory, "main.js"), `
import { message, mountPickerProof } from "./assets/helper.js";
export function activate(ctx) {
  let dialogMounts = 0;
  ctx.registerCodeBlock({ language: "smoke-note", mount(container, block) {
    container.dataset.smokeFence = "true"; container.dataset.smokeMeta = block.meta;
    container.textContent = "Rendered fence: " + block.source;
    return () => container.replaceChildren();
  }});
  ctx.registerToolRenderer({ toolName: "native_smoke_echo", backgroundPresentation: "plain", mount(container, tool) {
    container.dataset[tool.background ? "smokeBackground" : "smokeTool"] = "true";
    container.textContent = (tool.background ? "Rendered worker: " : "Rendered tool: ") + tool.output.value;
    return () => container.replaceChildren();
  }});
  ctx.registerAction({ id: "open", name: "Runtime proof", run: () => ctx.app.openView("proof") });
  ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" });
  ctx.placeAction({ id: "open-graph", actionId: "open", location: "graph" });
  ctx.placeAction({ id: "open-session", actionId: "open", location: "top-bar", sessions: ["teaching", "practice"] });
  for (let index = 0; index < 32; index++) {
    ctx.placeAction({ id: "rail-" + index, actionId: "open", location: "graph" });
    if (index < 8) {
      ctx.placeAction({ id: "sidebar-" + index, actionId: "open", location: "sidebar" });
      ctx.placeAction({ id: "session-" + index, actionId: "open", location: "top-bar", sessions: ["teaching", "practice"] });
    }
  }
  const row = { key: "proof", label: "Fixture toggle", type: "toggle", value: false, onChange(value) { settings.update({ rows: [{ ...row, value }] }); } };
  const settings = ctx.registerSettings({ rows: [row] });
  ctx.registerView({ id: "proof", name: "Runtime proof", async mount(container, signal) {
    const heading = document.createElement("h1"); heading.textContent = message; container.append(heading);
    const controls = document.createElement("div"); container.append(controls);
    const selection = document.createElement("p"); selection.dataset.smokeKnowledgeState = "true";
    selection.dataset.callbacks = "0"; selection.textContent = "[]"; container.append(selection);
    let picked = [];
    const knowledge = ctx.ui.mountKnowledgePicker(controls, {
      value: picked,
      onChange(ids) {
        picked = ids;
        knowledge.update({ value: picked });
        selection.textContent = JSON.stringify(picked);
        selection.dataset.callbacks = String(Number(selection.dataset.callbacks) + 1);
      }
    }, { signal });
    ctx.ui.mountButton(controls, { label: "Open host dialog", title: "Open host dialog", onClick: () => { ctx.ui.openDialog({ title: "Plugin dialog proof", content: (body) => { body.textContent = "Host dialog content"; } }, { signal }); } }, { signal });
    ctx.ui.mountButton(controls, { label: "Open knowledge dialog", title: "Open knowledge dialog", onClick: () => {
      ctx.ui.openDialog({ title: "Picker dialog proof", content: (body, dialogSignal) => mountPickerProof(ctx, body, dialogSignal, "dialog", ++dialogMounts) }, { signal });
    } }, { signal });
    let draft = "";
    const composerProps = () => ({ value: draft, onChange(value) { draft = value; widget.update({ composer: composerProps() }); }, onSend() { const sent = document.createElement("p"); sent.dataset.smokeSubmitted = "true"; sent.textContent = draft; container.append(sent); draft = ""; widget.update({ composer: composerProps() }); }, placeholder: "Plugin composer proof" });
    const widget = ctx.ui.mountStandardComposer(controls, { composer: composerProps(), model: { value: undefined, onChange() {} }, thinking: { model: undefined, value: undefined, onChange() {} }, dictation: { onTranscript(text) { draft = (draft + " " + text).trim(); widget.update({ composer: composerProps() }); } } }, { signal });
    const result = await ctx.call("proof", "browser-bridge");
    if (ctx.signal.aborted) return;
    const body = document.createElement("p"); body.textContent = result.answer; container.append(body);
    return () => container.replaceChildren();
  }});
}
`);
	// Separate frontend-only custom Settings page: preserve native-smoke's
	// existing schema registration/update-handle proof, without host injection.
	const settingsFixture = PLUGIN_PICKER_SETTINGS_FIXTURE;
	const settingsDirectory = path.join(home, "data", "plugins", settingsFixture.id);
	fs.mkdirSync(path.join(settingsDirectory, "assets"), { recursive: true });
	fs.writeFileSync(path.join(settingsDirectory, "manifest.json"), JSON.stringify({
		apiVersion: 1, id: settingsFixture.id, name: settingsFixture.name,
		version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
	}));
	fs.writeFileSync(path.join(settingsDirectory, "assets", "helper.js"), helper);
	fs.writeFileSync(path.join(settingsDirectory, "main.js"), `
import { mountPickerProof } from "./assets/helper.js";
export function activate(ctx) {
  let mounts = 0;
  ctx.registerSettings((container, signal) => mountPickerProof(ctx, container, signal, "settings", ++mounts));
}
`);
	fs.mkdirSync(path.join(directory, "data"), { recursive: true });
	fs.writeFileSync(path.join(directory, "data", "private.json"), '{"private":true}\n');
	// Seed native history; the later admission proof only opens held LOOPBACK
	// protocol requests. No model generation or external provider calls occur.
	// Browser proof exercises the SAME shared Markdown/tool surfaces as lessons.
	const chats = path.join(home, "data", "chats");
	fs.mkdirSync(chats, { recursive: true });
	fs.writeFileSync(path.join(chats, "chat_plugin_smoke.json"), JSON.stringify({
		version: 1, id: "chat_plugin_smoke", title: "Plugin transcript proof",
		createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
		messages: [
			{ id: "user_smoke", role: "user", content: "Show the stored plugin rendering fixture.", timestamp: 1 },
			{ id: "assistant_smoke", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
				content: [
					{ type: "text", text: "```smoke-note proof=1\nFence source.\n```" },
					{ type: "toolCall", id: "call_smoke", name: "native_smoke_echo", arguments: { value: "Stored input" } },
				], stopReason: "toolUse", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
			{ id: "result_smoke", role: "toolResult", toolCallId: "call_smoke", toolName: "native_smoke_echo",
				content: [{ type: "text", text: "Stored native result" }], details: { value: "Tool detail" }, isError: false, timestamp: 3 },
			{ id: "steer_job_plugin_smoke", role: "custom", customType: "subagent-steer", display: true,
				content: "A stored fixture worker finished; no real model was called.", timestamp: 4,
				details: { jobId: "job_plugin_smoke", kind: "plugin", toolCallId: "call_smoke", result: {
					pluginId: "native-smoke", toolName: "native_smoke_echo", input: { value: "Stored input" },
					outcome: { id: "task_smoke", status: "succeeded", result: { value: "Worker detail" } },
					text: "Stored worker result", data: { value: "Worker detail" },
				} },
			},
		],
	}, null, 2));
	// Inert graph truth is seeded by the HOST fixture before boot, never by
	// plugin code. The caller must set LH_DATA_DIR to this disposable home/data
	// (as smoke-server.mjs does). Exclusive writes refuse existing graph data.
	const graph = path.join(home, "data", "graph");
	fs.mkdirSync(graph, { recursive: true });
	const fixture = PLUGIN_KNOWLEDGE_FIXTURE;
	const createdAt = "2026-11-01T00:00:00.000Z";
	const provenance = [{ chatId: fixture.sourceId, messageId: "" }];
	const nodes = [
		{ id: fixture.premiseId, name: "Fixture premise", statement: "This is an inert picker premise.", aliases: [], createdAt, provenance },
		{ id: fixture.conclusionId, name: "Fixture conclusion", statement: "This is an inert picker conclusion.", aliases: [], createdAt, provenance },
	];
	fs.writeFileSync(path.join(graph, "nodes.jsonl"), nodes.map(node => JSON.stringify(node)).join("\n") + "\n", { flag: "wx" });
	fs.writeFileSync(path.join(graph, "chains.jsonl"), JSON.stringify({ id: fixture.chainId, premises: [fixture.premiseId], conclusion: fixture.conclusionId, createdAt, provenance }) + "\n", { flag: "wx" });
	fs.writeFileSync(path.join(graph, "sources.json"), JSON.stringify({ [fixture.sourceId]: { id: fixture.sourceId, filePath: fixture.sourceLabel + ".md", importedAt: createdAt } }) + "\n", { flag: "wx" });
	return directory;
}

export async function verifyPluginServer(url, home, headers = {}) {
	const directory = path.join(home, "data", "plugins", "native-smoke");
	const activated = path.join(directory, "data", "activated.txt");
	const disabled = path.join(directory, "data", "disabled.txt");
	const jsonRequest = async (route, method, body, expected = 200) => {
		const response = await fetch(url + route, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		const payload = await response.json();
		if (response.status !== expected) throw new Error(`${method} ${route}: ${response.status}: ${JSON.stringify(payload)}`);
		return payload;
	};
	const listing = await (await fetch(url + "/api/plugins", { headers })).json();
	const plugin = listing.plugins?.find((item) => item.id === "native-smoke");
	if (!plugin || plugin.enabled || plugin.status !== "disabled") throw new Error("External plugins must be discovered disabled without executing code");
	if (fs.existsSync(activated)) throw new Error("Disabled plugin backend was evaluated");
	await jsonRequest("/api/plugins/native-smoke", "PUT", { enabled: true });
	const proof = await jsonRequest("/api/plugins/native-smoke/call", "POST", { operation: "proof", input: "packaged-runtime" });
	if (proof.result?.answer !== "packaged-runtime" || !proof.result.node || proof.result.data !== path.join(directory, "data") || proof.result.learning !== path.join(home, "data")) throw new Error("Native backend/context/bridge proof failed");
	if (!fs.existsSync(activated)) throw new Error("Native backend did not activate");
	const admission = await jsonRequest("/api/plugins/native-smoke/call", "POST", { operation: "admission-status" });
	if (admission.result?.tasks?.length !== 0 || admission.result?.counts?.requests !== 0 || admission.result?.counts?.active !== 0) throw new Error("Plugin activation must not automatically start worker/model requests");
	const mock = new URL(admission.result.mockBase);
	if (mock.protocol !== "http:" || mock.hostname !== "127.0.0.1" || mock.pathname !== "/v1" || !mock.port) throw new Error("Fixture mock must bind an ephemeral loopback endpoint");
	for (const asset of ["main.js", "assets/helper.js"]) {
		const response = await fetch(`${url}/api/plugins/native-smoke/assets/${asset}`, { headers });
		if (response.status !== 200 || !response.headers.get("content-type")?.includes("javascript")) throw new Error(`Frontend module unavailable: ${asset}`);
	}
	for (const asset of ["backend.cjs", "manifest.json", "data/private.json"]) {
		const response = await fetch(`${url}/api/plugins/native-smoke/assets/${asset}`, { headers });
		if (response.ok) throw new Error(`Private package file exposed as asset: ${asset}`);
	}
	await jsonRequest("/api/plugins/native-smoke", "PUT", { enabled: false });
	if (!fs.existsSync(disabled) || !fs.existsSync(path.join(directory, "data", "private.json"))) throw new Error("Disable failed cleanup or deleted plugin data");
	// Do not configure this activation's URL: browser enable creates a fresh
	// ephemeral listener. Disable must await closure of the retained handle.
	let mockStillListening = false;
	try {
		const response = await fetch(mock + "/models", { signal: AbortSignal.timeout(2_000) });
		await response.text();
		mockStillListening = true;
	} catch { /* Connection refusal/abort is expected after cooperative cleanup. */ }
	if (mockStillListening) throw new Error("Disabled plugin leaked its loopback mock listener");
	const stopped = await fetch(url + "/api/plugins/native-smoke/call", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ operation: "proof" }) });
	if (stopped.ok) throw new Error("Disabled plugin accepted operations");
	console.log("[smoke-server] external plugin: disabled discovery → native backend/bridge/assets + idle loopback fixture → cooperative disable closes mock; data preserved");
}
