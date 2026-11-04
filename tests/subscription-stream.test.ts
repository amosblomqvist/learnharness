import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { NATIVE_SUBSCRIPTIONS, type NativeSubscriptionSnapshot } from "../src/core/contracts/subscriptions.ts";
import { refreshSubscriptionModels, nativeSubscriptionModels, subscriptionAbortController, subscriptionRequest } from "../src/agent/subscription-bridge.ts";
import { subscriptionHistory } from "../src/agent/subscription-stream.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backgroundCaptureDir, backgroundCaptureStream, createBackgroundCapture } from "../src/agent/background-capture.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
const xaiKey = process.env.XAI_API_KEY, copilotKey = process.env.COPILOT_GITHUB_TOKEN;
let revision = 1, denied = false, sends = 0;
const context = normalizeContext({ messages: [{ role: "user", content: "Offline fixture", timestamp: 0 }] });
function snapshot(background = true): NativeSubscriptionSnapshot {
	return {
		statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: true, pending: false, allowBackgroundUse: background, connectionId: `fixture-${p.providerId}`, epoch: 1, authorityRevision: 1, revision })),
		models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
	};
}
const emit = (value: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", value);
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	process.env.XAI_API_KEY = "fixture-must-never-be-used"; process.env.COPILOT_GITHUB_TOKEN = "fixture-api-route-only";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		sends++; queueMicrotask(() => emit({ channel: "lh:subscriptions", id: message.id, op: message.op, ...(denied && message.op === "lease" ? { ok: false, error: "fixture expired refresh" } : { ok: true, value: message.op === "snapshot" ? snapshot() : { scope: message.scope, auth: { apiKey: "fixture-oauth-only", ...(message.scope.providerId === "github-copilot" ? { baseUrl: "https://api.business.githubcopilot.com", headers: { "x-fixture-auth": "native-retained" } } : {}) } } }) }));
		callback?.(); return true;
	} });
	await refreshSubscriptionModels();
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	for (const [key, value] of [["LH_DESKTOP_SERVER", marker], ["LH_DESKTOP_API_SECRET", secret], ["XAI_API_KEY", xaiKey], ["COPILOT_GITHUB_TOKEN", copilotKey]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
});
test("logical subscription routes are separate catalog entries without rewriting native API models", () => {
	for (const p of NATIVE_SUBSCRIPTIONS) {
		assert(nativeSubscriptionModels().some((m) => m.provider === p.logicalId));
		assert(piModels().getModels(p.providerId).every((m) => m.provider === p.providerId));
	}
});
for (const p of NATIVE_SUBSCRIPTIONS) test(`${p.providerId}: every SDK transport keeps native identity, account auth and selected model before dispatch`, async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-capture-"));
	const previousDir = backgroundCaptureDir.current, previousFlag = process.env.LH_BACKGROUND_CAPTURE;
	backgroundCaptureDir.current = dir; process.env.LH_BACKGROUND_CAPTURE = "researcher";
	t.after(() => {
		backgroundCaptureDir.current = previousDir;
		if (previousFlag === undefined) delete process.env.LH_BACKGROUND_CAPTURE; else process.env.LH_BACKGROUND_CAPTURE = previousFlag;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const apis = new Set<string>();
	for (const native of piModels().getModels(p.providerId)) {
		if (apis.has(native.api)) continue; apis.add(native.api);
		const engine = piEngineForSpec({ provider: p.logicalId, id: native.id }, false);
		let requests = 0, payloadObserved = false;
		let actualBody: unknown;
		const runId = `${p.providerId}-${native.api}`;
		const capture = createBackgroundCapture({ role: "researcher", runId })!;
		const result = await backgroundCaptureStream(engine.streamFn, capture)(engine.model, context, {
			onPayload: (raw, selected) => { payloadObserved = true; assert.equal(selected.provider, p.providerId); return { ...raw as object, model: "caller-cannot-replace-selected" }; },
			fetch: async (input, init) => {
				requests++; const request = new Request(input, init), body = await request.json(); actualBody = body;
				assert.equal(request.headers.get("authorization"), "Bearer fixture-oauth-only");
				assert.equal(body.model, native.id);
				if (p.providerId === "github-copilot") { assert.equal(new URL(request.url).origin, "https://api.business.githubcopilot.com"); assert.equal(request.headers.get("x-fixture-auth"), "native-retained"); }
				else assert.equal(new URL(request.url).origin, "https://api.x.ai");
				return new Response('{"error":{"message":"private-fixture-provider-detail"}}', { status: 401, headers: { "content-type": "application/json" } });
			},
		}).result();
		assert(payloadObserved); assert.equal(requests, 1); assert.equal(result.provider, p.logicalId); assert.equal(result.stopReason, "error");
		assert(!result.errorMessage?.includes("private-fixture-provider-detail")); assert(result.errorMessage?.includes("No API-key fallback"));
		capture.reply(result); capture.finish();
		const record = JSON.parse(fs.readFileSync(path.join(dir, `researcher-${runId}.json`), "utf8"));
		assert.deepEqual(record.request.payload, actualBody, "Observe after the selected model is enforced, not the caller replacement");
		assert.equal(record.request.model.provider, p.logicalId);
		assert(!JSON.stringify(record).includes("fixture-oauth-only"));
		assert(!JSON.stringify(record).includes("native-retained"));
	}
});
test("failed OAuth lease never dispatches despite valid-looking ambient keys; forbidden auth overrides do not dispatch", async () => {
	let requests = 0; denied = true;
	try {
		for (const p of NATIVE_SUBSCRIPTIONS) {
			const model = piModels().getModels(p.providerId)[0]!, engine = piEngineForSpec({ provider: p.logicalId, id: model.id }, false);
			const fetch = async () => { requests++; throw new Error("must not dispatch"); };
			assert.equal((await engine.streamFn(engine.model, context, { fetch }).result()).stopReason, "error");
			assert.equal((await engine.streamFn(engine.model, context, { fetch, headers: { AUTHORIZATION: null } }).result()).stopReason, "error");
		}
		assert.equal(requests, 0);
	} finally { denied = false; }
});
test("a helper refused before dispatch reports no phantom usage or extraction step", async () => {
	denied = true; let usage = 0, steps = 0;
	try {
		const model = piModels().getModels("xai")[0]!, engine = piEngineForSpec({ provider: "xai-subscription", id: model.id });
		await assert.rejects(runSubagent([], { role: "researcher", engine, systemPrompt: "Offline fixture", prompt: "Do not dispatch", maxTurns: 1, onUsage: () => { usage++; }, onAssistantMessage: () => { steps++; } }));
		assert.equal(usage, 0); assert.equal(steps, 0);
	} finally { denied = false; }
});
test("history treatment distinguishes the same model through API and subscription, retaining only own reasoning signatures", () => {
	const native = piModels().getModels("xai")[0]!;
	const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message: AssistantMessage = { role: "assistant", provider: "xai", api: native.api, model: native.id, timestamp: 0, stopReason: "stop", usage, content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"private-api-signature"}', redacted: true }] };
	const own: AssistantMessage = { ...message, provider: "xai-subscription", content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"own-signature"}', redacted: true }] };
	const logical: Model<Api> = { ...native, provider: "xai-subscription" };
	const transformed = subscriptionHistory(normalizeContext({ messages: [message, own] }), logical, "xai");
	assert.deepEqual((transformed.messages[0] as AssistantMessage).content, []);
	assert.equal((transformed.messages[1] as AssistantMessage).content[0]!.type, "thinking");
	assert.equal(message.content.length, 1);
});
test("background invalidation is provider-specific and preserves foreground controllers; stale updates cannot reenable it", () => {
	const foreground = subscriptionAbortController("xai", false), background = subscriptionAbortController("xai", true), other = subscriptionAbortController("github-copilot", true);
	revision++; const next = snapshot(); next.statuses.find((s) => s.providerId === "xai")!.allowBackgroundUse = false;
	emit({ channel: "lh:subscriptions", op: "changed", snapshot: next });
	assert(!foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert(!other.controller.signal.aborted);
	const stale = snapshot(); stale.statuses.forEach((s) => { s.revision = 0; }); emit({ channel: "lh:subscriptions", op: "changed", snapshot: stale });
	foreground.release(); background.release(); other.release();
});
test("framework IPC alone cannot request subscription credentials or retain a usable catalog", async () => {
	const previous = sends; delete process.env.LH_DESKTOP_SERVER;
	await assert.rejects(subscriptionRequest("snapshot"), /desktop app/); assert.equal(sends, previous); assert.deepEqual(nativeSubscriptionModels(), []);
	process.env.LH_DESKTOP_SERVER = "1";
});
