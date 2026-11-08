/**
 * NOTE REWRITE: the smallest fix of a reviewed highlight. One tool-less
 * model call over the review thread; the reply is returned to the client,
 * which applies it. The server never edits `notes` or `messages`.
 */

import type { ChatRecord } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { newMessageId } from "../core/native-messages.ts";
import { cleanReplacement, noteRewriteModelTurns } from "../core/note-review.ts";
import { sideChatLessonDocument } from "../core/side-chat.ts";
import type { PiEngine } from "../agent/models.ts";
import { streamSideAnswer } from "../agent/side-chat.ts";
import { composeNoteRewriteInstructions } from "../agent/note-review.ts";
import { stores } from "./stores.ts";
import { productionEngineFor } from "./side-chat.ts";

export interface NoteRewriteDeps {
	chatStore: ChatStore;
	engineFor: (record: ChatRecord) => Promise<PiEngine | Response>;
	instructions: () => string;
}

export interface NoteRewriter {
	rewrite(chatId: string, threadId: string, signal?: AbortSignal): Promise<Response>;
}

export function createNoteRewriter(deps: NoteRewriteDeps): NoteRewriter {
	async function rewrite(chatId: string, threadId: string, signal?: AbortSignal): Promise<Response> {
		const record = deps.chatStore.getChat(chatId);
		const thread = record?.sideChats?.find((t) => t.id === threadId);
		if (!record || !thread) return Response.json({ error: "Unknown chat or side thread" }, { status: 404 });
		if (!thread.review) return Response.json({ error: "Only a note review can rewrite a note" }, { status: 400 });
		const last = thread.messages.at(-1);
		if (last?.role !== "assistant" || last.error !== undefined) {
			return Response.json({ error: "Wait for the review to finish" }, { status: 409 });
		}

		const engineOrRefusal = await deps.engineFor(record);
		if (engineOrRefusal instanceof Response) return engineOrRefusal;
		const engine = engineOrRefusal;

		const result = await streamSideAnswer({
			engine,
			instructions: deps.instructions(),
			turns: noteRewriteModelTurns(thread, sideChatLessonDocument(record.messages), record.notes ?? ""),
			signal,
		});
		if (result.usage) {
			const modelId = `${engine.model.provider}:${engine.model.id}`;
			try {
				deps.chatStore.appendTurnUsage(chatId, {
					id: crypto.randomUUID(),
					messageId: newMessageId(),
					at: new Date().toISOString(),
					model: modelId,
					steps: [
						{
							inputTokens: result.usage.input,
							outputTokens: result.usage.output,
							cacheReadTokens: result.usage.cacheRead,
							cacheWriteTokens: result.usage.cacheWrite,
							cacheWrite1hTokens: result.usage.cacheWrite1h ?? 0,
							reasoningTokens: result.usage.reasoning ?? 0,
						},
					],
				});
			} catch {
				/* the session was deleted mid-call — nothing to bill against */
			}
		}
		if (result.outcome === "done" && result.stopReason === "length") {
			return Response.json({ error: "The rewrite was cut off before it finished." }, { status: 502 });
		}
		const replacement = result.outcome === "done" ? cleanReplacement(result.text, thread.review.highlight) : "";
		if (!replacement) {
			return Response.json({ error: result.errorMessage ?? "The rewrite failed." }, { status: 502 });
		}
		return Response.json({ replacement });
	}

	return { rewrite };
}

export const noteRewriter: NoteRewriter = createNoteRewriter({
	chatStore: stores.chatStore,
	engineFor: productionEngineFor,
	instructions: composeNoteRewriteInstructions,
});
