/**
 * The record-kind composition (session/record kinds — stage A 2026-11-16,
 * stage B 2026-11-17): what a chat extracts into, wired to its host-owned
 * coverage ledger.
 *
 * The native graph is a static registry entry (its ledger stays at
 * data/graph/coverage.jsonl). Plugin record kinds are live registrations
 * resolved through the plugin host; their ledger is host bookkeeping at
 * <registering plugin dataDirectory>/records/<localId>/coverage.jsonl (owner
 * rulings q66/q69, P4). A chat's record is a function of its session kind:
 * teach → graph, practice → nothing, a plugin kind → the record its
 * definition names (any plugin's, or "graph").
 *
 * Availability (owner q65): a missing session kind OR a missing record
 * plugin resolves "unavailable" — the trigger skips and retries on a later
 * turn, the ring reports unavailable, nothing is guessed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatKind } from "../core/contracts/chat.ts";
import type { CoverageLedger } from "../core/ports.ts";
import type { PreparedPluginRecordKind } from "../core/plugin-session-kinds.ts";
import { createRecordKindRegistry, NATIVE_GRAPH_RECORD_KIND, type RecordKindRegistry } from "../core/record-kinds.ts";
import { createCoverageLedger } from "../store/coverage.ts";
import type { PluginRecordKindResolution } from "./plugin-host.ts";
import { getPluginHost } from "./plugins.ts";
import { resolveChatSessionKind } from "./session-kinds.ts";
import { recordExtractionEnabled } from "../core/settings-resolution.ts";
import { settingsStore } from "../store/settings.ts";
import { stores } from "./stores.ts";

export const recordKinds: RecordKindRegistry = createRecordKindRegistry([
	{ id: NATIVE_GRAPH_RECORD_KIND, label: "Knowledge graph", coverage: stores.coverage },
]);

/** A plugin record's host-owned extraction switch, read fresh (stage C, q54). */
export function pluginRecordExtractionEnabled(recordKindId: string): boolean {
	return recordExtractionEnabled(settingsStore.readSettings(), recordKindId);
}

/** The host-owned coverage ledger inside a plugin record's reserved folder. */
export const RECORD_COVERAGE_FILE = "coverage.jsonl";
export function pluginRecordCoverage(recordDirectory: string): CoverageLedger {
	return createCoverageLedger(path.join(/* turbopackIgnore: true */ recordDirectory, RECORD_COVERAGE_FILE));
}

export type ChatRecordTarget =
	/** The kind extracts nothing (practice). */
	| { status: "none"; sessionKindId: ChatKind }
	/** The native graph: unchanged pipeline, gated by graph.enabled (q51). */
	| { status: "graph"; sessionKindId: ChatKind; recordKindId: typeof NATIVE_GRAPH_RECORD_KIND; label: string; coverage: CoverageLedger }
	| { status: "plugin"; sessionKindId: ChatKind; recordKindId: string; label: string; chunkTokens: number; coverage: CoverageLedger;
		definition: PreparedPluginRecordKind; signal: AbortSignal; requireActive(): void }
	/** Session kind or record plugin unavailable; recordKindId null when the
	 *  session kind itself is missing (its record cannot be known). */
	| { status: "unavailable"; sessionKindId: ChatKind; recordKindId: string | null };

/** Pure over a record lookup (tests inject the lookup). */
export function pluginRecordTarget(sessionKindId: ChatKind, recordKindId: string, resolved: PluginRecordKindResolution): ChatRecordTarget {
	if (resolved.status !== "available") return { status: "unavailable", sessionKindId, recordKindId };
	return {
		status: "plugin", sessionKindId, recordKindId, label: resolved.definition.label, chunkTokens: resolved.definition.chunkTokens,
		coverage: pluginRecordCoverage(resolved.directory), definition: resolved.definition, signal: resolved.signal, requireActive: resolved.requireActive,
	};
}

/** Resolve what a saved chat extracts into, right now. */
export async function resolveChatRecord(kind: ChatKind | undefined): Promise<ChatRecordTarget> {
	const session = await resolveChatSessionKind(kind);
	const sessionKindId = session.id;
	if (session.status === "unavailable") return { status: "unavailable", sessionKindId, recordKindId: null };
	const recordKindId = session.status === "native"
		? (session.id === "practice" ? null : NATIVE_GRAPH_RECORD_KIND)
		: session.definition.record;
	if (recordKindId === null) return { status: "none", sessionKindId };
	if (recordKindId === NATIVE_GRAPH_RECORD_KIND) {
		const graph = recordKinds.get(NATIVE_GRAPH_RECORD_KIND)!;
		return { status: "graph", sessionKindId, recordKindId: NATIVE_GRAPH_RECORD_KIND, label: graph.label, coverage: graph.coverage };
	}
	try {
		const host = await getPluginHost();
		return pluginRecordTarget(sessionKindId, recordKindId, host.resolveRecordKind(recordKindId));
	} catch {
		return { status: "unavailable", sessionKindId, recordKindId };
	}
}

/**
 * Every plugin record coverage ledger on disk (enabled or not): community
 * plugins/<id>/data/records/<kind>/coverage.jsonl and core
 * core-plugin-data/<id>/records/<kind>/coverage.jsonl. Session deletion
 * purges the chat's rows from ALL of them — chat ids are unique, so no
 * kind resolution (which a disabled plugin could not answer) is needed.
 */
export function pluginRecordCoverageFiles(roots: { community: string; core?: string }): string[] {
	const files: string[] = [];
	const scan = (dataDirectory: string) => {
		const records = path.join(/* turbopackIgnore: true */ dataDirectory, "records");
		let kinds: fs.Dirent[];
		try { kinds = fs.readdirSync(/* turbopackIgnore: true */ records, { withFileTypes: true }); } catch { return; }
		for (const kind of kinds) {
			if (!kind.isDirectory()) continue;
			const file = path.join(/* turbopackIgnore: true */ records, kind.name, RECORD_COVERAGE_FILE);
			try { if (fs.lstatSync(file).isFile()) files.push(file); } catch { /* none yet */ }
		}
	};
	const plugins = (root: string, dataSegment: string | null) => {
		let ids: fs.Dirent[];
		try { ids = fs.readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true }); } catch { return; }
		for (const id of ids) if (id.isDirectory()) scan(dataSegment ? path.join(/* turbopackIgnore: true */ root, id.name, dataSegment) : path.join(/* turbopackIgnore: true */ root, id.name));
	};
	plugins(roots.community, "data");
	if (roots.core) plugins(roots.core, null);
	return files.sort();
}

/** Remove one chat's rows from every plugin record ledger; returns rows removed. */
export function purgePluginRecordCoverage(chatId: string, roots: { community: string; core?: string }): number {
	let removed = 0;
	for (const file of pluginRecordCoverageFiles(roots)) {
		const ledger = createCoverageLedger(file);
		const rows = ledger.read();
		const kept = rows.filter((row) => row.chatId !== chatId);
		if (kept.length === rows.length) continue;
		ledger.rewrite(kept);
		removed += rows.length - kept.length;
	}
	return removed;
}
