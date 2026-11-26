import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set LH_DATA_DIR before importing store/config modules so tests never touch repo data/.
const testDir = mkdtempSync(join(tmpdir(), "lh-agy-test-"));
const prevDataDir = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = testDir;

const { AGY_MINIMUM_VERSION, AGY_PROVIDER, providerKeyMissing, sanitizeUserSettings } = await import("../src/core/index.ts");
const { parseAgySettingsBody } = await import("../src/server/settings-body.ts");
const { agyAvailable, agyEnabled } = await import("../src/server/agy-config.ts");
const { agyInstallationResponse } = await import("../src/server/agy.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { toModelDto } = await import("../src/server/model-catalog.ts");
const { parseAgyModelsOutput } = await import("../src/agent/agy/provider.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { agyStatusLabel } = await import("../components/settings/agy-status.tsx");

describe("AGY settings sanitization & body parser", () => {
	it("sanitizes valid, absent, and malformed agy records", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, agy: { enabled: true } })?.agy, { enabled: true });
		assert.equal(sanitizeUserSettings({ version: 1 })?.agy, undefined);
		for (const malformed of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
			assert.notEqual(sanitizeUserSettings({ version: 1, agy: malformed as never })?.agy?.enabled, true);
		}
	});

	it("parses valid bodies and rejects non-boolean enabled", () => {
		assert.deepEqual(parseAgySettingsBody({}), { ok: true, settings: {} });
		assert.deepEqual(parseAgySettingsBody({ enabled: true, ignored: "extra" }), { ok: true, settings: { enabled: true } });
		for (const invalid of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
			assert.equal(parseAgySettingsBody(invalid).ok, false);
		}
	});
});

describe("AGY keys presence and catalog DTO", () => {
	before(() => {
		settingsStore.writeSettings({ version: 1 });
	});

	after(() => {
		if (prevDataDir !== undefined) process.env.LH_DATA_DIR = prevDataDir;
		else delete process.env.LH_DATA_DIR;
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reports availability and refusal message based on opt-in and binary presence", () => {
		settingsStore.writeSettings({ version: 1, agy: { enabled: false } });
		assert.equal(agyEnabled(), false);
		assert.equal(providerKeyPresent(AGY_PROVIDER), false);
		assert.match(providerKeyMissing(AGY_PROVIDER, ["strong"]).error, /Antigravity CLI is unavailable/);

		settingsStore.writeSettings({ version: 1, agy: { enabled: true } });
		assert.equal(agyEnabled(), true);
		assert.equal(providerKeyPresent(AGY_PROVIDER), agyAvailable());
	});

	it("projects agy models as unpriced with null contextWindow and maxTokens", () => {
		const [model] = parseAgyModelsOutput("gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)");
		assert(model);
		const dto = toModelDto(model);
		assert.equal(dto.cost, null);
		assert.equal(dto.contextWindow, null);
		assert.equal(dto.maxTokens, null);
	});
});

describe("AGY installation route response", () => {
	const makeRequest = (headers: Record<string, string> = {}) =>
		new Request("http://localhost:3000/api/agy", { headers: { "x-learnharness-agy": "1", ...headers } });
	const fakeStatus = { state: "meets-minimum" as const, version: "1.5.0", minimumVersion: AGY_MINIMUM_VERSION };

	it("rejects missing intent, non-GET, cross-site, and disabled requests", async () => {
		assert.equal((await agyInstallationResponse(new Request("http://localhost:3000/api/agy"), async () => fakeStatus, () => true)).status, 403);
		assert.equal((await agyInstallationResponse(new Request("http://localhost:3000/api/agy", { method: "POST", headers: { "x-learnharness-agy": "1" } }), async () => fakeStatus, () => true)).status, 403);
		assert.equal((await agyInstallationResponse(makeRequest({ "sec-fetch-site": "cross-site" }), async () => fakeStatus, () => true)).status, 403);
		assert.equal((await agyInstallationResponse(makeRequest({ origin: "https://attacker.invalid" }), async () => fakeStatus, () => true)).status, 403);

		let probed = false;
		const disabled = await agyInstallationResponse(makeRequest(), async () => { probed = true; return fakeStatus; }, () => false);
		assert.equal(disabled.status, 403);
		assert.equal(probed, false);
	});

	it("returns 200 with no-store when enabled and valid", async () => {
		const res = await agyInstallationResponse(makeRequest(), async () => fakeStatus, () => true);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.deepEqual(await res.json(), fakeStatus);
	});
});

describe("AGY status label formatter", () => {
	it("formats status states", () => {
		assert.equal(agyStatusLabel({ state: "not-found", version: null, minimumVersion: AGY_MINIMUM_VERSION }), "Not found");
		assert.equal(agyStatusLabel({ state: "meets-minimum", version: "1.5.0", minimumVersion: AGY_MINIMUM_VERSION }), "Version 1.5.0 · meets minimum");
		assert.equal(agyStatusLabel({ state: "update-required", version: "1.4.0", minimumVersion: AGY_MINIMUM_VERSION }), "Version 1.4.0 · update required");
		assert.equal(agyStatusLabel(null), "Version could not be checked");
	});
});
