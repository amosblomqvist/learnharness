import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { createLessonLan } from "../src/server/lesson-lan.ts";

assert.equal(process.env.NODE_ENV, "test");
test("only the same-origin local window can control LAN, with bounded JSON and no network access", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-control-"));
	const original = process.env.LH_DATA_DIR, fetch = globalThis.fetch;
	process.env.LH_DATA_DIR = root;
	let outbound = 0, enabled = false; const calls: string[] = [];
	globalThis.fetch = async () => { outbound++; throw new Error("Network forbidden"); };
	const host = globalThis as typeof globalThis & { __lessonLan?: ReturnType<typeof createLessonLan> };
	try {
		const { lessonLanControl } = await import("../src/server/lesson-lan-control.ts");
		host.__lessonLan = {
			async start() { calls.push("start"); enabled = true; }, async stop() { calls.push("stop"); enabled = false; },
			status() { return { enabled, addresses: ["192.168.1.2"], port: 42000, pairingActive: false, devices: [] }; },
			async pairing(address: string) { calls.push(address); return { connection: "synthetic", qr: "synthetic", expires: 1 }; },
			revoke(id: string) { calls.push(id); },
		};
		const request = (body: string, headers: Record<string, string> = {}, url = "http://localhost:3000/api/lesson-lan") => lessonLanControl(new Request(url, {
			method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers }, body,
		}));
		for (const headers of [{ Origin: "https://evil.test" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) assert.equal((await request('{"action":"start"}', headers)).status, 403);
		assert.equal((await request('{"action":"start"}', { Origin: "http://192.168.1.2:3000" }, "http://192.168.1.2:3000/api/lesson-lan")).status, 403);
		for (const body of ["null", "bad", '{"action":"unknown"}', "x".repeat(2049)]) assert.equal((await request(body)).status, 409);
		assert.equal((await request('{"action":"start"}', { "Content-Type": "text/plain" })).status, 409); assert.deepEqual(calls, []);
		const status = await request('{"action":"status"}'); assert.equal((await status.json()).enabled, false); assert.equal(status.headers.get("cache-control"), "no-store");
		assert.equal((await request('{"action":"start"}')).status, 200);
		assert.equal((await request('{"action":"pair"}')).status, 200);
		assert.equal((await request('{"action":"revoke","id":"synthetic-peer"}')).status, 200);
		assert.equal((await request('{"action":"stop"}')).status, 200);
		assert.deepEqual(calls, ["start", "192.168.1.2", "synthetic-peer", "stop"]); assert.equal(outbound, 0);
	} finally {
		delete host.__lessonLan; globalThis.fetch = fetch;
		if (original === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = original;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
