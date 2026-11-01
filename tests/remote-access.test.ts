import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
	SESSION_COOKIE,
	appsOnlyAllowed,
	SESSION_TTL_MS,
	isPublicPath,
	loginResponse,
	loginThrottled,
	mintSessionToken,
	passwordMatches,
	recordLoginFailure,
	remoteRequestAuthorized,
	safeNextPath,
	sessionTokenValid,
} from "../src/server/remote-access.ts";
import { proxy } from "../proxy.ts";

const env = { LH_SERVER_PASSWORD: "correct horse battery staple", LH_SESSION_SECRET: "s".repeat(48) };
const origin = "https://lh.example.test";

async function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	Object.assign(process.env, vars);
	try {
		await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

test("server mode off: every request is authorized (desktop and dev unchanged)", () => {
	assert(remoteRequestAuthorized(new Headers(), {}));
	assert(!sessionTokenValid(mintSessionToken(env), {}), "tokens mean nothing without server mode");
});

test("password check and session tokens: valid, expired, tampered, re-keyed", () => {
	assert(passwordMatches("correct horse battery staple", env));
	assert(!passwordMatches("wrong", env));
	assert(!passwordMatches("", {}), "no password configured never matches");

	const now = 1_000_000;
	const token = mintSessionToken(env, now);
	assert(sessionTokenValid(token, env, now + 1));
	assert(!sessionTokenValid(token, env, now + SESSION_TTL_MS + 1), "expired");
	const [v, exp, sig] = token.split(".");
	assert(!sessionTokenValid(`${v}.${Number(exp) + 1}.${sig}`, env, now), "extended expiry breaks the signature");
	assert(!sessionTokenValid(token, { ...env, LH_SESSION_SECRET: "t".repeat(48) }, now), "rotating the secret signs everyone out");
	assert(!sessionTokenValid("garbage", env, now));

	const noSecret = { LH_SERVER_PASSWORD: "pw-one" };
	assert(!sessionTokenValid(mintSessionToken(noSecret, now), { LH_SERVER_PASSWORD: "pw-two" }, now), "password change signs everyone out");
});

test("request authorization: cookie or long-enough bearer token", () => {
	const now = Date.now();
	const cookie = `other=1; ${SESSION_COOKIE}=${mintSessionToken(env, now)}`;
	assert(remoteRequestAuthorized(new Headers({ cookie }), env, now));
	assert(!remoteRequestAuthorized(new Headers(), env, now));
	const apiToken = "k".repeat(40);
	assert(remoteRequestAuthorized(new Headers({ authorization: `Bearer ${apiToken}` }), { ...env, LH_API_TOKEN: apiToken }, now));
	assert(!remoteRequestAuthorized(new Headers({ authorization: "Bearer nope" }), { ...env, LH_API_TOKEN: apiToken }, now));
	assert(!remoteRequestAuthorized(new Headers({ authorization: "Bearer short" }), { ...env, LH_API_TOKEN: "short" }, now), "short API tokens are ignored");
});

test("public paths and redirect targets", () => {
	assert(isPublicPath("/login") && isPublicPath("/api/auth/login"));
	assert(!isPublicPath("/") && !isPublicPath("/api/chats") && !isPublicPath("/loginx"));
	assert.equal(safeNextPath("/chat/abc?x=1"), "/chat/abc?x=1");
	for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "", null]) assert.equal(safeNextPath(bad), "/");
});

test("proxy in server mode: pages redirect to login, APIs 401, login flow stays public", async () => {
	await withEnv(env, () => {
		const page = proxy(new NextRequest(origin + "/chat/abc"));
		assert.equal(page.status, 307);
		assert.equal(page.headers.get("location"), origin + "/login?next=%2Fchat%2Fabc");
		assert.equal(proxy(new NextRequest(origin + "/api/events")).status, 401);
		assert.equal(proxy(new NextRequest(origin + "/login")).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(new NextRequest(origin + "/api/auth/login", { method: "POST" })).headers.get("x-middleware-next"), "1");
		const cookie = `${SESSION_COOKIE}=${mintSessionToken()}`;
		assert.equal(proxy(new NextRequest(origin + "/api/events", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(new NextRequest(origin + "/", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
	});
});

test("login route: sets a secure session cookie on success, throttles repeated failures", async () => {
	await withEnv(env, async () => {
		const post = (password: string, ip: string) => {
			const body = new FormData();
			body.set("password", password);
			body.set("next", "/chat/abc");
			return loginResponse(new Request(origin + "/api/auth/login", { method: "POST", body, headers: { "x-forwarded-for": ip, "x-forwarded-proto": "https" } }));
		};
		const ok = await post(env.LH_SERVER_PASSWORD, "10.0.0.1");
		assert.equal(ok.status, 303);
		assert.equal(ok.headers.get("location"), "/chat/abc");
		const setCookie = ok.headers.get("set-cookie") ?? "";
		assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=v1\\.`));
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /Secure/);
		const token = setCookie.split(";")[0]?.split("=")[1];
		assert(sessionTokenValid(token));

		const bad = await post("nope", "10.0.0.2");
		assert.match(bad.headers.get("location") ?? "", /error=invalid/);
		assert.equal(bad.headers.get("set-cookie"), null);

		for (let i = 0; i < 10; i++) recordLoginFailure("10.0.0.3");
		assert(loginThrottled("10.0.0.3"));
		const throttled = await post(env.LH_SERVER_PASSWORD, "10.0.0.3");
		assert.match(throttled.headers.get("location") ?? "", /error=throttled/, "even the right password is refused while throttled");
	});
});

test("apps only: browsers are refused before sign-in, the two apps and API tokens get through", async () => {
	const desktopUA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150 Electron/44.9.3 Safari/537.36 LearnHarnessDesktop/0.4.0";
	const iosUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LearnHarnessiOS/1.0";
	const safariUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";
	assert(appsOnlyAllowed(new Headers({ "user-agent": safariUA }), env), "off unless LH_APPS_ONLY=1");
	const appsEnv = { ...env, LH_APPS_ONLY: "1", LH_API_TOKEN: "k".repeat(40) };
	assert(!appsOnlyAllowed(new Headers({ "user-agent": safariUA }), appsEnv));
	assert(!appsOnlyAllowed(new Headers(), appsEnv));
	assert(appsOnlyAllowed(new Headers({ "user-agent": desktopUA }), appsEnv));
	assert(appsOnlyAllowed(new Headers({ "user-agent": iosUA }), appsEnv));
	assert(appsOnlyAllowed(new Headers({ "user-agent": "curl/8", authorization: `Bearer ${"k".repeat(40)}` }), appsEnv));
	assert(!appsOnlyAllowed(new Headers({ "user-agent": "LearnHarnessiOS" }), appsEnv), "needs a version");
	assert(appsOnlyAllowed(new Headers({ "user-agent": safariUA }), { LH_APPS_ONLY: "1" }), "needs server mode too");

	await withEnv({ ...env, LH_APPS_ONLY: "1" }, () => {
		const page = proxy(new NextRequest(origin + "/login", { headers: { "user-agent": safariUA } }));
		assert.equal(page.status, 403, "even the sign-in page");
		assert.equal(proxy(new NextRequest(origin + "/api/chats", { headers: { "user-agent": safariUA } })).status, 403);
		assert.equal(proxy(new NextRequest(origin + "/login", { headers: { "user-agent": iosUA } })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(new NextRequest(origin + "/api/chats", { headers: { "user-agent": desktopUA } })).status, 401, "apps still sign in");
	});
});
