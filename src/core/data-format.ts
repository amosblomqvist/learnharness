/**
 * The learning-data folder's format stamp (data-format.json at the data
 * root): the chat, graph and settings format versions of the build that
 * last wrote the folder. Sync plugins compare an incoming stamp with
 * CURRENT_DATA_FORMATS before applying data from another machine; the
 * per-file read guards (chat versions, graph/format.json, settings version)
 * stay the authority on what this build can read.
 */

import { CURRENT_CHAT_VERSION } from "./contracts/chat.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "./contracts/graph.ts";
import { CURRENT_SETTINGS_VERSION } from "./settings.ts";

export interface DataFormats {
	readonly chat: number;
	readonly graph: number;
	readonly settings: number;
}

export const DATA_FORMAT_KEYS = ["chat", "graph", "settings"] as const;

export const CURRENT_DATA_FORMATS: DataFormats = Object.freeze({
	chat: CURRENT_CHAT_VERSION,
	graph: CURRENT_GRAPH_FORMAT_VERSION,
	settings: CURRENT_SETTINGS_VERSION,
});

/** Parse a stamp; unknown keys are ignored, missing or invalid keys are absent. */
export function parseDataFormats(value: unknown): Partial<Record<keyof DataFormats, number>> {
	const out: Partial<Record<keyof DataFormats, number>> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const key of DATA_FORMAT_KEYS) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[key] = v;
	}
	return out;
}

/** The formats in `stamp` that are newer than `current`. */
export function newerDataFormats(stamp: Partial<Record<keyof DataFormats, number>>, current: DataFormats = CURRENT_DATA_FORMATS): (keyof DataFormats)[] {
	return DATA_FORMAT_KEYS.filter((key) => stamp[key] !== undefined && stamp[key]! > current[key]);
}
