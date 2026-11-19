import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
const { ANTIGRAVITY_MANAGED_VERSION, ANTIGRAVITY_PROVIDER, isProviderKeyRefusal, providerKeyMissing } = await import(
	"../src/core/index.ts"
);
const { spawnAcpClient } = await import("../src/agent/antigravity/acp-client.ts");
const { createAntigravityAuthManager } = await import("../src/agent/antigravity/auth.ts");
const {
	createAntigravityInstallerManager,
	managedRuntimeRoot,
	resolveAntigravityRuntimeSync,
} = await import("../src/agent/antigravity/installation.ts");
const {
	buildThinkingConfigFromRawValues,
	discoverAntigravityModels,
	hasCachedAntigravityModels,
	readAntigravityModelsCache,
} = await import("../src/agent/antigravity/models-discovery.ts");
const {
	antigravityModelsCachePath,
	antigravityTokenFilePath,
	buildAntigravityEnvironment,
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
		version: ANTIGRAVITY_MANAGED_VERSION,
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

test("discoverAntigravityModels on kind='acp-server' captures usage_update.size per model, resolves initial model via session/new or backfill, and keeps unknown limits null", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const modelsWithWindows = JSON.stringify([
		{ value: "gemini-4-argon", name: "Gemini 4 Argon", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", usageWindow: 1048576, thoughtValues: ["low", "high", "xhigh"] },
		{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", usageWindow: 131072, thoughtValues: [] },
		{ value: "claude-opus-5-5", name: "Claude Opus 5.5", usageWindow: 1000000, thoughtValues: ["low", "medium", "high"] },
		{ value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", usageWindow: 1000000, thoughtValues: ["low", "medium", "high"] },
		{ value: "unknown-limit-model", name: "Unknown Limit Model", usageWindow: null, thoughtValues: ["low"] },
	]);

	// Case 1: session/new silent -> initial active model is backfilled after switching away to a different model.
	const cacheBackfill = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsWithWindows,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
		},
	});

	assert.equal(cacheBackfill.models.find((m) => m.id === "gemini-4-argon")?.contextWindow, 1048576);
	assert.equal(cacheBackfill.models.find((m) => m.id === "gemini-4-hydrogen")?.contextWindow, 1048576);
	assert.equal(cacheBackfill.models.find((m) => m.id === "gpt-oss-120b-medium")?.contextWindow, 131072);
	assert.equal(cacheBackfill.models.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1000000);
	assert.equal(cacheBackfill.models.find((m) => m.id === "claude-sonnet-5-5")?.contextWindow, 1000000);
	assert.equal(cacheBackfill.models.find((m) => m.id === "unknown-limit-model")?.contextWindow, null);

	// Case 2: session/new emits initial usage_update -> same-model no-op on initial model uses it directly,
	// while a different silent model still preserves null.
	const cacheSessionNew = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsWithWindows,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
		},
	});

	assert.equal(cacheSessionNew.models.find((m) => m.id === "gemini-4-argon")?.contextWindow, 1048576);
	assert.equal(cacheSessionNew.models.find((m) => m.id === "gemini-4-hydrogen")?.contextWindow, 1048576);
	assert.equal(cacheSessionNew.models.find((m) => m.id === "gpt-oss-120b-medium")?.contextWindow, 131072);
	assert.equal(cacheSessionNew.models.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1000000);
	assert.equal(cacheSessionNew.models.find((m) => m.id === "claude-sonnet-5-5")?.contextWindow, 1000000);
	assert.equal(cacheSessionNew.models.find((m) => m.id === "unknown-limit-model")?.contextWindow, null);
});

test("discoverAntigravityModels (AGY-001) on kind='acp-server' preserves null when switching from a known model to a silent different model", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const modelsWithUnknown = JSON.stringify([
		{ value: "known-1m", name: "Known 1M", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "unknown-null-window", name: "Unknown Null Window", usageWindow: null, thoughtValues: ["low"] },
		{ value: "unknown-omitted-update", name: "Unknown Omitted Update", usageWindow: 262144, omitUsageUpdate: true, thoughtValues: ["low"] },
		{ value: "known-128k", name: "Known 128K", usageWindow: 131072, thoughtValues: [] },
	]);

	const cache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsWithUnknown,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
		},
	});

	assert.equal(cache.models.find((m) => m.id === "known-1m")?.contextWindow, 1048576);
	assert.equal(
		cache.models.find((m) => m.id === "unknown-null-window")?.contextWindow,
		null,
		"switching from a 1,048,576 model to a different silent model with usageWindow: null must preserve null",
	);
	assert.equal(
		cache.models.find((m) => m.id === "unknown-omitted-update")?.contextWindow,
		null,
		"switching to a different model with omitUsageUpdate: true must preserve null",
	);
	assert.equal(cache.models.find((m) => m.id === "known-128k")?.contextWindow, 131072);
});

test("discoverAntigravityModels attributes async pre-reply usage_update accurately and ignores other sessionIds", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const modelsWithWindows = JSON.stringify([
		{ value: "gemini-4-argon", name: "Gemini 4 Argon", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", usageWindow: 131072, thoughtValues: [] },
		{ value: "claude-opus-5-5", name: "Claude Opus 5.5", usageWindow: 1000000, thoughtValues: ["low", "medium", "high"] },
		{ value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", usageWindow: 1000000, thoughtValues: ["low", "medium", "high"] },
	]);

	const cache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsWithWindows,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_PRE_REPLY_DELAY_MS: "15",
			FAKE_ACP_FOREIGN_SESSION_USAGE_WINDOW: "777777",
		},
	});

	assert.equal(cache.models.find((m) => m.id === "gemini-4-argon")?.contextWindow, 1048576);
	assert.equal(cache.models.find((m) => m.id === "gemini-4-hydrogen")?.contextWindow, 1048576);
	assert.equal(cache.models.find((m) => m.id === "gpt-oss-120b-medium")?.contextWindow, 131072);
	assert.equal(cache.models.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1000000);
	assert.equal(cache.models.find((m) => m.id === "claude-sonnet-5-5")?.contextWindow, 1000000);
});

test("discoverAntigravityModels on kind='cli' does not infer contextWindow from usage_update while keeping explicit metadata and thought levels", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.rmSync(antigravityTokenFilePath(profileDir), { force: true });

	const cliModels = JSON.stringify([
		{ value: "cli-initial", name: "CLI Initial", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "cli-same-as-initial", name: "CLI Same As Initial", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "cli-small", name: "CLI Small", usageWindow: 131072, thoughtValues: [] },
		{ value: "cli-silent-unknown", name: "CLI Silent Unknown", thoughtValues: ["low"] },
		{ value: "cli-explicit", name: "CLI Explicit", contextWindow: 500000, thoughtValues: ["low", "medium"] },
	]);

	const cache = await discoverAntigravityModels(
		fakeRuntime({ source: "cli", kind: "cli", args: ["acp"], version: "1.5.10", harnessPath: undefined }),
		{
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODE: "cli-1510",
				FAKE_ACP_MODELS_JSON: cliModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
				FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			},
		},
	);

	assert.equal(cache.models.find((m) => m.id === "cli-initial")?.contextWindow, null);
	assert.equal(cache.models.find((m) => m.id === "cli-same-as-initial")?.contextWindow, null);
	assert.deepEqual(cache.models.find((m) => m.id === "cli-same-as-initial")?.supportedThinkingLevels, ["low", "high"]);
	assert.equal(cache.models.find((m) => m.id === "cli-small")?.contextWindow, null);
	assert.deepEqual(cache.models.find((m) => m.id === "cli-small")?.supportedThinkingLevels, ["off"]);
	assert.equal(cache.models.find((m) => m.id === "cli-silent-unknown")?.contextWindow, null);
	// Explicit choice metadata is still preserved on kind="cli".
	assert.equal(cache.models.find((m) => m.id === "cli-explicit")?.contextWindow, 500000);
	assert.deepEqual(cache.models.find((m) => m.id === "cli-explicit")?.supportedThinkingLevels, ["low", "medium"]);
});

test("discoverAntigravityModels (AGY-001B) on kind='acp-server' taints stream when reply and post-reply usage_update arrive in the same stdout chunk", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const sameChunkModels = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-clean", name: "Clean Model", usageWindow: 1048576, thoughtValues: ["low"] },
		{
			value: "model-same-chunk",
			name: "Same Chunk Post-Reply",
			usageWindow: 131072,
			emitPostReplyUsageInSameChunk: true,
			thoughtValues: ["low", "high"],
		},
		{ value: "model-after", name: "After Model", usageWindow: 262144, thoughtValues: ["low"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	for (const emitSessionNew of ["0", "1"]) {
		const cache = await discoverAntigravityModels(fakeRuntime(), {
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODELS_JSON: sameChunkModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
				FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: emitSessionNew,
			},
		});

		assert.equal(cache.models.find((m) => m.id === "model-clean")?.contextWindow, 1048576);
		assert.equal(
			cache.models.find((m) => m.id === "model-same-chunk")?.contextWindow,
			null,
			`same-chunk post-reply usage_update must taint and preserve null (sessionNew=${emitSessionNew})`,
		);
		assert.deepEqual(cache.models.find((m) => m.id === "model-same-chunk")?.supportedThinkingLevels, ["low", "high"]);
		assert.equal(
			cache.models.find((m) => m.id === "model-after")?.contextWindow,
			null,
			`subsequent model after same-chunk taint must preserve null (sessionNew=${emitSessionNew})`,
		);
		assert.equal(
			cache.models.find((m) => m.id === "model-init")?.contextWindow,
			null,
			`initial model must be null after stream taint (sessionNew=${emitSessionNew})`,
		);
		assert.equal(cache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
	}
});

test("discoverAntigravityModels (AGY-001B) on kind='cli' preserves null when delayed post-reply usage_update from model B arrives during silent model C", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.rmSync(antigravityTokenFilePath(profileDir), { force: true });

	const cliDelayedModels = JSON.stringify([
		{ value: "cli-model-a", name: "CLI Model A", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "cli-model-b", name: "CLI Model B", usageWindow: 131072, postReplyUsageDelayMs: 20, thoughtValues: ["low"] },
		{ value: "cli-model-c", name: "CLI Model C Silent", usageWindow: null, preReplyDelayMs: 60, thoughtValues: ["low", "high"] },
		{ value: "cli-model-explicit", name: "CLI Model Explicit", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	const cache = await discoverAntigravityModels(
		fakeRuntime({ source: "cli", kind: "cli", args: ["acp"], version: "1.5.10", harnessPath: undefined }),
		{
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODE: "cli-1510",
				FAKE_ACP_MODELS_JSON: cliDelayedModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			},
		},
	);

	assert.equal(cache.models.find((m) => m.id === "cli-model-a")?.contextWindow, null);
	assert.equal(cache.models.find((m) => m.id === "cli-model-b")?.contextWindow, null);
	assert.equal(
		cache.models.find((m) => m.id === "cli-model-c")?.contextWindow,
		null,
		"silent model C on kind='cli' must not adopt delayed post-reply usage_update from model B",
	);
	assert.deepEqual(cache.models.find((m) => m.id === "cli-model-c")?.supportedThinkingLevels, ["low", "high"]);
	assert.equal(cache.models.find((m) => m.id === "cli-model-explicit")?.contextWindow, 500000);
});

test("discoverAntigravityModels taints stream and preserves null when a delayed post-reply usage_update lands during the next probe", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	// Two successful switches have different sizes; model-b replies without emitting
	// usage_update and its update arrives late (20ms) while model-c (60ms) is being probed
	// and emits its own size. Neither model-b nor model-c may be misattributed.
	const overlappingModels = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-a", name: "Model A", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "model-b", name: "Model B", usageWindow: 131072, postReplyUsageDelayMs: 20, thoughtValues: ["low"] },
		{ value: "model-c", name: "Model C", usageWindow: 1000000, preReplyDelayMs: 60, thoughtValues: ["low", "high"] },
		{ value: "model-d", name: "Model D", usageWindow: 262144, thoughtValues: ["low"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	for (const { label, runtime, extraEnv, expectedModelA } of [
		{ label: "acp-server", runtime: fakeRuntime(), extraEnv: {}, expectedModelA: 1048576 },
		{
			label: "cli",
			runtime: fakeRuntime({ source: "cli", kind: "cli", args: ["acp"], version: "1.5.10", harnessPath: undefined }),
			extraEnv: { FAKE_ACP_MODE: "cli-1510" },
			expectedModelA: null,
		},
	]) {
		const cache = await discoverAntigravityModels(runtime, {
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				...extraEnv,
				FAKE_ACP_MODELS_JSON: overlappingModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			},
		});

		assert.equal(cache.models.find((m) => m.id === "model-a")?.contextWindow, expectedModelA, `${label}: model-a contextWindow`);
		assert.equal(
			cache.models.find((m) => m.id === "model-b")?.contextWindow,
			null,
			`${label}: model-b with delayed post-reply update must not inherit model-a's window`,
		);
		assert.equal(
			cache.models.find((m) => m.id === "model-c")?.contextWindow,
			null,
			`${label}: model-c receiving overlapping usage_update notifications must taint and preserve null`,
		);
		assert.deepEqual(cache.models.find((m) => m.id === "model-c")?.supportedThinkingLevels, ["low", "high"]);
		assert.equal(
			cache.models.find((m) => m.id === "model-d")?.contextWindow,
			null,
			`${label}: subsequent model after tainted stream must preserve null`,
		);
		assert.equal(
			cache.models.find((m) => m.id === "model-init")?.contextWindow,
			null,
			`${label}: backfill must be skipped after stream taint`,
		);
		assert.equal(
			cache.models.find((m) => m.id === "model-explicit")?.contextWindow,
			500000,
			`${label}: explicit choice metadata must survive stream taint`,
		);
	}
});

test("discoverAntigravityModels preserves null after a timed-out probe emits a late usage_update while keeping explicit metadata", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const modelsWithTimeout = JSON.stringify([
		{ value: "model-initial", name: "Initial Model", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "model-known", name: "Known Model", usageWindow: 131072, thoughtValues: ["low"] },
		{ value: "model-hang", name: "Hanging Model", usageWindow: 262144, thoughtValues: ["low"] },
		{ value: "model-after-hang", name: "After Hang Model", usageWindow: 262144, thoughtValues: ["low", "high"] },
		{ value: "model-explicit", name: "Explicit Window Model", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	const cache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		modelProbeTimeoutMs: 60,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsWithTimeout,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_HANG_CONFIG_VALUE: "model-hang",
			FAKE_ACP_HANG_LATE_USAGE_MS: "75",
		},
	});

	assert.equal(cache.models.find((m) => m.id === "model-known")?.contextWindow, 131072);
	assert.equal(cache.models.find((m) => m.id === "model-hang")?.contextWindow, null);
	assert.equal(
		cache.models.find((m) => m.id === "model-after-hang")?.contextWindow,
		null,
		"model probed after a timed-out switch must preserve null instead of inheriting a late or stale usage_update",
	);
	assert.deepEqual(cache.models.find((m) => m.id === "model-after-hang")?.supportedThinkingLevels, ["low", "high"]);
	assert.equal(cache.models.find((m) => m.id === "model-initial")?.contextWindow, null);
	assert.equal(cache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
});

test("discoverAntigravityModels keeps failed backfill candidate null without corrupting subsequent backfill switches", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	// 1) RPC error on initial backfill candidate keeps it null while preserving known models
	const rpcErrBackfillModels = JSON.stringify([
		{ value: "init-fail", name: "Init Fail", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "init-ok", name: "Init OK", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "init-same", name: "Init Same", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "mid-small", name: "Mid Small", usageWindow: 131072, thoughtValues: [] },
	]);
	const cacheRpcErr = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: rpcErrBackfillModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_PRE_REPLY_DELAY_MS: "10",
			FAKE_ACP_FAIL_BACKFILL_VALUE: "init-fail",
		},
	});
	assert.equal(cacheRpcErr.models.find((m) => m.id === "init-fail")?.contextWindow, null);
	assert.equal(cacheRpcErr.models.find((m) => m.id === "init-ok")?.contextWindow, 1048576);
	assert.equal(cacheRpcErr.models.find((m) => m.id === "init-same")?.contextWindow, 1048576);
	assert.equal(cacheRpcErr.models.find((m) => m.id === "mid-small")?.contextWindow, 131072);

	// 2) RPC error on backfill candidate alongside a silent unknown-limit model preserves null on both
	const silentAfterErrModels = JSON.stringify([
		{ value: "init-fail", name: "Init Fail", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "init-silent", name: "Init Silent", thoughtValues: ["low"] },
		{ value: "mid-small", name: "Mid Small", usageWindow: 131072, thoughtValues: [] },
	]);
	const cacheSilentAfterErr = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: silentAfterErrModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_FAIL_BACKFILL_VALUE: "init-fail",
		},
	});
	assert.equal(cacheSilentAfterErr.models.find((m) => m.id === "init-fail")?.contextWindow, null);
	assert.equal(
		cacheSilentAfterErr.models.find((m) => m.id === "init-silent")?.contextWindow,
		null,
		"silent model must not inherit stale contextWindow",
	);
	assert.equal(cacheSilentAfterErr.models.find((m) => m.id === "mid-small")?.contextWindow, 131072);

	// 3) Timed-out backfill probe emitting a late usage_update must leave failed and silent models null
	const timeoutBackfillModels = JSON.stringify([
		{ value: "init-hang", name: "Init Hang", usageWindow: 262144, thoughtValues: ["low"] },
		{ value: "init-silent", name: "Init Silent", usageWindow: null, thoughtValues: ["low"] },
		{ value: "mid-small", name: "Mid Small", usageWindow: 131072, thoughtValues: [] },
	]);
	const cacheTimeoutBackfill = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		modelProbeTimeoutMs: 60,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: timeoutBackfillModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_HANG_BACKFILL_VALUE: "init-hang",
			FAKE_ACP_HANG_LATE_USAGE_MS: "75",
		},
	});
	assert.equal(cacheTimeoutBackfill.models.find((m) => m.id === "init-hang")?.contextWindow, null);
	assert.equal(cacheTimeoutBackfill.models.find((m) => m.id === "init-silent")?.contextWindow, null);
	assert.equal(cacheTimeoutBackfill.models.find((m) => m.id === "mid-small")?.contextWindow, 131072);
});

test("discoverAntigravityModels (AGY-001B P2) disables usage_update inference for unverified custom, external, or unpinned acp-server runtimes", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const delayedModels = JSON.stringify([
		{ value: "model-a", name: "Model A", usageWindow: 1048576, thoughtValues: ["low"] },
		{ value: "model-b", name: "Model B", usageWindow: 131072, postReplyUsageDelayMs: 20, thoughtValues: ["low"] },
		{ value: "model-c", name: "Model C Silent", usageWindow: null, preReplyDelayMs: 60, thoughtValues: ["low", "high"] },
		{ value: "model-explicit", name: "Model Explicit", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	for (const { label, runtime } of [
		{
			label: "custom acp-server",
			runtime: fakeRuntime({ source: "custom", kind: "acp-server", version: ANTIGRAVITY_MANAGED_VERSION }),
		},
		{
			label: "t3-external acp-server",
			runtime: fakeRuntime({ source: "t3-external", kind: "acp-server", version: ANTIGRAVITY_MANAGED_VERSION }),
		},
		{
			label: "unpinned managed acp-server",
			runtime: fakeRuntime({ source: "managed", kind: "acp-server", version: "1.5.2" }),
		},
	]) {
		const cache = await discoverAntigravityModels(runtime, {
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODELS_JSON: delayedModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
				FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			},
		});

		assert.equal(cache.models.find((m) => m.id === "model-a")?.contextWindow, null, `${label}: model-a must stay null`);
		assert.equal(cache.models.find((m) => m.id === "model-b")?.contextWindow, null, `${label}: model-b must stay null`);
		assert.equal(
			cache.models.find((m) => m.id === "model-c")?.contextWindow,
			null,
			`${label}: silent model-c must not inherit delayed 131072 update from model-b`,
		);
		assert.deepEqual(cache.models.find((m) => m.id === "model-c")?.supportedThinkingLevels, ["low", "high"]);
		assert.equal(
			cache.models.find((m) => m.id === "model-explicit")?.contextWindow,
			500000,
			`${label}: explicit choice metadata must be preserved`,
		);
	}
});

test("discoverAntigravityModels (AGY-001B P3) drains trailing shutdown usage_update before writing models.json so returned and disk caches agree", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const shutdownRaceModels = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-direct", name: "Direct Model", usageWindow: 1048576, thoughtValues: ["low", "high"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
	]);

	const returnedCache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: shutdownRaceModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			FAKE_ACP_EMIT_USAGE_ON_STDIN_EOF: "1",
			FAKE_ACP_STDIN_EOF_USAGE_WINDOW: "131072",
		},
	});

	const diskCache = readAntigravityModelsCache({ dataDir: testData });
	assert.ok(diskCache, "models.json must be written to disk");
	assert.deepEqual(diskCache, returnedCache, "on-disk models.json must exactly match returned cache");

	assert.equal(
		returnedCache.models.find((m) => m.id === "model-init")?.contextWindow,
		null,
		"returned cache must clear session/new-inferred window when trailing shutdown usage_update taints stream",
	);
	assert.equal(
		diskCache.models.find((m) => m.id === "model-init")?.contextWindow,
		null,
		"on-disk models.json must clear session/new-inferred window before persisting",
	);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(diskCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
	assert.equal(diskCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
});

test("installAntigravityProviderSource (AGY-001B P2) suppresses usage_update-inferred context windows on runtime mismatch while preserving explicit metadata", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const managedRoot = managedRuntimeRoot(testData);
	const releaseId = `release-${ANTIGRAVITY_MANAGED_VERSION}`;
	const versionDir = path.join(managedRoot, "versions", releaseId);
	fs.mkdirSync(versionDir, { recursive: true });
	const managedExec = path.join(versionDir, "agy_acp_server");
	fs.writeFileSync(managedExec, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP}" "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(managedRoot, "active.json"), JSON.stringify({ releaseId }));
	fs.writeFileSync(
		path.join(versionDir, ".install-complete.json"),
		JSON.stringify({
			releaseId,
			version: ANTIGRAVITY_MANAGED_VERSION,
			executable: { name: "agy_acp_server", bytes: fs.statSync(managedExec).size },
		}),
	);

	const customBin = path.join(testRoot, "custom_agy_acp_server");
	fs.writeFileSync(customBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

	const prevEnvBin = process.env.LH_ANTIGRAVITY_BIN;
	delete process.env.LH_ANTIGRAVITY_BIN;
	try {
		const managedRuntime = resolveAntigravityRuntimeSync({ dataDir: testData });
		assert.ok(managedRuntime, "managed 1.4.5 runtime must resolve synchronously");
		assert.equal(managedRuntime.source, "managed");
		assert.equal(managedRuntime.kind, "acp-server");
		assert.equal(managedRuntime.version, ANTIGRAVITY_MANAGED_VERSION);

		const catalogModels = JSON.stringify([
			{ value: "model-inferred", name: "Model Inferred", usageWindow: 1048576, thoughtValues: ["low", "high"] },
			{ value: "model-explicit", name: "Model Explicit", contextWindow: 500000, thoughtValues: ["low"] },
		]);

		const discovered = await discoverAntigravityModels(managedRuntime, {
			authFile: testAuthFile,
			dataDir: testData,
			env: {
				...process.env,
				FAKE_ACP_MODELS_JSON: catalogModels,
				FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
				FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			},
		});

		assert.deepEqual(discovered.runtime, {
			source: "managed",
			kind: "acp-server",
			version: ANTIGRAVITY_MANAGED_VERSION,
			executablePath: managedExec,
		});
		assert.equal(discovered.models.find((m) => m.id === "model-inferred")?.contextWindow, 1048576);
		assert.equal(discovered.models.find((m) => m.id === "model-inferred")?.contextWindowSource, "usage_update");
		assert.equal(discovered.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
		assert.equal(discovered.models.find((m) => m.id === "model-explicit")?.contextWindowSource, "explicit");

		writeSettings({ version: 1, antigravity: { enabled: true } });
		installAntigravityProviderSource();

		// 1) Under matching managed 1.4.5 runtime: both inferred and explicit limits publish
		const managedCatalog = modelCatalog();
		const managedInferredDto = managedCatalog.models.find(
			(m) => m.provider === ANTIGRAVITY_PROVIDER && m.id === "model-inferred",
		);
		const managedExplicitDto = managedCatalog.models.find(
			(m) => m.provider === ANTIGRAVITY_PROVIDER && m.id === "model-explicit",
		);
		assert.equal(managedInferredDto?.contextWindow, 1048576);
		assert.equal(managedExplicitDto?.contextWindow, 500000);
		const managedLimits = catalogContextLimits();
		assert.equal(managedLimits.get(`${ANTIGRAVITY_PROVIDER}:model-inferred`), 1048576);
		assert.equal(managedLimits.get(`${ANTIGRAVITY_PROVIDER}:model-explicit`), 500000);

		// 2) Switch to custom binaryPath without refreshing models: inferred limit is suppressed immediately
		writeSettings({ version: 1, antigravity: { enabled: true, binaryPath: customBin } });
		const customPiModels = piModels().getModels(ANTIGRAVITY_PROVIDER);
		assert.equal(customPiModels.find((m) => m.id === "model-inferred")?.contextWindow, 0);
		assert.equal(customPiModels.find((m) => m.id === "model-explicit")?.contextWindow, 500000);

		const customCatalog = modelCatalog();
		const customInferredDto = customCatalog.models.find(
			(m) => m.provider === ANTIGRAVITY_PROVIDER && m.id === "model-inferred",
		);
		const customExplicitDto = customCatalog.models.find(
			(m) => m.provider === ANTIGRAVITY_PROVIDER && m.id === "model-explicit",
		);
		assert.equal(
			customInferredDto?.contextWindow,
			null,
			"usage_update-inferred contextWindow must be suppressed when active runtime mismatches cache runtime",
		);
		assert.equal(
			customExplicitDto?.contextWindow,
			500000,
			"explicit choice metadata contextWindow must remain intact across runtime switches",
		);
		const customLimits = catalogContextLimits();
		assert.equal(customLimits.has(`${ANTIGRAVITY_PROVIDER}:model-inferred`), false);
		assert.equal(customLimits.get(`${ANTIGRAVITY_PROVIDER}:model-explicit`), 500000);

		// 3) Switching back to the matching managed 1.4.5 runtime restores the inferred limit
		writeSettings({ version: 1, antigravity: { enabled: true } });
		const restoredLimits = catalogContextLimits();
		assert.equal(restoredLimits.get(`${ANTIGRAVITY_PROVIDER}:model-inferred`), 1048576);
		assert.equal(restoredLimits.get(`${ANTIGRAVITY_PROVIDER}:model-explicit`), 500000);
	} finally {
		if (prevEnvBin !== undefined) process.env.LH_ANTIGRAVITY_BIN = prevEnvBin;
		writeSettings({ version: 1 });
		fs.rmSync(managedRoot, { recursive: true, force: true });
	}
});

test("discoverAntigravityModels (AGY-001B P3) drains trailing stdout usage_update arriving after child exit before writing models.json", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const postExitModels = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
		{ value: "model-direct", name: "Direct Model", usageWindow: 1048576, thoughtValues: ["low", "high"] },
	]);

	const returnedCache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: postExitModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			FAKE_ACP_EXIT_AFTER_CONFIG_VALUE: "model-direct",
			FAKE_ACP_POST_EXIT_USAGE_DELAY_MS: "25",
			FAKE_ACP_POST_EXIT_USAGE_WINDOW: "131072",
		},
	});

	const diskCache = readAntigravityModelsCache({ dataDir: testData });
	assert.ok(diskCache, "models.json must be written to disk");
	assert.deepEqual(diskCache, returnedCache, "on-disk models.json must match returned cache");

	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindowSource, undefined);
	assert.equal(diskCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(diskCache.models.find((m) => m.id === "model-init")?.contextWindowSource, undefined);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindowSource, "usage_update");
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindowSource, "explicit");
});

test("discoverAntigravityModels (AGY-001B P3) bounds stdout drain timeout and clears session-inferred windows when stdout stays open", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const heldStdoutModels = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
		{ value: "model-direct", name: "Direct Model", usageWindow: 1048576, thoughtValues: ["low", "high"] },
	]);

	const startedAt = Date.now();
	const returnedCache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		stdoutDrainMs: 30,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: heldStdoutModels,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
			FAKE_ACP_EXIT_AFTER_CONFIG_VALUE: "model-direct",
			FAKE_ACP_POST_EXIT_HOLD_STDOUT_MS: "1500",
		},
	});
	const elapsedMs = Date.now() - startedAt;

	assert.ok(elapsedMs < 1000, `discoverAntigravityModels must finish promptly on stdout drain timeout (took ${elapsedMs}ms)`);

	const diskCache = readAntigravityModelsCache({ dataDir: testData });
	assert.ok(diskCache, "models.json must be written to disk");
	assert.deepEqual(diskCache, returnedCache, "on-disk models.json must match returned cache");

	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindowSource, undefined);
	assert.equal(diskCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
});

test("spawnAcpClient.close (AGY-001B P3) drains trailing stdout lines even when child.exitCode is already non-null before close()", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	const runDir = fs.mkdtempSync(path.join(testRoot, "acp-drain-"));
	const cwd = path.join(runDir, "cwd");
	const tempDir = path.join(runDir, "tmp");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });

	const observedSizes: number[] = [];
	const modelsJson = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-direct", name: "Direct Model", usageWindow: 1048576, thoughtValues: ["low"] },
	]);
	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsJson,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EXIT_AFTER_CONFIG_VALUE: "model-direct",
			FAKE_ACP_POST_EXIT_USAGE_DELAY_MS: "30",
			FAKE_ACP_POST_EXIT_USAGE_WINDOW: "131072",
		},
		geminiHome: profileDir,
		tempDir,
		harnessPath: "/tmp/localharness_external",
	});

	const client = spawnAcpClient({
		cwd,
		env,
		runtime: fakeRuntime(),
		profileDir,
		onSessionUpdate: (_sessionId, update) => {
			if (update.sessionUpdate === "usage_update" && typeof update.size === "number") {
				observedSizes.push(update.size);
			}
		},
	});

	try {
		await client.initialize(5_000);
		const sess = await client.sessionNew({ cwd, mcpServers: [] }, 5_000);
		await client.setConfigOption(sess.sessionId, "model", "model-direct", 5_000);

		// Explicitly wait until child has exited BEFORE calling close() to guarantee child.exitCode !== null.
		if (client.child.exitCode === null) {
			await once(client.child, "exit");
		}
		assert.equal(client.child.exitCode, 0);

		await client.close({ stdoutDrainMs: 250 });
		assert.equal(client.isStdoutDrained(), true);
		assert.ok(observedSizes.includes(131072), `expected trailing post-exit usage_update 131072, got ${observedSizes.join(",")}`);
	} finally {
		await client.close({ stdoutDrainMs: 50 }).catch(() => {});
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("discoverAntigravityModels (AGY-001B P3) clears session-inferred windows when stdout is destroyed prematurely before EOF", async () => {
	const profileDir = ensureAntigravityProfile({ authFile: testAuthFile });
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

	const modelsJson = JSON.stringify([
		{ value: "model-init", name: "Init Model", usageWindow: 524288, thoughtValues: ["low"] },
		{ value: "model-explicit", name: "Explicit Model", contextWindow: 500000, thoughtValues: ["low"] },
		{ value: "model-direct", name: "Direct Model", usageWindow: 1048576, thoughtValues: ["low", "high"] },
	]);

	let destroyedPrematurely = false;
	let readableEndedAtDestroy: boolean | null = null;
	const wrappedSpawn = ((...args: Parameters<typeof spawn>) => {
		const child = spawn(...args);
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			if (destroyedPrematurely) return;
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.includes('"currentValue":"model-direct"') && line.includes('"result"')) {
					destroyedPrematurely = true;
					queueMicrotask(() => {
						if (child.stdout) {
							readableEndedAtDestroy = child.stdout.readableEnded;
							child.stdout.destroy();
						}
					});
					break;
				}
			}
		});
		return child;
	}) as typeof spawn;

	const returnedCache = await discoverAntigravityModels(fakeRuntime(), {
		authFile: testAuthFile,
		dataDir: testData,
		spawnProcess: wrappedSpawn,
		env: {
			...process.env,
			FAKE_ACP_MODELS_JSON: modelsJson,
			FAKE_ACP_EMIT_USAGE_ON_MODEL_CHANGE: "1",
			FAKE_ACP_EMIT_USAGE_ON_SESSION_NEW: "1",
		},
	});

	assert.equal(destroyedPrematurely, true, "test wrapper must destroy stdout after final set_config_option reply");
	assert.equal(readableEndedAtDestroy, false, "stdout must be destroyed before reaching readable EOF");

	const diskCache = readAntigravityModelsCache({ dataDir: testData });
	assert.ok(diskCache, "models.json must be written to disk");
	assert.deepEqual(diskCache, returnedCache, "on-disk models.json must match returned cache");

	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(returnedCache.models.find((m) => m.id === "model-init")?.contextWindowSource, undefined);
	assert.equal(diskCache.models.find((m) => m.id === "model-init")?.contextWindow, null);
	assert.equal(diskCache.models.find((m) => m.id === "model-init")?.contextWindowSource, undefined);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(returnedCache.models.find((m) => m.id === "model-direct")?.contextWindowSource, "usage_update");
	assert.equal(diskCache.models.find((m) => m.id === "model-direct")?.contextWindow, 1048576);
	assert.equal(diskCache.models.find((m) => m.id === "model-direct")?.contextWindowSource, "usage_update");
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
	assert.equal(returnedCache.models.find((m) => m.id === "model-explicit")?.contextWindowSource, "explicit");
	assert.equal(diskCache.models.find((m) => m.id === "model-explicit")?.contextWindow, 500000);
	assert.equal(diskCache.models.find((m) => m.id === "model-explicit")?.contextWindowSource, "explicit");
});
