import fs from "node:fs";
import path from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { PATHS } from "../../config.ts";
import { setModelCatalogOverlay } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import type { ModelCatalogRefreshOutcome } from "../core/contracts/models.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { keyValue } from "./keys.ts";
import { readBoundedJson } from "./custom-provider-body.ts";

const FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "model-catalog.json");
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SHARD_ROWS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

// Only the picker’s builtin API-key chat providers. Existing dynamic/connected
// routes (e.g. Radius, OAuth, Claude Code and user endpoints) are not pi.dev shards.
const keyProviders = new Set(AUTH_PROVIDER_KEYS.map(({ id }) => id));
const builtins = new Map(builtinProviders().flatMap((provider) => {
	const models = provider.getModels();
	return keyProviders.has(provider.id) && !provider.refreshModels && models.length > 0
		? [[provider.id, models] as const] : [];
}));

const id = z.string().min(1).max(256).regex(/^[\w.~:@-]+(?:\/[\w.~:@-]+)*$/)
	.refine((value) => !value.split("/").some((part) => part === "." || part === ".."));
const rate = z.number().min(0).max(1_000_000);
const rates = z.object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate });
const tokens = z.number().int().positive().max(100_000_000);
const thinking = z.string().max(32).regex(/^[\w-]*$/).nullable().optional();
const rowSchema = z.object({
	type: z.literal("chat").optional(),
	id,
	name: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]*$/),
	api: z.string(),
	baseUrl: z.string(),
	reasoning: z.boolean(),
	thinkingLevelMap: z.object({ off: thinking, minimal: thinking, low: thinking, medium: thinking, high: thinking, xhigh: thinking, max: thinking }).optional(),
	input: z.array(z.enum(["text", "image"])).min(1).max(2).refine((values) => values.includes("text") && new Set(values).size === values.length),
	cost: rates.extend({ tiers: z.array(rates.extend({ inputTokensAbove: tokens })).max(8).optional() }),
	contextWindow: tokens,
	maxTokens: tokens,
});

// Optional wire flags needed by some new models. Never import headers,
// fallback models, gateway routing preferences, or raw request arguments.
const completionsCompat = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
	maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
	thinkingFormat: z.enum(["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template", "string-thinking", "ant-ling"]).optional(),
	zaiToolStream: z.boolean().optional(),
});
const anthropicCompat = z.object({
	forceAdaptiveThinking: z.boolean().optional(),
	supportsTemperature: z.boolean().optional(),
	supportsEagerToolInputStreaming: z.boolean().optional(),
	supportsCacheControlOnTools: z.boolean().optional(),
});

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function catalogRows(body: unknown): unknown[] {
	// Pi 1.5.x accepts an array, a {models:[]} envelope, or an id map.
	const rows = Array.isArray(body) ? body : record(body) ? ("models" in body ? body.models : Object.values(body)) : null;
	if (!Array.isArray(rows) || rows.length > MAX_SHARD_ROWS || !rows.every((row) => record(row) && typeof row.id === "string")) {
		throw new Error("Invalid pi.dev catalog");
	}
	return rows;
}

function checkedModels(provider: string, rows: readonly unknown[]): Model<Api>[] {
	const baseline = builtins.get(provider);
	if (!baseline) return [];
	const known = new Set(baseline.map((model) => model.id));
	const models = new Map<string, Model<Api>>();
	for (const row of rows) {
		if (!record(row) || (row.provider !== undefined && row.provider !== provider)) continue;
		const result = rowSchema.safeParse(row);
		if (!result.success) continue;
		const { id, api, baseUrl, ...metadata } = result.data;
		// The bundled Pi catalog owns existing entries. Only admit new IDs
		// for an exact API + URL pair that this provider already uses.
		if (known.has(id)) continue;
		const route = baseline.find((model) => model.api === api && model.baseUrl === baseUrl);
		if (!route || (route.api === "google-generative-ai" && id.includes(":"))) continue;
		const compat = route.api === "openai-completions" ? completionsCompat.safeParse(row.compat)
			: route.api === "anthropic-messages" ? anthropicCompat.safeParse(row.compat) : undefined;
		models.set(id, {
			...metadata, id, provider, api: route.api, baseUrl: route.baseUrl,
			...(route.headers ? { headers: route.headers } : {}),
			...(compat?.success ? { compat: compat.data } : {}),
		});
	}
	return [...models.values()];
}

type Catalog = Map<string, readonly Model<Api>[]>;
interface State { snapshot: Catalog; refreshing?: Promise<ModelCatalogRefreshOutcome> }
const STATE_KEY = Symbol.for("lh.remote-model-catalog");
const catalogGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: State };

function restoreSnapshot(): Catalog {
	try {
		if (fs.statSync(FILE).size > MAX_SNAPSHOT_BYTES) return new Map();
		const saved: unknown = JSON.parse(fs.readFileSync(FILE, "utf-8"));
		if (record(saved) && saved.version === 1 && record(saved.providers)) {
			return new Map([...builtins.keys()].flatMap((provider) => {
				const rows = saved.providers as Record<string, unknown>;
				const models = Array.isArray(rows[provider]) ? checkedModels(provider, catalogRows(rows[provider])) : [];
				return models.length ? [[provider, models] as const] : [];
			}));
		}
	} catch { /* Missing/unreadable snapshot: the bundled catalog is still usable. */ }
	return new Map();
}

/** Local file only. Next's server startup restores without checking pi.dev. */
export function initializeModelCatalog(): void {
	if (catalogGlobal[STATE_KEY]) return;
	const snapshot = restoreSnapshot();
	catalogGlobal[STATE_KEY] = { snapshot };
	setModelCatalogOverlay(snapshot);
}

async function fetchShard(provider: string, signal: AbortSignal): Promise<Model<Api>[]> {
	const url = new URL(`https://pi.dev/api/models/providers/${encodeURIComponent(provider)}?types=chat`);
	const response = await fetch(url, {
		cache: "no-store", credentials: "omit", redirect: "error", signal,
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		// These are the SDK's unsupported-shard statuses, not a deletion.
		if (response.status === 404 || response.status === 501) return [];
		throw new Error("pi.dev catalog request failed");
	}
	return checkedModels(provider, catalogRows(await readBoundedJson(response, MAX_SHARD_BYTES)));
}

async function refresh(state: State): Promise<ModelCatalogRefreshOutcome> {
	const configured = AUTH_PROVIDER_KEYS.filter(({ id, envVar }) => builtins.has(id) && keyValue(envVar) !== undefined);
	if (!configured.length) return "no-providers";
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	try {
		const shards = await Promise.all(configured.map(async ({ id }) => [id, await fetchShard(id, signal)] as const));
		signal.throwIfAborted();
		const snapshot: Catalog = new Map(state.snapshot);
		for (const [provider, models] of shards) {
			if (!models.length) continue;
			// Keep previously imported IDs if a later feed omits them: saved
			// slot, chat and background pins can still refer to them.
			const merged = new Map(snapshot.get(provider)?.map((model) => [model.id, model]));
			for (const model of models) {
				const previous = merged.get(model.id);
				if (!previous || (previous.api === model.api && previous.baseUrl === model.baseUrl)) merged.set(model.id, model);
			}
			if (merged.size > MAX_SHARD_ROWS) throw new Error("Model catalog exceeds the row limit");
			snapshot.set(provider, [...merged.values()]);
		}
		const encode = (value: Catalog) => JSON.stringify({ version: 1, providers: Object.fromEntries(value) });
		const text = encode(snapshot);
		if (text === encode(state.snapshot)) return "unchanged";
		if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error("Model catalog exceeds the snapshot limit");
		fs.mkdirSync(PATHS.data, { recursive: true });
		writeFileAtomicSync(FILE, text);
		state.snapshot = snapshot;
		setModelCatalogOverlay(snapshot);
		return "updated";
	} finally { controller.abort(); }
}

/** Called exclusively by the manual POST. Concurrent clicks share one fetch. */
export function refreshModelCatalog(): Promise<ModelCatalogRefreshOutcome> {
	initializeModelCatalog();
	const state = catalogGlobal[STATE_KEY]!;
	return state.refreshing ??= refresh(state).finally(() => { state.refreshing = undefined; });
}
