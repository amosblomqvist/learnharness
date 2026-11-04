/**
 * The artifacts surface under the UI language: the practice dock, the
 * conclusion card and the background-agents section render Spanish under
 * an `es` provider, and English with no provider mounted.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../components/i18n.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard } from "../components/practice-cards.tsx";
import { ActivitySection, type ActivityFeed } from "../components/activity-dock.tsx";

const dock = (
	<PracticeDock
		problemCallId="call_p1"
		input={{ statement: "Show that the sum is even." }}
		expanded={true}
		onExpand={() => {}}
		onSubmit={() => {}}
	/>
);

const conclude = (
	<ConcludeCard
		part={{
			type: "tool-conclude",
			state: "input-available",
			toolCallId: "call_c1",
			input: { outcome: "solvedWithHints", verdict: "Good." },
			reveal: "The sum of two odd numbers is even.",
		}}
	/>
);

const feed: ActivityFeed = {
	jobs: [
		{
			id: "j1",
			kind: "demo",
			chatId: "c1",
			toolCallId: "t1",
			status: "running",
			activity: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			title: "Chain-rule demo",
			contextLimit: null,
		},
	],
	extractions: [],
};
const activity = <ActivitySection feed={feed} />;

const es = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider initialLanguage="es">{node}</I18nProvider>);

describe("artifacts i18n", () => {
	it("renders Spanish under the es provider", () => {
		const dockHtml = es(dock);
		assert.ok(dockHtml.includes("TU RAZONAMIENTO"));
		assert.ok(dockHtml.includes('placeholder="Trabaja aquí, piensa en voz alta."'));
		assert.ok(dockHtml.includes("Enviar razonamiento"));

		const concludeHtml = es(conclude);
		assert.ok(concludeHtml.includes("Concluido"));
		assert.ok(concludeHtml.includes("Resuelto con pistas"));
		assert.ok(concludeHtml.includes("Solución modelo"));

		const activityHtml = es(activity);
		assert.ok(activityHtml.includes("Agentes en segundo plano"));
		assert.ok(activityHtml.includes("Creador de demos"));
		assert.ok(activityHtml.includes('title="Detener este proceso en segundo plano"'));
	});

	it("renders English without a provider", () => {
		const dockHtml = renderToStaticMarkup(dock);
		assert.ok(dockHtml.includes("YOUR THINKING"));
		assert.ok(dockHtml.includes("Submit thinking"));

		const concludeHtml = renderToStaticMarkup(conclude);
		assert.ok(concludeHtml.includes("Concluded"));
		assert.ok(concludeHtml.includes("Solved with hints"));

		const activityHtml = renderToStaticMarkup(activity);
		assert.ok(activityHtml.includes("Background agents"));
		assert.ok(activityHtml.includes("Demo builder"));
	});
});
