import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectionError, connectionErrorResponse, connectionGuard, readJsonBody } from "../src/server/connection-guard.ts";

const H = "x-learnharness-connections";
function req(method: string, headers: Record<string, string>, url = "http://127.0.0.1:3000/api/connections/login") {
	return new Request(url, { method, headers });
}
const ok = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", [H]: "1" };

describe("connectionGuard", () => {
	it("allows same-origin loopback mutation", () => {
		assert.equal(connectionGuard(req("POST", ok)), null);
		assert.equal(connectionGuard(req("POST", { ...ok, "sec-fetch-site": "same-origin" })), null);
		assert.equal(connectionGuard(req("POST", { host: "localhost:3000", origin: "http://localhost:3000", [H]: "1" })), null);
		assert.equal(connectionGuard(req("POST", { host: "[::1]:3000", origin: "http://[::1]:3000", [H]: "1" })), null);
	});
	it("rejects mutation without header, origin, or with mismatches", () => {
		const bad: Record<string, string>[] = [
			{ host: ok.host, origin: ok.origin },
			{ host: ok.host, [H]: "1" },
			{ ...ok, [H]: "0" },
			{ ...ok, origin: "http://evil.example" },
			{ ...ok, origin: "http://localhost:3000" }, // same loopback, different origin
			{ ...ok, origin: "http://127.0.0.1:3001" },
			{ ...ok, origin: "https://127.0.0.1:3000" === ok.origin ? "x" : "null" },
			{ ...ok, "sec-fetch-site": "cross-site" },
			{ ...ok, "sec-fetch-site": "same-site" },
			{ ...ok, "sec-fetch-site": "none" },
			{ ...ok, "x-forwarded-host": "evil.example" },
		];
		for (const h of bad) assert.equal(connectionGuard(req("POST", h))?.status, 403, JSON.stringify(h));
	});
	it("rejects non-loopback hosts (DNS rebinding) even when origin matches", () => {
		for (const host of ["evil.example", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example", "0.0.0.0:3000", "192.168.1.5:3000", "foo.localhost:3000"]) {
			const r = connectionGuard(req("POST", { host, origin: `http://${host}`, [H]: "1" }));
			assert.equal(r?.status, 403, host);
			assert.equal(connectionGuard(req("GET", { host }), false)?.status, 403, host);
		}
	});
	it("GET: allows header-less and same-origin, blocks cross-site reads", () => {
		assert.equal(connectionGuard(req("GET", { host: ok.host }), false), null);
		assert.equal(connectionGuard(req("GET", { host: ok.host, origin: ok.origin, "sec-fetch-site": "same-origin" }), false), null);
		assert.equal(connectionGuard(req("GET", { host: ok.host, "sec-fetch-site": "none" }), false), null);
		assert.equal(connectionGuard(req("GET", { host: ok.host, origin: "http://evil.example" }), false)?.status, 403);
		assert.equal(connectionGuard(req("GET", { host: ok.host, "sec-fetch-site": "cross-site" }), false)?.status, 403);
		assert.equal(connectionGuard(req("GET", { host: ok.host, origin: "null" }), false)?.status, 403);
	});
	it("scheme must match the request URL (http vs https on the same authority)", () => {
		const h = { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000", [H]: "1" };
		assert.equal(connectionGuard(req("POST", h))?.status, 403);
		assert.equal(connectionGuard(req("POST", h, "https://127.0.0.1:3000/x")), null);
		assert.equal(connectionGuard(req("POST", { ...h, origin: "http://127.0.0.1:3000" }, "https://127.0.0.1:3000/x"))?.status, 403);
		assert.equal(connectionGuard(req("GET", { host: ok.host, origin: "https://127.0.0.1:3000" }), false)?.status, 403);
		assert.equal(connectionGuard(req("POST", { ...ok, origin: "ftp://127.0.0.1:3000" }))?.status, 403);
	});
	it("Next-normalized localhost URL with a 127.0.0.1 Host still matches by Host and scheme", () => {
		const r = req("POST", ok, "http://localhost:3000/api/connections/login");
		assert.equal(connectionGuard(r), null);
	});
	it("denials are no-store JSON", async () => {
		const r = connectionGuard(req("POST", { host: "evil.example" }))!;
		assert.equal(r.headers.get("cache-control"), "no-store");
		assert.deepEqual(await r.json(), { error: "Forbidden." });
	});
	it("falls back to request.url host when Host is absent", () => {
		const r = new Request("http://127.0.0.1:3000/x", { method: "POST", headers: { origin: "http://127.0.0.1:3000", [H]: "1" } });
		assert.equal(connectionGuard(r), null);
	});
});

describe("readJsonBody / error response", () => {
	const post = (body: string, type = "application/json") => new Request("http://x/", { method: "POST", body, headers: { "content-type": type } });
	it("parses objects; rejects others", async () => {
		assert.deepEqual(await readJsonBody(post('{"a":1}')), { a: 1 });
		await assert.rejects(readJsonBody(post("[]")), (e: ConnectionError) => e.status === 400);
		await assert.rejects(readJsonBody(post("{x")), (e: ConnectionError) => e.status === 400);
		await assert.rejects(readJsonBody(post("{}", "text/plain")), (e: ConnectionError) => e.status === 415);
		await assert.rejects(readJsonBody(post(`{"a":"${"x".repeat(40000)}"}`)), (e: ConnectionError) => e.status === 413);
	});
	it("enforces the byte cap on the stream even without content-length", async () => {
		const big = new Uint8Array(40_000).fill(120);
		const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.close(); } });
		const r = new Request("http://x/", { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit);
		await assert.rejects(readJsonBody(r), (e: ConnectionError) => e.status === 413);
	});
	it("unknown errors never leak their message", async () => {
		const r = connectionErrorResponse(new Error("secret-token-xyz"));
		assert.equal(r.status, 500);
		assert.ok(!(await r.text()).includes("secret"));
	});
});
