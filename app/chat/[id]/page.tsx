import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { CLAUDE_CODE_PROVIDER, cliContextWindowOf, coverageBasisOf, measuredContextTokens, resolveSettings, sessionCacheHitRate, sideChatHistoryIds, slotsConfigured } from "@/src/core";
import { catalogEntryForSelection, catalogProviders, compactionInFlight, getChat, getChatOpening, isTurnRunning, readSettingsRecord, sessionCost, sessionCoverage, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const initiallyInFlight = isTurnRunning(id);
	const initiallyCompacting = compactionInFlight(id);
	const chat = prompt || initiallyInFlight || initiallyCompacting ? getChat(id) : getChatOpening(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	const initialConfigured = slotsConfigured(record?.models);
	const providers = catalogProviders();
	const initialZeroKeys = !providers.some(provider => provider.keyPresent);
	const strong = record?.models?.strong;
	const selection = chat.settings?.model ?? strong?.model;
	const { turnCosts: _turnCosts, ...pricing } = sessionCost(chat);
	const opening = "partial" in chat && chat.partial ? chat : undefined;
	const graph = resolveSettings(record).graph;
	const coverage = chat.kind !== "practice" && graph.enabled
		? sessionCoverage(chat.id, opening?.coverageBasis ?? coverageBasisOf(chat.messages))
		: null;
	const usage = opening?.dockUsage ?? {
		contextTokens: measuredContextTokens(chat.messages), cliContextWindow: cliContextWindowOf(chat.messages),
	};
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// The record is native agent history; the client derives its view.
			initialMessages={chat.messages}
			openingLayout={opening?.openingLayout}
			openingPresentation={opening?.presentation}
			initialSideHistoryIds={opening?.presentation.sideHistoryIds ?? sideChatHistoryIds("sideChats" in chat ? chat.sideChats : undefined)}
			initialCoverage={coverage}
			initialGraph={{ enabled: graph.enabled, chunkTokens: graph.extractionChunkTokens }}
			initialError={turnFailure(chat.id)}
			initialConfigured={initialConfigured}
			initialZeroKeys={initialZeroKeys}
			initialDock={{
				...usage,
				model: { settings: chat.settings, strong, entry: selection && catalogEntryForSelection(selection, providers) },
				pricing, turnCount: chat.turns?.length ?? 0,
				cacheHitRate: sessionCacheHitRate(chat),
				cliBilled: chat.turns?.some(turn => turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) ?? false,
			}}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={initiallyInFlight}
			initiallyCompacting={initiallyCompacting}
		/>
	);
}
