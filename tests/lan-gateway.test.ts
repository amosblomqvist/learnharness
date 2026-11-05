import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
const require = createRequire(import.meta.url);
const { createLanGateway } = require("../electron/lan-gateway.cjs");
const { hashPassword, verifyPassword } = require("../electron/lan-config.cjs");

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

const SECRET = "s".repeat(64);
const KEY = Buffer.alloc(32, 7);

async function startUpstream(handler?: http.RequestListener) {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
			if (handler) return handler(req, res);
			res.setHeader("content-type", "text/plain");
			res.end("upstream-ok");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	});
	return { server, seen, port: (server.address() as AddressInfo).port };
}

type Opts = { password?: string; now?: () => number; secret?: string | null; handler?: http.RequestListener; targetPort?: number };

async function setup(o: Opts = {}) {
	const up = await startUpstream(o.handler);
	const auth: { value: { passwordHash: string; sessionKey: Buffer } | null } = {
		value: o.password ? { passwordHash: hashPassword(o.password), sessionKey: KEY } : null,
	};
	const gw = createLanGateway({
		targetPort: o.targetPort ?? up.port,
		getSecret: o.secret === null ? undefined : () => o.secret ?? SECRET,
		getAuth: () => auth.value,
		verifyPassword,
		now: o.now,
	});
	await gw.listen(0, "127.0.0.1");
	cleanups.push(() => gw.close());
	return { gw, up, auth, base: `127.0.0.1:${gw.port}` };
}

function request(port: number, o: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string }): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/", headers: o.headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(o.body);
	});
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

async function login(s: { gw: { port: number }; base: string }, password: string, extra: Record<string, string> = {}) {
	return request(s.gw.port, {
		method: "POST",
		path: "/__lan/login",
		headers: { host: s.base, origin: `http://${s.base}`, "content-type": "application/x-www-form-urlencoded" },
		body: form({ password, ...extra }),
	});
}

const cookieOf = (r: Res) => String((r.headers["set-cookie"] ?? [])[0]).split(";")[0] as string;

// ---- proxying and header handling ----

test("no-password mode proxies method, path, query and body to the upstream", async () => {
	const s = await setup();
	const r = await request(s.gw.port, { method: "POST", path: "/api/x?y=1", headers: { host: s.base, origin: `http://${s.base}`, "content-type": "text/plain" }, body: "hello" });
	assert.equal(r.status, 200);
	assert.equal(r.body, "upstream-ok");
	assert.equal(r.headers["content-type"], "text/plain");
	assert.equal(s.up.seen[0]!.method, "POST");
	assert.equal(s.up.seen[0]!.url, "/api/x?y=1");
	assert.equal(s.up.seen[0]!.body, "hello");
});

test("the original Host is preserved and the real desktop secret is injected", async () => {
	const s = await setup();
	await request(s.gw.port, { headers: { host: s.base } });
	assert.equal(s.up.seen[0]!.headers.host, s.base);
	assert.equal(s.up.seen[0]!.headers["x-learnharness-desktop"], SECRET);
});

test("a client-sent desktop secret header is stripped and replaced", async () => {
	const s = await setup();
	await request(s.gw.port, { headers: { host: s.base, "x-learnharness-desktop": "forged" } });
	assert.equal(s.up.seen[0]!.headers["x-learnharness-desktop"], SECRET);
});

test("without a secret getter (dev) the client header is stripped and none is injected", async () => {
	const s = await setup({ secret: null });
	await request(s.gw.port, { headers: { host: s.base, "x-learnharness-desktop": "forged" } });
	assert.equal("x-learnharness-desktop" in s.up.seen[0]!.headers, false);
});

test("hop-by-hop request headers are not forwarded", async () => {
	const s = await setup();
	await request(s.gw.port, { headers: { host: s.base, connection: "keep-alive, x-secret-hop", "x-secret-hop": "1", "keep-alive": "timeout=5", te: "trailers", "proxy-authorization": "Basic abc" } });
	const h = s.up.seen[0]!.headers;
	for (const k of ["x-secret-hop", "keep-alive", "te", "proxy-authorization"]) assert.equal(k in h, false, k);
});

test("hop-by-hop response headers are not forwarded", async () => {
	const s = await setup({ handler: (_req, res) => { res.setHeader("keep-alive", "timeout=9"); res.setHeader("x-keep", "yes"); res.end("x"); } });
	const r = await request(s.gw.port, { headers: { host: s.base } });
	assert.equal(r.headers["x-keep"], "yes");
	assert.equal(r.headers["keep-alive"], undefined);
});

test("upstream status, set-cookie and redirects pass through", async () => {
	const s = await setup({ handler: (_req, res) => { res.statusCode = 307; res.setHeader("location", "/x"); res.setHeader("set-cookie", ["a=1", "b=2"]); res.end(); } });
	const r = await request(s.gw.port, { headers: { host: s.base } });
	assert.equal(r.status, 307);
	assert.equal(r.headers.location, "/x");
	assert.deepEqual(r.headers["set-cookie"], ["a=1", "b=2"]);
});

test("a dead upstream returns 502", async () => {
	const dead = await startUpstream();
	const port = dead.port;
	dead.server.closeAllConnections();
	await new Promise((r) => dead.server.close(r));
	const s = await setup({ targetPort: port });
	const r = await request(s.gw.port, { headers: { host: s.base } });
	assert.equal(r.status, 502);
});

test("an SSE chunk reaches the client before the upstream ends", async () => {
	let finish!: () => void;
	const s = await setup({
		handler: (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: one\n\n");
			finish = () => res.end("data: two\n\n");
		},
	});
	await new Promise<void>((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: s.gw.port, path: "/api/events", headers: { host: s.base }, agent: false }, (res) => {
			assert.equal(res.headers["content-type"], "text/event-stream");
			let got = "";
			let released = false;
			res.on("data", (c) => {
				got += c;
				if (!released && got.includes("one")) {
					released = true;
					assert.equal(got.includes("two"), false);
					finish();
				}
			});
			res.on("end", () => {
				try { assert.equal(got, "data: one\n\ndata: two\n\n"); resolve(); } catch (e) { reject(e); }
			});
		}).on("error", reject);
	});
});

test("response headers are flushed immediately, before any body byte", async () => {
	let finish!: () => void;
	const s = await setup({ handler: (_req, res) => { res.writeHead(200, { "x-early": "1" }); res.flushHeaders(); finish = () => res.end("late"); } });
	await new Promise<void>((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: s.gw.port, path: "/", headers: { host: s.base }, agent: false }, (res) => {
			assert.equal(res.headers["x-early"], "1");
			finish();
			res.resume();
			res.on("end", resolve);
		}).on("error", reject);
	});
});

test("a client abort destroys the upstream request", async () => {
	let upstreamClosed!: () => void;
	const closed = new Promise<void>((r) => (upstreamClosed = r));
	let reached!: () => void;
	const arrived = new Promise<void>((r) => (reached = r));
	const s = await setup({ handler: (req, res) => { res.writeHead(200); res.write("hi"); reached(); res.on("close", upstreamClosed); } });
	const clientReq = http.get({ host: "127.0.0.1", port: s.gw.port, path: "/", headers: { host: s.base }, agent: false }, (res) => { res.on("data", () => {}); res.on("error", () => {}); });
	clientReq.on("error", () => {});
	await arrived;
	await new Promise((r) => setTimeout(r, 50));
	clientReq.destroy();
	await closed;
});

// ---- guards ----

test("a Host that is not an IP literal, localhost or the machine name is rejected before proxying", async () => {
	const s = await setup();
	for (const host of ["evil.example.com", `evil.example.com:${s.gw.port}`]) {
		const r = await request(s.gw.port, { headers: { host } });
		assert.ok([403, 421].includes(r.status), `${host} -> ${r.status}`);
	}
	assert.equal(s.up.seen.length, 0);
});

test("allowed Host names pass, case-insensitively, with the gateway port or no port", async () => {
	const s = await setup();
	const name = os.hostname();
	const hosts = [`127.0.0.1:${s.gw.port}`, "192.168.1.5", `[::1]:${s.gw.port}`, `LOCALHOST:${s.gw.port}`, `${name.toUpperCase()}:${s.gw.port}`, `${name}.local`, `${name}.LOCAL:${s.gw.port}`];
	for (const host of hosts) {
		const r = await request(s.gw.port, { headers: { host } });
		assert.equal(r.status, 200, host);
	}
});

test("a Host port different from the gateway port is rejected", async () => {
	const s = await setup();
	const r = await request(s.gw.port, { headers: { host: `127.0.0.1:${s.gw.port + 1}` } });
	assert.ok([403, 421].includes(r.status));
	assert.equal(s.up.seen.length, 0);
});

test("a state-changing request with a foreign Origin is rejected with 403", async () => {
	const s = await setup();
	for (const origin of ["http://evil.example.com", `http://127.0.0.1:${s.gw.port + 1}`, "null"]) {
		const r = await request(s.gw.port, { method: "POST", headers: { host: s.base, origin }, body: "x" });
		assert.equal(r.status, 403, origin);
	}
	assert.equal(s.up.seen.length, 0);
});

test("a matching or absent Origin passes for state-changing requests", async () => {
	const s = await setup();
	assert.equal((await request(s.gw.port, { method: "POST", headers: { host: s.base, origin: `http://${s.base}` }, body: "x" })).status, 200);
	assert.equal((await request(s.gw.port, { method: "DELETE", headers: { host: s.base } })).status, 200);
});

test("Sec-Fetch-Site must be same-origin or none on state-changing requests", async () => {
	const s = await setup();
	for (const v of ["cross-site", "same-site"]) {
		assert.equal((await request(s.gw.port, { method: "POST", headers: { host: s.base, "sec-fetch-site": v }, body: "x" })).status, 403, v);
	}
	for (const v of ["same-origin", "none"]) {
		assert.equal((await request(s.gw.port, { method: "POST", headers: { host: s.base, "sec-fetch-site": v }, body: "x" })).status, 200, v);
	}
	assert.equal((await request(s.gw.port, { headers: { host: s.base, "sec-fetch-site": "cross-site" } })).status, 200, "GET is not CSRF-checked");
});

test("guards still apply with a password set", async () => {
	const s = await setup({ password: "pw" });
	const r = await request(s.gw.port, { headers: { host: "evil.example.com" } });
	assert.ok([403, 421].includes(r.status));
	assert.equal((await login(s, "pw", {})).status, 303);
	const bad = await request(s.gw.port, { method: "POST", path: "/__lan/login", headers: { host: s.base, origin: "http://evil.example.com", "content-type": "application/x-www-form-urlencoded" }, body: form({ password: "pw" }) });
	assert.equal(bad.status, 403);
});

// ---- password mode ----

test("unauthenticated page navigations redirect to the login page, other requests get 401 JSON", async () => {
	const s = await setup({ password: "pw" });
	const nav = await request(s.gw.port, { path: "/chat/abc?x=1", headers: { host: s.base, accept: "text/html,application/xhtml+xml" } });
	assert.equal(nav.status, 303);
	assert.equal(nav.headers.location, `/__lan/login?next=${encodeURIComponent("/chat/abc?x=1")}`);
	const api = await request(s.gw.port, { path: "/api/settings", headers: { host: s.base, accept: "application/json" } });
	assert.equal(api.status, 401);
	assert.match(String(api.headers["content-type"]), /application\/json/);
	assert.deepEqual(JSON.parse(api.body), { error: "unauthorized" });
	const apiHtml = await request(s.gw.port, { path: "/api/settings", headers: { host: s.base } });
	assert.equal(apiHtml.status, 401);
	const post = await request(s.gw.port, { method: "POST", path: "/x", headers: { host: s.base, accept: "text/html" }, body: "x" });
	assert.equal(post.status, 401);
	assert.equal(s.up.seen.length, 0);
});

test("the login page is self-contained, responsive HTML with no external assets", async () => {
	const s = await setup({ password: "pw" });
	const r = await request(s.gw.port, { path: "/__lan/login", headers: { host: s.base } });
	assert.equal(r.status, 200);
	assert.match(String(r.headers["content-type"]), /text\/html/);
	assert.equal(r.headers["cache-control"], "no-store");
	assert.match(r.body, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
	assert.match(r.body, /<form method="post" action="\/__lan\/login"/);
	assert.match(r.body, /type="password"/);
	assert.equal(/(src|href)=["']https?:/i.test(r.body), false);
	assert.equal(s.up.seen.length, 0);
});

test("the login page carries a safe next target and escapes it", async () => {
	const s = await setup({ password: "pw" });
	const r = await request(s.gw.port, { path: `/__lan/login?next=${encodeURIComponent('/a"><script>x</script>')}`, headers: { host: s.base } });
	assert.equal(r.body.includes("<script>x"), false);
	assert.match(r.body, /name="next" value="\/a&quot;&gt;&lt;script&gt;/);
	const evil = await request(s.gw.port, { path: "/__lan/login?next=//evil.com", headers: { host: s.base } });
	assert.equal(evil.body.includes("evil.com"), false);
});

test("login success sets a hardened 30-day session cookie and redirects to /", async () => {
	const s = await setup({ password: "pw" });
	const r = await login(s, "pw");
	assert.equal(r.status, 303);
	assert.equal(r.headers.location, "/");
	const raw = String((r.headers["set-cookie"] ?? [])[0]);
	assert.match(raw, /^lh_lan_session=\d+\.[A-Za-z0-9_-]{43}; /);
	for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) assert.ok(raw.includes(flag), flag);
	assert.equal(/secure/i.test(raw), false);
});

test("login honours a same-origin next path and ignores open redirects", async () => {
	const s = await setup({ password: "pw" });
	assert.equal((await login(s, "pw", { next: "/chat/abc?x=1" })).headers.location, "/chat/abc?x=1");
	for (const next of ["//evil.com", "https://evil.com", "/\\evil.com", "evil"]) {
		assert.equal((await login(s, "pw", { next })).headers.location, "/", next);
	}
});

test("login failure re-renders the form with an error and sets no cookie", async () => {
	const s = await setup({ password: "pw" });
	const r = await login(s, "wrong");
	assert.equal(r.status, 401);
	assert.match(String(r.headers["content-type"]), /text\/html/);
	assert.match(r.body, /Incorrect password/);
	assert.equal(r.headers["set-cookie"], undefined);
	assert.equal(s.up.seen.length, 0);
});

test("an oversized login body is rejected with 413", async () => {
	const s = await setup({ password: "pw" });
	const r = await login(s, "x".repeat(10_000));
	assert.equal(r.status, 413);
});

test("the session cookie authenticates and is stripped before the upstream, other cookies stay", async () => {
	const s = await setup({ password: "pw" });
	const cookie = cookieOf(await login(s, "pw"));
	const r = await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie: `a=1; ${cookie}; b=2` } });
	assert.equal(r.status, 200);
	assert.equal(s.up.seen[0]!.headers.cookie, "a=1; b=2");
	await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } });
	assert.equal("cookie" in s.up.seen[1]!.headers, false);
});

test("a tampered or malformed session cookie is rejected", async () => {
	const s = await setup({ password: "pw" });
	const cookie = cookieOf(await login(s, "pw"));
	const [name, value] = cookie.split("=") as [string, string];
	const [issued, sig] = value.split(".") as [string, string];
	for (const bad of [`${name}=${Number(issued) + 1}.${sig}`, `${name}=${issued}.${sig.slice(0, -1)}A`, `${name}=${issued}`, `${name}=garbage`, `${name}=${issued}.`]) {
		assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie: bad } })).status, 401, bad);
	}
});

test("the session cookie expires after 30 days", async () => {
	let t = 1_700_000_000_000;
	const s = await setup({ password: "pw", now: () => t });
	const cookie = cookieOf(await login(s, "pw"));
	t += 30 * 24 * 3600 * 1000 - 1000;
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } })).status, 200);
	t += 2000;
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } })).status, 401);
});

test("rotating the session key logs out existing cookies without a restart", async () => {
	const s = await setup({ password: "pw" });
	const cookie = cookieOf(await login(s, "pw"));
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } })).status, 200);
	s.auth.value = { passwordHash: hashPassword("pw"), sessionKey: Buffer.alloc(32, 9) };
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } })).status, 401);
});

test("removing the password takes effect on the next request", async () => {
	const s = await setup({ password: "pw" });
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base } })).status, 401);
	s.auth.value = null;
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base } })).status, 200);
});

test("5 failed logins lock the IP out for 60 seconds, then it recovers", async () => {
	let t = 1_700_000_000_000;
	const s = await setup({ password: "pw", now: () => t });
	for (let i = 0; i < 5; i++) assert.equal((await login(s, "bad")).status, 401);
	const locked = await login(s, "pw");
	assert.equal(locked.status, 429);
	assert.equal(locked.headers["set-cookie"], undefined);
	assert.match(locked.body, /Too many attempts/);
	t += 59_000;
	assert.equal((await login(s, "pw")).status, 429);
	t += 2_000;
	assert.equal((await login(s, "pw")).status, 303);
});

test("a successful login resets the failure count", async () => {
	const s = await setup({ password: "pw" });
	for (let i = 0; i < 4; i++) await login(s, "bad");
	assert.equal((await login(s, "pw")).status, 303);
	for (let i = 0; i < 4; i++) assert.equal((await login(s, "bad")).status, 401);
	assert.equal((await login(s, "pw")).status, 303);
});

test("a locked-out IP can still use an already-valid session", async () => {
	const s = await setup({ password: "pw" });
	const cookie = cookieOf(await login(s, "pw"));
	for (let i = 0; i < 5; i++) await login(s, "bad");
	assert.equal((await request(s.gw.port, { path: "/api/x", headers: { host: s.base, cookie } })).status, 200);
});

test("listen rejects with the bind error when the port is taken, and close frees it", async () => {
	const s = await setup();
	const other = createLanGateway({ targetPort: s.up.port, getAuth: () => null });
	await assert.rejects(other.listen(s.gw.port, "127.0.0.1"), (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE");
	await s.gw.close();
	const again = createLanGateway({ targetPort: s.up.port, getAuth: () => null });
	await again.listen(s.gw.port, "127.0.0.1");
	await again.close();
});

test("the exported verifyPassword is wired to the config hash", () => {
	assert.equal(verifyPassword("a", hashPassword("a")), true);
});
