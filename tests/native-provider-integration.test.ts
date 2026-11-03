/** Real module loading and server/engine wiring, with synthetic Pi streams only. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { AssistantMessage, Context, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelsSettings } from "../src/core/settings.ts";
import type { JobKind, SteerMessage } from "../src/core/contracts.ts";

const directory = mkdtempSync(join(tmpdir(), "lh-native-integration-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
const data = join(directory, "data");
const authFile = join(directory, "auth.json");
const configFile = join(directory, "providers.json");
const moduleFile = join(directory, "provider.cjs");
// Replace rather than extend: no inherited tokens, SDK URL overrides, cloud
// profiles or desktop auth IPC can escape this disposable test process.
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: directory, LH_DATA_DIR: data, LH_AUTH_FILE: authFile, LH_IGNORE_ENV_KEYS: "1", LH_NATIVE_PROVIDER_CONFIG: configFile };
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network request in offline native integration test"); };
writeFileSync(authFile, "{}", { mode: 0o600 });
after(() => {
	try { assert.equal(networkCalls, 0, "no test may dispatch to a real transport"); }
	finally {
		process.env = originalEnv;
		globalThis.fetch = originalFetch;
		rmSync(directory, { recursive: true, force: true });
	}
});

// The external CJS fixture resolves its sibling dependency with native Node
// require. Supply Pi's public test SDK through that dependency: tsx rewrites
// require(ESM) to CJS and cannot resolve Pi's import-only transitive exports.
// This keeps the *provider module* on the real default registry loader without
// monkey-patching require or injecting loadModule into the production registry.
writeFileSync(join(directory, "state.cjs"), "module.exports = { moduleLoads: 0, factories: [], states: {} };\n", { mode: 0o600 });
writeFileSync(moduleFile, `
const control = require('./state.cjs');
const { fauxProvider } = control.sdk;
control.moduleLoads++;
exports.createLearnHarnessProvider = function(options) {
  control.factories.push(options);
  if (options.fail) throw new Error('private-factory-secret');
  const state = control.states[options.id] = { ready: options.ready !== false, authCalls: 0, requests: [], key: 'offline-first' };
  const faux = fauxProvider({ provider: options.id, api: 'offline-native-api', tokenSize: { min: 64, max: 64 }, models: [{
    id: 'chat', name: 'Offline native chat', reasoning: true, input: ['text', 'image'],
    contextWindow: 16384, maxTokens: 1024, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 4 }
  }] });
  state.setResponses = faux.setResponses;
  const streamSimple = (model, context, requestOptions) => {
    state.requests.push({ model, context, options: requestOptions });
    return faux.provider.streamSimple(model, context, requestOptions);
  };
  const provider = { ...faux.provider, streamSimple, auth: { apiKey: {
    name: 'Offline auth', resolve: async ({ signal }) => {
      state.authCalls++;
      state.authSignal = signal;
      await Promise.resolve();
      return { auth: { apiKey: state.key }, source: 'offline-fixture' };
    }
  } } };
  return { provider, isReady: () => state.ready, ...(options.pricing ? { pricing: options.pricing } : {}) };
};
`, { mode: 0o600 });
const readyPin = { provider: "offline-native", id: "chat" };
const pricedPin = { provider: "offline-priced", id: "chat" };
const unavailablePin = { provider: "offline-unready", id: "chat" };
const failedPin = { provider: "offline-failed", id: "chat" };
writeFileSync(configFile, JSON.stringify({ version: 1, providers: [
	{ id: readyPin.provider, module: moduleFile, export: "createLearnHarnessProvider", options: { id: readyPin.provider } },
	{ id: pricedPin.provider, module: moduleFile, export: "createLearnHarnessProvider", options: { id: pricedPin.provider, pricing: "catalog" } },
	{ id: unavailablePin.provider, module: moduleFile, export: "createLearnHarnessProvider", options: { id: unavailablePin.provider, ready: false } },
	{ id: failedPin.provider, module: moduleFile, export: "createLearnHarnessProvider", options: { id: failedPin.provider, fail: true } },
] }), { mode: 0o600 });
interface FixtureState {
	ready: boolean;
	authCalls: number;
	authSignal?: AbortSignal;
	key: string;
	requests: { model: { provider: string; api: string }; context: TranscriptContext; options: SimpleStreamOptions }[];
	setResponses(responses: (AssistantMessage | (() => Promise<AssistantMessage>))[]): void;
}
const requireFixture = createRequire(import.meta.url);
const control = requireFixture(join(directory, "state.cjs")) as { moduleLoads: number; factories: unknown[]; states: Record<string, FixtureState>; sdk: typeof import("@earendil-works/pi-ai") };
control.sdk = await import("@earendil-works/pi-ai");
const { nativeProviderStatuses, nativeProviderAvailable, nativeProviderPricingUnknown } = await import("../src/server/native-providers.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { MODEL_SLOTS } = await import("../src/core/settings.ts");
const { normalizeContext, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall, Type } = await import("@earendil-works/pi-ai");
// Keys/catalog/stores/route imports follow the standalone native query
// assertion: stores sync the collection and keys also install provider sources.
const state = (id = readyPin.provider) => control.states[id]!;

beforeEach(() => {
	for (const [id, fixture] of Object.entries(control.states)) {
		fixture.ready = id !== unavailablePin.provider;
		fixture.authCalls = 0;
		fixture.requests = [];
		fixture.key = "offline-first";
		fixture.setResponses([]);
	}
	writeSettings({ version: 1 });
});

test("build guard rejects runtime manifest only at build, allows production server, and sanitizes its path without loading it", async () => {
	const { default: config, nextConfig } = await import("../next.config.ts");
	const { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER, PHASE_DEVELOPMENT_SERVER } = await import("next/constants.js");
	const previous = process.env.LH_NATIVE_PROVIDER_CONFIG;
	try {
		for (const file of [configFile, join(directory, "missing-private-config-secret.json")]) {
			process.env.LH_NATIVE_PROVIDER_CONFIG = file;
			assert.throws(() => config(PHASE_PRODUCTION_BUILD), error => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Unset LH_NATIVE_PROVIDER_CONFIG before building/);
				assert.ok(!error.message.includes(file));
				assert.ok(!error.message.includes(directory));
				return true;
			});
			assert.equal(config(PHASE_PRODUCTION_SERVER), nextConfig, "runtime server configuration is allowed, even with a nonexistent manifest");
			assert.equal(config(PHASE_DEVELOPMENT_SERVER), nextConfig);
		}
		delete process.env.LH_NATIVE_PROVIDER_CONFIG;
		assert.equal(config(PHASE_PRODUCTION_BUILD), nextConfig);
		process.env.LH_NATIVE_PROVIDER_CONFIG = "";
		assert.equal(config(PHASE_PRODUCTION_BUILD), nextConfig);
		assert.equal(control.moduleLoads, 0);
		assert.deepEqual(control.factories, []);
	} finally { process.env.LH_NATIVE_PROVIDER_CONFIG = previous; }
});

test("standalone pricing query self-installs lazily without keys import, then loads factories once", () => {
	assert.equal(control.moduleLoads, 0);
	assert.deepEqual(control.factories, []);
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = message => warnings.push(String(message));
	try {
		assert.equal(nativeProviderPricingUnknown(pricedPin.provider), false, "pricing must install and resolve the native source without keys boot wiring");
		assert.equal(nativeProviderPricingUnknown(readyPin.provider), true);
		assert.deepEqual(nativeProviderStatuses(), [
			{ id: readyPin.provider, envVar: "", keyPresent: true },
			{ id: pricedPin.provider, envVar: "", keyPresent: true },
			{ id: unavailablePin.provider, envVar: "", keyPresent: false },
			{ id: failedPin.provider, envVar: "", keyPresent: false },
		]);
	} finally { console.warn = originalWarn; }
	assert.equal(warnings.length, 1);
	assert.ok(!warnings[0]!.includes(directory));
	assert.ok(!warnings[0]!.includes("private-factory-secret"));
	assert.equal(control.moduleLoads, 1, "native Node module cache evaluates the shared CJS file once");
	assert.equal(control.factories.length, 4);
	assert.ok(piModels().getProvider("openai"), "built-in catalog remains registered");
	assert.equal(piModels().getModel(readyPin.provider, readyPin.id)!.api, "offline-native-api");
	assert.equal(nativeProviderAvailable(readyPin.provider), true);
	assert.equal(nativeProviderAvailable(unavailablePin.provider), false);
	assert.equal(nativeProviderAvailable("offline-removed"), undefined);
	assert.equal(nativeProviderAvailable(failedPin.provider), false);
	assert.equal(piModels().getProvider(failedPin.provider), undefined);
	assert.equal(control.factories.length, 4);
	for (const fixture of Object.values(control.states)) assert.equal(fixture.authCalls, 0);
});

test("picker readiness rows and live limits reflect local readiness without auth resolution", async () => {
	const { modelCatalog, catalogContextLimits } = await import("../src/server/model-catalog.ts");
	const { providerKeyPresent } = await import("../src/server/keys.ts");
	let catalog = modelCatalog();
	assert.deepEqual(catalog.providers.filter(provider => provider.id.startsWith("offline-")), [
		{ id: failedPin.provider, envVar: "", keyPresent: false },
		{ id: readyPin.provider, envVar: "", keyPresent: true },
		{ id: pricedPin.provider, envVar: "", keyPresent: true },
		{ id: unavailablePin.provider, envVar: "", keyPresent: false },
	]);
	assert.deepEqual(catalog.models.filter(model => model.provider.startsWith("offline-")).map(model => model.provider), [readyPin.provider, pricedPin.provider]);
	const dto = catalog.models.find(model => model.provider === readyPin.provider)!;
	assert.deepEqual(dto.input, ["text", "image"]);
	assert.equal(dto.reasoning, true);
	assert.equal(dto.contextWindow, 16384);
	assert.equal(dto.maxTokens, 1024);
	assert.ok(dto.supportedLevels.includes("high"));
	assert.equal(catalogContextLimits().get(`${readyPin.provider}:chat`), 16384);
	assert.equal(catalogContextLimits().has(`${unavailablePin.provider}:chat`), false);
	state().ready = false;
	catalog = modelCatalog();
	assert.equal(catalog.providers.find(provider => provider.id === readyPin.provider)!.keyPresent, false);
	assert.equal(catalog.models.some(model => model.provider === readyPin.provider), false);
	assert.equal(catalogContextLimits().has(`${readyPin.provider}:chat`), false);
	assert.equal(providerKeyPresent(readyPin.provider), false);
	state().ready = true;
	assert.equal(providerKeyPresent(readyPin.provider), true);
	assert.equal(modelCatalog().models.some(model => model.provider === readyPin.provider), true);
	for (const fixture of Object.values(control.states)) assert.equal(fixture.authCalls, 0);
});

test("unknown prices remain null while explicit catalog pricing uses native rates and arithmetic", async () => {
	const { modelCatalog } = await import("../src/server/model-catalog.ts");
	const { callCost } = await import("../src/server/pricing.ts");
	const catalog = modelCatalog();
	assert.equal(nativeProviderPricingUnknown(readyPin.provider), true);
	assert.equal(nativeProviderPricingUnknown(pricedPin.provider), false);
	assert.equal(catalog.models.find(model => model.provider === readyPin.provider)!.cost, null);
	assert.deepEqual(catalog.models.find(model => model.provider === pricedPin.provider)!.cost, { input: 2, output: 4, cacheRead: 1, cacheWrite: 4 });
	const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 250, cacheWriteTokens: 100, cacheWrite1hTokens: 0 };
	assert.equal(callCost(usage, `${readyPin.provider}:chat`), null);
	const cost = callCost(usage, `${pricedPin.provider}:chat`);
	assert.ok(cost !== null);
	assert.ok(Math.abs(cost - 0.00465) < 1e-12, `unexpected catalog cost: ${cost}`);
	assert.equal(callCost(usage, "offline-removed:chat"), null);
	assert.equal(state().authCalls, 0); assert.equal(state(pricedPin.provider).authCalls, 0);
});

async function putModels(models: unknown) {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	return PUT(new Request("http://offline.invalid/api/settings/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(models) }), { params: Promise.resolve({ section: "models" }) });
}
const allSlots = (pin: { provider: string; id: string }): ModelsSettings => Object.fromEntries(MODEL_SLOTS.map(slot => [slot, { model: pin, thinkingLevel: "high" }]));

test("all model slots and chat validators accept available native pins but reject unavailable/unknown identities", async () => {
	const { validateModelsSettings, validateChatSettings } = await import("../src/server/model-catalog.ts");
	assert.equal(validateChatSettings({ model: readyPin }).ok, true);
	assert.equal(validateModelsSettings(allSlots(readyPin)).ok, true);
	assert.equal((await putModels(allSlots(readyPin))).status, 200);
	for (const slot of MODEL_SLOTS) assert.deepEqual(readSettings()!.models?.[slot], { model: readyPin, thinkingLevel: "high" });
	for (const pin of [unavailablePin, failedPin, { provider: "offline-removed", id: "chat" }, { ...readyPin, id: "missing-model" }]) {
		assert.equal(validateChatSettings({ model: pin }).ok, false);
		for (const slot of MODEL_SLOTS) {
			assert.equal(validateModelsSettings({ [slot]: { model: pin } }).ok, false);
			const before = readSettings();
			assert.equal((await putModels({ ...before!.models, [slot]: { model: pin } })).status, 400);
			assert.deepEqual(readSettings(), before, "rejected settings writes must not persist");
		}
	}
	assert.equal(state().authCalls, 0);
});

test("unchanged unavailable pins survive same-slot repairs, but cannot authorize other slots or be reintroduced", async () => {
	const { validateModelsSettings, clampModelsLevels, modelCatalog } = await import("../src/server/model-catalog.ts");
	const { providerKeyPresent } = await import("../src/server/keys.ts");
	for (const pin of [unavailablePin, { provider: "offline-removed", id: "chat" }]) {
		const initial = allSlots(pin);
		writeSettings({ version: 1, models: initial, general: { autoUpdate: false } });
		assert.equal(validateModelsSettings(initial).ok, false, "no stored section means strict validation");
		assert.equal(validateModelsSettings(initial, initial).ok, true);
		assert.deepEqual(clampModelsLevels(initial), initial, "unavailable metadata preserves thinking preference");
		for (const slot of MODEL_SLOTS) {
			const before = readSettings()!.models!;
			assert.equal((await putModels({ ...before, [slot]: { model: pricedPin } })).status, 200);
			assert.deepEqual(readSettings()!.models?.[slot], { model: pricedPin });
			for (const other of MODEL_SLOTS.filter(name => name !== slot)) assert.deepEqual(readSettings()!.models?.[other], before[other]);
			const repaired = readSettings();
			assert.equal((await putModels({ ...repaired!.models, [slot]: initial[slot] })).status, 400);
			assert.deepEqual(readSettings(), repaired);
		}
		assert.deepEqual(readSettings()!.general, { autoUpdate: false });
		writeSettings({ version: 1, models: { strong: initial.strong } });
		assert.equal((await putModels({ strong: initial.strong, cheap: initial.strong })).status, 400, "same identity in another slot is a new unavailable selection");
		assert.equal(providerKeyPresent(pin.provider), false);
		assert.equal(modelCatalog().models.some(model => model.provider === pin.provider), false);
	}
});

const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", mimeType: "image/png" };
function context(): Context {
	return {
		systemPrompt: "Offline native instructions",
		tools: [{ name: "inspect", description: "Inspect a synthetic image", parameters: Type.Object({ label: Type.String() }) }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Inspect this" }, image], timestamp: 1 },
			fauxAssistantMessage([fauxThinking("earlier reasoning"), fauxToolCall("inspect", { label: "fixture" }, { id: "inspect-1" })], { stopReason: "toolUse" }),
			{ role: "toolResult", toolCallId: "inspect-1", toolName: "inspect", content: [{ type: "text", text: "Inspection complete" }, image], isError: false, timestamp: 2 },
		],
	};
}

test("actual native engine preserves normalized tool/image Context, reasoning, cache policy and per-dispatch async auth", async () => {
	const engine = piEngineForSpec({ ...readyPin, thinkingLevel: "high" }, false, undefined, () => "long");
	assert.equal(engine.level, "high");
	assert.equal(engine.model.api, "offline-native-api");
	assert.equal(state().authCalls, 0, "engine construction must not resolve auth");
	state().setResponses([fauxAssistantMessage([fauxThinking("synthetic reasoning"), fauxText("synthetic reply"), fauxToolCall("inspect", { label: "next" }, { id: "inspect-2" })], { stopReason: "toolUse" }), fauxAssistantMessage("second reply")]);
	const input = normalizeContext(context());
	const controller = new AbortController();
	const stream = engine.streamFn(engine.model, input, { signal: controller.signal, cacheRetention: "none", sessionId: "offline-session" });
	assert.equal(state().authCalls, 0, "auth is deferred to the lazy stream's dispatch microtask");
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.equal(result.provider, readyPin.provider);
	assert.equal(result.api, "offline-native-api");
	assert.deepEqual(result.content, [fauxThinking("synthetic reasoning"), fauxText("synthetic reply"), fauxToolCall("inspect", { label: "next" }, { id: "inspect-2" })]);
	for (const type of ["thinking_delta", "text_delta", "toolcall_end", "done"]) assert.ok(events.includes(type), `missing synthetic event ${type}`);
	assert.equal(state().authCalls, 1);
	const first = state().requests[0]!;
	assert.deepEqual(first.context, input, "native dispatch must not flatten system/tool/image/reasoning messages");
	assert.equal(first.options.reasoning, "high");
	assert.equal(first.options.signal, controller.signal);
	assert.equal(first.options.cacheRetention, "long", "slot policy is applied at operation time");
	assert.equal(first.options.sessionId, "offline-session");
	assert.equal(first.options.apiKey, "offline-first");
	state().key = "offline-rotated";
	assert.equal((await engine.streamFn(engine.model, input, {}).result()).stopReason, "stop");
	assert.equal(state().authCalls, 2);
	assert.equal(state().requests[1]!.options.apiKey, "offline-rotated", "auth is not snapshotted with the registry/engine");
});

test("cancellation reaches the synthetic native stream; readiness loss blocks subsequent operations before auth or dispatch", async () => {
	const engine = piEngineForSpec(readyPin, false);
	let release!: () => void;
	let started!: () => void;
	const dispatched = new Promise<void>(resolve => { started = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	state().setResponses([async () => { started(); await pending; return fauxAssistantMessage("must be cancelled"); }]);
	const controller = new AbortController();
	const operation = engine.streamFn(engine.model, normalizeContext(context()), { signal: controller.signal }).result();
	await dispatched;
	assert.equal(state().requests[0]!.options.signal, controller.signal);
	controller.abort(); release();
	assert.equal((await operation).stopReason, "aborted");
	assert.equal(state().requests.length, 1);
	assert.equal(state().authCalls, 1);
	state().ready = false;
	const blocked = await engine.streamFn(engine.model, normalizeContext(context()), {}).result();
	assert.equal(blocked.stopReason, "error");
	assert.match(blocked.errorMessage ?? "", /native provider is unavailable/i);
	assert.equal(state().requests.length, 1, "no later tool-loop dispatch after readiness loss");
	assert.equal(state().authCalls, 1, "the readiness guard runs before the async auth resolver");
});

test("unknown/removed native providers do not inherit a keyless admission bypass", async () => {
	const { providerKeyPresent } = await import("../src/server/keys.ts");
	assert.equal(providerKeyPresent("offline-removed"), false);
	assert.equal(providerKeyPresent("offline-unknown"), false);
	assert.equal(providerKeyPresent(unavailablePin.provider), false);
	assert.equal(providerKeyPresent(failedPin.provider), false);
	assert.throws(() => piEngineForSpec({ provider: "offline-removed", id: "chat" }), /catalog has no model/);
});

test("foreground request and input admission refuse an unavailable configured native provider without model dispatch or persistence", async () => {
	const { handleChatRequest, handleChatInput } = await import("../src/server/chat-handler.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const chat = chatStore.createChat("Offline native admission");
	writeSettings({ version: 1, models: allSlots(unavailablePin) });
	const file = join(data, "chats", `${chat.id}.json`);
	const before = readFileSync(file, "utf8");
	const settingsBefore = readSettings();
	let builds = 0;
	const build = () => { builds++; throw new Error("Unavailable native provider must not construct a turn agent"); };
	const input = { type: "text" as const, text: "Do not persist or dispatch this" };
	const responses = [
		await handleChatRequest(new Request("http://offline.invalid/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: chat.id, input }) }), build),
		await handleChatInput(chat.id, input, build),
	];
	for (const response of responses) {
		assert.equal(response.status, 503);
		const body = await response.json();
		assert.equal(body.provider, unavailablePin.provider);
		assert.equal(body.code, "provider_key_missing");
		assert.deepEqual(body.slots, ["strong"]);
	}
	assert.equal(builds, 0);
	assert.equal(state(unavailablePin.provider).authCalls, 0);
	assert.equal(state(unavailablePin.provider).requests.length, 0);
	assert.equal(readFileSync(file, "utf8"), before, "refusal must not append input or update the chat record");
	assert.deepEqual(readSettings(), settingsBefore);
	assert.equal(runningTurn(chat.id), undefined, "refusal must not begin a live turn");
});

test("accounting returns unpriced if a live provider later publishes malformed pricing tiers", async () => {
	const { callCost } = await import("../src/server/pricing.ts");
	const model = piModels().getModel(pricedPin.provider, pricedPin.id)!;
	const rates = model.cost;
	try {
		model.cost = { ...rates, tiers: {} as never };
		assert.equal(callCost({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 1 }, `${pricedPin.provider}:chat`), null);
	} finally { model.cost = rates; }
});

test("retired-model or arbitrary engine failures settle background jobs without leaking provider diagnostics", async () => {
	const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	for (const kind of ["research", "demo", "visual", "pdf"] as const) {
		for (const privateFailure of [false, true]) {
			const chat = chatStore.createChat("Offline retired model");
			const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `offline-retired-${kind}`, input: { title: "Synthetic demo", question: "Synthetic question", path: "offline.pdf" } });
			const delivered: SteerMessage[] = [];
			let release!: () => void;
			const delivery = new Promise<void>(resolve => { release = resolve; });
			const runner = createJobRunner({ chatStore, jobStore, deliver: steer => { delivered.push(steer); return delivery; }, engineFor: () => {
				if (privateFailure) throw new Error("private-provider-secret");
				return piEngineForSpec({ ...readyPin, id: "retired-model" });
			} });
			await runner.runJob(job.id);
			const settled = jobStore.getJob(job.id)!;
			assert.equal(settled.status, "error");
			assert.match(settled.error ?? "", /selected model is unavailable/);
			assert.ok(!JSON.stringify(settled).includes("private-provider-secret"));
			assert.equal(delivered.length, 1);
			assert.ok(!delivered[0]!.content.includes("private-provider-secret"));
			assert.equal(settled.usage, undefined);
			release();
		}
	}
	assert.equal(state().authCalls, 0);
	assert.equal(state().requests.length, 0);
});

test("runner catches typed native-provider refusal before catalog construction, settles every job kind and queues its failure delivery", async () => {
	const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
	const { ProviderKeyMissingError, ROLE_SLOT } = await import("../src/core/settings.ts");
	const { providerKeyPresent } = await import("../src/server/keys.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	// Real adapters write ONLY to our private scratch directory. The model and
	// delivery seams are fake, so no sub-agent loop or wake turn can start.
	const kinds: JobKind[] = ["research", "demo", "visual", "pdf"];
	for (const pin of [failedPin, unavailablePin, { provider: "offline-removed", id: "chat" }]) {
		for (const kind of kinds) {
			const chat = chatStore.createChat(`Offline refused ${kind}`);
			const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `offline-${kind}`, input: { title: "Offline demo", question: "Synthetic question", path: "offline.pdf" } });
			const originalChat = chatStore.getChat(chat.id);
			const delivered: SteerMessage[] = [];
			let engineCalls = 0, catalogConstructions = 0;
			let refusal: InstanceType<typeof ProviderKeyMissingError> | undefined;
			let release!: () => void;
			const pendingDelivery = new Promise<void>(resolve => { release = resolve; });
			const runner = createJobRunner({
				chatStore, jobStore,
				deliver: steer => { delivered.push(steer); return pendingDelivery; },
				engineFor: role => {
					engineCalls++;
					if (!providerKeyPresent(pin.provider)) {
						refusal = new ProviderKeyMissingError(pin.provider, [ROLE_SLOT[role]]);
						throw refusal;
					}
					catalogConstructions++;
					throw new Error("An unavailable native provider must never reach engine/catalog construction");
				},
				providerKeyMissing: () => { throw new Error("Typed admission refusal must be handled before the engine-level key gate"); },
			});
			await runner.runJob(job.id);
			assert.ok(refusal);
			const settled = jobStore.getJob(job.id)!;
			assert.equal(settled.status, "error", `${pin.provider}/${kind} must not remain running`);
			assert.equal(settled.activity, "failed");
			assert.equal(settled.error, refusal.message);
			assert.equal(settled.usage, undefined, "no model work was dispatched");
			assert.deepEqual(settled.delivery, { kind: "result", status: "pending" });
			assert.ok(settled.result);
			assert.ok(JSON.stringify(settled.result).includes(refusal.message));
			assert.equal(delivered.length, 1, "failed jobs still notify the teacher through the delivery seam");
			assert.ok(delivered[0]!.content.includes(refusal.message));
			assert.equal(engineCalls, 1); assert.equal(catalogConstructions, 0);
			await runner.runJob(job.id);
			assert.equal(engineCalls, 1); assert.equal(delivered.length, 1, "recovery does not rerun a settled refusal");
			assert.deepEqual(chatStore.getChat(chat.id), originalChat, "queued delivery does not persist a foreground turn");
			release();
		}
	}
	for (const fixture of Object.values(control.states)) {
		assert.equal(fixture.authCalls, 0);
		assert.equal(fixture.requests.length, 0);
	}
});
