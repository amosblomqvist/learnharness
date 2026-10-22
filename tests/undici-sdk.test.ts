/**
 * Regression coverage for the undici security patch (issue #13).
 *
 * These tests exercise the real npm `undici` transport underneath the real
 * pi SDK (and the OpenAI SDK it composes for ordinary API keys). The npm
 * package is available through OpenAI's optional peer and the Electron
 * downloader's optional dependency under the repository's full `npm ci`.
 * Production normally uses global fetch, not this explicit npm transport.
 * Node's built-in fetch contains separate code but shares the dispatcher
 * registry. Replacing fetch with `undici.fetch` avoids cross-version pairing
 * with that built-in implementation during these controlled tests.
 *
 * Every request is mocked at the DNS/connect boundary with
 * `MockAgent.disableNetConnect()`. There is no real network, no user
 * credential, no `.env`/auth file and no application data directory. Each
 * subscription test owns a fresh `mkdtemp` store and removes it afterwards.
 *
 * The undici version is intentionally not pinned here: the first patched
 * release is installed by the isolating CI job, and this file must keep
 * proving the same transport behavior for that build. The SDK versions the
 * ticket pins are checked below. This is a transport/wiring regression, not
 * an exploit reproduction or a claim about the patched CVE.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import {
	getGlobalDispatcher,
	MockAgent,
	setGlobalDispatcher,
	fetch as undiciFetch,
} from "undici";
import {
	createModels,
	normalizeContext,
	type Credential,
	type CredentialStore,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { engineForCollection } from "../src/agent/models.ts";
import { createSubscriptionStore, type OAuthCredential } from "../src/store/subscription-credentials.ts";
import { createSubscriptionService } from "../src/server/subscription.ts";
import { createSubscriptionEngine } from "../src/server/subscription-engine.ts";

const CODEX_URL = new URL("https://chatgpt.com/backend-api/codex/responses");
const OPENAI_URL = new URL("https://api.openai.com/v1/responses");
const PROVIDER_SENTINEL = "synthetic-undici-provider-body-do-not-leak";
const SYNTHETIC_API_KEY = "synthetic-openai-api-key";

const token = (account = "account-undici") =>
	`e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const grant = (expires = Date.now() + 3600_000): OAuthCredential => ({
	type: "oauth",
	access: token(),
	refresh: "isolated-undici-refresh",
	expires,
	accountId: "account-undici",
});
const context = () =>
	normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });

interface CapturedRequest {
	origin?: string;
	path: string;
	method: string;
	headers?: unknown;
	body: Buffer;
}

interface MockReply {
	statusCode: number;
	data?: string;
	responseOptions?: { headers?: Record<string, string> };
}

type Responder = (request: CapturedRequest) => MockReply;

function captureRequest(options: {
	origin?: string;
	path: string;
	method: string;
	headers?: unknown;
	body?: unknown;
}): CapturedRequest {
	const body = options.body;
	let bytes: Buffer;
	if (body === undefined || body === null) bytes = Buffer.alloc(0);
	else if (Buffer.isBuffer(body)) bytes = body;
	else if (body instanceof Uint8Array) bytes = Buffer.from(body);
	else if (body instanceof ArrayBuffer) bytes = Buffer.from(body);
	else if (typeof body === "string") bytes = Buffer.from(body);
	else throw new Error(`unexpected mock request body: ${typeof body}`);
	return { origin: options.origin, path: options.path, method: options.method, headers: options.headers, body: bytes };
}

function header(headers: CapturedRequest["headers"], name: string): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	if ("get" in headers && typeof headers.get === "function") {
		return (headers.get(name) as string | null | undefined) ?? undefined;
	}
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	if (!entry) return undefined;
	const value = entry[1];
	if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
	return typeof value === "string" ? value : undefined;
}

function decodedBody(request: CapturedRequest): string {
	const encoding = header(request.headers, "content-encoding");
	if (encoding === "zstd") return zstdDecompressSync(request.body).toString("utf8");
	if (encoding === "gzip") return gunzipSync(request.body).toString("utf8");
	return request.body.toString("utf8");
}

interface MockHarness {
	mockAgent: MockAgent;
	requests: CapturedRequest[];
	websocketAttempts: number;
	intercept(origin: string, path: string, responder: Responder): void;
}

async function withMockedUndici<T>(run: (harness: MockHarness) => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	const originalDispatcher = getGlobalDispatcher();
	const originalWebSocket = globalThis.WebSocket;
	const mockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	setGlobalDispatcher(mockAgent);
	// The engine's own transport boundary reads `globalThis.fetch`; this is
	// the npm undici copy that MockAgent intercepts, not Node's built-in one.
	const npmFetch = undiciFetch as unknown as typeof globalThis.fetch;
	const fetchAttempts: string[] = [];
	globalThis.fetch = (input, init) => {
		fetchAttempts.push(input instanceof Request ? input.url : String(input));
		return npmFetch(input, init);
	};
	const harness: MockHarness = {
		mockAgent,
		requests: [],
		websocketAttempts: 0,
		intercept(origin, path, responder) {
			mockAgent.get(origin).intercept({ path, method: "POST" }).reply((options) => {
				const request = captureRequest(options);
				harness.requests.push(request);
				return responder(request);
			});
		},
	};
	// A throwing constructor is the assertion: the composed engine pins SSE,
	// so selection or fallback to a WebSocket would fail this test loudly.
	globalThis.WebSocket = class ForbiddenWebSocket {
		constructor() {
			harness.websocketAttempts++;
			throw new Error("WebSocket transport must not be selected");
		}
	} as unknown as typeof globalThis.WebSocket;
	try {
		const result = await run(harness);
		// Count unmatched attempts too: a blocked retry or source switch must
		// not disappear merely because the one-shot interceptor was consumed.
		assert.deepEqual(fetchAttempts, harness.requests.map((request) => `${request.origin}${request.path}`));
		assert.equal(harness.websocketAttempts, 0, "no WebSocket fallback");
		return result;
	} finally {
		try {
			await mockAgent.close();
		} finally {
			setGlobalDispatcher(originalDispatcher);
			globalThis.fetch = originalFetch;
			globalThis.WebSocket = originalWebSocket;
		}
	}
}

function sse(payloads: unknown | unknown[]): string {
	const events = Array.isArray(payloads) ? payloads : [payloads];
	return events.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseReply(payloads: unknown | unknown[]): MockReply {
	return {
		statusCode: 200,
		data: sse(payloads),
		responseOptions: { headers: { "content-type": "text/event-stream" } },
	};
}

function completedEvents(text = "synthetic answer"): unknown[] {
	return [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: text },
		completedPayload(text),
	];
}

function completedPayload(text = "synthetic answer"): unknown {
	return {
		type: "response.completed",
		response: {
			id: "response-undici",
			status: "completed",
			output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
			usage: {
				input_tokens: 7,
				output_tokens: 2,
				total_tokens: 9,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	};
}

async function subscriptionFixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-undici-sdk-"));
	try {
		const store = createSubscriptionStore(directory);
		await store.transaction(async (tx) => {
			await tx.save({ ...tx.state, credential: grant() });
		});
		const service = createSubscriptionService(store);
		const generation = (await store.getSnapshot()).generation;
		const engine = createSubscriptionEngine(service, { provider: "openai-codex", id: "gpt-6-luna" }, generation);
		return { directory, store, service, engine };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

async function packageJsonPath(specifier: string): Promise<string> {
	const entry = fileURLToPath(import.meta.resolve(specifier));
	let directory = path.dirname(entry);
	while (true) {
		const candidate = path.join(directory, "package.json");
		if (path.basename(directory) !== "node_modules") {
			try {
				const pkg = JSON.parse(await readFile(candidate, "utf8")) as { name?: string };
				if (pkg.name) return candidate;
			} catch {
				// Keep walking up to the package root.
			}
		}
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error(`no package.json above ${entry}`);
		directory = parent;
	}
}

test("the regression loads the workspace npm undici and the pinned SDK versions", async () => {
	const undiciEntry = fileURLToPath(import.meta.resolve("undici"));
	assert.match(undiciEntry, /[\\/]node_modules[\\/]undici[\\/]/, "test must load the npm package, not a runtime built-in");
	assert.doesNotMatch(undiciEntry, /[\\/]openai[\\/]node_modules[\\/]undici[\\/]/, "test must load the workspace-root undici");
	const undici = JSON.parse(await readFile(path.join(path.dirname(undiciEntry), "package.json"), "utf8")) as { version?: string };
	assert.match(undici.version ?? "", /^7\./, "the patch is a 7.x release; the exact fixed version is supplied by CI");

	for (const [specifier, expected] of [
		["@earendil-works/pi-ai", "1.0.2"],
		["@earendil-works/pi-agent-core", "1.0.2"],
		["openai", "7.19.0"],
	] as const) {
		const pkg = JSON.parse(await readFile(await packageJsonPath(specifier), "utf8")) as { version?: string };
		assert.equal(pkg.version, expected, `${specifier} version must stay pinned`);
	}
});

test("real npm undici carries the OAuth request to the exact Codex source once, with no override or WebSocket switch", async () => {
	const f = await subscriptionFixture();
	try {
		await withMockedUndici(async (harness) => {
			harness.intercept(CODEX_URL.origin, CODEX_URL.pathname, () => sseReply(completedEvents()));
			let callerFetchCalls = 0;
			const result = await f.engine
				.streamFn(f.engine.model, context(), {
					apiKey: "other-paid-key",
					headers: { Authorization: "other-paid-key" },
					transport: "websocket",
					maxRetries: 9,
					fetch: async () => {
						callerFetchCalls++;
						throw new Error("caller fetch must not execute");
					},
				})
				.result();

			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.deepEqual(result.content, [{ type: "text", text: "synthetic answer" }]);
			assert.equal(result.usage.input, 7);
			assert.equal(result.usage.output, 2);
			assert.equal(callerFetchCalls, 0, "caller transport override must not execute");
			assert.equal(harness.websocketAttempts, 0, "the pinned SSE transport must not switch to WebSocket");
			assert.equal(harness.requests.length, 1, "one send only");
			const request = harness.requests[0]!;
			assert.equal(request.origin, CODEX_URL.origin);
			assert.equal(request.path, CODEX_URL.pathname);
			assert.equal(request.method, "POST");
			assert.equal(header(request.headers, "authorization"), `Bearer ${token()}`);
			assert.equal(header(request.headers, "chatgpt-account-id"), "account-undici");
			const body = JSON.parse(decodedBody(request)) as { model?: string; input?: unknown; stream?: boolean };
			assert.equal(body.model, "gpt-6-luna", "the selected model must not switch");
			assert.equal(body.stream, true);
			assert.match(JSON.stringify(body.input), /Hello/, "the transcript reaches the provider");
			harness.mockAgent.assertNoPendingInterceptors();
			assert.equal((await f.service.status()).state, "connected");
		});
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("real npm undici classifies HTTP 429 and 500 once, with no retry and no leaked body", async () => {
	const scenarios = [
		{ status: 429, body: { error: { code: "usage_limit_reached", message: PROVIDER_SENTINEL } }, code: "subscription_limit" },
		{ status: 500, body: { error: { message: PROVIDER_SENTINEL } }, code: "subscription_unknown" },
	] as const;
	for (const scenario of scenarios) {
		const f = await subscriptionFixture();
		try {
			await withMockedUndici(async (harness) => {
				harness.intercept(CODEX_URL.origin, CODEX_URL.pathname, () => ({
					statusCode: scenario.status,
					data: JSON.stringify(scenario.body),
					responseOptions: { headers: { "content-type": "application/json" } },
				}));
				const result = await f.engine.streamFn(f.engine.model, context(), { maxRetries: 9, transport: "auto" }).result();
				assert.equal(result.stopReason, "error");
				assert.equal(
					result.diagnostics?.find((diagnostic) => diagnostic.type === "subscription_error")?.details?.code,
					scenario.code,
				);
				assert.doesNotMatch(JSON.stringify(result), new RegExp(PROVIDER_SENTINEL));
				assert.doesNotMatch(JSON.stringify(result), /isolated-undici-refresh/);
				assert.equal(harness.requests.length, 1, `${scenario.status} must not retry`);
				const sent = JSON.parse(decodedBody(harness.requests[0]!)) as { model?: string };
				assert.equal(sent.model, "gpt-6-luna", `${scenario.status} must not switch models`);
				assert.equal((await f.service.status()).state, "connected");
			});
		} finally {
			await rm(f.directory, { recursive: true, force: true });
		}
	}
});

test("real npm undici keeps both 200 SSE failure shapes out of immediate and retained events", async () => {
	const scenarios = [
		{
			label: "response.failed",
			payload: {
				type: "response.failed",
				response: { id: "response-failed", status: "failed", error: { code: "usage_limit_reached", message: PROVIDER_SENTINEL }, output: [] },
			},
			code: "subscription_limit",
		},
		{
			label: "error",
			payload: { type: "error", code: "model_not_found", message: PROVIDER_SENTINEL },
			code: "subscription_model_unavailable",
		},
	] as const;
	for (const scenario of scenarios) {
		const f = await subscriptionFixture();
		try {
			await withMockedUndici(async (harness) => {
				harness.intercept(CODEX_URL.origin, CODEX_URL.pathname, () =>
					sseReply([{ type: "response.output_text.delta", output_index: 0, delta: "partial" }, scenario.payload]),
				);
				const consumed: unknown[] = [];
				const retained: unknown[] = [];
				const stream = f.engine.streamFn(f.engine.model, context());
				for await (const event of stream) {
					retained.push(event);
					// A forwarding consumer (SSE writer, log sink) serializes at receipt.
					consumed.push(JSON.parse(JSON.stringify(event)));
				}
				const result = await stream.result();
				assert.equal(result.stopReason, "error", scenario.label);
				assert.equal(
					result.diagnostics?.find((diagnostic) => diagnostic.type === "subscription_error")?.details?.code,
					scenario.code,
					scenario.label,
				);
				assert.doesNotMatch(JSON.stringify(consumed), new RegExp(PROVIDER_SENTINEL), `${scenario.label} consumed`);
				assert.doesNotMatch(JSON.stringify(retained), new RegExp(PROVIDER_SENTINEL), `${scenario.label} retained`);
				assert.doesNotMatch(JSON.stringify(result), new RegExp(PROVIDER_SENTINEL), `${scenario.label} result`);
				const partials = retained.filter(
					(event): event is { type: string; partial: { errorMessage?: unknown; diagnostics?: unknown } } =>
						typeof event === "object" && event !== null && "partial" in event,
				);
				assert.ok(partials.length > 0, `${scenario.label} delivered partials`);
				for (const event of partials) {
					assert.equal("errorMessage" in event.partial, false, `${scenario.label} ${event.type}`);
					assert.equal("diagnostics" in event.partial, false, `${scenario.label} ${event.type}`);
				}
				assert.equal(harness.requests.length, 1, `${scenario.label} one send only`);
				const sent = JSON.parse(decodedBody(harness.requests[0]!)) as { model?: string };
				assert.equal(sent.model, "gpt-6-luna", `${scenario.label} must not switch models`);
			});
		} finally {
			await rm(f.directory, { recursive: true, force: true });
		}
	}
});

test("the ordinary API-key path runs the real OpenAI SDK through npm undici once", async () => {
	let credential: Credential | undefined = { type: "api_key", key: SYNTHETIC_API_KEY };
	const credentials: CredentialStore = {
		read: async (provider) => (provider === "openai" ? credential : undefined),
		list: async () => [],
		delete: async (provider) => {
			if (provider === "openai") credential = undefined;
		},
		modify: async (provider, fn) => {
			if (provider !== "openai") return undefined;
			credential = (await fn(credential)) ?? credential;
			return credential;
		},
	};
	const models = createModels({ credentials });
	models.setProvider(openaiProvider());
	const engine = engineForCollection({ provider: "openai", id: "gpt-4.1-mini" }, models);

	await withMockedUndici(async (harness) => {
		harness.intercept(OPENAI_URL.origin, OPENAI_URL.pathname, () => sseReply(completedEvents()));
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(result.content, [{ type: "text", text: "synthetic answer" }]);
		assert.equal(harness.requests.length, 1, "one send only");
		const request = harness.requests[0]!;
		assert.equal(request.origin, OPENAI_URL.origin);
		assert.equal(request.path, OPENAI_URL.pathname);
		assert.equal(request.method, "POST");
		assert.equal(header(request.headers, "authorization"), `Bearer ${SYNTHETIC_API_KEY}`);
		const body = JSON.parse(decodedBody(request)) as { model?: string; stream?: boolean };
		assert.equal(body.model, "gpt-4.1-mini");
		assert.equal(body.stream, true);
		harness.mockAgent.assertNoPendingInterceptors();
	});
});
