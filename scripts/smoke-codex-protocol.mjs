// Native CLI protocol check only: isolated unsigned profile; NO turn/start,
// sign-in, credential-file reads, or inference. Run with node --import tsx.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectCodex } from "../src/agent/codex/client.ts";
const directory = await mkdtemp(path.join(tmpdir(), "lh-codex-protocol-"));
let client;
try {
	const profile = path.join(directory, "profile"), cwd = path.join(directory, "cwd");
	await mkdir(profile, { mode: 0o700 }); await mkdir(cwd);
	client = await connectCodex(profile, cwd);
	assert.equal((await client.request("account/read", { refreshToken: false })).account, null);
	const catalog = await client.request("model/list", { limit: 100 });
	assert(Array.isArray(catalog.data)); assert(catalog.data.length > 0);
	const model = catalog.data[0].model;
	const result = await client.request("thread/start", { model, modelProvider: "openai", allowProviderModelFallback: false,
		ephemeral: true, sandbox: "read-only", approvalPolicy: "never", baseInstructions: "Protocol smoke test. Do not run inference.",
		dynamicTools: [{ type: "function", name: "quiz", description: "Pose a learning question", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } }] });
	assert(result.thread.id); assert.equal(result.model, model);
	console.log("Codex native handshake, unsigned account, catalog, and ephemeral dynamic-tool thread passed. No inference requested.");
} finally { client?.close(); await rm(directory, { recursive: true, force: true }); }
