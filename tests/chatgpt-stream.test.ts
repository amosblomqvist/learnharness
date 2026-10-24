import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { chatGPTAbortController, chatGPTModels, refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { chatGPTHistory, chatGPTPayload } from "../src/agent/chatgpt-stream.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const realFetch = globalThis.fetch;
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const originalKey = process.env.OPENAI_API_KEY;
let leaseError: string | null = null;
let requests: { authorization: string | null; body: Record<string, any>; url: string }[] = [];
let responseEvents: unknown[] = [];
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: false }], error: null };
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	assert(model);
	process.env.OPENAI_API_KEY = "sk-scratch-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => {
			ipc({ channel: "lh:chatgpt", id: message.id, op: message.op,
				...(message.op === "lease" && leaseError ? { ok: false, error: leaseError, stamp: { epoch: 1, authorityRevision: 1, revision: 1 } } : { ok: true, value: message.op === "lease" ? { accessToken: "scratch-oauth-only", accountId: "scratch-account", epoch: 1, authorityRevision: 1, revision: 1 } : { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: model.id, name: "Scratch account model" }, { id: "unknown-capabilities", name: "Do not invent capabilities" }] } }),
			});
		});
		callback?.(); return true;
	} });
	await refreshChatGPTModels([model]);
	globalThis.fetch = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ authorization: req.headers.get("authorization"), body: JSON.parse(await req.text()), url: req.url });
		return new Response(responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
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
const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const complete = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_scratch", status: "completed", output, usage } });
const context = () => normalizeContext({ systemPrompt: "Scratch teacher instructions", messages: [{ role: "user", content: [{ type: "text", text: "Scratch learning material" }, { type: "image", data: "c2NyYXRjaA==", mimeType: "image/png" }], timestamp: 1 }], tools: [{ name: "scratch_tool", description: "Scratch local tool", parameters: Type.Object({ value: Type.String() }) }] });

test("catalog intersects supported capabilities, without inventing model limits", () => {
	assert.equal(chatGPTModels().length, 1);
	assert.equal(chatGPTModels()[0]!.provider, "chatgpt");
	assert.equal(chatGPTModels()[0]!.contextWindow, model.contextWindow);
	assert.deepEqual(chatGPTModels()[0]!.input, model.input);
});

test("alias resolves only OAuth; native Responses body is stateless/namespaced, image/history preserved and logical output retained", async () => {
	requests = [];
	const tool = { type: "function_call", id: "fc_scratch", call_id: "call_scratch", name: "scratch_tool", namespace: "learnharness", arguments: '{"value":"yes"}', status: "completed" };
	const reasoning = { type: "reasoning", id: "rs_scratch", summary: [], encrypted_content: "scratch-encrypted-reasoning" };
	responseEvents = [{ type: "response.created", response: { id: "resp_scratch" } }, { type: "response.output_item.added", output_index: 0, item: reasoning }, { type: "response.output_item.done", output_index: 0, item: reasoning }, { type: "response.output_item.added", output_index: 1, item: tool }, { type: "response.output_item.done", output_index: 1, item: tool }, complete([reasoning, tool])];
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	const stream = engine.streamFn(engine.model, context(), { temperature: 0.7, maxTokens: 1000, samplingParams: { top_p: 0.5 }, onPayload: (payload) => ({ ...payload as object, model: "caller-cannot-change", dangerous: true }) });
	const events = [];
	for await (const event of stream) { events.push(event); if ("partial" in event) assert.equal(event.partial.provider, "chatgpt"); }
	const result = await stream.result();
	assert.equal(result.provider, "chatgpt"); assert.equal(result.stopReason, "toolUse");
	assert.equal(requests.length, 1); assert.equal(requests[0]!.url, "https://api.openai.com/v1/responses");
	assert.equal(requests[0]!.authorization, "Bearer scratch-oauth-only");
	const body = requests[0]!.body;
	assert.equal(body.store, false); assert.equal(body.stream, true);
	for (const key of ["temperature", "top_p", "max_output_tokens", "previous_response_id", "background", "metadata", "prompt_cache_retention"]) assert.equal(body[key], undefined, key);
	assert.equal(body.input[0].role, "developer");
	assert.equal(body.input[1].content[1].type, "input_image");
	assert.equal(body.tools[0].type, "namespace"); assert.equal(body.tools[0].tools[0].name, "scratch_tool");
	const call = result.content.find((block) => block.type === "toolCall")!;
	assert.equal(call.id, "call_scratch|fc_scratch"); assert.equal(call.namespace, "learnharness");
	const thinking = result.content.find((block) => block.type === "thinking")!;
	assert.equal(thinking.thinkingSignature, JSON.stringify(reasoning));
	const history = normalizeContext({ messages: [...context().messages, result, { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, content: [{ type: "text", text: "Scratch tool result" }], timestamp: 2 }] });
	responseEvents = [complete()];
	await engine.streamFn(engine.model, history).result();
	const replay = requests[1]!.body.input;
	assert(replay.some((item: any) => item.encrypted_content === "scratch-encrypted-reasoning"));
	assert(replay.some((item: any) => item.type === "function_call" && item.id === "fc_scratch" && item.namespace === "learnharness"));
	assert(replay.some((item: any) => item.type === "function_call_output" && item.call_id === "call_scratch"));
});

test("mixed history never blanket-relabels API providers or reuses foreign reasoning signatures", () => {
	const native: AssistantMessage = { role: "assistant", provider: "openai", api: "openai-responses", model: model.id, content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"API-only"}', redacted: true }], stopReason: "stop", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
	const own = { ...native, provider: "chatgpt", content: [{ type: "thinking" as const, thinking: "", thinkingSignature: '{"encrypted_content":"ChatGPT-only"}', redacted: true }] };
	const transformed = chatGPTHistory(normalizeContext({ messages: [native, own] }), { ...model, provider: "chatgpt" });
	assert.equal((transformed.messages[0] as AssistantMessage).provider, "openai");
	assert.deepEqual((transformed.messages[0] as AssistantMessage).content, []);
	assert.equal((transformed.messages[1] as AssistantMessage).content[0]!.type, "thinking");
	assert.equal(native.content.length, 1, "source history must not be mutated");
});

test("no terminal completed is never success; late quota/incomplete streams are actionable/redacted", async () => {
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	for (const events of [[{ type: "response.created", response: { id: "resp_partial" } }], [{ type: "response.incomplete", response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, usage } }], [{ type: "error", code: "subscription_sharing_usage_limit_exceeded", message: "secret scratch provider diagnostic" }]]) {
		responseEvents = events;
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(result.stopReason, "error"); assert.equal(result.provider, "chatgpt");
		assert(!result.errorMessage?.includes("secret scratch provider diagnostic"));
		if (JSON.stringify(events).includes("usage_limit")) assert(result.errorMessage?.includes("https://chatgpt.com/settings/usage"));
	}
});

test("OAuth failure and background denial NEVER use ambient OPENAI_API_KEY", async () => {
	requests = [];
	for (const error of ["expired ChatGPT session", "Background use is off", "catalog unavailable", "quota exceeded"]) {
		leaseError = error;
		const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, true);
		assert.equal((await engine.streamFn(engine.model, context()).result()).stopReason, "error");
	}
	leaseError = null;
	assert.equal(requests.length, 0);
});

test("consent revocation cancels only applicable background streams and preserves foreground", () => {
	const foreground = chatGPTAbortController(false);
	const background = chatGPTAbortController(true);
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 2 }, status, invalidate: "background" });
	assert.equal(foreground.controller.signal.aborted, false);
	assert.equal(background.controller.signal.aborted, true);
	foreground.release(); background.release();
});

test("payload sanitizer omits unsupported fields and rejects unsupported hosted tools", () => {
	assert.deepEqual(chatGPTPayload({ model: "scratch", input: [], stream: false, store: true, metadata: { test: true }, previous_response_id: "old", background: true }, "scratch"), { model: "scratch", input: [], stream: true, store: false });
	assert.throws(() => chatGPTPayload({ input: [], tools: [{ type: "tool_search" }] }, "scratch"), /Unsupported/);
});

test("native identity/session/cache/fetch and awaited caller observers survive enforcement; terminal outcome exactly once", async () => {
	const { APP_IDENTITY } = await import("../src/agent/models.ts");
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	let headers = new Headers(), payload: any, observed = 0, responses = 0, delegated = 0;
	responseEvents = [complete()];
	const stream = engine.streamFn(engine.model, context(), {
		identity: APP_IDENTITY, sessionId: "exact-native-chat-session", timeoutMs: 12345,
		headers: { "x-native-observer": "retained", "x-suppressed": null },
		fetch: async (input, init) => { delegated++; const req = new Request(input, init); headers = req.headers; payload = JSON.parse(await req.text()); return new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } }); },
		onPayload: async (raw, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); return { ...raw as object, model: "not-the-selected-model", store: true, metadata: { forbidden: true } }; },
		onResponse: async (_response, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); responses++; },
		onProviderStreamEvent: async (_raw, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); observed++; },
	});
	const events = []; for await (const event of stream) events.push(event);
	assert.equal(delegated, 1); assert.equal(observed, 1); assert.equal(responses, 1);
	assert.equal(headers.get("user-agent"), APP_IDENTITY.userAgent.custom);
	assert.equal(headers.get("session_id"), "exact-native-chat-session");
	assert.equal(headers.get("x-client-request-id"), "exact-native-chat-session");
	assert.equal(headers.get("x-native-observer"), "retained"); assert.equal(headers.get("x-suppressed"), null);
	assert.equal(payload.prompt_cache_key, "exact-native-chat-session"); assert.equal(payload.model, model.id); assert.equal(payload.metadata, undefined);
	assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
	const failed = engine.streamFn(engine.model, context(), { onProviderStreamEvent: async () => { throw new Error("private observer detail"); } });
	const failedEvents = []; for await (const event of failed) failedEvents.push(event);
	assert.equal(failedEvents.filter((e) => e.type === "error").length, 1); assert.equal(failedEvents.filter((e) => e.type === "done").length, 0);
	assert(!(await failed.result()).errorMessage?.includes("private observer detail"));
});

test("case-insensitive Authorization overrides including null are refused before native fetch", async () => {
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	const before = requests.length;
	for (const headers of [{ Authorization: "Bearer wrong" }, { authorization: null }, { AUTHORIZATION: "" }] as Record<string, string | null>[]) {
		assert.equal((await engine.streamFn(engine.model, context(), { headers }).result()).stopReason, "error");
	}
	assert.equal(requests.length, before);
});

test("full credential-storage invalidation aborts foreground and background controllers and clears capabilities", () => {
	const foreground = chatGPTAbortController(false), background = chatGPTAbortController(true);
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 2, revision: 3 }, status: { ...status, available: false }, invalidate: "all" });
	assert(foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert.equal(chatGPTModels().length, 0);
	foreground.release(); background.release();
});
