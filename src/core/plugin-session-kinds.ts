/**
 * Plugin session kinds + record kinds — registration validation (stage B,
 * owner principles P1–P5 confirmed 2026-11-17).
 *
 * P1: capabilities are runtime registrations at activation; definitions
 * carry LOCAL ids and the host namespaces them "<pluginId>:<localId>".
 * P2: a session kind is the one contribution that replaces — its per-phase
 * prompt text stands in for the native phase fragments, and its tool delta
 * (same shape as the user's tool toggles: false removes) narrows the native
 * phase tools; forced tools stay. P4: record knobs live on the record
 * (chunkTokens default 4096, minimum 500).
 *
 * Pure and browser-safe: no IO, no host state. Prepared values are frozen
 * snapshots so later mutation of a plugin's own definition object changes
 * nothing.
 */

import type { PluginRecordKindDefinition, PluginSessionKindDefinition } from "./plugins.ts";
import { PLUGIN_KIND_LOCAL_ID_PATTERN, isRecordKindRef } from "./session-kinds.ts";
import type { PluginSessionKindId } from "./contracts/chat.ts";

/** Default and floor for a record's extraction chunk budget (the graph's own
 *  extractionChunkTokens default/minimum, applied per record — P4). */
export const RECORD_CHUNK_TOKENS_DEFAULT = 4096;
export const RECORD_CHUNK_TOKENS_MIN = 500;

/** Native tools a session kind can never remove (lockout-critical: the
 *  phase seam and the plan the teacher's questions validate against). */
export const FORCED_SESSION_KIND_TOOLS = Object.freeze({ prober: Object.freeze(["probe_done"]), teacher: Object.freeze(["plan_init"]) });

export interface PreparedPluginSessionKind {
	/** Full id "<pluginId>:<localId>". */
	readonly id: PluginSessionKindId;
	readonly localId: string;
	readonly pluginId: string;
	readonly label: string;
	/** "graph" or a full plugin record kind id. */
	readonly record: string;
	readonly prompts: { readonly prober: string; readonly teacher: string };
	readonly tools: { readonly prober: Readonly<Record<string, boolean>>; readonly teacher: Readonly<Record<string, boolean>> };
	readonly icon?: string;
}

export interface PreparedPluginRecordKind {
	readonly id: PluginSessionKindId;
	readonly localId: string;
	readonly pluginId: string;
	readonly label: string;
	readonly chunkTokens: number;
	readonly extract: PluginRecordKindDefinition["extract"];
	readonly purge?: NonNullable<PluginRecordKindDefinition["purge"]>;
}

const NATIVE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function localIdOf(value: unknown, what: string): string {
	if (typeof value !== "string" || !PLUGIN_KIND_LOCAL_ID_PATTERN.test(value)) throw new Error(`Invalid plugin ${what} id: use lowercase words joined by hyphens`);
	return value;
}

function toolDelta(value: unknown, phase: "prober" | "teacher"): Readonly<Record<string, boolean>> {
	if (value === undefined) return Object.freeze({});
	if (!object(value)) throw new Error(`Plugin session kind tools.${phase} must be a map of native tool names to booleans`);
	const delta: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(value)) {
		if (!NATIVE_TOOL_NAME.test(name) || typeof enabled !== "boolean") throw new Error(`Plugin session kind tools.${phase} must be a map of native tool names to booleans`);
		delta[name] = enabled;
	}
	return Object.freeze(delta);
}

export function preparePluginSessionKind(pluginId: string, definition: PluginSessionKindDefinition): PreparedPluginSessionKind {
	if (!object(definition)) throw new Error("Invalid plugin session kind definition");
	const localId = localIdOf(definition.id, "session kind");
	if (!text(definition.label)) throw new Error("Plugin session kind requires a nonempty label");
	if (!isRecordKindRef(definition.record)) throw new Error('Plugin session kind record must be "graph" or a "<pluginId>:<recordKindId>" id');
	const prompts = definition.prompts as unknown;
	if (!object(prompts) || !text(prompts.prober) || !text(prompts.teacher)) throw new Error("Plugin session kind requires nonempty prompts.prober and prompts.teacher");
	const tools = definition.tools as unknown;
	if (tools !== undefined && !object(tools)) throw new Error("Plugin session kind tools must be an object keyed by phase");
	if (definition.icon !== undefined && !text(definition.icon)) throw new Error("Plugin session kind icon must be nonempty SVG markup");
	return Object.freeze({
		id: `${pluginId}:${localId}` as PluginSessionKindId,
		localId,
		pluginId,
		label: definition.label,
		record: definition.record,
		prompts: Object.freeze({ prober: prompts.prober, teacher: prompts.teacher }),
		tools: Object.freeze({ prober: toolDelta(tools?.prober, "prober"), teacher: toolDelta(tools?.teacher, "teacher") }),
		...(definition.icon !== undefined ? { icon: definition.icon } : {}),
	});
}

export function preparePluginRecordKind(pluginId: string, definition: PluginRecordKindDefinition): PreparedPluginRecordKind {
	if (!object(definition)) throw new Error("Invalid plugin record kind definition");
	const localId = localIdOf(definition.id, "record kind");
	if (!text(definition.label)) throw new Error("Plugin record kind requires a nonempty label");
	const chunkTokens = definition.chunkTokens ?? RECORD_CHUNK_TOKENS_DEFAULT;
	if (!Number.isInteger(chunkTokens) || chunkTokens < RECORD_CHUNK_TOKENS_MIN) throw new Error(`Plugin record kind chunkTokens must be an integer of at least ${RECORD_CHUNK_TOKENS_MIN}`);
	if (typeof definition.extract !== "function") throw new Error("Plugin record kind requires an extract(batch) function");
	if (definition.purge !== undefined && typeof definition.purge !== "function") throw new Error("Plugin record kind purge must be a function");
	return Object.freeze({
		id: `${pluginId}:${localId}` as PluginSessionKindId,
		localId,
		pluginId,
		label: definition.label,
		chunkTokens,
		extract: definition.extract.bind(definition),
		...(definition.purge ? { purge: definition.purge.bind(definition) } : {}),
	});
}

/** Apply a session kind's phase delta to a native tool set: false removes,
 *  forced tools always stay. User toggles were applied before (false wins). */
export function applySessionKindToolDelta<T extends { name: string }>(tools: readonly T[], delta: Readonly<Record<string, boolean>>, phase: "prober" | "teacher"): T[] {
	const forced: readonly string[] = FORCED_SESSION_KIND_TOOLS[phase];
	return tools.filter((tool) => delta[tool.name] !== false || forced.includes(tool.name));
}
