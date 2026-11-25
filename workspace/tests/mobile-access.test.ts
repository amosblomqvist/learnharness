import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMobileAccess, tailnetFrom, requestOrigin } from "../electron/mobile-access.cjs";

const origin = "https://pc.tail123456.ts.net:9443";
const identity = { origin, login: "owner@example.com", serving: true };
const authorized = { host: new URL(origin).host, "tailscale-user-login": identity.login, "x-forwarded-proto": "https" };

test("Tailscale configuration requires this gateway, HTTPS, personal identity, and no Funnel", () => {
	const status = { BackendState: "Running", Self: { DNSName: "pc.tail123456.ts.net.", UserID: 1 }, User: { 1: { LoginName: identity.login } } };
	const serve = { TCP: { 9443: { HTTPS: true } }, Web: { "pc.tail123456.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4397" } } } } };
	assert.deepEqual(tailnetFrom(status, serve), identity);
	assert.equal(tailnetFrom({ ...status, Self: { ...status.Self, Tags: ["tag:server"] } }, serve), null);
	assert.equal(tailnetFrom(status, { ...serve, AllowFunnel: { "pc.tail123456.ts.net:9443": true } })?.serving, false);
	assert.equal(tailnetFrom(status, {})?.serving, false);
	assert.equal(requestOrigin({ headers: { ...authorized, "tailscale-user-login": "other@example.com" } }, identity), null);
	assert.equal(requestOrigin({ headers: authorized }, identity), origin);
	assert.equal(requestOrigin({ headers: { host: "127.0.0.1:1234" } }, null, "http://127.0.0.1:1234", "private"), null);
	assert.equal(requestOrigin({ headers: { host: "127.0.0.1:1234", "x-learnharness-preview": "private" } }, null, "http://127.0.0.1:1234", "private"), "http://127.0.0.1:1234");
});

test("direct link requires the PROXY-protocol forward, no Funnel, and same-account untagged unexpired devices", () => {
	const status = { BackendState: "Running", Self: { DNSName: "pc.tail123456.ts.net.", UserID: 1, TailscaleIPs: ["100.64.1.1", "fd7a::1"] }, User: { 1: { LoginName: identity.login } },
		Peer: { phone: { UserID: 1, TailscaleIPs: ["100.64.1.2"] }, stranger: { UserID: 2, TailscaleIPs: ["100.64.1.3"] }, expired: { UserID: 1, TailscaleIPs: ["100.64.1.4"], Expired: true }, tagged: { UserID: 1, TailscaleIPs: ["100.64.1.5"], Tags: ["tag:ci"] } } };
	const serve = { TCP: { 9081: { TCPForward: "127.0.0.1:4398", ProxyProtocol: 1 } } };
	const direct = tailnetFrom(status, serve)?.direct;
	assert.equal(direct?.origin, "http://100.64.1.1:9081"); assert.equal(direct?.address, "100.64.1.1");
	assert.deepEqual([...direct!.owners].sort(), ["100.64.1.1", "100.64.1.2"]);
	assert.equal(tailnetFrom(status, { TCP: { 9081: { TCPForward: "127.0.0.1:4398" } } })?.direct, undefined, "PROXY protocol is the identity source");
	assert.equal(tailnetFrom(status, { TCP: { 9081: { TCPForward: "127.0.0.1:9999", ProxyProtocol: 1 } } })?.direct, undefined);
	assert.equal(tailnetFrom(status, { ...serve, AllowFunnel: { "pc.tail123456.ts.net:9081": true } })?.direct, undefined);
	const route = { origin: "http://100.64.1.1:9081", address: "100.64.1.1", owners: new Set(["100.64.1.2"]) };
	const tailnet = { ...identity, direct: route };
	assert.equal(requestOrigin({ headers: { host: "100.64.1.1:9081" } }, tailnet, undefined, undefined, "100.64.1.2"), route.origin);
	assert.equal(requestOrigin({ headers: { host: "100.64.1.1:9081" } }, tailnet, undefined, undefined, "100.64.1.3"), null);
	assert.equal(requestOrigin({ headers: authorized }, tailnet, undefined, undefined, "100.64.1.2"), null, "a direct socket never falls back to header identity");
	assert.equal(requestOrigin({ headers: { host: "100.64.1.1:9081" } }, tailnet), null, "the direct host needs a PROXY-verified socket");
});

test("direct listener forwards only PROXY-verified same-account sockets", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-mobile-direct-"));
	const upstream = createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ path: request.url, host: request.headers.host })); });
	await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
	const route = { origin: "http://100.64.1.1:9081", address: "100.64.1.1", owners: new Set(["100.64.1.2"]) };
	let tailnet: { origin: string; login: string; serving: boolean; direct?: typeof route } = { ...identity, serving: false, direct: route };
	const mobile = createMobileAccess({ app: new EventEmitter(), BrowserWindow: undefined, session: undefined, appearance: () => "#141414", nativeControl: undefined, updateControl: undefined, openWebBrowser: undefined,
		origin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, directory, desktopSecret: undefined, readTailnet: async () => tailnet, port: 0, directPort: 0 });
	const raw = (text: string) => new Promise<string>((resolve, reject) => {
		const socket = connect((mobile.directAddress() as { port: number }).port, "127.0.0.1", () => socket.write(text));
		let reply = ""; socket.setEncoding("utf8"); socket.on("data", chunk => reply += chunk); socket.on("close", () => resolve(reply)); socket.on("error", reject);
	});
	const proxied = (source: string, destination = route.address, host = "100.64.1.1:9081") =>
		raw(`PROXY TCP4 ${source} ${destination} 51000 ${(mobile.directAddress() as { port: number }).port}\r\nGET /api/settings HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
	try {
		await mobile.setEnabled(true);
		assert.equal(mobile.status().directUrl, route.origin); assert.match(mobile.status().message, /^Ready/);
		const owner = await proxied("100.64.1.2");
		assert.match(owner, /^HTTP\/1\.1 200/); assert.match(owner, /"path":"\/api\/settings"/);
		assert.equal(await proxied("100.64.1.3"), "", "another account's device is dropped before HTTP");
		assert.equal(await proxied("100.64.1.2", "100.64.9.9"), "", "the forwarded destination must be this PC");
		assert.equal(await raw("GET /api/settings HTTP/1.1\r\nHost: 100.64.1.1:9081\r\nConnection: close\r\n\r\n"), "", "no PROXY header, no access");
		assert.match(await proxied("100.64.1.2", route.address, "evil.example"), /^HTTP\/1\.1 403/);
		tailnet = { ...identity, serving: false, direct: { ...route, owners: new Set<string>() } }; await mobile.refresh();
		assert.equal(await proxied("100.64.1.2"), "", "a device removed from the account loses access at the next check");
		await mobile.setEnabled(false); assert.equal(mobile.directAddress(), undefined); assert.equal(mobile.status().directUrl, null);
	} finally {
		mobile.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("gateway protects HTML, streams, writes and desktop capability; disabling closes access", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-mobile-"));
	const upstream = createServer((request, response) => {
		if (request.url === "/api/events") {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write("data: connected\n\n");
			setTimeout(() => response.end("data: done\n\n"), 15); return;
		}
		const chunks: Buffer[] = [];
		request.on("data", chunk => chunks.push(chunk));
		request.on("end", () => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ path: request.url, host: request.headers.host, origin: request.headers.origin, secret: request.headers["x-learnharness-desktop"], preview: request.headers["x-learnharness-preview"], body: Buffer.concat(chunks).toString() })); });
	});
	upstream.on("upgrade", (_request, socket) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
		socket.on("data", bytes => socket.write(bytes));
		socket.on("error", () => {});
		socket.on("end", () => socket.destroy());
	});
	await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
	const address = upstream.address() as { port: number };
	const app = new EventEmitter();
	const mobile = createMobileAccess({ app, BrowserWindow: undefined, session: undefined, appearance: () => "#141414", nativeControl: undefined, updateControl: undefined, openWebBrowser: undefined,
		origin: `http://127.0.0.1:${address.port}`, directory, desktopSecret: "a".repeat(64), readTailnet: async () => identity, port: 0, directPort: 0 });
	const call = (url: string, headers: Record<string, string> = authorized, method = "GET", body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
		const request = httpRequest({ host: "127.0.0.1", port: (mobile.address() as { port: number }).port, path: url, method, headers }, response => {
			let text = ""; response.setEncoding("utf8"); response.on("data", chunk => text += chunk); response.on("end", () => resolve({ status: response.statusCode!, body: text }));
		});
		request.on("error", reject); request.end(body);
	});
	try {
		await mobile.initialize(); assert.equal(mobile.status().enabled, false);
		await mobile.setEnabled(true);
		assert.equal((await call("/", {})).status, 403);
		assert.equal((await call("/api/settings", { ...authorized, "tailscale-user-login": "stranger@example.com" })).status, 403);
		assert.equal((await call("/api/settings", { ...authorized, origin: "https://evil.example" }, "POST", "{}")).status, 403);
		assert.equal((await call("/api/settings", { ...authorized, "sec-fetch-site": "cross-site" }, "POST")).status, 403);
		assert.equal((await call("/\\evil.example/api/keys")).status, 400);
		const write = await call("/api/settings?q=1", { ...authorized, origin, "x-learnharness-desktop": "forged", "x-learnharness-preview": "forged", "Content-Type": "application/json" }, "POST", '{"saved":true}');
		assert.equal(write.status, 200);
		const forwarded = JSON.parse(write.body);
		assert.equal(forwarded.secret, "a".repeat(64)); assert.equal(forwarded.preview, undefined);
		assert.equal(forwarded.origin, `http://127.0.0.1:${address.port}`); assert.equal(forwarded.path, "/api/settings?q=1"); assert.equal(forwarded.body, '{"saved":true}');
		const stream = await call("/api/events"); assert.match(stream.body, /connected[\s\S]*done/);
		await new Promise<void>((resolve, reject) => {
			const upgrade = httpRequest({ host: "127.0.0.1", port: (mobile.address() as { port: number }).port, path: "/_next/hmr", headers: { ...authorized, origin, connection: "Upgrade", upgrade: "websocket" } });
			upgrade.on("upgrade", (_response, socket) => {
				socket.on("data", bytes => { assert.equal(bytes.toString(), "round-trip"); socket.end(); resolve(); });
				socket.on("error", reject); socket.write("round-trip");
			});
			upgrade.on("error", reject); upgrade.end();
		});
		assert.equal(JSON.parse((await call("/api/mobile-access")).body).remote, true);
		const disabled = await call("/api/mobile-access", { ...authorized, origin, "Content-Type": "application/json" }, "POST", JSON.stringify({ op: "enable", enabled: false }));
		assert.equal(disabled.status, 200); assert.equal(JSON.parse(disabled.body).enabled, false); assert.equal(mobile.address(), undefined);
	} finally {
		mobile.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
