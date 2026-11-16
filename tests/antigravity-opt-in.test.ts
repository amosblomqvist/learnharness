import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing, isProviderKeyRefusal } = await import("../src/core/settings.ts");
const { parseAntigravitySettingsBody } = await import("../src/server/settings-body.ts");
const { antigravityEnabled, antigravityBinaryPath } = await import("../src/server/antigravity-config.ts");
const { antigravityStatusResponse, antigravityInstallResponse } = await import("../src/server/antigravity.ts");
const { validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { toPiAntigravityModel } = await import("../src/agent/antigravity/provider.ts");

function setup(t: TestContext) {
	const previous = readSettings();
	t.after(() => {
		if (previous) writeSettings(previous);
		else rmSync(SETTINGS_FILE, { force: true });
	});
	writeSettings({ version: 1 });
}

async function save(body: unknown) {
	return PUT(
		new Request("http://test/api/settings/antigravity", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section: "antigravity" }) },
	);
}

test("opt-in parses strictly and malformed stored values never enable Antigravity", () => {
	assert.deepEqual(parseAntigravitySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, ignored: true }), {
		ok: true,
		settings: { enabled: true },
	});
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: false }), {
		ok: true,
		settings: { enabled: false },
	});
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, binaryPath: "  /opt/bin/agy  " }), {
		ok: true,
		settings: { enabled: true, binaryPath: "/opt/bin/agy" },
	});
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, binaryPath: "   " }), {
		ok: true,
		settings: { enabled: true },
	});

	for (const raw of [
		true,
		null,
		[],
		"on",
		{ enabled: "true" },
		{ enabled: 1 },
		{ enabled: true, binaryPath: 123 },
		{ enabled: true, binaryPath: "/bad\0path" },
	]) {
		assert.equal(parseAntigravitySettingsBody(raw).ok, false);
	}

	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, antigravity: raw })?.antigravity?.enabled, true);
	}
	assert.deepEqual(
		sanitizeUserSettings({ version: 1, antigravity: { enabled: true, binaryPath: "/bad\0path" } })?.antigravity,
		{ enabled: true },
	);
	assert.deepEqual(
		sanitizeUserSettings({ version: 1, antigravity: { enabled: true, binaryPath: "  /opt/agy  " } })?.antigravity,
		{ enabled: true, binaryPath: "/opt/agy" },
	);
	assert.equal(sanitizeUserSettings({ version: 1 })?.antigravity, undefined);
});

test("default off; section writes toggle enabled and binaryPath while preserving saved model pins and unrelated settings", async (t) => {
	setup(t);
	const models = {
		strong: { model: { provider: "antigravity", id: "gemini-2.5-pro" } },
		cheap: { model: { provider: "antigravity", id: "gemini-2.5-flash" } },
	};
	writeSettings({ version: 1, models, graph: { enabled: false }, futureSection: { keep: 1 } });

	assert.equal(antigravityEnabled(), false);
	assert.equal(antigravityBinaryPath(), undefined);
	assert.equal(providerKeyPresent("antigravity"), false);

	assert.equal((await save({ enabled: true, binaryPath: "/custom/agy" })).status, 200);
	assert.equal(antigravityEnabled(), true);
	assert.equal(antigravityBinaryPath(), "/custom/agy");

	// Clearing binaryPath via replace-whole section leaves enabled intact and removes binaryPath
	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(antigravityEnabled(), true);
	assert.equal(antigravityBinaryPath(), undefined);

	// Toggling off preserves models and unrelated sections
	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(antigravityEnabled(), false);
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(
		validateModelsSettings(models, models).ok,
		true,
		"saved unavailable antigravity pins remain repairable, not silently removed",
	);

	// Invalid update leaves persisted setting unchanged
	assert.equal((await save({ enabled: "true" })).status, 400);
	assert.equal(antigravityEnabled(), false);
	assert.equal((await save({})).status, 200);
	assert.equal(antigravityEnabled(), false);
});

test("providerKeyMissing refusal explains Settings -> Providers setup rather than API keys", () => {
	const refusal = providerKeyMissing("antigravity", ["strong"]);
	assert.equal(refusal.code, "provider_key_missing");
	assert.equal(refusal.provider, "antigravity");
	assert.match(refusal.error, /Antigravity/);
	assert.match(refusal.error, /Settings → Providers/);
	assert(!refusal.error.includes("add one in Settings → Keys"));
	assert.equal(isProviderKeyRefusal(refusal.error), true);
});

test("disabled opt-in refuses status probe and install/remove mutations with 403", async (t) => {
	setup(t);
	const statusReq = new Request("http://test/api/antigravity", {
		headers: { "x-learnharness-antigravity": "1" },
	});
	const statusRes = await antigravityStatusResponse(statusReq, async () =>
		assert.fail("disabled Antigravity must not inspect runtime"),
	);
	assert.equal(statusRes.status, 403);

	const installReq = new Request("http://test/api/antigravity/install", {
		method: "POST",
		headers: { "x-learnharness-antigravity": "1" },
	});
	const installRes = await antigravityInstallResponse(installReq);
	assert.equal(installRes.status, 403);

	const removeReq = new Request("http://test/api/antigravity/install", {
		method: "DELETE",
		headers: { "x-learnharness-antigravity": "1" },
	});
	const removeRes = await antigravityInstallResponse(removeReq);
	assert.equal(removeRes.status, 403);
});

test("a saved Antigravity background job is refused before model execution while opt-in is off", async (t) => {
	setup(t);
	const chat = chatStore.createChat("Antigravity opt-in job fixture");
	t.after(() => {
		jobStore.deleteJobsForChat(chat.id);
		chatStore.deleteChat(chat.id);
	});
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "agy-off-job" });
	let calls = 0;
	const model = toPiAntigravityModel({
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		input: ["text"],
		reasoning: true,
		supportedThinkingLevels: ["low", "medium", "high"],
		thinkingLevelMap: {
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
			max: "high",
		},
		contextWindow: null,
		maxTokens: null,
	});
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async () => {},
		engineFor: () => ({
			model,
			streamFn: () => {
				calls++;
				assert.fail("must not run a disabled Antigravity model");
			},
		}),
		providerKeyMissing: (provider, tier) =>
			providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
	});
	await runner.runJob(job.id, { question: "Synthetic fixture only" });
	assert.equal(calls, 0);
	const refused = jobStore.getJob(job.id)!;
	assert.equal(refused.status, "error");
	assert.match(JSON.stringify(refused.result), /Settings → Providers/);
	assert(!JSON.stringify(refused.result).includes("add one in Settings → Keys"));
});
