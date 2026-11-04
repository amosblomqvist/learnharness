import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { normalizeServerUrl, insecureRemote, readServerChoice, writeServerChoice, probeServer } = require("../electron/remote-server.cjs");

test("typed addresses normalize to a server origin", () => {
	assert.deepEqual(normalizeServerUrl("my-server:3000"), { url: "http://my-server:3000" });
	assert.deepEqual(normalizeServerUrl("  lh.example.com/chat/abc?x=1 "), { url: "https://lh.example.com" });
	assert.deepEqual(normalizeServerUrl("http://192.168.1.20:3000/"), { url: "http://192.168.1.20:3000" });
	for (const bad of ["", "   ", "ftp://host", "javascript:alert(1)", "http://user:pw@host:3000", "http://"]) {
		assert.ok(normalizeServerUrl(bad).error, bad);
	}
});

test("plain http is only flagged off private networks", () => {
	for (const ok of ["https://lh.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.20:3000", "http://10.0.0.5:3000", "http://172.20.0.2:3000", "http://100.101.1.2:3000", "http://box.tail1234.ts.net:3000", "http://nas.local:3000", "http://box.lan:3000", "http://box.home.arpa:3000", "http://my-server:3000"]) {
		assert.equal(insecureRemote(ok), false, ok);
	}
	for (const bad of ["http://lh.example.com", "http://8.8.8.8:3000", "http://172.32.0.1:3000"]) assert.equal(insecureRemote(bad), true, bad);
});

test("server choice round-trips and falls back to local", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-choice-"));
	const file = path.join(dir, "server.json");
	assert.deepEqual(readServerChoice(file), { mode: "local" }, "absent");
	writeServerChoice(file, { mode: "remote", url: "http://my-server:3000" });
	assert.deepEqual(readServerChoice(file), { mode: "remote", url: "http://my-server:3000" });
	writeServerChoice(file, { mode: "local" });
	assert.deepEqual(readServerChoice(file), { mode: "local" });
	fs.writeFileSync(file, '{"mode":"remote","url":"ftp://nope"}');
	assert.deepEqual(readServerChoice(file), { mode: "local" }, "invalid url");
	fs.writeFileSync(file, "not json");
	assert.deepEqual(readServerChoice(file), { mode: "local" }, "corrupt file");
	fs.rmSync(dir, { recursive: true });
});

test("probe identifies itself as the desktop app (apps-only servers)", async () => {
	let sent = "";
	await probeServer("http://s:3000", async (_url: string, init: RequestInit) => {
		sent = new Headers(init.headers).get("user-agent") ?? "";
		return new Response('action="/api/auth/login"', { status: 200 });
	});
	assert.match(sent, /LearnHarnessDesktop\/\d/);
});

test("probe accepts only a LearnHarness sign-in page", async () => {
	const page = (status: number, body: string) => async () => new Response(body, { status });
	assert.deepEqual(await probeServer("http://s:3000", page(200, '<form method="post" action="/api/auth/login">')), { ok: true });
	assert.match((await probeServer("http://s:3000", page(200, "<html>some other site</html>"))).error, /isn't a LearnHarness server/);
	assert.match((await probeServer("http://s:3000", page(404, "missing"))).error, /isn't a LearnHarness server/);
	assert.match((await probeServer("http://s:3000", async () => { throw new TypeError("fetch failed"); })).error, /Couldn't reach/);
});
