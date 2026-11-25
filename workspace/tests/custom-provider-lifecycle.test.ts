/** Native Pi payloads with synthetic transport and owned scratch files only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { normalizeContext, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-lifecycle-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), ...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
await import("../src/server/keys.ts");
const { readCustomAuth } = await import("../src/store/auth.ts");
const { persistCustomAuth, customAuthState } = await import("../src/server/custom-provider-auth.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const { modelCatalog, catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { createReadTool } = await import("../src/agent/tools/read.ts");
const { installCustomProviderSource } = await import("../src/server/custom-provider.ts");
let requests: { url: string; auth: string | null; body: Record<string, unknown> }[];
function configure(baseUrl = "http://first/v1", reasoning = false, maxTokens = 512, authMode: "keyless" | "apiKey" = "apiKey") {
	const key = authMode === "apiKey" ? readCustomAuth().fileKey() ?? "first-key" : undefined;
	writeSettings({ version: 1, customProvider: authorizeFixture({ baseUrl, authMode, models: [{ id: "m", context: 16384, maxTokens, reasoning }] }, key) });
}
function answer() {
	return new Response(`data: ${JSON.stringify({ id: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function capture(url: unknown, init?: RequestInit) {
	requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
}
const context = (messages: Message[] = [{ role: "user", content: "synthetic", timestamp: 0 }]) => normalizeContext({ messages });
const run = (engine: ReturnType<typeof piEngineForSpec>, messages?: Message[]) => engine.streamFn(engine.model, context(messages), {}).result();
beforeEach(() => {
	requests = []; fs.writeFileSync(path.join(scratch, "auth.json"), "{}"); configure();
	globalThis.fetch = async (url, init) => { capture(url, init); return answer(); };
});
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(scratch, { recursive: true, force: true }); });

test("native requests revalidate endpoint/model/key/limits with no fallback and retain in-flight setup", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	let started!: () => void; const ready = new Promise<void>((r) => { started = r; });
	let release!: () => void;
	globalThis.fetch = async (url, init) => { capture(url, init); started(); return new Promise<Response>((resolve) => { release = () => resolve(answer()); }); };
	const inFlight = run(engine); await ready;
	configure("http://second/v1", false, 1024); persistCustomAuth(readCustomAuth().binding, "second-key");
	globalThis.fetch = async (url, init) => { capture(url, init); return answer(); };
	assert.equal((await run(engine)).stopReason, "stop");
	release(); assert.equal((await inFlight).stopReason, "stop");
	assert.match(requests[0]!.url, /^http:\/\/first\/v1\/chat\/completions$/);
	assert.equal(requests[0]!.auth, "Bearer first-key"); assert.equal(requests[0]!.body.max_completion_tokens, 512);
	assert.match(requests[1]!.url, /^http:\/\/second\/v1\/chat\/completions$/);
	assert.equal(requests[1]!.auth, "Bearer second-key"); assert.equal(requests[1]!.body.max_completion_tokens, 1024);
	writeSettings({ version: 1, customProvider: { ...readSettings()!.customProvider, models: [{ id: "other" }] } });
	assert.ok(piModels().getProvider("custom"), "provider stays authorized while this model is removed");
	assert.equal((await run(engine)).stopReason, "error");
	writeSettings({ version: 1 }); assert.equal((await run(engine)).stopReason, "error");
	assert.equal(requests.length, 2);
	assert.ok(piModels().getProvider("openai"), "native route survives custom removal");
});
test("current key changes without configuration edits are reflected on the next operation", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	await run(engine); persistCustomAuth(readCustomAuth().binding, "rotated-key"); await run(engine);
	assert.deepEqual(requests.map((r) => r.auth), ["Bearer first-key", "Bearer rotated-key"]);
});
test("original saved thinking preference recovers after capability expansion and contracts again", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m", thinkingLevel: "high" });
	assert.equal(engine.level, "off");
	await run(engine); configure("http://first/v1", true); await run(engine); configure(); await run(engine);
	assert.deepEqual(requests.map((r) => r.body.reasoning_effort), [undefined, "high", undefined]);
});
test("unset preference reselects the existing default against current reasoning metadata", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	configure("http://first/v1", true); await run(engine);
	assert.equal(requests[0]!.body.reasoning_effort, "medium");
	configure(); await run(engine); assert.equal(requests[1]!.body.reasoning_effort, undefined);
});
test("catalog capabilities remain reported and prices unknown despite runtime image permission", () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	assert.deepEqual(engine.model.input, ["text", "image"]);
	const dto = modelCatalog().models.find((m) => m.provider === "custom")!;
	assert.deepEqual(dto.input, ["text"]); assert.equal(dto.cost, null);
	assert.equal(callCost({ inputTokens: 100, outputTokens: 100 }, "custom:m"), null);
	assert.equal(catalogContextLimits().get("custom:m"), 16384);
});
const image = { type: "image" as const, data: createCanvas(1, 1).toBuffer("image/png").toString("base64"), mimeType: "image/png" };
test("actual native encoder preserves USER and tool-result images under missing metadata, including after reload", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 0 },
		fauxAssistantMessage([fauxToolCall("read", {}, { id: "read-1" })], { stopReason: "toolUse" }),
		{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [image], isError: false, timestamp: 1 },
	];
	await run(engine, messages); configure("http://second/v1"); await run(engine, messages);
	for (const request of requests) {
		const body = JSON.stringify(request.body.messages);
		assert.equal((body.match(/"type":"image_url"/g) ?? []).length, 2);
		assert.equal((body.match(/data:image\/png;base64/g) ?? []).length, 2);
		assert.ok(!body.includes("image omitted"));
	}
	assert.deepEqual(piModels().getModel("custom", "m")!.input, ["text"]);
});
test("teacher-bound read returns image without contradictory omission note", async () => {
	const file = path.join(scratch, "synthetic.png"); fs.writeFileSync(file, Buffer.from(image.data, "base64"));
	const engine = piEngineForSpec({ provider: "custom", id: "m" });
	const result = await createReadTool(engine.model).execute("read-1", { path: file });
	assert.ok(result.content.some((block) => block.type === "image"));
	assert.ok(!JSON.stringify(result).includes("image will be omitted"));
});
test("backend image rejection surfaces once, never retries without images", async () => {
	globalThis.fetch = async (url, init) => { capture(url, init); return Response.json({ error: { message: "images rejected by backend" } }, { status: 400 }); };
	const result = await run(piEngineForSpec({ provider: "custom", id: "m" }), [{ role: "user", content: [image], timestamp: 0 }]);
	assert.equal(result.stopReason, "error"); assert.match(result.errorMessage ?? "", /images rejected/); assert.equal(requests.length, 1);
});
test("existing engine refuses nonce mismatch on EVERY operation, without falling back to env", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: "m" }); await run(engine);
	persistCustomAuth({ ...readCustomAuth().binding!, id: "b".repeat(32) }, "different-key");
	assert.equal((await run(engine)).stopReason, "error"); assert.equal(requests.length, 1);
});
test("keyless publication never reads the credential lookup", async () => {
	configure("http://first/v1", false, 512, "keyless");
	let credentialLookups = 0;
	installCustomProviderSource((inspect, cp) => { if (inspect) credentialLookups++; return customAuthState(inspect, cp); });
	try { assert.equal((await run(piEngineForSpec({ provider: "custom", id: "m" }))).stopReason, "stop"); assert.equal(credentialLookups, 0); assert.equal(requests[0]!.auth, "Bearer not-needed"); }
	finally { installCustomProviderSource(); }
});
