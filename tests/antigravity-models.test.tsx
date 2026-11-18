import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { getSupportedThinkingLevels, clampThinkingLevel } from "@earendil-works/pi-ai";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-models-test-"));
const testData = path.join(testRoot, "data");
const testAuthFile = path.join(testRoot, "secrets", "auth.json");
fs.mkdirSync(testData, { recursive: true });
fs.mkdirSync(path.dirname(testAuthFile), { recursive: true });
process.env.LH_DATA_DIR = testData;
process.env.LH_AUTH_FILE = testAuthFile;
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

import type { ResolvedAntigravityRuntime } from "../src/agent/antigravity/installation.ts";
const { ANTIGRAVITY_PROVIDER, isProviderKeyRefusal, providerKeyMissing } = await import("../src/core/index.ts");
const { createAntigravityAuthManager } = await import("../src/agent/antigravity/auth.ts");
const { createAntigravityInstallerManager } = await import("../src/agent/antigravity/installation.ts");
const {
	buildThinkingConfigFromRawValues,
	discoverAntigravityModels,
	hasCachedAntigravityModels,
	readAntigravityModelsCache,
} = await import("../src/agent/antigravity/models-discovery.ts");
const {
	antigravityModelsCachePath,
	antigravityTokenFilePath,
	ensureAntigravityProfile,
} = await import("../src/agent/antigravity/profile.ts");
const { piModels } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const {
	antigravityAvailable,
	createAntigravityModelsManager,
	installAntigravityProviderSource,
} = await import("../src/server/antigravity-provider.ts");
const { antigravityModelsResponse } = await import("../src/server/antigravity.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { catalogContextLimits, modelCatalog, toModelDto } = await import("../src/server/model-catalog.ts");
const { callCost, jobCost, sessionCost } = await import("../src/server/pricing.ts");
const { accumulateJobUsage } = await import("../src/core/contracts/jobs.ts");
const { ModelMenuList } = await import("../components/settings/model-menu.tsx");
const { StatsBar } = await import("../components/stats-bar.tsx");

const FAKE_ACP = path.resolve(import.meta.dirname, "fixtures", "antigravity", "fake-acp.mjs");

function fakeRuntime(overrides: Partial<ResolvedAntigravityRuntime> = {}): ResolvedAntigravityRuntime {
	return {
		source: "managed",
		kind: "acp-server",
		executablePath: FAKE_ACP,
		harnessPath: "/tmp/localharness_external",
		args: [],
		version: "1.5.2",
		...overrides,
	};
}

test("buildThinkingConfigFromRawValues maps ACP values to 7-level map and handles non-reasoning models", () => {
	const mapped = buildThinkingConfigFromRawValues(["low", "medium", "very-high"]);
	assert.equal(mapped.reasoning, true);
	assert.deepEqual(mapped.supportedThinkingLevels, ["low", "medium", "xhigh"]);
	assert.deepEqual(mapped.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: null,
		xhigh: "very-high",
		max: null,
	});

	const nonReasoning = buildThinkingConfigFromRawValues([]);
	assert.equal(nonReasoning.reasoning, false);
	assert.deepEqual(nonReasoning.supportedThinkingLevels, ["off"]);
	assert.equal(nonReasoning.thinkingLevelMap.off, null);
});

test("discoverAntigravityModels probes session/new + per-model setConfigOption and falls back cleanly on timeout or error", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const customModels = JSON.stringify([
		{ value: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 1000000, thoughtValues: ["low", "high"] },
		{ value: "gemini-hang", name: "Hanging Model", thoughtValues: ["off", "low"] },
		{ value: "gemini-err", name: "Error Model", thoughtValues: ["off", "max"] },
		{ value: "gemini-flash", name: "Gemini Flash", thoughtValues: ["off", "minimal", "medium"] },
	]);

	const cache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		modelProbeTimeoutMs: 120,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: customModels,
			FAKE_ACP_HANG_CONFIG_VALUE: "gemini-hang",
			FAKE_ACP_ERROR_CONFIG_VALUE: "gemini-err",
			FAKE_ACP_CONFIG_VIA_NOTIFICATION: "1",
		},
	});

	assert.equal(cache.version, 1);
	assert.equal(cache.models.length, 4);
	assert.equal(hasCachedAntigravityModels({ dataDir: testData }), true);

	const pro = cache.models.find((m) => m.id === "gemini-3.1-pro")!;
	assert.equal(pro.contextWindow, 1000000);
	assert.deepEqual(pro.supportedThinkingLevels, ["low", "high"]);

	const flash = cache.models.find((m) => m.id === "gemini-flash")!;
	assert.equal(flash.contextWindow, null);
	assert.deepEqual(flash.supportedThinkingLevels, ["off", "minimal", "medium"]);

	// Timed-out & errored models still register with fallback thought_level values
	const hung = cache.models.find((m) => m.id === "gemini-hang")!;
	assert.equal(hung.reasoning, true);
	assert.ok(readAntigravityModelsCache({ dataDir: testData }));
});

test("model catalog surfaces Antigravity only when all 4 readiness gates hold, never probes ACP on boot/GET, and keeps pricing CLI billing", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	// Seed models.json cleanly without hitting fake-acp
	const cache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_INCLUDE_CONTEXT: "1",
		},
	});
	assert.equal(cache.models.length, 3);

	let runtimeAvailable = true;
	const spawnMarker = path.join(testRoot, "unexpected-spawn.txt");
	const noSpawnBin = path.join(testRoot, "no-spawn-acp.sh");
	fs.writeFileSync(
		noSpawnBin,
		`#!/bin/sh\necho "spawned" > "${spawnMarker}"\nexit 1\n`,
		{ mode: 0o755 },
	);
	const { resolveAntigravityRuntimeSync } = await import("../src/agent/antigravity/installation.ts");
	assert.equal(typeof resolveAntigravityRuntimeSync, "function");

	// Point installAntigravityProviderSource at current test root with stubbed runtime resolution
	installAntigravityProviderSource({
		resolveRuntimeSync: () => (runtimeAvailable ? fakeRuntime({ executablePath: noSpawnBin }) : null),
	});

	// 1) Disabled -> hidden
	writeSettings({ version: 1, antigravity: { enabled: false } });
	assert.equal(antigravityAvailable({ resolveRuntimeSync: () => fakeRuntime({ executablePath: noSpawnBin }) }), false);
	assert.equal(piModels().getModels(ANTIGRAVITY_PROVIDER).length, 0);
	assert.equal(modelCatalog().models.some((m) => m.provider === ANTIGRAVITY_PROVIDER), false);
	const refusal = providerKeyMissing(ANTIGRAVITY_PROVIDER, ["strong"]);
	assert.match(refusal.error, /Settings → Providers/);
	assert.equal(isProviderKeyRefusal(refusal.error), true);

	// 2) Enabled, signed in, models.json non-empty, runtime absent -> hidden
	writeSettings({ version: 1, antigravity: { enabled: true } });
	runtimeAvailable = false;
	assert.equal(piModels().getModels(ANTIGRAVITY_PROVIDER).length, 0);

	// 3) Enabled, signed in, models.json missing, runtime present -> hidden
	runtimeAvailable = true;
	const savedCache = fs.readFileSync(antigravityModelsCachePath({ dataDir: testData }), "utf8");
	fs.rmSync(antigravityModelsCachePath({ dataDir: testData }), { force: true });
	assert.equal(piModels().getModels(ANTIGRAVITY_PROVIDER).length, 0);

	// 4) Enabled, signed out -> hidden
	fs.writeFileSync(antigravityModelsCachePath({ dataDir: testData }), savedCache);
	fs.rmSync(antigravityTokenFilePath(profileDir), { force: true });
	assert.equal(piModels().getModels(ANTIGRAVITY_PROVIDER).length, 0);

	// 5) All 4 hold -> models appear in piModels & GET /api/models DTOs without spawning discovery!
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });
	const piAgy = piModels().getModels(ANTIGRAVITY_PROVIDER);
	assert.equal(piAgy.length, 3);
	assert.equal(fs.existsSync(spawnMarker), false, "readiness gates and piModels() must never spawn ACP");

	const proPi = piAgy.find((m) => m.id === "gemini-3.1-pro")!;
	const flashPi = piAgy.find((m) => m.id === "gemini-3-flash")!;
	const miniPi = piAgy.find((m) => m.id === "non-reasoning-mini")!;
	assert.deepEqual(getSupportedThinkingLevels(proPi), ["low", "medium", "high"]);
	assert.equal(clampThinkingLevel(proPi, "off"), "low");
	assert.deepEqual(getSupportedThinkingLevels(flashPi), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(getSupportedThinkingLevels(miniPi), ["off"]);

	const proDto = toModelDto(proPi);
	const flashDto = toModelDto(flashPi);
	assert.equal(proDto.cost, null);
	assert.equal(proDto.contextWindow, 1000000);
	assert.equal(flashDto.cost, null);
	assert.equal(flashDto.contextWindow, null, "unknown contextWindow must project as null, never a guessed fallback");
	assert.equal(flashDto.maxTokens, null);

	// Verify modelCatalog & pricing when providerKeyPresent reads real antigravityAvailable()
	process.env.LH_ANTIGRAVITY_BIN = FAKE_ACP;
	try {
		installAntigravityProviderSource();
		assert.equal(providerKeyPresent(ANTIGRAVITY_PROVIDER), true);
		const catalog = modelCatalog();
		assert.equal(
			catalog.providers.find((p) => p.id === ANTIGRAVITY_PROVIDER)?.keyPresent,
			true,
		);
		const agyDtos = catalog.models.filter((m) => m.provider === ANTIGRAVITY_PROVIDER);
		assert.equal(agyDtos.length, 3);
		const limits = catalogContextLimits();
		assert.equal(limits.get(`${ANTIGRAVITY_PROVIDER}:gemini-3.1-pro`), 1000000);
		assert.equal(limits.has(`${ANTIGRAVITY_PROVIDER}:gemini-3-flash`), false);

		// Pricing checks: unpriced / CLI billing
		const step = { inputTokens: 1000, outputTokens: 100, reasoningTokens: undefined, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const agyModelId = `${ANTIGRAVITY_PROVIDER}:gemini-3.1-pro`;
		assert.equal(callCost(step, agyModelId), null);
		const turn = { id: "t1", messageId: "m1", at: "2026-11-15T00:00:00Z", model: agyModelId, steps: [step] };
		const pricing = sessionCost({ turns: [turn] });
		assert.equal(pricing.unpriced, 1);
		assert.equal(jobCost({ usage: accumulateJobUsage(undefined, agyModelId, step) }), null);

		const menuHtml = renderToStaticMarkup(
			<ModelMenuList models={[proDto, flashDto]} effectiveId={undefined} onPick={() => {}} />,
		);
		assert.equal((menuHtml.match(/>CLI billing<\/span>/g) ?? []).length, 2);
		assert.match(menuHtml, /Antigravity account; LearnHarness does not estimate it/);
		assert.match(menuHtml, />—<\/span>/);

		const statsHtml = renderToStaticMarkup(<StatsBar turns={[turn]} pricing={pricing} />);
		assert(!statsHtml.includes("$0"));
		assert.match(statsHtml, /data-testid="stats-cost">CLI<\/span>/);
	} finally {
		delete process.env.LH_ANTIGRAVITY_BIN;
		writeSettings({ version: 1 });
	}
});

test("POST /api/antigravity/models enforces guards, refreshes models, and sign-in/logout manage models.json", async () => {
	const modelsPath = antigravityModelsCachePath({ dataDir: testData });
	fs.rmSync(modelsPath, { force: true });

	const installer = createAntigravityInstallerManager({
		resolveRuntime: async () => ({
			runtime: fakeRuntime(),
			managedInstalled: true,
			updateRequiredVersion: null,
			error: null,
		}),
	});
	const models = createAntigravityModelsManager({
		discover: (rt, opts) =>
			discoverAntigravityModels(rt, {
				...opts,
				authFile: testAuthFile,
				dataDir: testData,
			}),
		readCache: () => readAntigravityModelsCache({ dataDir: testData }),
		onUpdated: () => piModels(),
	});
	const auth = createAntigravityAuthManager({
		authFile: testAuthFile,
		dataDir: testData,
		onSignedIn: async (rt) => {
			await models.refresh(rt);
		},
	});
	const deps = {
		enabled: () => true,
		installer,
		auth,
		models,
		resolveRuntime: async () => ({
			runtime: fakeRuntime(),
			managedInstalled: true,
			updateRequiredVersion: null,
			error: null,
		}),
	};

	const modelsReq = (method = "POST", headers: Record<string, string> = {}) =>
		new Request("http://localhost:3000/api/antigravity/models", {
			method,
			headers: { "x-learnharness-antigravity": "1", ...headers },
		});

	// Guards: 405, 403 CSRF, 403 disabled, 409 signed out
	assert.equal((await antigravityModelsResponse(modelsReq("GET"), deps)).status, 405);
	assert.equal(
		(await antigravityModelsResponse(modelsReq("POST", { "x-learnharness-antigravity": "" }), deps)).status,
		403,
	);
	assert.equal((await antigravityModelsResponse(modelsReq("POST"), { ...deps, enabled: () => false })).status, 403);
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.rmSync(antigravityTokenFilePath(profileDir), { force: true });
	assert.equal((await antigravityModelsResponse(modelsReq("POST"), deps)).status, 409);

	// Complete Google sign-in -> onSignedIn automatically populates models.json
	const state = await auth.startAuth(fakeRuntime());
	const authUrl = new URL(state.authUrl!);
	const cbRedirect = new URL(authUrl.searchParams.get("redirect_uri")!);
	cbRedirect.searchParams.set("state", authUrl.searchParams.get("state")!);
	cbRedirect.searchParams.set("code", "auth-code-models");
	await fetch(cbRedirect);
	await auth.waitForIdle();
	assert.equal(auth.getState().phase, "succeeded");
	assert.equal(fs.existsSync(modelsPath), true);
	assert.equal(models.getStatus().count, 3);

	// Manual Refresh models returns 200 and updated models count
	const refreshRes = await antigravityModelsResponse(modelsReq("POST"), deps);
	assert.equal(refreshRes.status, 200);
	const refreshBody = (await refreshRes.json()) as { models?: { count: number; discovering: boolean; error: string | null } };
	assert.equal(refreshBody.models?.count, 3);
	assert.equal(refreshBody.models?.discovering, false);
	assert.equal(refreshBody.models?.error, null);

	// Logout clears token + models.json
	await auth.logout(fakeRuntime());
	assert.equal(fs.existsSync(modelsPath), false);
	assert.equal(models.getStatus().count, 0);
});

test("discoverAntigravityModels works with kind='cli' (agy 1.5.10) using --gemini-dir/--app-data-dir isolation", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.rmSync(antigravityTokenFilePath(profileDir), { force: true });
	const cache = await discoverAntigravityModels(
		fakeRuntime({ source: "cli", kind: "cli", args: ["acp"], version: "1.5.10", harnessPath: undefined }),
		{
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODE: "cli-1510",
				FAKE_ACP_RECORD_EVENTS: "1",
			},
		},
	);
	assert.equal(cache.models.length, 3);
	const recordedArgv = JSON.parse(
		fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-argv.json"), "utf8"),
	) as { argv: string[] };
	assert.deepEqual(recordedArgv.argv, ["acp", "--gemini-dir", profileDir, "--app-data-dir", "antigravity-acp"]);
});
