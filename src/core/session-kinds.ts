/**
 * Session kinds (session/record kinds — stage A 2026-11-16, stage B
 * 2026-11-17).
 *
 * A chat's SESSION KIND (contracts/chat.ts ChatKind) decides what the chat
 * extracts into — its RECORD KIND (record-kinds.ts). The two native kinds
 * resolve here; plugin-declared kinds ("<pluginId>:<localId>", owner ruling
 * 2026-11-11 q53) are registered at plugin activation and name their record
 * in their definition, so their record resolves through the plugin host
 * (server/record-kinds.ts) — this module only recognizes their id form.
 *
 * Every plugin kind runs the TEACHING shape (owner rulings q41–q56): the
 * prober → probe_done → teacher lifecycle with the kind's own phase prompts.
 */

import type { ChatKind, PluginSessionKindId } from "./contracts/chat.ts";
import { NATIVE_GRAPH_RECORD_KIND } from "./record-kinds.ts";

/** Local ids of plugin-declared kinds share the plugin-id grammar. */
export const PLUGIN_KIND_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FULL_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Split a namespaced plugin kind id; null for native or malformed ids. */
export function parsePluginKindId(id: unknown): { pluginId: string; localId: string } | null {
	if (typeof id !== "string") return null;
	const match = FULL_ID.exec(id);
	return match ? { pluginId: match[1]!, localId: match[2]! } : null;
}

/** True for a well-formed "<pluginId>:<localId>" session kind id. */
export function isPluginSessionKindId(kind: unknown): kind is PluginSessionKindId {
	return parsePluginKindId(kind) !== null;
}

/** A session-kind id a contribution may target: native teach/practice or a
 *  well-formed plugin kind id (which need not be registered yet). */
export function isSessionKindId(kind: unknown): kind is ChatKind {
	return kind === "teach" || kind === "practice" || isPluginSessionKindId(kind);
}

/** A record-kind reference: the native graph or "<pluginId>:<localId>". */
export function isRecordKindRef(id: unknown): id is string {
	return id === NATIVE_GRAPH_RECORD_KIND || parsePluginKindId(id) !== null;
}

/** The exact session-kind id of a saved chat (absent reads as teach). */
export function sessionKindIdOf(kind: ChatKind | undefined): ChatKind {
	return kind ?? "teach";
}

/** The lifecycle SHAPE a session kind runs (owner ruling q55: plugin kinds
 *  are teaching-shaped; the plugin-contract unions keep this as their shape). */
export function sessionShapeOf(kind: ChatKind | undefined): "teaching" | "practice" {
	return kind === "practice" ? "practice" : "teaching";
}

/** The record kind a chat of a NATIVE session kind extracts into; null when
 *  the kind writes nothing (practice, owner 2026-10-04: no extraction, no
 *  graph, no coverage). An absent kind reads as teach — no migration.
 *  Plugin kinds return undefined: their definition names the record. */
export function recordKindIdOf(kind: ChatKind | undefined): string | null | undefined {
	if (kind === undefined || kind === "teach") return NATIVE_GRAPH_RECORD_KIND;
	if (kind === "practice") return null;
	return undefined;
}
