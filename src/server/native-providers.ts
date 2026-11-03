/** Trusted, runtime-only native Pi providers. This is not a Pi extension host.
 * No module is evaluated until the model collection is first used. Configuration
 * is snapshotted once per process; auth stays in the provider's request path.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, join } from "node:path";
import type { Api, MutableModels, Provider } from "@earendil-works/pi-ai";
import { configureNativeProviderSource, piModels } from "../agent/models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";

/** The selected module export receives its manifest options and returns this.
 * Readiness is a synchronous LOCAL configuration check, not an auth probe.
 * Factories must not perform network IO, refresh credentials, or use extension hooks.
 */
export interface NativeProviderModule {
	provider: Provider<Api>;
	isReady(): boolean;
	pricing?: "catalog" | "unknown";
}
interface ProviderEntry {
	id: string;
	module: string;
	export: string;
	options: Record<string, unknown>;
}
interface LoadedEntry {
	id: string;
	module?: NativeProviderModule;
}
interface RegistryOptions {
	configPath(): string | undefined;
	loadModule?(path: string): unknown;
	warn?(message: string): void;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_PROVIDERS = 64;

/** Malformed async implementations fail closed without process-wide rejections. */
function discardAsync(value: unknown): boolean {
	if (!isRecord(value) || typeof value.then !== "function") return false;
	void Promise.resolve(value).catch(() => undefined);
	return true;
}

function parseManifest(value: unknown, reserved: ReadonlySet<string>): ProviderEntry[] {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS) {
		throw new Error("Invalid manifest structure");
	}
	const ids = new Set<string>();
	return value.providers.map((entry) => {
		if (!isRecord(entry) || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.id)
			|| ids.has(entry.id) || reserved.has(entry.id)
			|| typeof entry.module !== "string" || !isAbsolute(entry.module) || ![".js", ".mjs", ".cjs"].includes(extname(entry.module))
			|| typeof entry.export !== "string" || !entry.export || (entry.options !== undefined && !isRecord(entry.options))) {
			throw new Error("Invalid provider entry or reserved/duplicate ID");
		}
		ids.add(entry.id);
		return { id: entry.id, module: entry.module, export: entry.export, options: entry.options ?? {} };
	});
}

function validateModule(value: unknown, id: string): NativeProviderModule {
	if (!isRecord(value) || typeof value.isReady !== "function"
		|| (value.pricing !== undefined && value.pricing !== "unknown" && value.pricing !== "catalog")) throw new Error("Invalid factory result");
	const provider = value.provider;
	if (!isRecord(provider) || provider.id !== id || typeof provider.name !== "string"
		|| typeof provider.getModels !== "function" || typeof provider.stream !== "function" || typeof provider.streamSimple !== "function"
		|| !isRecord(provider.auth) || (!provider.auth.apiKey && !provider.auth.oauth)) throw new Error("Invalid native Provider");
	const validRates = (cost: unknown): cost is Record<string, unknown> => isRecord(cost) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key]) && cost[key] >= 0);
	const validCost = (cost: unknown): boolean => validRates(cost) && (cost.tiers === undefined
		|| (Array.isArray(cost.tiers) && cost.tiers.every((tier) => validRates(tier) && typeof tier.inputTokensAbove === "number" && Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0)));
	const validChatModel = (model: unknown): boolean => isRecord(model) && model.provider === id
		&& typeof model.id === "string" && !!model.id && typeof model.name === "string" && typeof model.api === "string"
		&& Array.isArray(model.input) && model.input.includes("text") && typeof model.reasoning === "boolean"
		&& typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
		&& typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0
		&& validCost(model.cost);
	const models: unknown = provider.getModels();
	if (discardAsync(models) || !Array.isArray(models) || !models.every(validChatModel)) throw new Error("Invalid chat model catalog");
	// Models reads getAllModels when supplied, even for chat lookup. Validate
	// that actual catalog too, without rejecting legitimate non-chat entries.
	if (provider.getAllModels !== undefined) {
		if (typeof provider.getAllModels !== "function") throw new Error("Invalid full catalog");
		const all: unknown = provider.getAllModels();
		if (discardAsync(all) || !Array.isArray(all) || all.some((model) => !isRecord(model) || model.provider !== id
			|| ((model.type === undefined || model.type === "chat") && !validChatModel(model)))) throw new Error("Invalid full catalog");
	}
	return value as unknown as NativeProviderModule;
}

/** Exported for offline tests. Native require (Node >=22.12) supports compiled
 * CJS and synchronous ESM without bundling/tracing the operator's module tree.
 * Modules resolve their own dependencies relative to their installed location.
 */
export function createNativeProviderRegistry(options: RegistryOptions) {
	let entries: LoadedEntry[] | undefined;
	const installed = new WeakSet<MutableModels>();
	const warn = options.warn ?? ((message: string) => console.warn(message));
	function initialize(models: MutableModels) {
		if (entries) return;
		entries = [];
		const file = options.configPath();
		if (!file) return;
		let manifest: ProviderEntry[];
		try {
			if (!isAbsolute(file)) throw new Error("Invalid config path");
			const metadata = statSync(file);
			if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new Error("Invalid config file");
			const reserved = new Set([
				...models.getProviders().map((provider) => provider.id), CUSTOM_PROVIDER.id, "chatgpt",
				...NATIVE_SUBSCRIPTIONS.flatMap((provider) => [provider.logicalId, provider.providerId]),
			]);
			manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")), reserved);
		} catch {
			// Exception messages, options, paths and module responses may contain secrets.
			warn("[native-providers] Invalid configuration; no native modules loaded. Check the manifest and reserved IDs.");
			return;
		}
		const load = options.loadModule ?? createRequire(join(process.cwd(), "package.json"));
		entries = manifest.map((entry) => {
			try {
				const namespace = load(entry.module);
				const factory = isRecord(namespace) ? namespace[entry.export] : undefined;
				if (typeof factory !== "function") throw new Error("Missing factory export");
				const result: unknown = factory(entry.options);
				if (discardAsync(result)) throw new Error("Async factory");
				return { id: entry.id, module: validateModule(result, entry.id) };
			} catch {
				warn(`[native-providers] Provider ${entry.id} could not be loaded. Check its export and Pi SDK compatibility; synchronous JavaScript is required.`);
				return { id: entry.id };
			}
		});
	}
	return {
		sync(models: MutableModels) {
			initialize(models);
			if (installed.has(models)) return;
			for (const entry of entries!) if (entry.module) models.setProvider(entry.module.provider);
			installed.add(models);
		},
		owns(id: string): boolean { return entries?.some((entry) => entry.id === id) ?? false; },
		isReady(id: string): boolean {
			try {
				const result: unknown = entries?.find((entry) => entry.id === id)?.module?.isReady();
				return !discardAsync(result) && result === true;
			} catch { return false; }
		},
		pricingUnknown(id: string): boolean {
			const entry = entries?.find((entry) => entry.id === id);
			return entry !== undefined && entry.module?.pricing !== "catalog";
		},
		statuses() { return (entries ?? []).map((entry) => ({ id: entry.id, envVar: "", keyPresent: this.isReady(entry.id) })); },
	};
}

type Registry = ReturnType<typeof createNativeProviderRegistry>;
const globalRegistry = globalThis as typeof globalThis & { __lhNativeProviders?: Registry };
function registry(): Registry {
	return globalRegistry.__lhNativeProviders ??= createNativeProviderRegistry({ configPath: () => process.env.LH_NATIVE_PROVIDER_CONFIG });
}

/** Wiring only: no config reads, imports or provider factory calls at boot/build. */
export function installNativeProviderSource(): void {
	configureNativeProviderSource(registry());
}
function initializedRegistry(): Registry {
	installNativeProviderSource();
	piModels();
	return registry();
}
export function nativeProviderStatuses() { return initializedRegistry().statuses(); }
export function nativeProviderAvailable(id: string): boolean | undefined {
	const source = initializedRegistry();
	return source.owns(id) ? source.isReady(id) : undefined;
}
export function nativeProviderPricingUnknown(id: string): boolean {
	return initializedRegistry().pricingUnknown(id);
}
