import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";
import { withUserScope } from "@/src/server/auth/context.ts";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	// Every read below is account-scoped: pages never pass through withUser,
	// and an unscoped read sees the empty base root (404 on a live chat).
	const view = await withUserScope(() => {
		const chat = getChat(id);
		return {
			chat,
			record: chat ? readSettingsRecord() : null,
			failure: chat ? turnFailure(chat.id) : undefined,
			running: chat ? isTurnRunning(chat.id) : false,
			compacting: chat ? compactionInFlight(chat.id) : false,
		};
	});
	const { chat, record, failure, running, compacting } = view;
	if (!chat) notFound();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={failure}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={running}
			initiallyCompacting={compacting}
		/>
	);
}
