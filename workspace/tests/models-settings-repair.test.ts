import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ModelsSettings, ModelSlotName } from "../src/core/settings.ts";
import type { NativeSubscriptionSnapshot } from "../src/core/contracts/subscriptions.ts";

// Every app import follows isolation. No installed credentials, ambient keys,
// OAuth, or provider requests: subscription state comes from synthetic IPC.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-models-repair-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
process.env.LH_DESKTOP_SERVER = "1";
process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
Object.defineProperty(process, "connected", { configurable: true, value: true });

const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { refreshSubscriptionModels } = await import("../src/agent/subscription-bridge.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { readSettings: readSettingsRecord, writeSettings: writeSettingsRecord } = await import("../src/store/settings.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { clampThinkingLevel, normalizeContext } = await import("@earendil-works/pi-ai");
const native = piModels().getModels("github-copilot")[0]!;
const copilot = { provider: "github-copilot-subscription", id: native.id };
const replacement = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const slots: ModelSlotName[] = ["strong", "cheap", "vision"];
const initial: ModelsSettings = Object.fromEntries(slots.map((slot) => [slot, { model: copilot, thinkingLevel: "high" }]));
let connected = false, revision = 0, leases = 0;
function snapshot(): NativeSubscriptionSnapshot {
	return {
		statuses: [{ providerId: "github-copilot", available: true, connected, pending: false, allowBackgroundUse: true, connectionId: connected ? "fixture-connection" : null, epoch: revision, authorityRevision: revision, revision }],
		models: { "github-copilot": connected ? [native] : [] },
	};
}
Object.defineProperty(process, "send", { configurable: true, value: (message: { id: string; op: string }, callback?: () => void) => {
	if (message.op !== "snapshot") { leases++; throw new Error("No credential lease expected"); }
	queueMicrotask(() => (process.emit as (event: string, value: unknown) => boolean)("message", { channel: "lh:subscriptions", id: message.id, op: message.op, ok: true, value: snapshot() }));
	callback?.(); return true;
} });
async function connection(value: boolean) { connected = value; revision++; await refreshSubscriptionModels(); }
async function put(body: unknown) {
	return PUT(new Request("http://localhost/api/settings/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ section: "models" }) });
}
beforeEach(async () => {
	await connection(false);
	writeSettingsRecord({ version: 1, models: initial, general: { autoUpdate: false }, graph: { rendering: false } });
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	for (const [key, value] of [["LH_DESKTOP_SERVER", marker], ["LH_DESKTOP_API_SECRET", secret]]) {
		if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
	}
	fs.rmSync(directory, { recursive: true, force: true });
});

for (const slot of slots) test(`${slot} can be replaced while the other disconnected slots remain saved`, async () => {
	const response = await put({ ...initial, [slot]: { model: replacement, thinkingLevel: "xhigh" } });
	assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
	const stored = readSettingsRecord()!;
	assert.deepEqual(stored.models?.[slot], { model: replacement, thinkingLevel: "max" });
	for (const other of slots.filter((name) => name !== slot)) assert.deepEqual(stored.models?.[other], initial[other]);
	assert.deepEqual(stored.general, { autoUpdate: false });
	assert.deepEqual(stored.graph, { rendering: false });
	assert.deepEqual((await response.json()).settings, stored);
	assert(!modelCatalog().models.some((model) => model.provider === copilot.provider), "saving stale pins must not make them available choices");
});

test("all three slots can be repaired successively without reconnecting", async () => {
	for (const slot of slots) {
		const response = await put({ ...readSettingsRecord()!.models, [slot]: { model: replacement } });
		assert.equal(response.status, 200);
	}
	assert.deepEqual(readSettingsRecord()!.models, Object.fromEntries(slots.map((slot) => [slot, { model: replacement }])));
});

test("thinking preferences on unchanged disconnected models can be changed, removed, and restored", async () => {
	for (const thinkingLevel of ["max", undefined, "minimal"] as const) {
		const strong = { model: copilot, ...(thinkingLevel ? { thinkingLevel } : {}) };
		const response = await put({ ...initial, strong });
		assert.equal(response.status, 200);
		assert.deepEqual(readSettingsRecord()!.models?.strong, strong);
	}
	await connection(true);
	const engine = piEngineForSpec({ ...copilot, thinkingLevel: "minimal" }, false);
	assert.equal(engine.level, clampThinkingLevel(native, "minimal"), "reconnected runtime clamps the saved preference");
	assert.equal((await put(readSettingsRecord()!.models)).status, 200);
	assert.equal(readSettingsRecord()!.models?.strong?.thinkingLevel, engine.level, "known metadata still clamps on write");
});

test("introduced or replaced unknown models still reject, without writing any section", async () => {
	for (const model of [
		{ provider: copilot.provider, id: "fixture-not-in-catalog" },
		{ provider: "xai-subscription", id: copilot.id },
		{ provider: "fixture-unknown-provider", id: copilot.id },
		{ provider: replacement.provider, id: "fixture-not-in-catalog" },
	]) {
		const before = readSettingsRecord();
		assert.equal((await put({ ...initial, strong: { model } })).status, 400);
		assert.deepEqual(readSettingsRecord(), before);
	}
	writeSettingsRecord({ version: 1, models: { strong: initial.strong } });
	assert.equal((await put({ strong: initial.strong, cheap: initial.strong })).status, 400, "a pin saved in one slot cannot authorize another slot");
	assert.equal((await put(initial)).status, 400, "missing slots cannot introduce disconnected models");
});

test("a first models write cannot introduce disconnected selections", async () => {
	fs.unlinkSync(path.join(directory, "settings.json"));
	assert.equal((await put(initial)).status, 400);
	assert.equal(readSettingsRecord(), null);
});

test("a replaced stale selection cannot be reintroduced without availability", async () => {
	assert.equal((await put({ ...initial, strong: { model: replacement } })).status, 200);
	assert.equal((await put(initial)).status, 400);
	assert.deepEqual(readSettingsRecord()!.models?.strong?.model, replacement);
});

test("slot removal still replaces the whole section, including clearing all slots", async () => {
	assert.equal((await put({ cheap: initial.cheap })).status, 200);
	assert.deepEqual(readSettingsRecord()!.models, { cheap: initial.cheap });
	assert.equal((await put({})).status, 200);
	assert.deepEqual(readSettingsRecord()!.models, {});
});

test("unchanged model identity does not bypass body shape validation", async () => {
	for (const body of [
		{ ...initial, strong: { model: copilot, thinkingLevel: 7 } },
		{ ...initial, strong: { thinkingLevel: "high" } },
		{ ...initial, strong: { model: { provider: copilot.provider } } },
	]) assert.equal((await put(body)).status, 400);
	assert.deepEqual(readSettingsRecord()!.models, initial);
});

test("standalone catalog validation stays strict without a stored section", () => {
	assert.equal(validateModelsSettings(initial).ok, false);
	assert.equal(validateModelsSettings({ strong: { model: replacement } }).ok, true);
});

test("retained selections remain unavailable at runtime, with no API-key fallback or credential lease", async () => {
	await connection(true);
	const engine = piEngineForSpec(copilot, false);
	await connection(false);
	assert.equal((await put({ ...initial, cheap: { model: replacement } })).status, 200);
	assert.throws(() => piEngineForSpec(copilot, false), /catalog has no model/);
	let requests = 0;
	const before = leases;
	const key = process.env.COPILOT_GITHUB_TOKEN;
	process.env.COPILOT_GITHUB_TOKEN = "fixture-must-not-be-used";
	try {
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [] }), { fetch: async () => { requests++; throw new Error("Must not dispatch"); } }).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No API-key fallback was used/);
		assert.equal(requests, 0);
		assert.equal(leases, before);
	} finally {
		if (key === undefined) delete process.env.COPILOT_GITHUB_TOKEN; else process.env.COPILOT_GITHUB_TOKEN = key;
	}
});
