import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { ChatOpening } from "@/components/chat-opening";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, getChatOpening, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

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
	if ("partial" in chat && chat.partial) {
		return <ChatOpening key={id} chatId={id} title={chat.title} recent={chat.messages} initialConfigured={initialConfigured} />;
	}
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// The record is native agent history; the client derives its view.
			initialMessages={chat.messages}
			initialError={turnFailure(chat.id)}
			initialConfigured={initialConfigured}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={initiallyInFlight}
			initiallyCompacting={initiallyCompacting}
		/>
	);
}
