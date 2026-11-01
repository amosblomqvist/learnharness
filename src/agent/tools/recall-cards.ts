/**
 * RECALL CARDS (owner, 2026-11-01): the agent writes the learner's Anki
 * cards while it teaches. The cards ride THIS call's arguments, like
 * `probe_done`'s payload and `problem`'s modelSolution — the transcript
 * already persists them, so the export route is a pure scan of history
 * (core/anki-cards.ts). No storage, no export-time model call.
 *
 * Mechanics-only description (the practice.ts doctrine ruling): what to
 * pass and what happens. What deserves a card lives in the prompts.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { RECALL_CARDS_TOOL } from "../../core/native-messages.ts";
import { serverExecute } from "../tool-execute.ts";

const recallCardsInput = Type.Object({
	cards: Type.Array(
		Type.Object({
			front: Type.String({
				minLength: 1,
				pattern: "\\S",
				description:
					"REQUIRED — a closed question with one right answer, readable with no other context (plain text; LaTeX allowed). Never 'explain…' or 'why…'.",
			}),
			back: Type.String({
				minLength: 1,
				pattern: "\\S",
				description:
					"REQUIRED — the short answer: a word, a term, a formula, a rule, a number, or one short sentence. No explanation.",
			}),
		}),
		{ minItems: 1, maxItems: 8, description: "REQUIRED — 1 to 8 cards. One fact per card." },
	),
});

export const recallCardsTool: AgentTool<typeof recallCardsInput> = {
	name: RECALL_CARDS_TOOL,
	label: RECALL_CARDS_TOOL,
	description:
		"Save recall cards for the learner's Anki export. Each card is one fact: a closed question on the front, a short answer on the back. " +
		"The cards ride this call's arguments and are collected when he exports the session. " +
		"The call does not pause or end your turn and shows him nothing new — it is a quiet bookkeeping step. " +
		"Up to 8 cards per call.",
	parameters: recallCardsInput,
	executionMode: "sequential",
	execute: serverExecute(RECALL_CARDS_TOOL, recallCardsInput, ({ cards }) => `Saved ${cards.length} recall card(s).`),
};
