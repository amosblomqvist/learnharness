import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { refreshNativeSubscriptionModels, type NativeSubscriptionProviderId } from "../src/agent/native-subscription-bridge.ts";
import { nativeSubscriptionHistory, nativeSubscriptionStream, nativeSubscriptionStreamError } from "../src/agent/native-subscription-stream.ts";

const A: NativeSubscriptionProviderId = "subscription-anthropic", X: NativeSubscriptionProviderId = "subscription-xai";
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
const ambient = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN: process.env.ANTHROPIC_OAUTH_TOKEN, XAI_API_KEY: process.env.XAI_API_KEY };
const realFetch = globalThis.fetch;
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const sdk = new Map(builtinProviders().map((p) => [p.id, p]));
const logical = (alias: NativeSubscriptionProviderId): Model<Api> => {
	const real = alias === A ? "anthropic" : "xai";
	const all = sdk.get(real)!.getModels(); const m = (alias === X ? all.find((x) => x.reasoning) : undefined) ?? all[0]!;
	return { ...m, provider: alias, name: `${m.name} · subscription` };
};
const modelA = logical(A), modelX = logical(X);
let base = 100000, rev = 0;
const stamp = () => ({ epoch: 1, authorityRevision: 1, revision: base + rev });
const status = (extra: object = {}) => ({ available: true, pending: false, allowBackgroundUse: true, activeId: "acct-1", accounts: [{ id: "acct-1", label: "scratch", connected: true }], error: null, ...extra });
const push = (provider: NativeSubscriptionProviderId, invalidate: string, extra: object = {}) => ipc({ channel: "lh:subscription", kind: "state", provider, stamp: { ...stamp(), revision: base + ++rev }, status: status(extra), invalidate });
let leases = 0, leaseToken = "sk-ant-oat01-scratch";
let requests: { url: string; headers: Headers; body: any }[] = [];
let sse: () => Response;
const anthropicSse = (text = "hello") => () => new Response([
	["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: modelA.id, stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
	["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const xaiSse = () => new Response([
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
	{ type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
	{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "hi" },
	{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] } },
	{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	// Ambient provider credentials that MUST NOT reach the wire.
	process.env.ANTHROPIC_API_KEY = "sk-ant-api03-ambient-must-never-be-used"; process.env.ANTHROPIC_AUTH_TOKEN = "ambient-auth-token"; process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-ambient"; process.env.XAI_API_KEY = "xai-ambient-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (m: any, cb?: () => void) => {
		queueMicrotask(() => {
			const reply = m.op === "lease" ? (leases++, { ok: true, value: { accessToken: m.provider === A ? leaseToken : "eyJscratch.jwt.token", accountId: "acct-1", ...stamp() } })
				: { ok: true, value: { ...stamp(), status: status(), accountId: "acct-1", models: [{ id: (m.provider === A ? modelA : modelX).id, name: "m" }] } };
			ipc({ channel: "lh:subscription", id: m.id, provider: m.provider, op: m.op, ...reply });
		});
		cb?.(); return true;
	} });
	globalThis.fetch = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ url: req.url, headers: req.headers, body: JSON.parse((await req.text()) || "null") });
		return sse();
	};
});
beforeEach(async () => {
	base += 1000; rev = 0; leases = 0; leaseToken = "sk-ant-oat01-scratch"; requests = []; sse = anthropicSse();
	for (const p of [A, X]) push(p, "all");
	await refreshNativeSubscriptionModels();
});
after(() => {
	globalThis.fetch = realFetch;
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
	for (const [k, v] of Object.entries(ambient)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});
const ctx = () => normalizeContext({ systemPrompt: "Scratch system", messages: [{ role: "user", content: "Scratch question", timestamp: 1 }] });
async function run(stream: ReturnType<ReturnType<typeof nativeSubscriptionStream>>) { const events = []; for await (const e of stream) events.push(e); return { events, result: await stream.result() }; }

test("Claude: leased OAuth token is the only credential; logical provider is kept; ambient keys never reach the wire", async () => {
	const stream = nativeSubscriptionStream(A, () => false)(modelA, ctx(), {
		apiKey: "sk-ant-api03-caller-key", env: { ANTHROPIC_API_KEY: "caller-env" }, headers: { Authorization: "Bearer caller", "x-api-key": "caller" }, maxRetries: 5,
		onPayload: (p: any) => ({ ...p, metadata: { hook: "kept" } }),
	});
	const { events, result } = await run(stream);
	assert.equal(result.stopReason, "stop"); assert.equal(result.provider, A);
	for (const e of events) assert.equal(("partial" in e ? e.partial : e.type === "done" ? e.message : e.error).provider, A);
	assert.equal(requests.length, 1); assert.match(requests[0]!.url, /^https:\/\/api\.anthropic\.com\//);
	assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-ant-oat01-scratch");
	assert.equal(requests[0]!.headers.get("x-api-key"), null);
	const wire = JSON.stringify([...requests[0]!.headers.entries()]);
	for (const secret of ["ambient", "caller"]) assert.ok(!wire.includes(secret), secret);
	assert.equal(requests[0]!.body.metadata?.hook, "kept", "payload hook preserved");
	assert.equal(leases, 1);
});

test("Grok: native xai transport with the leased token, no env fallback, logical provider retained", async () => {
	sse = xaiSse;
	const { result } = await run(nativeSubscriptionStream(X, () => false)(modelX, ctx(), { apiKey: "xai-caller-key", headers: { Authorization: "Bearer caller" } }));
	assert.equal(result.stopReason, "stop"); assert.equal(result.provider, X);
	assert.match(requests[0]!.url, /^https:\/\/api\.x\.ai\/v1\//);
	assert.equal(requests[0]!.headers.get("authorization"), "Bearer eyJscratch.jwt.token");
	assert.ok(requests[0]!.body.include.includes("reasoning.encrypted_content"), "native xAI reasoning request field preserved");
	assert.ok(!JSON.stringify([...requests[0]!.headers.entries()]).includes("ambient"));
});

test("Claude lease the pinned SDK would send as x-api-key is refused before any request", async () => {
	leaseToken = "sk-ant-api03-not-oauth";
	const { result } = await run(nativeSubscriptionStream(A, () => false)(modelA, ctx()));
	assert.equal(result.stopReason, "error"); assert.equal(requests.length, 0);
	assert.ok(!result.errorMessage!.includes("sk-"));
});

test("no connection or uncataloged model: immediate generic error, no lease, no request, no API-key fallback", async () => {
	push(A, "all", { available: false, accounts: [], activeId: null });
	const { result } = await run(nativeSubscriptionStream(A, () => false)(modelA, ctx()));
	assert.equal(result.stopReason, "error"); assert.equal(leases, 0); assert.equal(requests.length, 0);
	assert.match(result.errorMessage!, /No API-key fallback/);
	const wrong = await run(nativeSubscriptionStream(A, () => false)({ ...modelA, provider: "anthropic" }, ctx()));
	assert.equal(wrong.result.stopReason, "error"); assert.equal(requests.length, 0);
	const other = await run(nativeSubscriptionStream(A, () => false)({ ...modelA, id: "not-in-catalog" }, ctx()));
	assert.equal(other.result.stopReason, "error"); assert.equal(requests.length, 0);
});

test("background revocation mid-lease aborts before any request", async () => {
	const originalSendDesc = Object.getOwnPropertyDescriptor(process, "send")!;
	Object.defineProperty(process, "send", { configurable: true, value: (m: any, cb?: () => void) => {
		queueMicrotask(() => {
			if (m.op === "lease") { push(A, "background", { allowBackgroundUse: false }); ipc({ channel: "lh:subscription", id: m.id, provider: m.provider, op: "lease", ok: true, value: { accessToken: leaseToken, accountId: "acct-1", ...stamp() } }); }
		});
		cb?.(); return true;
	} });
	try {
		const { result } = await run(nativeSubscriptionStream(A, () => true)(modelA, ctx()));
		assert.equal(result.stopReason, "aborted"); assert.equal(requests.length, 0);
		assert.match(result.errorMessage!, /cancelled/);
	} finally { Object.defineProperty(process, "send", originalSendDesc); }
});

test("account switch ('all') during the response aborts, and the stale response is not delivered", async () => {
	sse = () => { push(A, "all", { activeId: "acct-2", accounts: [{ id: "acct-2", label: "n", connected: true }] }); return anthropicSse("stale text")(); };
	const { events, result } = await run(nativeSubscriptionStream(A, () => false)(modelA, ctx()));
	assert.equal(result.stopReason, "aborted"); assert.ok(!events.some((e) => e.type === "done"));
	assert.ok(!JSON.stringify(result).includes("stale text"));
});

test("single dispatch: a second fetch from the SDK for the same stream is refused", async () => {
	let calls = 0;
	const stream = nativeSubscriptionStream(A, () => false)(modelA, ctx(), { fetch: async (...a: Parameters<typeof fetch>) => { calls++; return globalThis.fetch(...a); } });
	await run(stream);
	assert.equal(calls, 1);
});

test("provider errors are replaced with generic provider-specific text, never the raw body", async () => {
	sse = () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "SECRET-RAW-BODY quota exceeded for org-123" } }), { status: 429, headers: { "content-type": "application/json" } });
	const { result } = await run(nativeSubscriptionStream(A, () => false)(modelA, ctx()));
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Claude subscription usage limit/);
	assert.ok(!/SECRET|org-123/.test(result.errorMessage!));
	assert.equal(requests.length, 1, "maxRetries is 0");
	assert.match(nativeSubscriptionStreamError(X, "401 expired"), /Grok session expired/);
	assert.match(nativeSubscriptionStreamError(X, "weird SECRET"), /Grok request failed/);
	assert.ok(!nativeSubscriptionStreamError(A, "weird SECRET").includes("SECRET"));
});

test("history: foreign turns are transformed against the logical model, own turns take the SDK provider id, ids/signatures preserved", () => {
	const own = { role: "assistant", api: modelA.api, provider: A, model: modelA.id, content: [{ type: "toolCall", id: "toolu_keep", name: "t", arguments: {}, thoughtSignature: "sig-keep" }, { type: "thinking", thinking: "t", thinkingSignature: "think-sig" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } as any;
	const keyed = { ...own, provider: "anthropic", timestamp: 3, content: [{ type: "thinking", thinking: "real api key turn", thinkingSignature: "keyed-sig" }] };
	const result = nativeSubscriptionHistory({ messages: [{ role: "user", content: "x", timestamp: 1 }, own, keyed] } as any, modelA, "anthropic");
	const [a, b] = (result.messages as any[]).filter((m) => m.role === "assistant");
	assert.equal(a.provider, "anthropic"); assert.equal(a.content[0].id, "toolu_keep"); assert.equal(a.content[1].thinkingSignature, "think-sig");
	assert.equal(b.provider, "anthropic");
	assert.equal(own.provider, A, "input not mutated");
});

test("transport origin comes from the pinned SDK catalog: a malicious logical baseUrl/api/headers never receives the token", async () => {
	for (const [provider, model, origin] of [[A, modelA, "https://api.anthropic.com"], [X, modelX, "https://api.x.ai"]] as const) {
		requests = []; sse = provider === A ? anthropicSse() : xaiSse;
		const evil = { ...model, baseUrl: "https://evil.example/v1", headers: { "x-evil": "1", authorization: "Bearer evil" }, compat: { ...(model as any).compat, supportsDeveloperRole: true } } as Model<Api>;
		const { result } = await run(nativeSubscriptionStream(provider, () => false)(evil, ctx()));
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0]!.url).origin, origin);
		assert.equal(requests[0]!.headers.get("x-evil"), null);
		assert.ok(!requests[0]!.headers.get("authorization")!.includes("evil"));
	}
});

test("fetch is pinned to the SDK origin with redirect:error; cross-origin or redirecting requests never carry the key", async () => {
	let seen: RequestInit | undefined; const urls: string[] = [];
	const { result } = await run(nativeSubscriptionStream(A, () => false)(modelA, ctx(), { fetch: async (input, init) => { seen = init; urls.push(input instanceof Request ? input.url : String(input)); return globalThis.fetch(input, init); } }));
	assert.equal(result.stopReason, "stop"); assert.equal(seen?.redirect, "error"); assert.equal(urls.length, 1);
	// A model whose id is not in the pinned SDK catalog cannot select an endpoint at all.
	requests = [];
	const unknown = await run(nativeSubscriptionStream(A, () => false)({ ...modelA, id: "invented-model", baseUrl: "https://evil.example" }, ctx()));
	assert.equal(unknown.result.stopReason, "error"); assert.equal(requests.length, 0);
});

test("hostile onPayload cannot change the wire model; invalid replacements are refused; output model stays logical", async () => {
	for (const [provider, model] of [[A, modelA], [X, modelX]] as const) {
		requests = []; sse = provider === A ? anthropicSse() : xaiSse;
		const { result } = await run(nativeSubscriptionStream(provider, () => false)(model, ctx(), { onPayload: (p: any) => ({ ...p, model: "some-other-expensive-model" }) }));
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests[0]!.body.model, model.id); assert.equal(result.model, model.id); assert.equal(result.provider, provider);
		requests = []; sse = provider === A ? anthropicSse() : xaiSse;
		const bad = await run(nativeSubscriptionStream(provider, () => false)(model, ctx(), { onPayload: () => "not an object" as any }));
		assert.equal(bad.result.stopReason, "error"); assert.equal(requests.length, 0);
	}
});

test("ambient OpenAI org/project (and caller headers) never reach Claude or Grok requests", async () => {
	const saved = { o: process.env.OPENAI_ORG_ID, p: process.env.OPENAI_PROJECT_ID };
	process.env.OPENAI_ORG_ID = "org-AMBIENT-SENTINEL"; process.env.OPENAI_PROJECT_ID = "proj-AMBIENT-SENTINEL";
	try {
		for (const [provider, model] of [[A, modelA], [X, modelX]] as const) {
			requests = []; sse = provider === A ? anthropicSse() : xaiSse;
			const { result } = await run(nativeSubscriptionStream(provider, () => false)(model, ctx(), { headers: { "OpenAI-Organization": "org-CALLER", "OpenAI-Project": "proj-CALLER" } }));
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(requests[0]!.headers.get("openai-organization"), null); assert.equal(requests[0]!.headers.get("openai-project"), null);
			assert.ok(!JSON.stringify([...requests[0]!.headers.entries()]).includes("SENTINEL") && !JSON.stringify(requests[0]!.body).includes("SENTINEL"));
		}
	} finally { for (const [k, v] of [["OPENAI_ORG_ID", saved.o], ["OPENAI_PROJECT_ID", saved.p]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
