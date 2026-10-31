/** Off-network external-plugin proof for the packaged server smoke. The package
 * is created AFTER the build, outside the source/standalone trees. No provider
 * credentials, real learning data, or source-tree imports are involved. */
import * as fs from "node:fs";
import * as path from "node:path";

export function createPluginSmokeFixture(home) {
	const directory = path.join(home, "data", "plugins", "native-smoke");
	fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
	fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
		apiVersion: 1, id: "native-smoke", name: "Runtime proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js", backend: "backend.cjs",
	}));
	fs.writeFileSync(path.join(directory, "backend.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
exports.activate = (ctx) => {
  fs.writeFileSync(path.join(ctx.dataDirectory, "activated.txt"), "native-node");
  ctx.registerInstructions({ agents: ["teacher"], text: "Packaged smoke fixture: no automatic model requests." });
  ctx.registerTools({ agents: ["teacher"], create: () => [{
    name: "native_smoke_echo", label: "Native smoke echo", description: "Offline runtime fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (_id, input) => ({ content: [{ type: "text", text: input.value }], details: input })
  }] });
  ctx.handle("proof", (input) => ({ answer: input, node: process.versions.node, data: ctx.dataDirectory, learning: ctx.learning.directory }));
  ctx.cleanup(() => fs.writeFileSync(path.join(ctx.dataDirectory, "disabled.txt"), "cleaned"));
};
`);
	fs.writeFileSync(path.join(directory, "assets", "helper.js"), 'export const message = "External module loaded";\n');
	fs.writeFileSync(path.join(directory, "main.js"), `
import { message } from "./assets/helper.js";
export function activate(ctx) {
  ctx.registerCodeBlock({ language: "smoke-note", mount(container, block) {
    container.dataset.smokeFence = "true"; container.dataset.smokeMeta = block.meta;
    container.textContent = "Rendered fence: " + block.source;
    return () => container.replaceChildren();
  }});
  ctx.registerToolRenderer({ toolName: "native_smoke_echo", mount(container, tool) {
    container.dataset[tool.background ? "smokeBackground" : "smokeTool"] = "true";
    container.textContent = (tool.background ? "Rendered worker: " : "Rendered tool: ") + tool.output.value;
    return () => container.replaceChildren();
  }});
  ctx.registerView({ id: "proof", name: "Runtime proof", async mount(container) {
    const heading = document.createElement("h1"); heading.textContent = message; container.append(heading);
    const result = await ctx.call("proof", "browser-bridge");
    if (ctx.signal.aborted) return;
    const body = document.createElement("p"); body.textContent = result.answer; container.append(body);
    return () => container.replaceChildren();
  }});
}
`);
	fs.mkdirSync(path.join(directory, "data"), { recursive: true });
	fs.writeFileSync(path.join(directory, "data", "private.json"), '{"private":true}\n');
	// Seed native history, never simulate model generation or call a provider.
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
	const stopped = await fetch(url + "/api/plugins/native-smoke/call", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ operation: "proof" }) });
	if (stopped.ok) throw new Error("Disabled plugin accepted operations");
	console.log("[smoke-server] external plugin: disabled discovery → native backend/bridge/assets → cooperative disable; data preserved");
}
