/**
 * The client's view of session kinds and record kinds (session/record kinds
 * stage C, owner principles C1–C4 confirmed 2026-11-19): one pure derivation
 * over the plugin snapshot that home, the new-session draft, the sidebar and
 * the delete dialog all read, so every surface agrees on which kinds exist.
 *
 * Native kinds are fixed: teach and practice. Plugin kinds and records come
 * from ACTIVE plugins' server listings; a record is shown on home only when
 * its plugin also registered a record view (C1: the body is plugin-owned).
 */

import type { ChatKind, PluginRecordKindSummary, PluginSessionKindSummary } from "@/src/core";
import type { PluginMount, PluginSnapshot } from "./plugin-manager.ts";

export const GRAPH_RECORD_ID = "graph";
export const GRAPH_RECORD_LABEL = "Knowledge graph";

export interface CatalogSessionKind extends PluginSessionKindSummary {
	pluginId: string;
	pluginName: string;
}
export interface CatalogRecordKind extends PluginRecordKindSummary {
	pluginId: string;
	pluginName: string;
}
/** A record home can show: the graph (native body) or a plugin record view. */
export type HomeRecord =
	| { id: typeof GRAPH_RECORD_ID; label: string }
	| { id: string; label: string; pluginId: string; mount: PluginMount };
/** One entry of home's mode switch / the draft's kind. */
export interface HomeKind {
	id: ChatKind;
	label: string;
	icon?: string;
}

export interface KindCatalog {
	/** False until the plugin manager's first listing lands — an absent
	 *  kind is only "unavailable" once the catalog is ready. */
	ready: boolean;
	sessionKinds: readonly CatalogSessionKind[];
	recordKinds: readonly CatalogRecordKind[];
	homeRecords: readonly HomeRecord[];
}

export function kindCatalog(snapshot: Pick<PluginSnapshot, "plugins" | "recordViews"> & { loading?: boolean }): KindCatalog {
	const sessionKinds: CatalogSessionKind[] = [];
	const recordKinds: CatalogRecordKind[] = [];
	for (const plugin of snapshot.plugins) {
		const { info } = plugin;
		if (!info.enabled || info.status !== "active") continue;
		const pluginName = info.manifest?.name ?? info.id;
		for (const kind of info.sessionKinds ?? []) sessionKinds.push({ ...kind, pluginId: info.id, pluginName });
		for (const record of info.recordKinds ?? []) recordKinds.push({ ...record, pluginId: info.id, pluginName });
	}
	const homeRecords: HomeRecord[] = [{ id: GRAPH_RECORD_ID, label: GRAPH_RECORD_LABEL }];
	for (const view of snapshot.recordViews ?? []) {
		const record = recordKinds.find((kind) => kind.id === view.recordKindId && kind.pluginId === view.pluginId);
		if (record) homeRecords.push({ id: record.id, label: record.label, pluginId: record.pluginId, mount: view.mount });
	}
	return { ready: snapshot.loading !== true, sessionKinds, recordKinds, homeRecords };
}

/** The session kinds that write into a record, in switch order: on the
 *  graph Teach, Practice, then plugin kinds naming the graph (q42/q50). */
export function kindsForRecord(catalog: KindCatalog, recordId: string): HomeKind[] {
	const plugin = catalog.sessionKinds
		.filter((kind) => kind.record === recordId)
		.map((kind) => ({ id: kind.id as ChatKind, label: kind.label, ...(kind.icon ? { icon: kind.icon } : {}) }));
	return recordId === GRAPH_RECORD_ID
		? [{ id: "teach", label: "Teach" }, { id: "practice", label: "Practice" }, ...plugin]
		: plugin;
}

export function sessionKindOf(catalog: KindCatalog, kind: ChatKind | undefined): CatalogSessionKind | undefined {
	return catalog.sessionKinds.find((entry) => entry.id === kind);
}

/** What a chat of this kind extracts into, as the client can know it now. */
export type ChatRecordView =
	| { status: "graph" }
	| { status: "none" }
	| { status: "plugin"; record: CatalogRecordKind }
	/** The kind's plugin, or its record's plugin, is not active. */
	| { status: "unavailable"; label: string | null };

export function recordOfKind(catalog: KindCatalog, kind: ChatKind | undefined): ChatRecordView {
	if (kind === undefined || kind === "teach") return { status: "graph" };
	if (kind === "practice") return { status: "none" };
	const session = sessionKindOf(catalog, kind);
	if (!session) return { status: "unavailable", label: null };
	if (session.record === GRAPH_RECORD_ID) return { status: "graph" };
	const record = catalog.recordKinds.find((entry) => entry.id === session.record);
	return record ? { status: "plugin", record } : { status: "unavailable", label: null };
}

/** Sidebar filter segments (C3/J2): Teaching / Practice / each active plugin
 *  kind / All. Sessions of inactive kinds show under All only. */
export type SessionFilter = "teach" | "practice" | "all" | `${string}:${string}`;
export function sessionFilters(catalog: KindCatalog): SessionFilter[] {
	return ["teach", "practice", ...catalog.sessionKinds.map((kind) => kind.id as SessionFilter), "all"];
}
export function matchesSessionFilter(kind: ChatKind | undefined, filter: SessionFilter): boolean {
	return filter === "all" || (kind ?? "teach") === filter;
}
