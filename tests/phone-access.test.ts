import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
const require = createRequire(import.meta.url);
const { createPhoneAccess, cleanDeviceName, lanAddresses } = require("../electron/phone-access.cjs");
const { bonjourAdvertiser, dnsSdAdvertiser, phoneAccessAdvertiser } = require("../electron/phone-access-bonjour.cjs");

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; fingerprint: string };

/** The app's loopback server: records what reaches it. */
async function fakeUpstream() {
	const seen: http.IncomingHttpHeaders[] = [];
	const server = http.createServer((req, res) => {
		seen.push(req.headers);
		if (req.url === "/redirect") { res.writeHead(307, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/login` }); return res.end(); }
		if (req.url === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: one\n\n");
			return; // stays open
		}
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(`${req.method} ${req.url}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function harness(t: import("node:test").TestContext, { secret = "s".repeat(64) as string | null } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-"));
	const upstream = await fakeUpstream();
	const adverts: unknown[] = [];
	let stopped = 0;
	const make = () => createPhoneAccess({
		directory, port: 0, host: "127.0.0.1", computerName: "Test Mac", appVersion: "0.7.0",
		addresses: () => ["192.168.1.88"],
		upstream: () => ({ origin: upstream.origin, secret }),
		advertise: (service: unknown) => { adverts.push(service); return { stop: () => { stopped++; } }; },
	});
	const phone = make();
	t.after(async () => { await phone.stop(); upstream.server.closeAllConnections(); upstream.server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
	const request = (method: string, url: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) => new Promise<Reply>((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = https.request({ host: "127.0.0.1", port: phone.port, method, path: url, rejectUnauthorized: false, agent: false,
			headers: { host: `192.168.1.88:${phone.port}`, ...(payload ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
			const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
			let text = ""; res.setEncoding("utf8"); res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text, fingerprint }));
		});
		req.on("error", reject); req.end(payload);
	});
	const json = (reply: Reply) => JSON.parse(reply.body);
	return { directory, upstream, adverts, phone, make, request, json, stoppedAdverts: () => stopped };
}

/** Pair through the QR link and return the device token. */
async function pairByQR(h: Awaited<ReturnType<typeof harness>>, deviceName = "Ana's iPhone") {
	const link = new URL(h.phone.status().pairingLink);
	const reply = await h.request("POST", "/.well-known/learnharness/pair/qr", { body: { code: link.searchParams.get("c"), deviceName } });
	assert.equal(reply.status, 200, reply.body);
	return h.json(reply) as { token: string; deviceId: string };
}

test("off by default; enabling starts HTTPS, advertises without secrets, and is remembered", async (t) => {
	const h = await harness(t);
	assert.equal(h.phone.status().enabled, false);
	assert.equal(h.phone.status().running, false);
	const status = await h.phone.setEnabled(true);
	assert.equal(status.running, true);
	const link = new URL(status.pairingLink);
	assert.equal(link.protocol, "learnharness:");
	assert.equal(link.searchParams.get("h"), "192.168.1.88");
	assert.equal(link.searchParams.get("f")?.length, 64);
	const advert = h.adverts[0] as { port: number; txt: Record<string, string> };
	assert.equal(advert.txt.fp, link.searchParams.get("f")!.slice(0, 16));
	assert.ok(!JSON.stringify(advert).includes(link.searchParams.get("c")!), "no pairing code in the advert");
	const info = await h.request("GET", "/.well-known/learnharness/info");
	assert.deepEqual(h.json(info), { app: "LearnHarness", version: "0.7.0", name: "Test Mac" });
	assert.equal(info.fingerprint, link.searchParams.get("f"));
	await h.phone.stop();
	assert.equal(h.stoppedAdverts(), 1);
	const again = h.make();
	assert.equal(again.status().enabled, true, "remembered");
	await again.startIfEnabled();
	assert.equal(again.status().running, true);
	await again.stop();
});

test("unpaired requests are refused before reaching the app", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	for (const headers of [{}, { authorization: "Bearer nope" }, { cookie: "lh_device=nope" }] as Record<string, string>[]) {
		assert.equal((await h.request("GET", "/api/chats", { headers })).status, 401);
	}
	assert.equal(h.upstream.seen.length, 0);
});

test("QR pairing: one-time code, then the token works by header or cookie and is never forwarded", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	const used = new URL(h.phone.status().pairingLink).searchParams.get("c");
	const { token } = await pairByQR(h);
	assert.equal((await h.request("POST", "/.well-known/learnharness/pair/qr", { body: { code: used, deviceName: "x" } })).status, 403, "code is single-use");
	assert.notEqual(new URL(h.phone.status().pairingLink).searchParams.get("c"), used, "a fresh code is shown");
	const viaHeader = await h.request("GET", "/api/chats", { headers: { authorization: `Bearer ${token}`, "x-learnharness-desktop": "forged", "x-forwarded-for": "1.2.3.4" } });
	assert.equal(viaHeader.body, "GET /api/chats");
	const viaCookie = await h.request("GET", "/chat/new", { headers: { cookie: `theme=dark; lh_device=${token}` } });
	assert.equal(viaCookie.body, "GET /chat/new");
	const [api, page] = h.upstream.seen as [http.IncomingHttpHeaders, http.IncomingHttpHeaders];
	assert.equal(api["x-learnharness-desktop"], "s".repeat(64), "the gateway's capability, not the phone's");
	assert.equal(api.authorization, undefined);
	assert.equal(api["x-forwarded-for"], undefined);
	assert.equal(api.host, new URL(h.upstream.origin).host);
	assert.equal(page["x-learnharness-desktop"], undefined, "capability only on /api");
	assert.equal(page.cookie, "theme=dark", "device cookie removed, others kept");
	const devices = h.phone.status().devices;
	assert.equal(devices.length, 1);
	assert.equal(devices[0].name, "Ana's iPhone");
	const stored = fs.readFileSync(path.join(h.directory, "devices.json"), "utf8");
	assert.ok(!stored.includes(token), "only a hash is stored");
	assert.equal(fs.statSync(path.join(h.directory, "devices.json")).mode & 0o777, 0o600);
});

test("expired QR codes are refused", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	const code = new URL(h.phone.status().pairingLink).searchParams.get("c");
	h.phone.newCode();
	assert.equal((await h.request("POST", "/.well-known/learnharness/pair/qr", { body: { code, deviceName: "x" } })).status, 403);
	assert.equal((await h.request("POST", "/.well-known/learnharness/pair/qr", { body: { code: "guess", deviceName: "x" } })).status, 403);
});

test("there is no pairing without the QR code", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	assert.equal((await h.request("POST", "/.well-known/learnharness/pair/request", { body: { deviceName: "x" } })).status, 404);
	assert.equal(h.phone.status().devices.length, 0);
	assert.equal("key" in h.phone.status(), false);
});

test("pairing attempts are rate limited per address", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	let last = 0;
	for (let i = 0; i < 11; i++) last = (await h.request("POST", "/.well-known/learnharness/pair/qr", { body: { code: "x", deviceName: "x" } })).status;
	assert.equal(last, 429);
});

test("cross-site requests are refused; same-origin writes reach the app as same-origin", async (t) => {
	const h = await harness(t, { secret: null }); // dev mode: browser-only loopback server
	await h.phone.setEnabled(true);
	const { token } = await pairByQR(h);
	const auth = { cookie: `lh_device=${token}` };
	assert.equal((await h.request("POST", "/api/x", { headers: { ...auth, origin: "https://evil.example", "content-type": "text/plain" } })).status, 403);
	assert.equal((await h.request("POST", "/api/x", { headers: { ...auth, "sec-fetch-site": "cross-site" } })).status, 403);
	const ok = await h.request("POST", "/api/x", { headers: { ...auth, origin: `https://192.168.1.88:${h.phone.port}`, "sec-fetch-site": "same-origin" } });
	assert.equal(ok.body, "POST /api/x");
	assert.equal(h.upstream.seen.at(-1)!.origin, h.upstream.origin);
	assert.equal(h.upstream.seen.at(-1)!["x-learnharness-desktop"], undefined, "no capability in dev mode");
});

test("redirects to the loopback server stay on the gateway", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	const { token } = await pairByQR(h);
	const reply = await h.request("GET", "/redirect", { headers: { authorization: `Bearer ${token}` } });
	assert.equal(reply.status, 307);
	assert.equal(reply.headers.location, "/login");
});

test("revoking a phone refuses it at once and closes its open streams", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	const { token, deviceId } = await pairByQR(h);
	const closed = new Promise<void>((resolve, reject) => {
		const req = https.request({ host: "127.0.0.1", port: h.phone.port, path: "/api/events", rejectUnauthorized: false, agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
			res.once("data", () => { assert.ok(h.phone.revoke(deviceId)); });
			res.on("close", () => resolve()); res.on("error", () => resolve());
		});
		req.on("error", () => resolve()); req.end();
		setTimeout(() => reject(new Error("stream stayed open")), 3000).unref();
	});
	await closed;
	assert.equal((await h.request("GET", "/api/chats", { headers: { authorization: `Bearer ${token}` } })).status, 401);
	assert.equal(h.phone.status().devices.length, 0);
});

test("a phone can unpair itself", async (t) => {
	const h = await harness(t);
	await h.phone.setEnabled(true);
	const { token } = await pairByQR(h);
	assert.equal((await h.request("POST", "/.well-known/learnharness/unpair", { headers: { authorization: `Bearer ${token}` } })).status, 200);
	assert.equal(h.phone.status().devices.length, 0);
});

test("a busy port is reported instead of silently moving", async (t) => {
	const blocker = http.createServer();
	await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
	t.after(() => blocker.close());
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const phone = createPhoneAccess({ directory, port: (blocker.address() as AddressInfo).port, host: "127.0.0.1", upstream: () => null });
	const status = await phone.setEnabled(true);
	assert.equal(status.running, false);
	assert.match(status.error, /already in use/);
});

test("helpers: device names and LAN addresses", () => {
	assert.equal(cleanDeviceName("  iPad\u0007 Pro  "), "iPad Pro");
	assert.equal(cleanDeviceName(""), "Phone");
	assert.equal(cleanDeviceName(42), "Phone");
	assert.equal(cleanDeviceName("x".repeat(100)).length, 64);
	assert.deepEqual(lanAddresses({
		lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
		en0: [{ family: "IPv4", address: "100.101.1.2", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
		en1: [{ family: "IPv4", address: "192.168.1.88", internal: false }, { family: "IPv4", address: "169.254.3.4", internal: false }],
	}), ["192.168.1.88", "100.101.1.2"]);
});

test("Bonjour failures are reported, never thrown (they would crash the desktop app)", () => {
	const errors: unknown[] = [];
	let handler: ((error: Error) => void) | undefined;
	let published: { name: string; type: string; port: number; txt: Record<string, string> } | undefined;
	class FakeBonjour {
		constructor(_options: unknown, errorCallback: (error: Error) => void) { handler = errorCallback; }
		publish(service: typeof published) { published = service; return { on() {}, stop() { throw new Error("stop failed"); } }; }
		destroy() {}
	}
	const advertise = bonjourAdvertiser({ load: () => ({ Bonjour: FakeBonjour }), onError: (error: unknown) => errors.push(error) });
	const advert = advertise({ name: "LearnHarness on Mac", port: 4399, txt: { v: "1", fp: "abc" } });
	assert.deepEqual(published, { name: "LearnHarness on Mac", type: "learnharness", protocol: "tcp", port: 4399, txt: { v: "1", fp: "abc" } });
	assert.doesNotThrow(() => handler!(Object.assign(new Error("send EHOSTUNREACH 224.0.0.251:5353"), { code: "EHOSTUNREACH" })));
	assert.doesNotThrow(() => advert.stop());
	assert.deepEqual(errors.map((e) => (e as Error).message), ["send EHOSTUNREACH 224.0.0.251:5353", "stop failed"]);
});

test("macOS advertises through the system dns-sd, withdrawn on stop or exit", () => {
	const { EventEmitter } = require("node:events");
	const errors: unknown[] = [];
	const spawned: { command: string; args: string[]; child: InstanceType<typeof EventEmitter> & { killed: number } }[] = [];
	const spawn = (command: string, args: string[]) => {
		const child = Object.assign(new EventEmitter(), { killed: 0, stderr: new EventEmitter(), kill() { this.killed++; } });
		spawned.push({ command, args, child });
		return child;
	};
	const processRef = new EventEmitter();
	const advertise = dnsSdAdvertiser({ spawn, onError: (error: unknown) => errors.push(error), processRef });
	const advert = advertise({ name: "LearnHarness on Mac", port: 4399, txt: { v: "1", fp: "abc", ver: "0.7.0" } });
	assert.equal(spawned[0]!.command, "/usr/bin/dns-sd");
	assert.deepEqual(spawned[0]!.args, ["-R", "LearnHarness on Mac", "_learnharness._tcp", "local", "4399", "v=1", "fp=abc", "ver=0.7.0"]);
	spawned[0]!.child.emit("exit", 1, null);
	assert.match((errors[0] as Error).message, /dns-sd exited \(1\)/);
	advert.stop();
	advert.stop();
	assert.equal(spawned[0]!.child.killed, 1);
	spawned[0]!.child.emit("exit", null, "SIGTERM");
	assert.equal(errors.length, 1, "a requested stop is not an error");
	assert.equal(processRef.listenerCount("exit"), 0);

	advertise({ name: "x", port: 1, txt: {} });
	processRef.emit("exit");
	assert.equal(spawned[1]!.child.killed, 1, "the advert dies with the app");
	spawned[1]!.child.emit("error", new Error("ENOENT"));
	assert.equal((errors[1] as Error).message, "ENOENT");
});

test("the advertiser is native on macOS and bonjour-service elsewhere", () => {
	const spawned: string[] = [];
	const spawn = (command: string) => { spawned.push(command); const { EventEmitter } = require("node:events"); return Object.assign(new EventEmitter(), { kill() {} }); };
	phoneAccessAdvertiser({ platform: "darwin", spawn, processRef: { once() {}, removeListener() {} } })({ name: "a", port: 1, txt: {} });
	assert.deepEqual(spawned, ["/usr/bin/dns-sd"]);
	let loaded = false;
	class FakeBonjour { publish() { return { on() {}, stop() {} }; } destroy() {} }
	phoneAccessAdvertiser({ platform: "win32", load: () => { loaded = true; return { Bonjour: FakeBonjour }; } })({ name: "a", port: 1, txt: {} });
	assert.equal(loaded, true);
});
