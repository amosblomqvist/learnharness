/**
 * Session → Anki cards (owner, 2026-11-01): the recall cards the agent
 * wrote while it taught, as Basic cards, for Anki's TSV import. The cards
 * live in the `recall_cards` call arguments (the transcript already
 * persists them), so this is a pure scan of history — no LLM call, no
 * storage. Same shape as the markdown export: a pure engine (this file)
 * behind one download route.
 *
 * Limits, on purpose (v1): only successful `recall_cards` calls count, the
 * first card per front (case-insensitive) wins, LaTeX passes through unchanged (Anki needs
 * `\(…\)` delimiters), and math-heavy cards are the learner's problem on
 * import.
 */

import type { LhMessage } from "./native-messages.ts";
import { RECALL_CARDS_TOOL } from "./native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** One Basic note: front text, back text, space-separated Anki tags. */
export interface AnkiCard {
	front: string;
	back: string;
	tag: string;
}

/** One parsed card entry: a string front and back, both trimmed, both non-empty. */
function cardEntry(value: unknown): { front: string; back: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const { front, back } = value as { front?: unknown; back?: unknown };
	if (typeof front !== "string" || typeof back !== "string") return null;
	const trimmedFront = front.trim();
	const trimmedBack = back.trim();
	return trimmedFront.length > 0 && trimmedBack.length > 0 ? { front: trimmedFront, back: trimmedBack } : null;
}

/**
 * The session's recall cards, in message order. `tag` is stamped on every
 * card (the route passes the base tag plus the session slug). Only calls
 * whose result landed without error count: a bare or aborted call is no
 * evidence the cards were ever saved.
 */
export function ankiCards(messages: ReadonlyArray<LhMessage>, tag = "learnharness"): AnkiCard[] {
	const landed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (result.toolName !== RECALL_CARDS_TOOL || result.isError) continue;
		landed.add(result.toolCallId);
	}

	const cards: AnkiCard[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const block = part as { type?: string; name?: string; id?: string; arguments?: unknown };
			if (block.type !== "toolCall" || block.name !== RECALL_CARDS_TOOL) continue;
			if (typeof block.id !== "string" || !landed.has(block.id)) continue;
			const args = block.arguments as { cards?: unknown } | undefined;
			if (!Array.isArray(args?.cards)) continue;
			for (const raw of args.cards) {
				const entry = cardEntry(raw);
				if (entry === null) continue;
				const key = entry.front.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				cards.push({ ...entry, tag });
			}
		}
	}
	return cards;
}

/** One TSV field: HTML-escaped (the file declares `#html:true`), tabs and
 *  newlines flattened so a card can never break the row. Entities first —
 *  the `<br>` minted here must stay literal. */
function tsvField(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r\n?|\n/g, "<br>").replace(/\t/g, " ");
}

/** The Anki import file: three header lines, then `front<TAB>back<TAB>tags`. */
export function ankiTsv(cards: AnkiCard[]): string {
	const rows = cards.map((card) => `${tsvField(card.front)}\t${tsvField(card.back)}\t${card.tag}`);
	return ["#separator:tab", "#html:true", "#tags column:3", ...rows].join("\n");
}
