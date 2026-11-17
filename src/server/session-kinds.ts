/**
 * Session-kind resolution (session/record kinds, stage B — owner principles
 * P1–P5 confirmed 2026-11-17).
 *
 * Native kinds (teach / practice / absent) resolve without the plugin host.
 * A plugin kind "<pluginId>:<localId>" resolves through the live host: it is
 * available exactly while the declaring plugin is enabled, active and still
 * registers it. Otherwise its saved sessions are READ-ONLY (P5): every
 * model-work entry refuses honestly at its gate — 409
 * session-kind-unavailable, before any liveness effect — while open, rename,
 * export and delete stay untouched (none of them is model work).
 */

import type { ChatKind } from "../core/contracts/chat.ts";
import type { PreparedPluginSessionKind } from "../core/plugin-session-kinds.ts";
import { parsePluginKindId } from "../core/session-kinds.ts";
import type { PluginSessionKindResolution } from "./plugin-host.ts";
import { getPluginHost } from "./plugins.ts";

export type ChatSessionKind =
	| { status: "native"; id: "teach" | "practice" }
	| { status: "plugin"; id: ChatKind; pluginId: string; pluginName: string; definition: PreparedPluginSessionKind }
	| { status: "unavailable"; id: ChatKind; pluginId: string; pluginName: string };

/** Pure classification over a host lookup (tests inject the lookup). */
export function classifySessionKind(kind: ChatKind | undefined, lookup: ((id: string) => PluginSessionKindResolution) | null): ChatSessionKind {
	if (kind === undefined || kind === "teach") return { status: "native", id: "teach" };
	if (kind === "practice") return { status: "native", id: "practice" };
	const parsed = parsePluginKindId(kind);
	const pluginId = parsed?.pluginId ?? "";
	if (!parsed || !lookup) return { status: "unavailable", id: kind, pluginId, pluginName: pluginId || kind };
	const resolved = lookup(kind);
	return resolved.status === "available"
		? { status: "plugin", id: kind, pluginId, pluginName: resolved.pluginName, definition: resolved.definition }
		: { status: "unavailable", id: kind, pluginId, pluginName: resolved.pluginName || pluginId };
}

/** Resolve a saved chat's session kind against the live plugin host. A host
 *  that cannot start leaves plugin kinds unavailable (never a native guess). */
export async function resolveChatSessionKind(kind: ChatKind | undefined): Promise<ChatSessionKind> {
	if (kind === undefined || kind === "teach" || kind === "practice") return classifySessionKind(kind, null);
	let lookup: ((id: string) => PluginSessionKindResolution) | null = null;
	try {
		const host = await getPluginHost();
		lookup = (id) => host.resolveSessionKind(id);
	} catch { /* unavailable below */ }
	return classifySessionKind(kind, lookup);
}

/** The read-only refusal (P5) — the same envelope for turns and side chats. */
export function sessionKindUnavailableResponse(kind: Extract<ChatSessionKind, { status: "unavailable" }>): Response {
	return Response.json({
		error: `This session needs the "${kind.pluginName}" plugin, which is disabled or not installed.`,
		code: "session-kind-unavailable",
		sessionKindId: kind.id,
		pluginId: kind.pluginId,
		pluginName: kind.pluginName,
	}, { status: 409 });
}

/** The client's read-only view of a saved chat's kind (GET /api/chats/[id]). */
export interface SessionKindStatus {
	id: ChatKind;
	available: boolean;
	/** Plugin kinds only: the kind's label while available. */
	label?: string;
	pluginId?: string;
	pluginName?: string;
}

export function sessionKindStatus(kind: ChatSessionKind): SessionKindStatus {
	if (kind.status === "native") return { id: kind.id, available: true };
	if (kind.status === "plugin") return { id: kind.id, available: true, label: kind.definition.label, pluginId: kind.pluginId, pluginName: kind.pluginName };
	return { id: kind.id, available: false, pluginId: kind.pluginId, pluginName: kind.pluginName };
}
