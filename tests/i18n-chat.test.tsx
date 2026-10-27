/**
 * Spanish chat shell — the session row and the abort dialog render their
 * Spanish copy inside an es LocaleProvider and stay English without one.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, type ChatListItem } from "../src/core/index.ts";
import { LocaleProvider } from "../components/locale.tsx";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
import { AbortTurnBody } from "../components/abort-turn-dialog.tsx";

const chat: ChatListItem = {
	id: "c1",
	title: "Test session",
	kind: "practice",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: new Date().toISOString(),
	messageCount: 4,
	phase: "probe",
	pendingQuestion: true,
	pendingProblem: false,
	busy: false,
	compacting: false,
};

const es = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="es">{node}</LocaleProvider>);

describe("Spanish chat shell", () => {
	it("translates the session row's meta line and practice label", () => {
		const row = <SessionRow chat={chat} active={false} onOpen={() => {}} />;
		const spanish = es(row);
		assert.ok(spanish.includes("Esperando entrada · ahora mismo"));
		assert.ok(spanish.includes('aria-label="Sesión de práctica"'));
		const english = renderToStaticMarkup(row);
		assert.ok(english.includes("Waiting for input · just now"));
		assert.ok(english.includes('aria-label="Practice session"'));
	});

	it("translates the abort dialog's copy and actions", () => {
		const body = <AbortTurnBody mode="question" busy onClose={() => {}} onConfirm={() => {}} />;
		const spanish = es(body);
		assert.ok(spanish.includes("¿Descartar esta pregunta?"));
		assert.ok(spanish.includes("Se omite — el profesor continúa sin ella. El turno en curso también se detiene."));
		assert.ok(spanish.includes(">Cancelar<"));
		const english = renderToStaticMarkup(body);
		assert.ok(english.includes("Skipped — the teacher moves on without it. The working turn stops too."));
		assert.ok(english.includes(">Cancel<"));
	});

	it("timeAgo stays English by default and takes a translator", () => {
		const now = new Date("2026-01-02T12:00:00.000Z");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now, (text, vars) => translate("es", text, vars)), "hace 5 min");
	});
});
