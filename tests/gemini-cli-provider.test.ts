import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { clampThinkingLevel, createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

const testData = mkdtempSync(join(tmpdir(), "lh-gemini-cli-provider-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { createGeminiCliProvider, GEMINI_CLI_MODELS } = await import("../src/agent/gemini-cli/provider.ts");
const { GeminiInstallKind } = await import("../src/agent/gemini-cli/binary.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { EXTERNAL_CLI_PROVIDERS, GEMINI_CLI_MINIMUM_VERSION } = await import("../src/core/index.ts");
const { EXTERNAL_CLI_STATUS_STATES } = await import("../src/core/contracts/external-cli.ts");
const { geminiCliInstallationResponse: respond, geminiCliInstallationStatus } = await import("../src/server/gemini-cli.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { catalogContextLimits, catalogProviders, modelCatalog, validateChatSettings } = await import("../src/server/model-catalog.ts");
const { SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

function withIsolatedCliEnv(t: TestContext, installKind: "none" | "binary" | "bundle", enabled: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "gemini-cli-bin-"));
	const saved = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		APPDATA: process.env.APPDATA,
		npm_config_prefix: process.env.npm_config_prefix,
	};
	const previousSettings = readSettings();

	if (installKind === "binary") {
		writeFileSync(join(dir, process.platform === "win32" ? "gemini.exe" : "gemini"), "", { mode: 0o755 });
	} else if (installKind === "bundle" && process.platform === "win32") {
		writeFileSync(join(dir, "gemini.cmd"), "");
		writeFileSync(join(dir, "node.exe"), "");
		const bundleDir = join(dir, "node_modules", "@google", "gemini-cli", "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "gemini.js"), "");
	}

	process.env.PATH = dir;
	process.env.HOME = dir;
	process.env.APPDATA = dir;
	delete process.env.npm_config_prefix;
	writeSettings({ version: 1, geminiCli: { enabled } });

	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (previousSettings) writeSettings(previousSettings);
		else rmSync(SETTINGS_FILE, { force: true });
		rmSync(dir, { recursive: true, force: true });
	});
}

test("registers fixed Gemini CLI aliases with reasoning disabled and unpriced placeholders", async () => {
	const collection = createModels();
	collection.setProvider(createGeminiCliProvider(() => createAssistantMessageEventStream()));
	const models = collection.getModels(EXTERNAL_CLI_PROVIDERS.geminiCli);
	assert.deepEqual(models.map((m) => m.id), ["pro", "flash", "flash-lite"]);
	assert.deepEqual(models.map((m) => m.name), ["Gemini Pro", "Gemini Flash", "Gemini Flash-Lite"]);
	assert.deepEqual(models, GEMINI_CLI_MODELS);

	for (const model of models) {
		assert.equal(model.reasoning, false);
		assert.equal(model.thinkingLevelMap, undefined);
		assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
		assert.equal(clampThinkingLevel(model, "high"), "off");
		assert.deepEqual(model.input, ["text"]);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}

	assert.ok(await collection.checkAuth(EXTERNAL_CLI_PROVIDERS.geminiCli));
	assert.deepEqual(
		piModels().getModels(EXTERNAL_CLI_PROVIDERS.geminiCli).map((m) => m.id),
		["pro", "flash", "flash-lite"],
	);
});

test("modelCatalog and providerKeyPresent stay closed when opt-in is off or binary is missing", (t) => {
	withIsolatedCliEnv(t, "binary", false);
	assert.equal(providerKeyPresent(EXTERNAL_CLI_PROVIDERS.geminiCli), false);
	assert.equal(catalogProviders().find((p) => p.id === EXTERNAL_CLI_PROVIDERS.geminiCli)?.keyPresent, false);
	assert.equal(modelCatalog().models.some((m) => m.provider === EXTERNAL_CLI_PROVIDERS.geminiCli), false);
	assert.equal(validateChatSettings({ model: { provider: EXTERNAL_CLI_PROVIDERS.geminiCli, id: "pro" } }).ok, false);
});

test("modelCatalog hides Gemini CLI when opt-in is on but binary is absent", (t) => {
	withIsolatedCliEnv(t, "none", true);
	assert.equal(providerKeyPresent(EXTERNAL_CLI_PROVIDERS.geminiCli), false);
	assert.equal(modelCatalog().models.some((m) => m.provider === EXTERNAL_CLI_PROVIDERS.geminiCli), false);
});

test("modelCatalog exposes Gemini CLI aliases with null cost and contextWindow when opted in and binary is on PATH", (t) => {
	withIsolatedCliEnv(t, "binary", true);
	assert.equal(providerKeyPresent(EXTERNAL_CLI_PROVIDERS.geminiCli), true);
	assert.equal(catalogProviders().find((p) => p.id === EXTERNAL_CLI_PROVIDERS.geminiCli)?.keyPresent, true);

	const models = modelCatalog().models.filter((m) => m.provider === EXTERNAL_CLI_PROVIDERS.geminiCli);
	assert.deepEqual(models.map((m) => m.id), ["flash", "flash-lite", "pro"]);
	for (const model of models) {
		assert.equal(model.cost, null);
		assert.equal(model.contextWindow, null);
		assert.equal(model.maxTokens, null);
		assert.deepEqual(model.supportedLevels, ["off"]);
	}
	assert.equal(catalogContextLimits().has("gemini-cli:pro"), false);
	const engine = piEngineForSpec({ provider: EXTERNAL_CLI_PROVIDERS.geminiCli, id: "pro" });
	assert.equal(engine.model.id, "pro");
	assert.equal(engine.level, "off");
});

if (process.platform === "win32") {
	test("Windows npm gemini.cmd + bundle + node on PATH opens the Gemini CLI gate", (t) => {
		withIsolatedCliEnv(t, "bundle", true);
		assert.equal(providerKeyPresent(EXTERNAL_CLI_PROVIDERS.geminiCli), true);
		assert.equal(modelCatalog().models.filter((m) => m.provider === EXTERNAL_CLI_PROVIDERS.geminiCli).length, 3);
	});
}

const geminiCliInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function statusRequest(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/gemini-cli", { headers: { "x-learnharness-external-cli": "1", ...headers } });
}

const status = { state: "not-found" as const, version: null, minimumVersion: GEMINI_CLI_MINIMUM_VERSION };

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-external-cli": "" },
] as Record<string, string>[]) {
	test(`unsafe status request ${JSON.stringify(headers)} never invokes the probe`, async () => {
		let probes = 0;
		const response = await geminiCliInstallationResponse(statusRequest(headers), async () => { probes++; return status; });
		assert.equal(response.status, 403);
		assert.equal(probes, 0);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	});
}

test("disabled opt-in never starts even a version probe", async () => {
	let probes = 0;
	const response = await respond(statusRequest(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403);
	assert.equal(probes, 0);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("ordinary image/subresource GET without intent header cannot start a probe", async () => {
	const response = await geminiCliInstallationResponse(new Request("http://localhost:3000/api/gemini-cli"), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

for (const headers of [{}, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
	test(`legitimate Providers GET ${JSON.stringify(headers)} is supported`, async () => {
		let probes = 0;
		const response = await geminiCliInstallationResponse(statusRequest(headers), async () => { probes++; return status; });
		assert.equal(response.status, 200);
		assert.equal(probes, 1);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.deepEqual(await response.json(), status);
	});
}

test("a forged forwarded origin cannot authorize a foreign Origin header", async () => {
	const response = await geminiCliInstallationResponse(
		statusRequest({ origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" }),
		async () => assert.fail("must not probe"),
	);
	assert.equal(response.status, 403);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("production status reports not-found when discovery finds nothing", async () => {
	assert.deepEqual(await geminiCliInstallationStatus(() => ({ kind: GeminiInstallKind.NOT_FOUND })), status);
});

test("production status reports node-missing for a bundle without node, and never reads a version", async () => {
	let reads = 0;
	const result = await geminiCliInstallationStatus(
		() => ({ kind: GeminiInstallKind.NODE_MISSING, script: "C:/npm/node_modules/@google/gemini-cli/bundle/gemini.js" }),
		async () => { reads++; return GEMINI_CLI_MINIMUM_VERSION; },
	);
	assert.deepEqual(result, { state: EXTERNAL_CLI_STATUS_STATES.nodeMissing, version: null, minimumVersion: GEMINI_CLI_MINIMUM_VERSION });
	assert.equal(result.state, "node-missing");
	assert.equal(reads, 0);
});

test("production status reads the version of a bundle script through node with GEMINI_CLI_NO_RELAUNCH=1", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gemini-status-bundle-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "gemini.js");
	// Prints a version only when the bundle was told not to start a copy of itself.
	writeFileSync(script, `process.stdout.write(process.env.GEMINI_CLI_NO_RELAUNCH === "1" ? "${GEMINI_CLI_MINIMUM_VERSION}\\n" : "relaunched\\n");\n`);
	assert.deepEqual(
		await geminiCliInstallationStatus(() => ({ kind: GeminiInstallKind.BUNDLE, script, node: process.execPath })),
		{ state: "meets-minimum", version: GEMINI_CLI_MINIMUM_VERSION, minimumVersion: GEMINI_CLI_MINIMUM_VERSION },
	);
});
