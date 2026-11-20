import { NewSession } from "@/components/new-session";
import { readSettingsRecord, resolveChatSessionKind } from "@/src/server";
import { isPluginSessionKindId, slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * The draft view behind "+ New session" (owner, 2026-09-13): NO session is
 * created until the first message is sent — the view is a sessionless empty
 * chat; on send it creates the chat (title = that message) and redirects to
 * the real page, whose initialPrompt path delivers the message as turn 1.
 * Static segment beats the dynamic [id] route — "new" is never a chat id.
 *
 * The draft's model control binds the STRONG SLOT (the new-session
 * default); the session the first send creates is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 *
 * ?kind=<pluginId>:<localId> opens a plugin session kind's draft (session/
 * record kinds stage C, owner C3: every session kind is a door). The kind
 * is resolved here for the first paint; the client follows plugin changes
 * live, and an unavailable kind's draft is read-only (stage B, P5).
 */
export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ mode?: string | string[]; kind?: string | string[] }>;
}) {
	const { mode, kind } = await searchParams;
	const pluginKind = isPluginSessionKindId(kind) ? kind : null;
	const resolved = pluginKind ? await resolveChatSessionKind(pluginKind) : null;
	return (
		<NewSession
			initialConfigured={slotsConfigured(readSettingsRecord()?.models)}
			mode={pluginKind ?? (mode === "practice" ? "practice" : "teach")}
			initialKind={resolved?.status === "plugin"
				? { label: resolved.definition.label, pluginName: resolved.pluginName, available: true }
				: resolved?.status === "unavailable" ? { label: null, pluginName: resolved.pluginName, available: false } : undefined}
		/>
	);
}
