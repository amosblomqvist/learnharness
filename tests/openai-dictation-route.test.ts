import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { pcm16Wav } from "../src/core/dictation.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-openai-stt-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.OPENAI_API_KEY;
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey } = await import("../src/server/keys.ts");
const { POST } = await import("../app/api/stt/openai/route.ts");
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	delete process.env.OPENAI_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});
const request = () => new Request("http://localhost/api/stt/openai", {
	method: "POST", headers: { "content-type": "audio/wav" }, body: pcm16Wav([new Uint8Array([0, 1])]),
});

it("only dispatches through the saved OpenAI provider and Platform key", async () => {
	let calls = 0;
	globalThis.fetch = async (_input, init) => {
		calls++;
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-fake-test-key-123456");
		return Response.json({ text: "Recorded text" });
	};
	assert.equal((await POST(request())).status, 403, "Deepgram remains the default");
	writeSettings({ version: 1, general: { dictationProvider: "openai" } });
	assert.equal((await POST(request())).status, 503, "subscription login is not an API key");
	assert.equal(saveKey("OPENAI_API_KEY", "sk-fake-test-key-123456").ok, true);
	const result = await POST(request());
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), { text: "Recorded text" });
	assert.equal(calls, 1);
});
