import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";
import { withUserScope } from "@/src/server/auth/context.ts";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default async function HomePage() {
	// Account-scoped reads (mobile-web): server pages never pass through
	// withUser, so the record must be read inside the account's scope or it
	// resolves against the empty base root.
	const { configured, rendering } = await withUserScope(() => {
		// First-run gate (model-slots wave): chats cannot start until the user
		// has picked all three slots — the dock shows the CTA while the raw
		// record's models section lacks any slot pin.
		const record = readSettingsRecord();
		// GRAPH RENDERING (owner, 2026-10-06): off = the home's main view is
		// the chains view. Resolved through the one core resolver (missing
		// section / absent key → factory default on); re-read per navigation.
		return {
			configured: slotsConfigured(record?.models),
			rendering: resolveSettings(record ?? null).graph.rendering,
		};
	});
	return <Home initialConfigured={configured} rendering={rendering} />;
}
