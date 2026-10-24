/**
 * LOCAL MODEL SERVERS — the composition (local-models wave, 2026-10-24):
 * the server list in the settings record (`localServers`) + each server's
 * optional key in auth.json, joined to the engine collection
 * (src/agent/models.ts registerLocalServer) and kept honest by discovery
 * (src/agent/local-models.ts — the server reports its own models and
 * limits).
 *
 * Lifecycle:
 *  - SYNC (sync, cheap): every configured server is registered as a pi
 *    provider — at import (so a cold process can build a pinned local
 *    model's engine before anything else runs) and on every list/refresh,
 *    so a hand-edited settings.json lands too.
 *  - DISCOVERY (async): asks a server for its models. The catalog route
 *    refreshes servers older than LOCAL_DISCOVERY_TTL_MS; a turn on a local
 *    model only makes sure its server was asked once this process. A failed
 *    refresh keeps the last good model list (pi's dynamic-provider rule)
 *    and records the error for the settings row.
 *  - CONNECT probes FIRST and persists only a server that answered with
 *    at least one usable model — a typo never lands in the record.
 */

import { localServerKeyGuard } from "../core/auth-keys.ts";
import {
	LOCAL_CONTEXT_WINDOW_FLOOR,
	LOCAL_ENGINE_LABELS,
	LOCAL_SERVER_APIS,
	displayAddress,
	isLocalServerApi,
	localServerIdFor,
	localServerKeyVar,
	normalizeLocalServerUrl,
	type LocalEngine,
	type LocalModelInfo,
	type LocalServer,
	type LocalServerInput,
	type LocalServerStatus,
	type LocalServerView,
} from "../core/local-servers.ts";
import { CURRENT_SETTINGS_VERSION } from "../core/settings.ts";
import { buildLocalModel, discoverLocalModels, type DiscoveredModel, type LocalDiscovery } from "../agent/local-models.ts";
import {
	piModels,
	registerLocalServer,
	registeredLocalServer,
	registeredLocalServers,
	unregisterLocalServer,
} from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { deleteKey, keyValue, saveKey } from "./keys.ts";

/** How long a discovery stays fresh for the catalog's reads — the picker
 *  re-fetches the catalog on every open, the server is asked at most this
 *  often. */
export const LOCAL_DISCOVERY_TTL_MS = 30_000;

/** The last discovery against one server, for the inputs it answered. */
interface DiscoveryRecord {
	/** api + baseUrl + named models — an edit that changes any voids it. */
	target: string;
	ok: boolean;
	engine: LocalEngine | null;
	discovered: DiscoveredModel[];
	hidden: { id: string; reason: string }[];
	error?: string;
	checkedAt: number;
}

const discoveries = new Map<string, DiscoveryRecord>();
const inflight = new Map<string, Promise<void>>();

function targetOf(server: Pick<LocalServer, "baseUrl" | "api" | "models">): string {
	return `${server.api} ${server.baseUrl} ${(server.models ?? []).join(",")}`;
}

function sameServer(a: LocalServer, b: LocalServer): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.baseUrl === b.baseUrl &&
		a.api === b.api &&
		a.contextWindow === b.contextWindow &&
		a.vision === b.vision &&
		(a.models ?? []).join(",") === (b.models ?? []).join(",")
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The configured servers, straight from the settings record. */
export function configuredLocalServers(): LocalServer[] {
	return settingsStore.readSettings()?.localServers ?? [];
}

/** Make the engine collection hold exactly the configured servers. A
 *  server whose config is unchanged keeps its registration (and models);
 *  a changed one re-registers with the models its target last reported. */
export function syncLocalServers(servers: readonly LocalServer[] = configuredLocalServers()): void {
	const wanted = new Set(servers.map((s) => s.id));
	for (const registered of registeredLocalServers()) {
		if (wanted.has(registered.id)) continue;
		unregisterLocalServer(registered.id);
		discoveries.delete(registered.id);
	}
	for (const server of servers) {
		const current = registeredLocalServer(server.id);
		if (current && sameServer(current, server)) continue;
		const record = discoveries.get(server.id);
		registerLocalServer(server, record?.target === targetOf(server) ? record.discovered : []);
	}
}

function storeDiscovery(server: LocalServer, discovery: LocalDiscovery): void {
	discoveries.set(server.id, {
		target: targetOf(server),
		ok: true,
		engine: discovery.engine,
		discovered: discovery.models,
		hidden: discovery.hidden,
		checkedAt: Date.now(),
	});
}

/** Store a background discovery and publish its models — unless the
 *  server's config changed while it ran (the newer config wins). */
function recordDiscovery(server: LocalServer, discovery: LocalDiscovery): void {
	storeDiscovery(server, discovery);
	const current = registeredLocalServer(server.id);
	if (!current || sameServer(current, server)) registerLocalServer(server, discovery.models);
}

function rediscover(server: LocalServer): Promise<void> {
	const flightKey = `${server.id} ${targetOf(server)}`;
	const running = inflight.get(flightKey);
	if (running) return running;
	const run = (async () => {
		try {
			const discovery = await discoverLocalModels(server, { apiKey: keyValue(localServerKeyVar(server.id)) });
			recordDiscovery(server, discovery);
		} catch (err) {
			const previous = discoveries.get(server.id);
			const kept = previous?.target === targetOf(server) ? previous : undefined;
			discoveries.set(server.id, {
				target: targetOf(server),
				ok: false,
				engine: kept?.engine ?? null,
				discovered: kept?.discovered ?? [],
				hidden: kept?.hidden ?? [],
				error: errorMessage(err),
				checkedAt: Date.now(),
			});
		}
	})().finally(() => inflight.delete(flightKey));
	inflight.set(flightKey, run);
	return run;
}

/** Ask every configured server (or `ids`) whose last answer is older than
 *  `maxAgeMs` (default: the TTL; `force` = always) for its models. Never
 *  rejects — failures land in the server's status. */
export async function refreshLocalServers(
	options: { force?: boolean; ids?: readonly string[]; maxAgeMs?: number } = {},
): Promise<void> {
	const servers = configuredLocalServers();
	syncLocalServers(servers);
	const maxAge = options.force ? 0 : (options.maxAgeMs ?? LOCAL_DISCOVERY_TTL_MS);
	await Promise.all(
		servers
			.filter((s) => !options.ids || options.ids.includes(s.id))
			.map((server) => {
				const record = discoveries.get(server.id);
				const fresh = record && record.target === targetOf(server) && Date.now() - record.checkedAt < maxAge;
				return fresh ? undefined : rediscover(server);
			}),
	);
}

/** The turn's cold-start guard: a conversation on a local model whose
 *  server this process never asked gets its real context window before
 *  compaction and max-token math read it. No-op for hosted providers. */
export async function ensureLocalServerDiscovered(provider: string): Promise<void> {
	if (!registeredLocalServer(provider)) return;
	await refreshLocalServers({ ids: [provider], maxAgeMs: Infinity });
}

function modelInfo(server: LocalServer, discovered: DiscoveredModel): LocalModelInfo {
	const model = buildLocalModel(server, discovered);
	return {
		id: model.id,
		contextWindow: model.contextWindow,
		vision: model.input.includes("image"),
		reasoning: model.reasoning,
	};
}

function statusOf(server: LocalServer): LocalServerStatus | null {
	const record = discoveries.get(server.id);
	if (!record || record.target !== targetOf(server)) return null;
	return {
		ok: record.ok,
		engine: record.engine,
		models: record.discovered.map((m) => modelInfo(server, m)),
		hidden: record.hidden,
		...(record.error !== undefined ? { error: record.error } : {}),
		checkedAt: record.checkedAt,
	};
}

export function localServerView(server: LocalServer): LocalServerView {
	return {
		...server,
		address: displayAddress(server.baseUrl),
		apiKeySet: keyValue(localServerKeyVar(server.id)) !== undefined,
		status: statusOf(server),
	};
}

/** GET /api/local-servers — every configured server with its last status. */
export function listLocalServers(): LocalServerView[] {
	const servers = configuredLocalServers();
	syncLocalServers(servers);
	return servers.map(localServerView);
}

// ─── Connect / remove ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The POST body parser — strict on every field (the settings-body.ts
 *  discipline: a bad shape is a 400, never a silent drop). */
export function parseLocalServerInput(
	body: unknown,
): { ok: true; input: LocalServerInput } | { ok: false; error: string } {
	if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
	if (body.id !== undefined && typeof body.id !== "string") return { ok: false, error: "id must be a string" };
	if (typeof body.address !== "string") return { ok: false, error: "address must be a string" };
	if (!isLocalServerApi(body.api)) {
		return { ok: false, error: `api must be one of: ${LOCAL_SERVER_APIS.join(", ")}` };
	}
	const input: LocalServerInput = { address: body.address, api: body.api };
	if (body.id !== undefined) input.id = body.id as string;
	if (body.apiKey !== undefined) {
		if (body.apiKey !== null && typeof body.apiKey !== "string") {
			return { ok: false, error: "apiKey must be a string or null" };
		}
		if (typeof body.apiKey === "string") {
			const shape = localServerKeyGuard("apiKey", body.apiKey);
			if (!shape.ok) return { ok: false, error: shape.error };
		}
		input.apiKey = body.apiKey;
	}
	if (body.contextWindow !== undefined) {
		const cw = body.contextWindow;
		if (cw !== null && (typeof cw !== "number" || !Number.isInteger(cw) || cw < LOCAL_CONTEXT_WINDOW_FLOOR)) {
			return { ok: false, error: `contextWindow must be a whole number of at least ${LOCAL_CONTEXT_WINDOW_FLOOR} tokens, or null` };
		}
		input.contextWindow = cw;
	}
	if (body.vision !== undefined) {
		if (body.vision !== null && typeof body.vision !== "boolean") {
			return { ok: false, error: "vision must be a boolean or null" };
		}
		input.vision = body.vision;
	}
	if (body.models !== undefined) {
		const models = body.models;
		if (models !== null && (!Array.isArray(models) || !models.every((m) => typeof m === "string" && m.trim() && !/\s/.test(m.trim())))) {
			return { ok: false, error: "models must be a list of model ids (no spaces), or null" };
		}
		input.models = models === null ? null : [...new Set((models as string[]).map((m) => m.trim()))];
	}
	return { ok: true, input };
}

function noModelsError(discovery: LocalDiscovery): string {
	if (discovery.hidden.length === 0) {
		return "The server answered but lists no models — load or pull one, then connect again.";
	}
	const why = discovery.hidden.map((h) => `${h.id}: ${h.reason}`).join(", ");
	return `The server answered but none of its models can run an agent (${why}) — load a chat model with tool calling, then connect again.`;
}

export type LocalServerResult =
	| { ok: true; server: LocalServerView }
	| { ok: false; status: 400 | 404 | 502; error: string };

/**
 * POST /api/local-servers — connect a new server (no id) or update one.
 * The server is asked for its models BEFORE anything is stored; only a
 * server that answers with at least one usable model is saved. The
 * provider id is fixed at creation (pins reference it); the name follows
 * the detected engine, else the server's own `owned_by`, else its address.
 */
export async function connectLocalServer(body: unknown): Promise<LocalServerResult> {
	const parsed = parseLocalServerInput(body);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const input = parsed.input;
	const url = normalizeLocalServerUrl(input.address, input.api);
	if (!url.ok) return { ok: false, status: 400, error: url.error };

	const servers = configuredLocalServers();
	const existing = input.id !== undefined ? servers.find((s) => s.id === input.id) : undefined;
	if (input.id !== undefined && !existing) {
		return { ok: false, status: 404, error: `unknown local server "${input.id}"` };
	}
	// Probe with the key the server WILL have: a new one, none (cleared),
	// or the one already stored for this server.
	const apiKey =
		input.apiKey === null
			? undefined
			: (input.apiKey?.trim() ?? (existing ? keyValue(localServerKeyVar(existing.id)) : undefined));

	const models = input.models === undefined ? existing?.models : (input.models ?? undefined);
	let discovery: LocalDiscovery;
	try {
		discovery = await discoverLocalModels({ baseUrl: url.baseUrl, api: input.api, models }, { apiKey });
	} catch (err) {
		return { ok: false, status: 502, error: errorMessage(err) };
	}
	if (discovery.models.length === 0) return { ok: false, status: 502, error: noModelsError(discovery) };

	const id =
		existing?.id ??
		localServerIdFor(
			discovery.engine ?? discovery.owner ?? "local",
			new Set([...piModels().getProviders().map((p) => p.id), ...servers.map((s) => s.id)]),
		);
	const server: LocalServer = {
		id,
		name: discovery.engine ? LOCAL_ENGINE_LABELS[discovery.engine] : (discovery.owner ?? displayAddress(url.baseUrl)),
		baseUrl: url.baseUrl,
		api: input.api,
	};
	const contextWindow = input.contextWindow === undefined ? existing?.contextWindow : (input.contextWindow ?? undefined);
	if (contextWindow !== undefined) server.contextWindow = contextWindow;
	const vision = input.vision === undefined ? existing?.vision : (input.vision ?? undefined);
	if (vision !== undefined) server.vision = vision;
	if (models?.length) server.models = models;

	const record = settingsStore.readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	const next = existing ? servers.map((s) => (s.id === id ? server : s)) : [...servers, server];
	settingsStore.writeSettings({ ...record, localServers: next });
	const keyVar = localServerKeyVar(id);
	if (typeof input.apiKey === "string") saveKey(keyVar, input.apiKey);
	else if (input.apiKey === null) deleteKey(keyVar);

	storeDiscovery(server, discovery);
	registerLocalServer(server, discovery.models);
	return { ok: true, server: localServerView(server) };
}

/** DELETE /api/local-servers/:id — the record entry, its key, and its
 *  provider go together. Slots still pinned to it are left as they are:
 *  the pickers show them unavailable, the same as a deleted provider key. */
export function removeLocalServer(id: string): { ok: true } | { ok: false; status: 404; error: string } {
	const servers = configuredLocalServers();
	if (!servers.some((s) => s.id === id)) return { ok: false, status: 404, error: `unknown local server "${id}"` };
	const { localServers: _old, ...rest } = settingsStore.readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	const next = servers.filter((s) => s.id !== id);
	settingsStore.writeSettings(next.length ? { ...rest, localServers: next } : rest);
	deleteKey(localServerKeyVar(id));
	discoveries.delete(id);
	unregisterLocalServer(id);
	return { ok: true };
}

// Register the configured servers at first import — before any engine build.
syncLocalServers();
