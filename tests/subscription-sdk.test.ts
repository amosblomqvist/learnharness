import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { createSubscriptionStore, type OAuthCredential } from "../src/store/subscription-credentials.ts";
import { createSubscriptionService } from "../src/server/subscription.ts";
import { createSubscriptionEngine } from "../src/server/subscription-engine.ts";
import { messageUsagePresence, messageUsageReported, piUsageToStep, type CallUsage, type TurnUsage } from "../src/core/contracts.ts";
import { callEstimate, turnEstimate } from "../src/core/prices.ts";

const token = (account = "account-contract") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const grant = (expires = Date.now() + 3600_000): OAuthCredential => ({ type: "oauth", access: token(), refresh: "isolated-refresh-old", expires, accountId: "account-contract" });
const context = () => normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
async function fixture(expires?: number) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-sdk-contract-"));
	const store = createSubscriptionStore(directory);
	await store.transaction(async (tx) => { await tx.save({ ...tx.state, credential: grant(expires) }); });
	const service = createSubscriptionService(store);
	const generation = (await store.getSnapshot()).generation;
	const engine = createSubscriptionEngine(service, { provider: "openai-codex", id: "gpt-6-luna" }, generation);
	return { directory, store, service, generation, engine };
}
function success() {
	const payload = { type: "response.completed", response: { id: "response-contract", status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9, input_tokens_details: { cached_tokens: 0 } } } };
	return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("real pi SDK sends only the selected legacy source and ignores injected auth/transport overrides", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	let calls = 0;
	let sent: { input: string; headers: Headers; body: string; redirect?: RequestRedirect } | undefined;
	globalThis.fetch = async (input, init) => {
		calls++;
		const headers = new Headers(init?.headers);
		const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
		sent = { input: String(input), headers, body: (headers.get("content-encoding") === "gzip" ? gunzipSync(bytes) : headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"), redirect: init?.redirect };
		return success();
	};
	try {
		const result = await f.engine.streamFn(f.engine.model, context(), { apiKey: "other-paid-key", headers: { Authorization: "other-paid-key" }, transport: "websocket", maxRetries: 9, fetch: async () => { throw new Error("Caller fetch must not execute"); } }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(sent!.input, "https://chatgpt.com/backend-api/codex/responses");
		assert.equal(sent!.headers.get("authorization"), `Bearer ${token()}`);
		assert.equal(sent!.headers.get("chatgpt-account-id"), "account-contract");
		assert.equal(JSON.parse(sent!.body).model, "gpt-6-luna");
		assert.equal(sent!.redirect, "error");
		assert.equal(messageUsageReported(result), true);
		assert.equal(result.usage.input, 7);
		assert.equal(result.usage.output, 2);
		assert.equal(calls, 1);
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("real SDK HTTP and network failures send once, classify only known codes and redact bodies", async () => {
	for (const scenario of [
		{ status: 429, body: { error: { code: "usage_limit_reached", message: "private-provider-secret" } }, code: "subscription_limit" },
		{ status: 403, body: { error: { code: "model_not_found" } }, code: "subscription_model_unavailable" },
		{ status: 401, body: { error: { message: "private-provider-secret" } }, code: "subscription_unknown" },
		{ status: 500, body: { error: { message: "private-provider-secret" } }, code: "subscription_unknown" },
		{ status: 0, body: {}, code: "subscription_network" },
	]) {
		const f = await fixture();
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; if (!scenario.status) throw new Error("private-network-secret"); return Response.json(scenario.body, { status: scenario.status }); };
		try {
			const result = await f.engine.streamFn(f.engine.model, context()).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage!, new RegExp(scenario.code));
			assert.doesNotMatch(JSON.stringify(result), /private-provider-secret|private-network-secret|isolated-refresh-old/);
			assert.equal(calls, 1);
			assert.equal((await f.service.status()).state, "connected");
		} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
	}
});

test("concurrent real SDK refresh serializes rotation once and both streams use the durable new token", async () => {
	const f = await fixture(Date.now() - 1000);
	const original = globalThis.fetch;
	let refreshes = 0;
	let sends = 0;
	globalThis.fetch = async (input, init) => {
		if (String(input) === "https://auth.openai.com/oauth/token") {
			refreshes++;
			assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "isolated-refresh-old");
			return Response.json({ access_token: token("rotated-account"), refresh_token: "isolated-refresh-new", expires_in: 3600 });
		}
		sends++;
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token("rotated-account")}`);
		return success();
	};
	try {
		const [a, b] = await Promise.all([f.engine.streamFn(f.engine.model, context()).result(), f.engine.streamFn(f.engine.model, context()).result()]);
		assert.equal(a.stopReason, "stop", a.errorMessage);
		assert.equal(b.stopReason, "stop", b.errorMessage);
		assert.equal(refreshes, 1);
		assert.equal(sends, 2);
		assert.equal((await f.store.snapshot()).journal, undefined);
		assert.equal((await f.store.getSnapshot()).credential!.refresh, "isolated-refresh-new");
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("confirmed invalid_grant disconnects only its generation; ambiguous refresh remains quarantined after reconstruction", async () => {
	for (const recognized of [true, false]) {
		const f = await fixture(Date.now() - 1);
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; return Response.json(recognized ? { error: "invalid_grant", error_description: "private-refresh-secret" } : { error: "unfamiliar", secret: "private-refresh-secret" }, { status: 400 }); };
		try {
			const result = await f.engine.streamFn(f.engine.model, context()).result();
			assert.match(result.errorMessage!, new RegExp(recognized ? "subscription_needs_login" : "subscription_recovery_required"));
			assert.doesNotMatch(JSON.stringify(result), /private-refresh-secret|isolated-refresh-old/);
			const restarted = createSubscriptionService(createSubscriptionStore(f.directory));
			assert.equal((await restarted.status()).state, recognized ? "disconnected" : "reconnect_required");
			await f.engine.streamFn(f.engine.model, context()).result();
			assert.equal(calls, 1);
			await restarted.disconnect();
			assert.equal((await restarted.status()).state, "disconnected");
		} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
	}
});

test("an engine from a disconnected generation cannot send with a later account", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => { calls++; return success(); };
	try {
		await f.service.disconnect();
		await f.store.transaction(async (tx) => { await tx.save({ ...tx.state, credential: grant() }); });
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.match(result.errorMessage!, /subscription_needs_login/);
		assert.equal(calls, 0);
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

// ─── usage presence (accounting wave, issue #8 P2) ──────────────────────────
// The real SDK seeds every assistant message with all-zero usage; only a
// terminal `response.completed|incomplete` carrying `response.usage` proves
// the supplier reported a call. Capture must project an unreported call as
// unknown, never as a priced $0 complete.

const PRICED = "openai-codex:gpt-6-luna";

/** What a capture site persists for one engine result. */
function capturedStep(result: AssistantMessage) {
	return piUsageToStep(result.usage, messageUsagePresence(result));
}

/** The money channel's CallUsage shape for that same capture (an
 *  unreported field stays undefined — CallUsage's own contract). */
function capturedCallUsage(result: AssistantMessage): CallUsage {
	const step = capturedStep(result);
	return {
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
		cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
		reasoningTokens: step.outputTokenDetails?.reasoningTokens,
	};
}

function progressStream() {
	// A 200 SSE response that starts (a delta) and then dies before any
	// terminal event — the shape of a dropped connection mid-answer.
	return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial answer" })}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function terminalUsageStream(usage: Record<string, unknown>) {
	// A terminal event whose usage payload is exactly what the supplier sent
	// — the only place a trustworthy report can come from.
	const payload = { type: "response.completed", response: { id: "response-usage", status: "completed", output: [], usage } };
	return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function zeroUsageStream() {
	// A full explicit zero: every reported field present and 0 (the SDK's
	// seeded zeros without details prove nothing — see the partial cases).
	const payload = { type: "response.completed", response: { id: "response-zero", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } };
	return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("a rejected subscription request reports no usage: the step folds to unknown, never $0", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ error: { message: "private-provider-secret" } }, { status: 401 });
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "error");
		// Nothing was reported: no trusted usage signal, so capture is unknown.
		assert.equal(messageUsageReported(result), false);
		const step = capturedStep(result);
		assert.equal(step.inputTokens, undefined);
		assert.equal(step.outputTokens, undefined);
		assert.equal(step.inputTokenDetails, undefined);
		// The money channel: absent, not a priced zero.
		assert.deepEqual(callEstimate(step, PRICED), { dollars: null, coverage: "unknown", pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 1 });
		const turn: TurnUsage = { id: "t1", messageId: "m1", at: "2026-10-19T00:00:00Z", model: PRICED, steps: [capturedCallUsage(result)] };
		assert.equal(turnEstimate(turn).dollars, null);
		assert.equal(turnEstimate(turn).coverage, "unknown");
		// Diagnostics stay sanitized: the presence flag and the safe code only.
		const marker = result.diagnostics?.find((diagnostic) => diagnostic.type === "usage_report");
		assert.equal(marker?.details?.reported, false);
		assert.doesNotMatch(JSON.stringify(result), /private-provider-secret|isolated-refresh-old/);
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("a 200 stream that dies before its terminal event reports no usage", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => progressStream();
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /subscription_/);
		// Started, never completed: the partial text may survive, the usage may not.
		assert.equal(messageUsageReported(result), false);
		const step = capturedStep(result);
		assert.equal(step.inputTokens, undefined);
		assert.equal(step.outputTokens, undefined);
		assert.equal(callEstimate(step, PRICED).coverage, "unknown");
		assert.doesNotMatch(JSON.stringify(result), /isolated-refresh-old/);
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("a terminal event carrying only a total is not a reported call: it stays unknown", async () => {
	// `total_tokens` alone proves nothing about the priced sides. The SDK
	// fills the missing fields with zeros, so trusting the total would price
	// an unreported call as a complete $0.
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({ total_tokens: 12 });
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(messageUsageReported(result), false);
		const step = capturedStep(result);
		assert.equal(step.inputTokens, undefined);
		assert.equal(step.outputTokens, undefined);
		assert.deepEqual(callEstimate(step, PRICED), { dollars: null, coverage: "unknown", pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 1 });
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("a terminal event with only one side of the breakdown is not a reported call", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({ input_tokens: 9 });
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(messageUsageReported(result), false, "not priceable as a whole");
		const step = capturedStep(result);
		assert.equal(step.inputTokens, 9, "the obtained field survives");
		assert.equal(step.outputTokens, undefined);
		assert.equal(callEstimate(capturedCallUsage(result), PRICED).coverage, "unknown");
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("input-only usage keeps the reported token: only the missing side is unknown", async () => {
	// Plan law: preserve EACH obtained token field. A supplier that reports
	// input but not output still billed input — capture keeps it.
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({ input_tokens: 9 });
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const step = capturedStep(result);
		assert.equal(step.inputTokens, 9, "the reported token survives");
		assert.equal(step.outputTokens, undefined, "the unreported side stays unknown");
		const estimate = callEstimate(step, PRICED);
		assert.equal(estimate.dollars, null, "no price without both sides");
		assert.equal(estimate.missingUsageCalls, 1);
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("input/output reported without cache details: tokens survive, the cost stays unknown", async () => {
	// The SDK defaults the cache fields to 0; an absent cache report must not
	// become "a complete $0-cache bill" — the price of the cached portion is
	// simply not knowable, so no complete dollar figure.
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({ input_tokens: 7, output_tokens: 2 });
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(messageUsageReported(result), true, "both priced sides were reported");
		const step = capturedStep(result);
		assert.equal(step.inputTokens, 7);
		assert.equal(step.outputTokens, 2);
		assert.equal(step.inputTokenDetails?.cacheReadTokens, undefined);
		assert.equal(step.inputTokenDetails?.cacheWriteTokens, undefined);
		assert.equal(step.outputTokenDetails?.reasoningTokens, undefined);
		const estimate = callEstimate(step, PRICED);
		assert.equal(estimate.dollars, null);
		assert.notEqual(estimate.coverage, "complete");
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("a full explicit report stays complete even when reasoning is not itemized", async () => {
	// Reasoning rides inside output tokens; its itemization is not money.
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({
		input_tokens: 7,
		output_tokens: 2,
		input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
	});
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		const step = capturedStep(result);
		assert.equal(step.inputTokenDetails?.cacheReadTokens, 0);
		assert.equal(step.outputTokenDetails?.reasoningTokens, undefined);
		assert.equal(callEstimate(capturedCallUsage(result), PRICED).coverage, "complete");
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("capture restores total input: the SDK's fresh-input figure is not double-discounted", async () => {
	// The SDK reports input as raw minus cached minus cache-write
	// (openai-responses-shared.js finalizeResponse); CallUsage persists the
	// TOTAL and the price fold subtracts the cache part once. Re-capturing
	// the SDK's 100 here would make priceCall subtract 900 twice.
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => terminalUsageStream({
		input_tokens: 1_000,
		output_tokens: 10,
		input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
	});
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.usage.input, 100, "the SDK's own figure stays fresh");
		const step = capturedStep(result);
		assert.equal(step.inputTokens, 1_000, "capture persists the total input");
		assert.equal(step.inputTokenDetails?.cacheReadTokens, 900);
		const estimate = callEstimate(capturedCallUsage(result), PRICED);
		// 100 fresh @0.1 + 900 cache @0.01 + 10 out @0.5, per 1M tokens.
		assert.ok(estimate.dollars !== null);
		assert.ok(Math.abs(estimate.dollars - 2.4e-5) < 1e-12, `expected 2.4e-5, got ${estimate.dollars}`);
		assert.equal(estimate.coverage, "complete");
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});

test("a supplier-reported all-zero usage stays a real zero: priced complete at $0", async () => {
	const f = await fixture();
	const original = globalThis.fetch;
	globalThis.fetch = async () => zeroUsageStream();
	try {
		const result = await f.engine.streamFn(f.engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(messageUsageReported(result), true);
		const step = capturedStep(result);
		assert.equal(step.inputTokens, 0);
		assert.equal(step.outputTokens, 0);
		assert.deepEqual(callEstimate(capturedCallUsage(result), PRICED), { dollars: 0, coverage: "complete", pricedCalls: 1, unpricedCalls: 0, missingUsageCalls: 0 });
	} finally { globalThis.fetch = original; await rm(f.directory, { recursive: true, force: true }); }
});
