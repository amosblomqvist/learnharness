import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const data = mkdtempSync(path.join(tmpdir(), "lh-codex-dictation-"));
process.env.LH_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));
const { writeSettings } = await import("../src/store/settings.ts");
const { POST } = await import("../app/api/stt/transcribe/route.ts");

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/stt/transcribe", {
		method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "x-lh-dictation": "1", "content-type": "audio/pcm", ...headers }, body: new Uint8Array([0, 0]),
	});
}

test("subscription dictation requires an explicit choice and a same-origin request", async () => {
	writeSettings({ version: 1 });
	assert.equal((await POST(request())).status, 403);
	writeSettings({ version: 1, dictation: { provider: "codex" } });
	assert.equal((await POST(request({ origin: "https://other.example" }))).status, 403);
	assert.equal((await POST(request({ "sec-fetch-site": "cross-site" }))).status, 403);
	assert.equal((await POST(request({ "x-lh-dictation": "" }))).status, 403);
	assert.equal((await POST(request())).status, 200); // Short silence needs no upstream request.
});
