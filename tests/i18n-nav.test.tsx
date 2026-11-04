/**
 * The nav surface in Spanish: the sidebar row, the minimal home's summary
 * and the zero-keys pill render the provider's language, and English
 * without a provider. Every keyboard action has a translated label.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KEYBOARD_ACTIONS, translate, type ChatListItem } from "../src/core/index.ts";
import { I18nProvider } from "../components/i18n.tsx";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
import { KnowledgeSummary } from "../components/minimal-home.tsx";
import { ZeroKeysPill } from "../components/setup-cta.tsx";
import { shortcutLabelKey } from "../components/keyboard-shortcuts.tsx";

const chat: ChatListItem = {
	id: "c1",
	title: "Derivadas parciales",
	kind: "practice",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	messageCount: 4,
	phase: "probe",
	pendingQuestion: true,
	pendingProblem: false,
	busy: false,
	compacting: false,
};

function surfaces() {
	return (
		<>
			<SessionRow chat={chat} active={false} onOpen={() => {}} />
			<KnowledgeSummary propositions={1} chains={5} teachSessions={0} practiceSessions={0} importedNotes={0} />
			<ZeroKeysPill inline onOpen={() => {}} />
		</>
	);
}

describe("nav surface — Spanish", () => {
	it("renders the provider's language", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLanguage="es">{surfaces()}</I18nProvider>);
		assert.ok(html.includes("Esperando tu respuesta · "));
		assert.ok(html.includes('aria-label="Sesión de práctica"'));
		assert.ok(html.includes("1 proposición"));
		assert.ok(html.includes("5 cadenas"));
		assert.ok(html.includes(">Agrega una clave de proveedor<"));
		assert.ok(!html.includes("Waiting for input"));
	});

	it("renders English without a provider", () => {
		const html = renderToStaticMarkup(surfaces());
		assert.ok(html.includes("Waiting for input · "));
		assert.ok(html.includes('aria-label="Practice session"'));
		assert.ok(html.includes("1 proposition"));
		assert.ok(html.includes("5 chains"));
		assert.ok(html.includes(">Add a provider key<"));
	});

	it("timeAgo takes a translator and defaults to English", () => {
		const now = new Date("2026-01-02T12:00:00.000Z");
		const es = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("es", key, vars);
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now, es), "hace 5 min");
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now, es), "justo ahora");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
	});

	it("every keyboard action has a nav.kbd label matching the registry's English", () => {
		for (const action of KEYBOARD_ACTIONS) {
			assert.equal(translate("en", shortcutLabelKey(action.id)), action.label, action.id);
			assert.notEqual(translate("es", shortcutLabelKey(action.id)), action.label, `${action.id} is translated`);
		}
	});
});
