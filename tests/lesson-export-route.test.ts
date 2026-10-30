/** Real route, synthetic isolated library, no server, keys or provider requests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-export-route-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
let POST: (request: Request) => Promise<Response>;
let beginTurn: (id: string) => boolean, endTurn: (id: string) => void;
const originalFetch = globalThis.fetch;
let network = 0;
before(async () => {
	globalThis.fetch = async () => { network++; throw new Error("Network forbidden in export test"); };
	POST = (await import("../app/api/lesson-export/route.ts")).POST;
	({ beginTurn, endTurn } = await import("../src/server/turn-liveness.ts"));
	fs.mkdirSync(path.join(root, "chats"), { recursive: true });
	fs.writeFileSync(path.join(root, "chats/chat_export.json"), JSON.stringify({ id: "chat_export", title: "Synthetic", messages: [{ id: "u", role: "user", content: "Offline example" }] }));
});
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
const request = (body: unknown, origin = "http://localhost") => new Request("http://localhost/api/lesson-export", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
test("route rejects foreign origins, oversized bodies, stale previews and live writers", async () => {
	assert.equal((await POST(request({ ids: ["chat_export"], mode: "json" }, "https://foreign.invalid"))).status, 403);
	assert.equal((await POST(request({ data: "x".repeat(65_536) }))).status, 400);
	assert.equal((await POST(request({ ids: ["chat_export"], mode: "zip", revision: "stale", allowIncomplete: true }))).status, 400);
	assert.equal(beginTurn("chat_export"), true);
	try { assert.equal((await POST(request({ ids: ["chat_export"], mode: "json" }))).status, 409); }
	finally { endTurn("chat_export"); }
	assert.equal(network, 0);
});
test("route returns download headers and supports preview/explicit partial ZIP without mutation or spending", async () => {
	const before = fs.readFileSync(path.join(root, "chats/chat_export.json"));
	const res = await POST(request({ ids: ["chat_export"], mode: "json" }));
	assert.equal(res.status, 200); assert.equal(res.headers.get("Cache-Control"), "no-store");
	assert.match(res.headers.get("Content-Disposition")!, /^attachment/);
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), before);
	const preview = await POST(request({ ids: ["chat_export"], preview: true }));
	assert.equal(preview.status, 200);
	const body = await preview.json() as { revision: string };
	const zip = await POST(request({ ids: ["chat_export"], mode: "zip", revision: body.revision, files: [], allowIncomplete: true }));
	assert.equal(zip.status, 200); assert.equal(zip.headers.get("Content-Type"), "application/zip");
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_export.json")), before); assert.equal(network, 0);
});
