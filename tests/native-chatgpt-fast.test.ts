import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { chatGPTModels, refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { chatGPTPayload, chatGPTStream } from "../src/agent/chatgpt-stream.ts";

// Offline native ChatGPT Fast tests: synthetic IPC catalog/lease plus synthetic fetch.
// Tier is requested, not guaranteed delivered; these assert the request body only.

const FAST = "gpt-6-sol";
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const realFetch = globalThis.fetch;
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const originalKey = process.env.OPENAI_API_KEY;
let leaseError: string | null = null;
let requests: { authorization: string | null; body: Record<string, any> }[] = [];
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: false }], error: null };
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const completed = { type: "response.completed", response: { id: "resp_fast", status: "completed", output: [], usage } };
let fastModel: Model<any>, standardModel: Model<any>;

before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	process.env.OPENAI_API_KEY = "sk-scratch-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op,
			...(message.op === "lease" && leaseError ? { ok: false, error: leaseError, stamp: { epoch: 1, authorityRevision: 1, revision: 1 } }
				: { ok: true, value: message.op === "lease" ? { accessToken: "scratch-oauth-only", accountId: "scratch-account", epoch: 1, authorityRevision: 1, revision: 1 } : { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: FAST, name: "Fast" }, { id: "gpt-5", name: "Standard" }] } }) }));
		callback?.(); return true;
	} });
	const base = piModels().getModel("openai", "gpt-5") as Model<any>;
	await refreshChatGPTModels([base, { ...base, id: FAST }] as never);
	fastModel = chatGPTModels().find((m) => m.id === FAST)!;
	standardModel = chatGPTModels().find((m) => m.id === "gpt-5")!;
	assert.ok(fastModel && standardModel, "synthetic catalog must expose both models");
	globalThis.fetch = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ authorization: req.headers.get("authorization"), body: JSON.parse(await req.text()) });
		return new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	globalThis.fetch = realFetch;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
});
const context = () => normalizeContext({ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
async function run(model: Model<any>, tier?: "default" | "priority", options: Record<string, unknown> = {}) {
	requests = [];
	const result = await chatGPTStream(() => false, undefined, tier)(model, context(), options as never).result();
	return result;
}

test("priority on a known native model sends service_tier priority with the same account, model and OAuth bearer", async () => {
	const result = await run(fastModel, "priority", { reasoning: "high" });
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(requests.length, 1);
	const body = requests[0]!.body;
	assert.equal(body.service_tier, "priority");
	assert.equal(body.model, FAST); assert.equal(body.store, false); assert.equal(body.stream, true);
	assert.equal(requests[0]!.authorization, "Bearer scratch-oauth-only");
	assert.equal(body.reasoning?.effort, "high", "Fast does not change reasoning");
});

test("Standard (default or absent) omits service_tier and ignores caller-supplied tiers from onPayload and samplingParams", async () => {
	for (const tier of ["default", undefined] as const) {
		await run(fastModel, tier, { onPayload: (p: any) => ({ ...p, service_tier: "priority" }), samplingParams: { service_tier: "priority" } });
		assert.equal("service_tier" in requests[0]!.body, false, String(tier));
	}
	await run(fastModel, undefined, { onPayload: (p: any) => { p.service_tier = "priority"; } });
	assert.equal("service_tier" in requests[0]!.body, false);
});

test("a caller hook cannot enable Fast, and priority survives a hook that replaces the body", async () => {
	await run(fastModel, "priority", { onPayload: () => ({ input: [], service_tier: "flex" }) });
	assert.equal(requests[0]!.body.service_tier, "priority");
});

test("unknown model ids never get priority even when requested", async () => {
	const result = await run(standardModel, "priority");
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal("service_tier" in requests[0]!.body, false);
});

test("chatGPTPayload gates the field on tier and known model, and never copies the caller's tier", () => {
	const raw = { input: [], service_tier: "priority" };
	assert.equal("service_tier" in chatGPTPayload(raw, FAST), false);
	assert.equal("service_tier" in chatGPTPayload(raw, FAST, "default"), false);
	assert.equal(chatGPTPayload({ input: [] }, FAST, "priority").service_tier, "priority");
	assert.equal("service_tier" in chatGPTPayload({ input: [] }, "gpt-5", "priority"), false);
	assert.equal("service_tier" in chatGPTPayload({ input: [] }, "unknown", "priority"), false);
});

test("Fast errors stay scoped and never fall back to an API key", async () => {
	leaseError = "quota exceeded";
	try {
		const result = await run(fastModel, "priority");
		assert.equal(result.stopReason, "error");
		assert.equal(requests.length, 0);
		assert(result.errorMessage?.includes("No API-key fallback"));
		assert(!result.errorMessage?.includes("sk-scratch"));
	} finally { leaseError = null; }
});

test("cancellation before dispatch is reported as aborted without a request", async () => {
	const controller = new AbortController(); controller.abort();
	const result = await run(fastModel, "priority", { signal: controller.signal });
	assert.equal(result.stopReason, "aborted");
	assert.equal(requests.length, 0);
});

async function viaFactory(spec: { provider: string; id: string; serviceTier?: "default" | "priority" }, options: Record<string, unknown> = {}) {
	requests = [];
	const engine = piEngineForSpec(spec as never, false);
	assert.equal(engine.model.provider, "chatgpt");
	const result = await engine.streamFn(engine.model, context(), options as never).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(requests.length, 1);
	return requests[0]!;
}

test("piEngineForSpec routes native and legacy provider ids to the same leased bearer with priority", async () => {
	for (const provider of ["chatgpt", "subscription-openai-codex"]) {
		const req = await viaFactory({ provider, id: FAST, serviceTier: "priority" }, { apiKey: "leaked-key" });
		assert.equal(req.body.service_tier, "priority", provider);
		assert.equal(req.authorization, "Bearer scratch-oauth-only", provider);
		assert.equal(req.body.model, FAST);
		assert.ok(!(req.authorization ?? "").includes("leaked"), "caller apiKey is not used");
	}
});

test("piEngineForSpec Standard or absent tier sends no service_tier, even for a legacy id and hostile onPayload", async () => {
	for (const provider of ["chatgpt", "subscription-openai-codex"]) {
		for (const serviceTier of ["default", undefined] as const) {
			const req = await viaFactory({ provider, id: FAST, ...(serviceTier ? { serviceTier } : {}) }, { onPayload: (p: any) => ({ ...p, service_tier: "priority" }) });
			assert.equal("service_tier" in req.body, false, `${provider}/${serviceTier}`);
		}
	}
});

test("piEngineForSpec never sends priority for a model outside the Fast allowlist", async () => {
	const req = await viaFactory({ provider: "subscription-openai-codex", id: "gpt-5", serviceTier: "priority" });
	assert.equal("service_tier" in req.body, false);
});
