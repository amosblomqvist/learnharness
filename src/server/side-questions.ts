/** Delivery of already-frozen raw context snapshots. Only a still-unresolved
 * native tool batch can delay insertion: helper generation never does. There
 * is no volatile close queue and no delivery of post-cutoff side activity. */
import type { ChatStore } from "../core/ports.ts";
import { sideConversationEntries } from "../core/side-chat.ts";
import { hasUnresolvedQuestion } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";

export function flushSideContextSnapshots(chatStore: ChatStore, chatId: string): void {
	const record = chatStore.getChat(chatId);
	if (!record || hasUnresolvedQuestion(record.messages)) return;
	const entries = sideConversationEntries(record);
	if (!entries.length) return;
	chatStore.saveMessages(chatId, [...record.messages, ...entries]);
	emit("record-changed", { chatId });
}
