import assert from "node:assert/strict";
import test from "node:test";
import { androidRequestAuthorized } from "../src/server/android-access.ts";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";

const env = { LH_ANDROID: "1", LH_ANDROID_API_SECRET: "a".repeat(64), LH_ANDROID_ORIGIN: "http://127.0.0.1:41237" };
const headers = (extra: Record<string, string> = {}) => new Headers({ host: "127.0.0.1:41237", cookie: `lh_android=${"a".repeat(64)}`, ...extra });

test("Android local data requires the private window capability", () => {
	assert.equal(androidRequestAuthorized(headers(), env), true);
	assert.equal(androidRequestAuthorized(headers({ cookie: "" }), env), false);
	assert.equal(androidRequestAuthorized(headers({ cookie: `lh_android=${"b".repeat(64)}` }), env), false);
	assert.equal(androidRequestAuthorized(headers({ cookie: `lh_android=${"a".repeat(64)}; lh_android=invalid` }), env), false);
});
test("Android rejects cross-site requests and forged hosts even with a cookie", () => {
	assert.equal(androidRequestAuthorized(headers({ origin: env.LH_ANDROID_ORIGIN, "sec-fetch-site": "same-origin" }), env), true);
	assert.equal(androidRequestAuthorized(headers({ origin: "https://example.com" }), env), false);
	assert.equal(androidRequestAuthorized(headers({ "sec-fetch-site": "cross-site" }), env), false);
	assert.equal(androidRequestAuthorized(headers({ host: "example.com:41237" }), env), false);
});
test("Android missing launch configuration fails closed; other hosts are unchanged", () => {
	assert.equal(androidRequestAuthorized(headers(), { LH_ANDROID: "1" }), false);
	assert.equal(androidRequestAuthorized(headers(), { ...env, LH_ANDROID_API_SECRET: "short" }), false);
	assert.equal(androidRequestAuthorized(headers(), { ...env, LH_ANDROID_ORIGIN: "https://example.com" }), false);
	assert.equal(androidRequestAuthorized(new Headers(), {}), true);
});

test("Android proxy protects server-rendered courses and subscription APIs", () => {
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, env);
		for (const route of ["/", "/chat/new", "/api/subscriptions", "/api/events"]) {
			assert.equal(proxy(new NextRequest(env.LH_ANDROID_ORIGIN + route)).status, 403);
			assert.equal(proxy(new NextRequest(env.LH_ANDROID_ORIGIN + route, { headers: headers() })).headers.get("x-middleware-next"), "1");
		}
	} finally {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});
