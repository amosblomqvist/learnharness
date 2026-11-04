/** Offline registry contracts: no operator files, credentials or transports. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const directory = mkdtempSync(join(tmpdir(), "lh-native-registry-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: directory, LH_DATA_DIR: directory, LH_AUTH_FILE: join(directory, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
globalThis.fetch = async () => { throw new Error("Unexpected network request in offline registry test"); };
writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	rmSync(directory, { recursive: true, force: true });
});
const { createNativeProviderRegistry } = await import("../src/server/native-providers.ts");
const { configureNativeProviderSource, configureProviderSource, piModels } = await import("../src/agent/models.ts");
const { CUSTOM_PROVIDER } = await import("../src/core/auth-keys.ts");
const { NATIVE_SUBSCRIPTIONS } = await import("../src/core/contracts/subscriptions.ts");

let sequence = 0;
const modulePath = join(directory, "private-module.cjs");
const entry = (overrides: Record<string, unknown> = {}) => ({ id: "offline-native", module: modulePath, export: "createLearnHarnessProvider", options: {}, ...overrides });
const manifest = (providers: unknown[] = [entry()]) => ({ version: 1, providers });
function config(value: unknown, raw = false): string {
	const file = join(directory, `manifest-${sequence++}.json`);
	writeFileSync(file, raw ? String(value) : JSON.stringify(value), { mode: 0o600 });
	return file;
}
function native(id = "offline-native") {
	const faux = fauxProvider({ provider: id, models: [{ id: "chat", name: "Offline chat", reasoning: true, input: ["text", "image"], contextWindow: 16384, maxTokens: 1024, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 4 } }] });
	return { provider: faux.provider, isReady: () => true };
}
function collection(): MutableModels {
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	for (const provider of builtinProviders()) models.setProvider(provider);
	// The app also registers its CLI provider before native manifest preflight.
	models.setProvider(native("claude-code").provider);
	return models;
}

function rejectedManifest(value: unknown, raw = false) {
	let evaluations = 0;
	const warnings: string[] = [];
	const registry = createNativeProviderRegistry({ configPath: () => config(value, raw), loadModule: () => { evaluations++; return { createLearnHarnessProvider: () => native() }; }, warn: message => warnings.push(message) });
	const models = collection();
	const before = models.getProviders();
	registry.sync(models);
	registry.sync(models);
	assert.equal(evaluations, 0, "the entire manifest must pass preflight before evaluating ANY module");
	assert.deepEqual(models.getProviders(), before);
	assert.deepEqual(registry.statuses(), []);
	assert.equal(registry.owns("offline-native"), false);
	assert.equal(registry.isReady("offline-native"), false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /^\[native-providers\] Invalid configuration;/);
	assert.ok(!warnings[0]!.includes(directory));
	assert.ok(!warnings[0]!.includes("private-option-secret"));
}

test("default off is lazy, does not evaluate modules, and snapshots the disabled configuration", () => {
	let reads = 0, loads = 0;
	let file: string | undefined;
	const registry = createNativeProviderRegistry({ configPath: () => { reads++; return file; }, loadModule: () => { loads++; throw new Error("must not load"); } });
	assert.deepEqual(registry.statuses(), []);
	assert.equal(registry.owns("offline-native"), false);
	assert.equal(registry.isReady("offline-native"), false);
	assert.equal(registry.pricingUnknown("offline-native"), false);
	assert.equal(reads, 0);
	registry.sync(createModels());
	file = config(manifest());
	registry.sync(createModels());
	assert.equal(reads, 1);
	assert.equal(loads, 0);
	assert.deepEqual(registry.statuses(), []);
});

test("enabled configuration loads once on sync, passes options, and snapshots path and file contents", () => {
	let reads = 0, loads = 0, factories = 0;
	const options = { region: "offline", nested: { value: 3 } };
	let file = config(manifest([entry({ options })]));
	const initialFile = file;
	const result = native();
	const registry = createNativeProviderRegistry({ configPath: () => { reads++; return file; }, loadModule: absolutePath => {
		loads++; assert.equal(absolutePath, modulePath);
		return { createLearnHarnessProvider: (received: unknown) => { factories++; assert.deepEqual(received, options); return result; } };
	} });
	assert.equal(reads, 0); assert.equal(loads, 0); assert.equal(factories, 0);
	const first = createModels(), second = createModels();
	let installs = 0;
	const setProvider = first.setProvider.bind(first);
	first.setProvider = provider => { installs++; setProvider(provider); };
	registry.sync(first);
	writeFileSync(initialFile, "malformed-after-snapshot", { mode: 0o600 });
	file = config(manifest([entry({ id: "another-native" })]));
	registry.sync(first); registry.sync(second);
	assert.equal(reads, 1); assert.equal(loads, 1); assert.equal(factories, 1); assert.equal(installs, 1);
	assert.equal(first.getProvider("offline-native"), result.provider);
	assert.equal(second.getProvider("offline-native"), result.provider);
	assert.equal(registry.owns("another-native"), false);
	assert.deepEqual(registry.statuses(), [{ id: "offline-native", envVar: "", keyPresent: true }]);
});

test("missing, relative, directory and oversized config files fail closed before module evaluation", () => {
	const oversized = config(" ".repeat(128 * 1024 + 1), true);
	for (const file of [join(directory, "missing.json"), "relative.json", directory, oversized]) {
		let loads = 0;
		const warnings: string[] = [];
		const registry = createNativeProviderRegistry({ configPath: () => file, loadModule: () => { loads++; throw new Error("not reached"); }, warn: message => warnings.push(message) });
		registry.sync(createModels()); registry.sync(createModels());
		assert.equal(loads, 0, file); assert.equal(warnings.length, 1, file);
		assert.deepEqual(registry.statuses(), []);
		assert.ok(!warnings.join().includes(directory));
	}
});

const invalidShapes: [string, unknown][] = [
	["null", null], ["array", []], ["missing version", { providers: [] }],
	["wrong version", { version: 2, providers: [] }], ["string version", { version: "1", providers: [] }],
	["missing providers", { version: 1 }], ["non-array providers", { version: 1, providers: {} }],
	["too many providers", manifest(Array.from({ length: 65 }, (_, i) => entry({ id: `offline-${i}` })))],
];
for (const [name, value] of invalidShapes) test(`manifest rejects ${name}`, () => rejectedManifest(value));
test("malformed JSON diagnostics do not disclose paths or contents", () => rejectedManifest('{"private-option-secret":', true));

const invalidEntries: [string, unknown][] = [
	["null", null], ["array", []], ["missing id", entry({ id: undefined })], ["empty id", entry({ id: "" })],
	["uppercase id", entry({ id: "Offline" })], ["punctuation id", entry({ id: "bad/id" })],
	["long id", entry({ id: "x".repeat(129) })], ["non-string id", entry({ id: 1 })],
	["missing module", entry({ module: undefined })], ["relative module", entry({ module: "provider.cjs" })],
	["remote URL", entry({ module: "https://offline.invalid/provider.mjs" })], ["file URL", entry({ module: `file://${modulePath}` })],
	["TypeScript module", entry({ module: join(directory, "provider.ts") })], ["TSX module", entry({ module: join(directory, "provider.tsx") })],
	["unsupported extension", entry({ module: join(directory, "provider.json") })],
	["missing export", entry({ export: undefined })], ["empty export", entry({ export: "" })], ["non-string export", entry({ export: 1 })],
	["null options", entry({ options: null })], ["array options", entry({ options: [] })], ["primitive options", entry({ options: "private-option-secret" })],
];
for (const [name, value] of invalidEntries) test(`preflight rejects ${name} even after a valid entry`, () => rejectedManifest(manifest([entry({ id: "first-valid" }), value])));
test("duplicate IDs invalidate the whole manifest", () => rejectedManifest(manifest([entry(), entry()])));
test("built-in, logical connection, CLI and custom identities cannot be replaced", () => {
	const reserved = new Set([...builtinProviders().map(provider => provider.id), "chatgpt", "claude-code", CUSTOM_PROVIDER.id, ...NATIVE_SUBSCRIPTIONS.flatMap(provider => [provider.logicalId, provider.providerId])]);
	for (const id of reserved) rejectedManifest(manifest([entry({ id: "first-valid" }), entry({ id })]));
});

test("compiled JS extensions, empty manifest and omitted options are supported", () => {
	for (const extension of [".mjs", ".js", ".cjs"]) {
		const registry = createNativeProviderRegistry({ configPath: () => config(manifest([entry({ module: join(directory, `fixture${extension}`), options: undefined })])), loadModule: () => ({ createLearnHarnessProvider: (options: unknown) => { assert.deepEqual(options, {}); return native(); } }) });
		registry.sync(createModels()); assert.equal(registry.isReady("offline-native"), true);
	}
	const empty = createNativeProviderRegistry({ configPath: () => config(manifest([])), loadModule: () => { throw new Error("not reached"); } });
	empty.sync(createModels()); assert.deepEqual(empty.statuses(), []);
});

const invalidModules: [string, () => unknown][] = [
	["missing namespace", () => undefined], ["missing export", () => ({})],
	["non-function export", () => ({ createLearnHarnessProvider: true })],
	["thrown module", () => { throw new Error(`${modulePath}: private-option-secret`); }],
	["thrown factory", () => ({ createLearnHarnessProvider: () => { throw new Error("private-option-secret"); } })],
	["async factory", () => ({ createLearnHarnessProvider: async () => native() })],
	["rejected async factory", () => ({ createLearnHarnessProvider: async () => { throw new Error("private-option-secret"); } })],
	["missing factory result", () => ({ createLearnHarnessProvider: () => undefined })],
	["identity mismatch", () => ({ createLearnHarnessProvider: () => native("other-native") })],
	["missing readiness", () => ({ createLearnHarnessProvider: () => ({ provider: native().provider }) })],
	["invalid pricing", () => ({ createLearnHarnessProvider: () => ({ ...native(), pricing: "free" }) })],
	["missing stream", () => ({ createLearnHarnessProvider: () => ({ ...native(), provider: { ...native().provider, stream: undefined } }) })],
	["missing simple stream", () => ({ createLearnHarnessProvider: () => ({ ...native(), provider: { ...native().provider, streamSimple: undefined } }) })],
	["missing auth", () => ({ createLearnHarnessProvider: () => ({ ...native(), provider: { ...native().provider, auth: {} } }) })],
];
for (const [name, loadModule] of invalidModules) test(`loaded failure: ${name} remains an unavailable, owned status row`, async () => {
	const warnings: string[] = [];
	const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule, warn: message => warnings.push(message) });
	const models = createModels(); registry.sync(models); registry.sync(models);
	assert.equal(models.getProvider("offline-native"), undefined);
	assert.equal(registry.owns("offline-native"), true);
	assert.equal(registry.isReady("offline-native"), false);
	assert.equal(registry.pricingUnknown("offline-native"), true);
	assert.deepEqual(registry.statuses(), [{ id: "offline-native", envVar: "", keyPresent: false }]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /Provider offline-native could not be loaded/);
	assert.ok(!warnings[0]!.includes(directory)); assert.ok(!warnings[0]!.includes("private-option-secret"));
	// Drain promise rejections from rejected async factories; node:test also
	// reports any uncaught rejection after this test completes.
	await new Promise<void>(resolve => setImmediate(resolve));
});

const catalogMutations: [string, Record<string, unknown>][] = [
	["provider mismatch", { provider: "other-native" }], ["missing model id", { id: "" }],
	["missing name", { name: undefined }], ["missing API", { api: undefined }],
	["no text input", { input: ["image"] }], ["invalid input", { input: null }], ["invalid reasoning", { reasoning: "yes" }],
	["zero context", { contextWindow: 0 }], ["infinite context", { contextWindow: Infinity }],
	["negative max tokens", { maxTokens: -1 }], ["NaN max tokens", { maxTokens: NaN }],
	["missing costs", { cost: {} }], ["negative cost", { cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	["non-finite cost", { cost: { input: 1, output: Infinity, cacheRead: 0, cacheWrite: 0 } }],
];
for (const [name, changes] of catalogMutations) test(`catalog rejects ${name}`, () => {
	const result = native();
	const model = result.provider.getModels()[0]!;
	const invalid = { ...result, provider: { ...result.provider, getModels: () => [{ ...model, ...changes }] } };
	const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => invalid }), warn: () => undefined });
	const models = createModels(); registry.sync(models);
	assert.equal(models.getProvider("offline-native"), undefined);
	assert.equal(registry.isReady("offline-native"), false);
});
test("throwing, async and non-array catalogs are rejected", () => {
	for (const getModels of [() => { throw new Error("private-option-secret"); }, async () => [], () => ({})]) {
		const result = native();
		const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => ({ ...result, provider: { ...result.provider, getModels } }) }), warn: () => undefined });
		const models = createModels(); registry.sync(models);
		assert.equal(models.getProvider("offline-native"), undefined);
	}
});

test("readiness is fresh, strict-boolean, local, and fail-closed for throws or promises", () => {
	let ready: unknown = true, checks = 0;
	const result = native();
	const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => ({ ...result, isReady: () => { checks++; if (ready instanceof Error) throw ready; return ready; } }) }) });
	registry.sync(createModels()); assert.equal(checks, 0, "registration does not probe readiness/auth");
	for (const value of [true, false, 1, "true", undefined, new Error("private-option-secret"), Promise.resolve(false), Promise.resolve(true)]) {
		ready = value;
		assert.equal(registry.isReady("offline-native"), value === true);
		assert.equal(registry.statuses()[0]!.keyPresent, value === true);
	}
	assert.equal(registry.isReady("not-owned"), false);
});

test("rejecting async catalogs and readiness fail closed without unhandled private errors", async () => {
	for (const callback of ["getModels", "getAllModels", "isReady"] as const) {
		const value = native();
		const reject = async () => { throw new Error("private-rejection-secret"); };
		const result = callback === "isReady"
			? { ...value, isReady: reject }
			: { ...value, provider: { ...value.provider, [callback]: reject } };
		const warnings: string[] = [];
		const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => result }), warn: message => warnings.push(message) });
		const models = createModels();
		registry.sync(models);
		assert.equal(registry.isReady("offline-native"), false);
		assert.equal(registry.statuses()[0]!.keyPresent, false);
		assert.ok(!warnings.join().includes("private-rejection-secret"));
		await new Promise<void>(resolve => setImmediate(resolve));
	}
});

test("the effective full catalog cannot bypass chat metadata validation", () => {
	for (const catalog of [null, {}, [{ provider: "other-native", type: "chat" }], [{ provider: "offline-native", type: "chat", cost: { tiers: {} } }]]) {
		const value = native();
		const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => ({ ...value, provider: { ...value.provider, getAllModels: () => catalog } }) }), warn: () => undefined });
		const models = createModels(); registry.sync(models);
		assert.equal(models.getProvider("offline-native"), undefined);
	}
});

test("pricing tiers require finite nonnegative thresholds and complete rates", () => {
	const rates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 2 };
	for (const tiers of [{}, null, [null], [{ ...rates }], [{ ...rates, inputTokensAbove: -1 }], [{ ...rates, inputTokensAbove: Infinity }], [{ ...rates, inputTokensAbove: 1000, output: NaN }]]) {
		const value = native();
		const model = value.provider.getModels()[0]!;
		const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => ({ ...value, provider: { ...value.provider, getModels: () => [{ ...model, cost: { ...rates, tiers } }] }, pricing: "catalog" }) }), warn: () => undefined });
		const models = createModels(); registry.sync(models);
		assert.equal(models.getProvider("offline-native"), undefined);
		assert.equal(registry.isReady("offline-native"), false);
	}
	const value = native();
	const model = value.provider.getModels()[0]!;
	const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => ({ ...value, provider: { ...value.provider, getModels: () => [{ ...model, cost: { ...rates, tiers: [{ ...rates, inputTokensAbove: 1000 }] } }] }, pricing: "catalog" }) }) });
	const models = createModels(); registry.sync(models);
	assert.equal(registry.isReady("offline-native"), true);
	assert.equal(registry.pricingUnknown("offline-native"), false);
});

test("unknown pricing is the default; only explicit catalog opt-in enables rates", () => {
	const ids = ["default-price", "unknown-price", "catalog-price"];
	const registry = createNativeProviderRegistry({
		configPath: () => config(manifest(ids.map(id => entry({ id, options: { id } })))),
		loadModule: () => ({ createLearnHarnessProvider: ({ id }: { id: string }) => ({
			...native(id), ...(id === "default-price" ? {} : { pricing: id === "catalog-price" ? "catalog" : "unknown" }),
		}) }),
	});
	registry.sync(createModels());
	assert.equal(registry.pricingUnknown(ids[0]!), true); assert.equal(registry.pricingUnknown(ids[1]!), true);
	assert.equal(registry.pricingUnknown(ids[2]!), false); assert.equal(registry.pricingUnknown("not-owned"), false);
});

test("default Node loader resolves sibling dependencies and isolates missing, malformed and throwing modules", () => {
	const goodModule = join(directory, "compiled-provider.cjs");
	const catalogModule = join(directory, "compiled-catalog.cjs");
	const malformedModule = join(directory, "malformed-provider.cjs");
	const throwingModule = join(directory, "throwing-provider.cjs");
	const model = native().provider.getModels()[0]!;
	writeFileSync(catalogModule, `exports.model = ${JSON.stringify(model)};\n`, { mode: 0o600 });
	writeFileSync(goodModule, `
const { model } = require('./compiled-catalog.cjs');
exports.createLearnHarnessProvider = ({ id }) => ({
  provider: {
    id, name: 'Offline compiled provider',
    getModels: () => [{ ...model, provider: id }],
    auth: { apiKey: { name: 'Offline', resolve: async () => ({ auth: {} }) } },
    stream: () => { throw new Error('No dispatch expected'); },
    streamSimple: () => { throw new Error('No dispatch expected'); }
  },
  isReady: () => true
});\n`, { mode: 0o600 });
	writeFileSync(malformedModule, "private-syntax-secret ( {", { mode: 0o600 });
	writeFileSync(throwingModule, "throw new Error('private-module-secret');\n", { mode: 0o600 });
	const ids = ["compiled-good", "compiled-missing", "compiled-malformed", "compiled-thrown"];
	const modules = [goodModule, join(directory, "does-not-exist.cjs"), malformedModule, throwingModule];
	const warnings: string[] = [];
	const registry = createNativeProviderRegistry({
		configPath: () => config(manifest(ids.map((id, index) => entry({ id, module: modules[index], options: { id } })))),
		warn: message => warnings.push(message),
	});
	const models = createModels();
	registry.sync(models);
	assert.equal(models.getModel(ids[0]!, "chat")!.name, model.name, "the native loader resolves dependencies from the fixture's module directory");
	assert.deepEqual(registry.statuses(), ids.map((id, index) => ({ id, envVar: "", keyPresent: index === 0 })));
	assert.equal(warnings.length, 3);
	for (const message of warnings) {
		assert.ok(!message.includes(directory));
		assert.ok(!message.includes("private-syntax-secret"));
		assert.ok(!message.includes("private-module-secret"));
	}
	for (const id of ids.slice(1)) assert.equal(models.getProvider(id), undefined);
});

test("native and settings-owned sources coexist without retiring each other's providers", () => {
	const result = native();
	const registry = createNativeProviderRegistry({ configPath: () => config(manifest()), loadModule: () => ({ createLearnHarnessProvider: () => result }) });
	const custom = native(CUSTOM_PROVIDER.id).provider;
	configureProviderSource({ sync: models => models.setProvider(custom), isCustom: id => id === custom.id });
	configureNativeProviderSource(registry);
	try {
		const models = piModels();
		const builtin = models.getProvider("openai");
		assert.ok(builtin);
		assert.equal(models.getProvider(custom.id), custom);
		assert.equal(models.getProvider(result.provider.id), result.provider);
		configureProviderSource({ sync: () => undefined, isCustom: () => false });
		assert.equal(piModels(), models);
		assert.equal(models.getProvider(custom.id), undefined);
		assert.equal(models.getProvider(result.provider.id), result.provider);
		assert.equal(models.getProvider("openai"), builtin);
	} finally {
		piModels().deleteProvider(result.provider.id);
		configureNativeProviderSource({ sync: () => undefined, owns: () => false, isReady: () => false });
		configureProviderSource({ sync: () => undefined, isCustom: () => false });
	}
});
