/**
 * The chat surface in Spanish: the transcript's chrome (phase chip and
 * dividers, compaction dividers, the reading-thinking field, thinking rows,
 * the mermaid fallback, empty state, spinner) renders the provider's
 * language, and English with no provider. The session model's own error
 * copy follows its language; server text stays raw.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../components/i18n.tsx";
import { PhaseChip, PhaseDivider } from "../components/phase-divider.tsx";
import { CompactionCutDivider, CompactionMomentDivider, type CompactionDividerData } from "../components/compaction-divider.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { MermaidError } from "../components/mermaid-error.tsx";
import { ConversationEmptyState } from "../components/ai-elements/conversation.tsx";
import { BrailleSpinner } from "../components/braille-spinner.tsx";
import { SessionModel } from "../components/session-core.ts";

const compaction: CompactionDividerData = {
	content: "[SESSION HISTORY COMPACTED]",
	details: { firstKeptMessageId: "kept_1", tokensBefore: 152000, at: "2026-10-05T00:00:00.000Z" },
};

function Transcript() {
	return (
		<>
			<PhaseChip phase="teach" />
			<PhaseDivider phase="plan" nodeCount={4} />
			<PhaseDivider phase="plan" nodeCount={1} />
			<CompactionMomentDivider data={compaction} />
			<CompactionCutDivider data={compaction} />
			<ReadingThinkingField value="" onChange={() => {}} claim={false} />
			<ThinkingBlock text="hmm" />
			<MermaidError chart="graph TD" error="parse error" retry={() => {}} />
			<ConversationEmptyState />
			<BrailleSpinner />
		</>
	);
}

describe("chat surface i18n", () => {
	it("renders Spanish under the Spanish provider", () => {
		const html = renderToStaticMarkup(
			<I18nProvider initialLanguage="es">
				<Transcript />
			</I18nProvider>,
		);
		assert.ok(html.includes(">Enseñando<"));
		assert.ok(html.includes("Plan · 4 nodos"));
		assert.ok(html.includes("Plan · 1 nodo<"));
		assert.ok(html.includes("Contexto compactado"));
		assert.ok(html.includes("Historial compactado · 152k tok"));
		assert.ok(html.includes("Pensando mientras lees"));
		assert.ok(html.includes('placeholder="Lo que se te ocurra mientras lees."'));
		assert.ok(html.includes("TU RAZONAMIENTO"));
		assert.ok(html.includes("No se pudo renderizar el diagrama"));
		assert.ok(html.includes(">Reintentar<"));
		assert.ok(html.includes("Aún no hay mensajes"));
		assert.ok(html.includes('aria-label="Trabajando"'));
	});

	it("renders English without a provider", () => {
		const html = renderToStaticMarkup(<Transcript />);
		assert.ok(html.includes(">Teaching<"));
		assert.ok(html.includes("Plan · 4 nodes"));
		assert.ok(html.includes("Plan · 1 node<"));
		assert.ok(html.includes("History compacted · 152k tok"));
		assert.ok(html.includes("Thinking while reading"));
		assert.ok(html.includes("YOUR THINKING"));
		assert.ok(html.includes("Diagram failed to render"));
		assert.ok(html.includes("No messages yet"));
		assert.ok(html.includes('aria-label="Working"'));
	});
});

describe("session model error copy", () => {
	const refused = () =>
		new SessionModel({
			chatId: "chat_x",
			initialMessages: [],
			fetch: (async () => new Response("", { status: 409 })) as typeof globalThis.fetch,
			waitMaxMs: 0,
		});

	it("follows the model's language", async () => {
		const m = refused();
		m.language = "es";
		await m.send({ type: "text", text: "hola" });
		assert.equal(m.getState().error?.message, "Ya hay un turno en curso — inténtalo de nuevo en un momento.");
	});

	it("defaults to English", async () => {
		const m = refused();
		await m.send({ type: "text", text: "hi" });
		assert.equal(m.getState().error?.message, "A turn is already running — try again in a moment.");
	});
});
