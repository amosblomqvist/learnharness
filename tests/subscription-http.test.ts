import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import {
	SUBSCRIPTION_BODY_LIMIT_BYTES,
	createSubscriptionHttpHandlers,
	createSubscriptionHttpHandlersFromEnvironment,
	projectSubscriptionStatus,
	type SubscriptionHttpHandlers,
	type SubscriptionHttpService,
} from "../src/server/subscription-http.ts";
import {
	SubscriptionError,
	type SubscriptionMethod,
	type SubscriptionStatus,
} from "../src/core/subscription.ts";

const BASE = "http://localhost:3000";
const HEADER = "x-learnharness-subscription";

interface Calls {
	status: number;
	start: SubscriptionMethod[];
	reply: Array<{ id: string; promptId: string; input: string }>;
	cancel: string[];
	disconnect: number;
}

function status(overrides: Partial<SubscriptionStatus> = {}): SubscriptionStatus {
	return { state: "disconnected", ...overrides };
}

function fakeService(overrides: Partial<SubscriptionHttpService> = {}): { service: SubscriptionHttpService; calls: Calls } {
	const calls: Calls = { status: 0, start: [], reply: [], cancel: [], disconnect: 0 };
	const service: SubscriptionHttpService = {
		async status() {
			calls.status += 1;
			return status({ state: "connected", account: "acct-1" });
		},
		async start(method) {
			calls.start.push(method);
			return status({ state: "authorizing", attempt: { id: "attempt-1", method, expiresAt: 10, ownedHere: true } });
		},
		async reply(id, promptId, input) {
			calls.reply.push({ id, promptId, input });
			return status({ state: "authorizing" });
		},
		async cancel(id) {
			calls.cancel.push(id);
			return status({ state: "disconnected" });
		},
		async disconnect() {
			calls.disconnect += 1;
			return status({ state: "disconnected" });
		},
		...overrides,
	};
	return { service, calls };
}

function request(
	path: string,
	options: { method?: string; body?: string | Uint8Array; headers?: Record<string, string>; origin?: string | null } = {},
): Request {
	const method = options.method ?? "GET";
	const headers = new Headers({ host: "localhost:3000", [HEADER]: "1" });
	if (options.origin === undefined) {
		if (method !== "GET" && method !== "HEAD") headers.set("origin", BASE);
	} else if (options.origin !== null) {
		headers.set("origin", options.origin);
	}
	if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
	for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
	return new Request(`${BASE}${path}`, { method, headers, body: options.body as BodyInit | undefined });
}

function handlers(service: SubscriptionHttpService, now?: () => number): SubscriptionHttpHandlers {
	return createSubscriptionHttpHandlers(service, now ? { now, startLimit: { max: 2, windowMs: 1_000 } } : {});
}

// Next normalizes loopback URL authorities to localhost while preserving the
// raw Host header. These tests exercise that real framework behavior.
function nextRequest(
	path: string,
	options: { method?: string; headers?: Record<string, string>; origin?: string | null; base?: string } = {},
): NextRequest {
	const method = options.method ?? "GET";
	const base = options.base ?? "http://127.0.0.1:3000";
	const origin = new URL(base).origin;
	const headers = new Headers({ host: new URL(base).host, [HEADER]: "1" });
	if (options.origin === undefined) {
		if (method !== "GET" && method !== "HEAD") headers.set("origin", origin);
	} else if (options.origin !== null) {
		headers.set("origin", options.origin);
	}
	for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
	return new NextRequest(`${base}${path}`, { method, headers });
}

const PUBLIC_ORIGIN = "https://learn.example.com";

// A reverse proxy may send an internal proxy-to-server URL while preserving
// the browser's raw Host and Origin.
function proxiedRequest(
	path: string,
	options: { method?: string; body?: string; headers?: Record<string, string>; origin?: string | null } = {},
): Request {
	const method = options.method ?? "GET";
	const headers = new Headers({ host: "learn.example.com", [HEADER]: "1" });
	if (options.origin === undefined) {
		if (method !== "GET" && method !== "HEAD") headers.set("origin", PUBLIC_ORIGIN);
	} else if (options.origin !== null) {
		headers.set("origin", options.origin);
	}
	if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
	for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
	return new Request(`http://10.0.0.8:3000${path}`, { method, headers, body: options.body });
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function assertNoStore(response: Response): void {
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function assertSafeFailure(value: Record<string, unknown>): void {
	assert.equal(typeof value.error, "object");
	assert.ok(value.error);
	assert.equal(typeof (value.error as { code?: unknown }).code, "string");
	assert.equal(typeof (value.error as { message?: unknown }).message, "string");
}

describe("subscription HTTP status projection", () => {
	test("GET returns only the sanitized public status", async () => {
		const { service, calls } = fakeService({
			async status() {
				calls.status += 1;
				return {
					...status({ state: "connected", account: "acct-1" }),
					secret: "do-not-leak",
					attempt: {
						id: "attempt-1",
						method: "browser",
						expiresAt: 1_700_000_000_000,
						ownedHere: true,
						authorizationUrl: "https://evil.example/oauth",
						unsafeSupplierPath: "https://auth.openai.com/not-allowed",
						verificationUri: "https://auth.openai.com/codex/device",
						userCode: "ABCD-EFGH",
						promptId: "prompt-1",
						manualAvailable: true,
						callbackListening: false,
						providerToken: "do-not-leak",
					},
				} as SubscriptionStatus;
			},
		});
		const response = await handlers(service).getStatus(request("/api/subscription"));
		assert.equal(response.status, 200);
		assertNoStore(response);
		const value = await body(response);
		assert.deepEqual(value, {
			state: "connected",
			account: "acct-1",
			attempt: {
				id: "attempt-1",
				method: "browser",
				expiresAt: 1_700_000_000_000,
				ownedHere: true,
				verificationUri: "https://auth.openai.com/codex/device",
				userCode: "ABCD-EFGH",
				promptId: "prompt-1",
				manualAvailable: true,
				callbackListening: false,
			},
		});
		assert.equal(calls.status, 1);
	});

	test("unknown status states become a safe 500", async () => {
		const { service } = fakeService({ async status() { return { state: "hacked" } as unknown as SubscriptionStatus; } });
		const response = await handlers(service).getStatus(request("/api/subscription"));
		assert.equal(response.status, 500);
		assertNoStore(response);
		assertSafeFailure(await body(response));
	});
});

describe("subscription HTTP request guard", () => {
	test("rejects missing/invalid guard headers, hosts, and origins", async () => {
		const { service } = fakeService();
		const instance = handlers(service);
		const cases: Request[] = [
			request("/api/subscription", { headers: { [HEADER]: "0" } }),
			request("/api/subscription", { headers: { host: "evil.example" } }),
			request("/api/subscription/attempts", { method: "POST", headers: { [HEADER]: "" } }),
			request("/api/subscription/attempts", { method: "POST", origin: null }),
			request("/api/subscription/attempts", { method: "POST", origin: "http://evil.example" }),
			request("/api/subscription/attempts", { method: "POST", headers: { origin: `${BASE}.evil.example` } }),
			request("/api/subscription/attempts", { method: "POST", headers: { host: "evil.example", "x-forwarded-host": "localhost:3000" } }),
		];
		for (const candidate of cases) {
			const response = await instance.start(candidate);
			assert.equal(response.status, 403);
			assertNoStore(response);
			const value = await body(response);
			assertSafeFailure(value);
			assert.equal((value.error as { code?: unknown }).code, "subscription_invalid_input");
		}
		assert.ok(service);
	});

	test("GET may omit Origin but rejects a mismatched one", async () => {
		const { service } = fakeService();
		const instance = handlers(service);
		const accepted = await instance.getStatus(request("/api/subscription", { origin: null }));
		assert.equal(accepted.status, 200);
		const rejected = await instance.getStatus(request("/api/subscription", { origin: "http://evil.example" }));
		assert.equal(rejected.status, 403);
		assertNoStore(rejected);
	});

	test("forwarded headers are never trusted", async () => {
		const { service } = fakeService();
		const response = await handlers(service).start(
			request("/api/subscription/attempts", {
				method: "POST",
				headers: { host: "evil.example", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "https" },
			}),
		);
		assert.equal(response.status, 403);
	});

	test("accepts Next-normalized loopback URLs with the matching raw Host", async () => {
		const { service, calls } = fakeService();
		const instance = handlers(service);
		const normalized127 = nextRequest("/api/subscription");
		assert.equal(new URL(normalized127.url).hostname, "localhost");
		const accepted127 = await instance.getStatus(normalized127);
		assert.equal(accepted127.status, 200);
		assertNoStore(accepted127);

		const acceptedLocalhost = await instance.getStatus(nextRequest("/api/subscription", { base: "http://localhost:3000" }));
		assert.equal(acceptedLocalhost.status, 200);

		const acceptedIpv6 = await instance.getStatus(nextRequest("/api/subscription", { base: "http://[::1]:3000" }));
		assert.equal(acceptedIpv6.status, 200);

		const disconnected = await instance.disconnect(
			nextRequest("/api/subscription", { method: "DELETE", origin: "http://127.0.0.1:3000" }),
		);
		assert.equal(disconnected.status, 200);
		assert.equal(calls.disconnect, 1);
	});

	test("rejects loopback authority changes with a different port or non-loopback Host", async () => {
		const { service } = fakeService();
		const instance = handlers(service);
		for (const candidate of [
			nextRequest("/api/subscription", { headers: { host: "127.0.0.1:3001" } }),
			nextRequest("/api/subscription", { headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" } }),
			nextRequest("/api/subscription", { headers: { host: "localhost:3001" } }),
			nextRequest("/api/subscription", { headers: { host: "evil.example:3000" } }),
		]) {
			const response = await instance.getStatus(candidate);
			assert.equal(response.status, 403);
			assertNoStore(response);
		}
	});

	test("raw Host, not the normalized loopback URL, must match Origin", async () => {
		const { service, calls } = fakeService();
		const instance = handlers(service);
		const crossAlias = await instance.getStatus(
			nextRequest("/api/subscription", { origin: "http://localhost:3000" }),
		);
		assert.equal(crossAlias.status, 403);

		const mismatchedMutation = await instance.start(
			nextRequest("/api/subscription/attempts", {
				method: "POST",
				origin: "http://localhost:3000",
			}),
		);
		assert.equal(mismatchedMutation.status, 403);
		assert.equal(calls.start.length, 0);
	});

	test("configured HTTPS ports are independent of the internal HTTP default port", async () => {
		const { service } = fakeService();
		const atPort80 = createSubscriptionHttpHandlers(service, { applicationOrigin: "https://learn.example.com:80" });
		const valid = proxiedRequest("/api/subscription", {
			method: "DELETE",
			headers: { host: "learn.example.com:80" },
			origin: "https://learn.example.com:80",
		});
		assert.equal((await atPort80.disconnect(valid)).status, 200);
		const defaultHttps = createSubscriptionHttpHandlers(service, { applicationOrigin: PUBLIC_ORIGIN });
		const wrongPort = proxiedRequest("/api/subscription", {
			method: "DELETE",
			headers: { host: "learn.example.com:80" },
			origin: PUBLIC_ORIGIN,
		});
		assert.equal((await defaultHttps.disconnect(wrongPort)).status, 403);
	});

	test("configured application origin accepts an internal proxy URL", async () => {
		const { service, calls } = fakeService();
		const instance = createSubscriptionHttpHandlers(service, { applicationOrigin: PUBLIC_ORIGIN });
		const noOrigin = await instance.getStatus(proxiedRequest("/api/subscription"));
		assert.equal(noOrigin.status, 200);
		const withOrigin = await instance.getStatus(proxiedRequest("/api/subscription", { origin: PUBLIC_ORIGIN }));
		assert.equal(withOrigin.status, 200);
		const disconnected = await instance.disconnect(proxiedRequest("/api/subscription", { method: "DELETE" }));
		assert.equal(disconnected.status, 200);
		const started = await instance.start(
			proxiedRequest("/api/subscription/attempts", {
				method: "POST",
				body: JSON.stringify({ method: "browser" }),
			}),
		);
		assert.equal(started.status, 202);
		assert.deepEqual(calls.start, ["browser"]);
	});

	test("configured origin rejects foreign Host/Origin and ignores forwarded headers", async () => {
		const { service, calls } = fakeService();
		const instance = createSubscriptionHttpHandlers(service, { applicationOrigin: PUBLIC_ORIGIN });
		const rejected = [
			proxiedRequest("/api/subscription", { headers: { host: "evil.example" } }),
			proxiedRequest("/api/subscription", {
				headers: { host: "evil.example", "x-forwarded-host": "learn.example.com" },
			}),
			proxiedRequest("/api/subscription", { origin: "https://evil.example" }),
			proxiedRequest("/api/subscription", { origin: "http://learn.example.com" }),
			proxiedRequest("/api/subscription/attempts", {
				method: "POST",
				body: JSON.stringify({ method: "browser" }),
				origin: null,
			}),
		];
		for (const candidate of rejected) {
			const response = candidate.method === "POST"
				? await instance.start(candidate)
				: await instance.getStatus(candidate);
			assert.equal(response.status, 403);
			assertNoStore(response);
		}
		assert.equal(calls.start.length, 0);

		const forwardedIgnored = await instance.getStatus(
			proxiedRequest("/api/subscription", {
				origin: PUBLIC_ORIGIN,
				headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
			}),
		);
		assert.equal(forwardedIgnored.status, 200);

		const wrongPort = createSubscriptionHttpHandlers(service, {
			applicationOrigin: "https://learn.example.com:8443",
		});
		const missingPort = await wrongPort.getStatus(
			proxiedRequest("/api/subscription", { origin: "https://learn.example.com:8443" }),
		);
		assert.equal(missingPort.status, 403);
		const matchingPort = await wrongPort.getStatus(
			proxiedRequest("/api/subscription", {
				origin: "https://learn.example.com:8443",
				headers: { host: "learn.example.com:8443" },
			}),
		);
		assert.equal(matchingPort.status, 200);
	});

	test("invalid configured application origins fail closed", () => {
		const invalid = [
			"",
			"  https://learn.example.com",
			"learn.example.com",
			"ftp://learn.example.com",
			"https://learn.example.com/path",
			"https://user@learn.example.com",
			"https://learn.example.com?query=1",
			"https://learn.example.com#fragment",
		];
		for (const applicationOrigin of invalid) {
			assert.throws(
				() => createSubscriptionHttpHandlers(fakeService().service, { applicationOrigin }),
				/LH_SUBSCRIPTION_ORIGIN/,
				applicationOrigin,
			);
		}
	});

	test("environment composition reads LH_SUBSCRIPTION_ORIGIN once", async () => {
		const { service } = fakeService();
		const configured = createSubscriptionHttpHandlersFromEnvironment(service, {}, {
			LH_SUBSCRIPTION_ORIGIN: PUBLIC_ORIGIN,
		});
		assert.equal((await configured.getStatus(proxiedRequest("/api/subscription"))).status, 200);
		assert.throws(
			() => createSubscriptionHttpHandlersFromEnvironment(service, {}, {
				LH_SUBSCRIPTION_ORIGIN: "https://learn.example.com/path",
			}),
			/LH_SUBSCRIPTION_ORIGIN/,
		);
		const local = createSubscriptionHttpHandlersFromEnvironment(service, {}, {});
		assert.equal((await local.getStatus(request("/api/subscription"))).status, 200);
	});
});

describe("subscription HTTP body handling", () => {
	test("start accepts exactly {method} and returns 202", async () => {
		const { service, calls } = fakeService();
		const response = await handlers(service).start(
			request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "browser" }) }),
		);
		assert.equal(response.status, 202);
		assertNoStore(response);
		assert.deepEqual(calls.start, ["browser"]);
	});

	test("rejects wrong content type, oversize, invalid UTF-8, non-object, and extra fields", async () => {
		const { service } = fakeService();
		const instance = handlers(service);
		const cases: Request[] = [
			request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "browser" }), headers: { "content-type": "text/plain" } }),
			request("/api/subscription/attempts", {
				method: "POST",
				body: JSON.stringify({ method: "browser" }),
				headers: { "content-length": String(SUBSCRIPTION_BODY_LIMIT_BYTES + 1) },
			}),
			request("/api/subscription/attempts", { method: "POST", body: "x".repeat(SUBSCRIPTION_BODY_LIMIT_BYTES + 1) }),
			request("/api/subscription/attempts", { method: "POST", body: new Uint8Array([0xff, 0xfe]) }),
			request("/api/subscription/attempts", { method: "POST", body: "[]" }),
			request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "browser", extra: true }) }),
			request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "manual" }) }),
		];
		for (const candidate of cases) {
			const response = await instance.start(candidate);
			assert.equal(response.status === 400 || response.status === 413 || response.status === 415, true);
			assertNoStore(response);
			assertSafeFailure(await body(response));
		}
	});

	test("rate limits successful start requests in a fixed window", async () => {
		let now = 1_000;
		const { service, calls } = fakeService();
		const instance = handlers(service, () => now);
		const make = () => request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "device_code" }) });
		assert.equal((await instance.start(make())).status, 202);
		assert.equal((await instance.start(make())).status, 202);
		const limited = await instance.start(make());
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "1");
		assertNoStore(limited);
		const limitedBody = await body(limited);
		assertSafeFailure(limitedBody);
		assert.equal((limitedBody.error as { message?: unknown }).message, "Too many authorization attempts. Try again later.");
		assert.equal(calls.start.length, 2);
		now += 1_000;
		assert.equal((await instance.start(make())).status, 202);
		assert.equal(calls.start.length, 3);
	});

	test("rate window is shared across route entries by rateLimitKey", async () => {
		const key = `test-${process.pid}-${Date.now()}-shared`;
		const { service } = fakeService();
		const make = () => request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "browser" }) });
		const first = createSubscriptionHttpHandlers(service, { rateLimitKey: key, startLimit: { max: 1, windowMs: 1_000 } });
		const second = createSubscriptionHttpHandlers(service, { rateLimitKey: key });
		assert.equal((await first.start(make())).status, 202);
		assert.equal((await second.start(make())).status, 429);
	});
});

describe("subscription HTTP reply, cancel, and disconnect", () => {
	test("reply validates and forwards the complete callback URL", async () => {
		const { service, calls } = fakeService();
		const url = "http://localhost:1455/auth/callback?code=abc&state=xyz";
		const response = await handlers(service).reply(
			request("/api/subscription/attempts/attempt-1/input", {
				method: "POST",
				body: JSON.stringify({ promptId: "prompt-1", value: url }),
			}),
			"attempt-1",
		);
		assert.equal(response.status, 200);
		assertNoStore(response);
		assert.deepEqual(calls.reply, [{ id: "attempt-1", promptId: "prompt-1", input: url }]);
	});

	test("reply accepts 127.0.0.1 and rejects bare codes / unsafe URLs", async () => {
		const acceptedUrl = "http://127.0.0.1:1455/auth/callback?state=xyz&code=abc";
		const { service, calls } = fakeService();
		const instance = handlers(service);
		const accepted = await instance.reply(
			request("/api/subscription/attempts/a/input", {
				method: "POST",
				body: JSON.stringify({ promptId: "p", value: acceptedUrl }),
			}),
			"a",
		);
		assert.equal(accepted.status, 200);
		assert.deepEqual(calls.reply, [{ id: "a", promptId: "p", input: acceptedUrl }]);

		const invalidValues = [
			"abc",
			"http://localhost:1455/auth/callback?code=abc",
			"http://localhost:1455/auth/callback?code=abc&state=",
			"http://localhost:1455/auth/callback?code=abc&code=def&state=xyz",
			"http://localhost:1455/auth/callback?code=abc&state=xyz&state=other",
			"https://localhost:1455/auth/callback?code=abc&state=xyz",
			"http://localhost:1456/auth/callback?code=abc&state=xyz",
			"http://localhost:1455/other?code=abc&state=xyz",
			"http://localhost:1455/auth/callback?code=abc&state=xyz#fragment",
			"http://user@localhost:1455/auth/callback?code=abc&state=xyz",
			"http://localhost:1455/auth/callback?code=abc&state=xyz&error=access_denied",
			"http://localhost:1455/auth/callback?code=a%0Ab&state=xyz",
		];
		for (const value of invalidValues) {
			const response = await instance.reply(
				request("/api/subscription/attempts/a/input", { method: "POST", body: JSON.stringify({ promptId: "p", value }) }),
				"a",
			);
			assert.equal(response.status, 400, value);
			assertSafeFailure(await body(response));
		}
		assert.equal(calls.reply.length, 1);
	});

	test("reply rejects extra fields and missing strings", async () => {
		const { service } = fakeService();
		const instance = handlers(service);
		for (const bodyValue of [
			{ promptId: "p", value: "http://localhost:1455/auth/callback?code=a&state=s", extra: true },
			{ promptId: "", value: "http://localhost:1455/auth/callback?code=a&state=s" },
			{ promptId: "p", value: "" },
			{ promptId: "p" },
		]) {
			const response = await instance.reply(
				request("/api/subscription/attempts/a/input", { method: "POST", body: JSON.stringify(bodyValue) }),
				"a",
			);
			assert.equal(response.status, 400);
		}
	});

	test("void reply results are followed by a status read", async () => {
		const { service, calls } = fakeService();
		service.reply = async (id, promptId, input) => {
			calls.reply.push({ id, promptId, input });
		};
		const response = await handlers(service).reply(
			request("/api/subscription/attempts/a/input", {
				method: "POST",
				body: JSON.stringify({ promptId: "p", value: "http://localhost:1455/auth/callback?code=a&state=s" }),
			}),
			"a",
		);
		assert.equal(response.status, 200);
		assert.equal(calls.reply.length, 1);
		assert.equal(calls.status, 1);
	});

	test("cancel and disconnect are guarded mutations", async () => {
		const { service, calls } = fakeService();
		const instance = handlers(service);
		const cancelled = await instance.cancel(request("/api/subscription/attempts/attempt-1", { method: "DELETE" }), "attempt-1");
		assert.equal(cancelled.status, 200);
		assert.deepEqual(calls.cancel, ["attempt-1"]);
		const disconnected = await instance.disconnect(request("/api/subscription", { method: "DELETE" }));
		assert.equal(disconnected.status, 200);
		assert.equal(calls.disconnect, 1);
		const missingOrigin = await instance.cancel(request("/api/subscription/attempts/attempt-1", { method: "DELETE", origin: null }), "attempt-1");
		assert.equal(missingOrigin.status, 403);
	});
});

describe("subscription HTTP safe failures", () => {
	test("known subscription errors are mapped without exposing raw text", async () => {
		const { service } = fakeService({
			async status() {
				throw new SubscriptionError("subscription_storage_error");
			},
		});
		const response = await handlers(service).getStatus(request("/api/subscription"));
		assert.equal(response.status, 503);
		assertNoStore(response);
		const value = await body(response);
		assertSafeFailure(value);
		assert.equal((value.error as { code?: unknown }).code, "subscription_storage_error");
	});

	test("storage-named and unknown errors are safely redacted", async () => {
		for (const error of [Object.assign(new Error("raw secret refresh-token"), { name: "SubscriptionStorageError" }), new Error("raw secret refresh-token")]) {
			const { service } = fakeService({ async start() { throw error; } });
			const response = await handlers(service).start(
				request("/api/subscription/attempts", { method: "POST", body: JSON.stringify({ method: "browser" }) }),
			);
			assert.equal(response.status === 503 || response.status === 500, true);
			assertNoStore(response);
			const text = await response.text();
			assert.equal(text.includes("refresh-token"), false);
			assert.equal(text.includes("raw secret"), false);
		}
	});

	test("an invalid attempt identifier is rejected before the service", async () => {
		const { service, calls } = fakeService();
		const response = await handlers(service).cancel(request("/api/subscription/attempts/x", { method: "DELETE" }), "");
		assert.equal(response.status, 400);
		assert.deepEqual(calls.cancel, []);
	});
});

test("projectSubscriptionStatus rejects malformed values directly", () => {
	assert.throws(() => projectSubscriptionStatus(null));
	assert.throws(() => projectSubscriptionStatus({ state: "nope" }));
});

test("the live route module delegates actual requests with a temp data dir", () => {
	const directory = mkdtempSync(join(tmpdir(), "lh-subscription-http-"));
	try {
		const script = `
(async () => {
	const { NextRequest } = await import("next/server");
	const { GET } = await import("./app/api/subscription/route.ts");
	const ok = await GET(new NextRequest("http://127.0.0.1:3000/api/subscription", {
		headers: { host: "127.0.0.1:3000", "x-learnharness-subscription": "1" },
	}));
	const body = await ok.json();
	const blocked = await GET(new Request("http://localhost:3000/api/subscription", {
		headers: { host: "localhost:3000" },
	}));
	console.log(JSON.stringify({ status: ok.status, cache: ok.headers.get("cache-control"), body, blocked: blocked.status }));
})().catch((error) => { console.error(error); process.exit(1); });
`;
		const result = spawnSync(
			process.execPath,
			["--import", fileURLToPath(import.meta.resolve("tsx")), "-e", script],
			{ cwd: process.cwd(), encoding: "utf8", env: { ...process.env, LH_DATA_DIR: directory, NODE_ENV: "test" } },
		);
		assert.equal(result.status, 0, result.stderr);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
		assert.equal(value.status, 200);
		assert.equal(value.cache, "no-store");
		assert.deepEqual(value.body, { state: "disconnected" });
		assert.equal(value.blocked, 403);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the live route module applies LH_SUBSCRIPTION_ORIGIN to proxy requests", () => {
	const directory = mkdtempSync(join(tmpdir(), "lh-subscription-proxy-"));
	try {
		const script = `
(async () => {
	const { GET } = await import("./app/api/subscription/route.ts");
	const ok = await GET(new Request("http://10.0.0.8:3000/api/subscription", {
		headers: { host: "learn.example.com", "x-learnharness-subscription": "1" },
	}));
	const blocked = await GET(new Request("http://10.0.0.8:3000/api/subscription", {
		headers: { host: "evil.example", "x-forwarded-host": "learn.example.com", "x-learnharness-subscription": "1" },
	}));
	console.log(JSON.stringify({ status: ok.status, cache: ok.headers.get("cache-control"), body: await ok.json(), blocked: blocked.status }));
})().catch((error) => { console.error(error); process.exit(1); });
`;
		const result = spawnSync(
			process.execPath,
			["--import", fileURLToPath(import.meta.resolve("tsx")), "-e", script],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					LH_DATA_DIR: directory,
					LH_SUBSCRIPTION_ORIGIN: PUBLIC_ORIGIN,
					NODE_ENV: "test",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
		assert.equal(value.status, 200);
		assert.equal(value.cache, "no-store");
		assert.deepEqual(value.body, { state: "disconnected" });
		assert.equal(value.blocked, 403);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
