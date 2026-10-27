import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dev-ipc-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
process.env.OPENAI_API_KEY = "sk-fixture-not-used-for-generation";
const { GET } = await import("../app/api/models/route.ts");
const { chatGPTRequest, chatGPTConnected, chatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("Next-style IPC is not desktop transport; web ownership works without delaying keyed catalogs", async () => {
	const send = Object.getOwnPropertyDescriptor(process, "send");
	const connected = Object.getOwnPropertyDescriptor(process, "connected");
	const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
	const originalFetch = globalThis.fetch;
	let sends = 0;
	try {
		globalThis.fetch = async () => { throw new Error("provider/network calls forbidden in catalog fixture"); };
		Object.defineProperty(process, "send", { configurable: true, value: (_message: unknown, callback?: (error: Error) => void) => { sends++; callback?.(new Error("not a desktop parent")); return false; } });
		Object.defineProperty(process, "connected", { configurable: true, value: true });
		for (const [mode, capability] of [[undefined, undefined], ["1", undefined], [undefined, "d".repeat(64)], ["1", "short"]]) {
			if (mode === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = mode;
			if (capability === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = capability;
			// A framework parent cannot establish ChatGPT state by sharing only IPC.
			(process.emit as (name: string, value: unknown) => boolean)("message", { channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 1 }, status: { available: true, activeId: "fixture", accounts: [{ id: "fixture", connected: true, planEnabled: true }] } });
			const response = await GET();
			assert.equal(response.status, 200);
			const catalog = await response.json();
			assert.ok(catalog.models.some((m: { provider: string }) => m.provider === "openai"));
			assert.equal(catalog.providers.find((p: { id: string }) => p.id === "openai").keyPresent, true);
			assert.equal(catalog.providers.find((p: { id: string }) => p.id === "chatgpt").keyPresent, false);
			assert.equal(chatGPTConnected(), false);
			assert.deepEqual(chatGPTModels(), []);
			if (!mode && !capability) {
				const value = await chatGPTRequest<{ status: { available: boolean; accounts: unknown[] } }>("status");
				assert.equal(value.status.available, true);
				assert.deepEqual(value.status.accounts, []);
			} else await assert.rejects(chatGPTRequest("status"), /available only in the desktop app/);
			assert.equal(sends, 0, "no desktop request/timer may be started over framework IPC");
		}
		process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
		Object.defineProperty(process, "connected", { configurable: true, value: false });
		await GET();
		await assert.rejects(chatGPTRequest("status"), /available only in the desktop app/);
		assert.equal(sends, 0, "desktop markers without connected IPC do not suffice");
	} finally {
		globalThis.fetch = originalFetch;
		if (send) Object.defineProperty(process, "send", send); else delete process.send;
		if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
		if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
		if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
	}
});
