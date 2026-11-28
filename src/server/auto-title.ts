/**
 * AI session titles (2026-11). A session starts titled by its first
 * prompt line; after the first reply the cheap-slot model names it, and
 * once the probe concludes (the goal is known) it names it again from the
 * goal. A title the learner set by hand is final: the store refuses an
 * automatic rename over a user one (re-checked at write time, so a rename
 * made while the model was thinking still wins).
 *
 * Fire-and-forget after turn settle; any failure keeps the current title.
 * ponytail: the title call's usage is not recorded (a few hundred tokens);
 * add it to the usage log if the cost needs to show.
 */

import { randomUUID } from "node:crypto";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../agent/models.ts";
import { CLAUDE_CODE_PROVIDER } from "../agent/claude-code/constants.ts";
import type { ChatRecord, ChatTitleSource } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { probeDoneResultIds, userFacingTextOf, type LhMessage } from "../core/native-messages.ts";
import { tr } from "../core/i18n.ts";

export interface AutoTitleDeps {
	chatStore: Pick<ChatStore, "getChat" | "renameChat">;
	/** The cheap-slot engine, resolved fresh; undefined = not configured / not allowed. */
	engine: () => PiEngine | undefined;
}

const INSTRUCTIONS = () => tr(
	"你为一次学习会话起标题。只输出标题本身：不超过 16 个汉字，点明要学的主题，不加引号、书名号或句末标点，不要“学习”“会话”“关于”这类空词。",
	"You name a learning session. Output only the title: at most 6 words, naming the subject being learned — no quotes, no trailing punctuation, no filler like \"Learning\" or \"Session about\".",
);

/** Which rename (if any) this record is due for. */
export function titleStageDue(record: Pick<ChatRecord, "messages" | "titleSource" | "title">): "auto" | "goal" | null {
	if (record.titleSource === "user" || record.titleSource === "goal") return null;
	// Records from before titleSource existed: a title that is no longer the
	// creation default was set by hand — leave it.
	if (record.titleSource === undefined && !isDefaultTitle(record)) return null;
	if (goalOf(record.messages)) return "goal";
	if (record.titleSource === "auto") return null;
	const replied = record.messages.some((m) => m.role === "assistant" && userFacingTextOf((m as { content?: unknown }).content).length > 0);
	return replied ? "auto" : null;
}

/** Still the creation default: the first prompt's line, or the empty-prompt floor. */
function isDefaultTitle(record: Pick<ChatRecord, "messages" | "title">): boolean {
	if (record.title === "未命名会话" || record.title === "Untitled session") return true;
	const first = record.messages.find((m) => m.role === "user");
	const text = first ? userFacingTextOf((first as { content?: unknown }).content).join("\n") : "";
	return text.trim() !== "" && titleFromPrompt(text) === record.title;
}

/** The concluded probe's goal: its summary plus the strand names. */
export function goalOf(messages: readonly LhMessage[]): string | null {
	if (probeDoneResultIds(messages).size === 0) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		for (const block of m.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.name !== "probe_done") continue;
			const a = (block.arguments as { assessment?: { summary?: unknown; strands?: Array<{ strand?: unknown }> } } | undefined)?.assessment;
			const strands = (a?.strands ?? []).map((s) => s.strand).filter((s): s is string => typeof s === "string");
			const summary = typeof a?.summary === "string" ? a.summary : "";
			const text = [summary, strands.length ? `Strands: ${strands.join("; ")}` : ""].filter(Boolean).join("\n");
			if (text) return text;
		}
	}
	return null;
}

/** What the learner asked for: the first user-visible messages. */
function openingOf(messages: readonly LhMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === "user" || m.role === "custom") parts.push(...userFacingTextOf((m as { content?: unknown }).content));
		if (parts.join("\n").length > 1500) break;
		if (m.role === "assistant") break;
	}
	return parts.join("\n").slice(0, 1500);
}

/** One model line → a clean title, or null when unusable. */
export function cleanTitle(raw: string): string | null {
	const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	const t = line.replace(/^(标题|title)\s*[:：]\s*/i, "").replace(/^["'“”‘’《「『]+|["'“”‘’》」』。.!！?？]+$/g, "").trim();
	return t ? titleFromPrompt(t) : null;
}

export function createAutoTitler(deps: AutoTitleDeps) {
	const inFlight = new Set<string>();
	return async function maybeAutoTitle(chatId: string): Promise<void> {
		if (inFlight.has(chatId)) return;
		const record = deps.chatStore.getChat(chatId);
		const stage = record ? titleStageDue(record) : null;
		if (!record || !stage) return;
		const engine = deps.engine();
		if (!engine) return;
		inFlight.add(chatId);
		try {
			const goal = stage === "goal" ? goalOf(record.messages) : null;
			const input = [`Learner's opening:\n${openingOf(record.messages)}`, goal ? `Agreed goal:\n${goal}` : ""].filter(Boolean).join("\n\n");
			const sessionId = engine.model.provider === CLAUDE_CODE_PROVIDER ? undefined : randomUUID();
			const stream = engine.streamFn(engine.model, normalizeContext({
				systemPrompt: INSTRUCTIONS(),
				messages: [{ role: "user", content: input, timestamp: Date.now() }],
				tools: [],
			}), { signal: AbortSignal.timeout(90_000), ...(sessionId ? { sessionId } : {}) });
			let final: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") final = event.message;
				else if (event.type === "error") throw new Error(event.error.errorMessage ?? event.reason);
			}
			const text = final?.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("") ?? "";
			const title = cleanTitle(text);
			if (title) deps.chatStore.renameChat(chatId, title, stage satisfies ChatTitleSource);
		} catch (err) {
			console.error(`[chat ${chatId}] auto title failed:`, err instanceof Error ? err.message : err);
		} finally {
			inFlight.delete(chatId);
		}
	};
}
