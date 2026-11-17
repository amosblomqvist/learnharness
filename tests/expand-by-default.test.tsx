import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { DEFAULT_THEME, FACTORY_SETTINGS, resolveSettings, sanitizeUserSettings, type AppearanceSettings, type QuestionAnswerData } from "../src/core/index.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { AppearanceProvider, resolveAppearance, useAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ThinkingBlock } from "../components/thinking-block.tsx";

(globalThis as Record<string, unknown>).React = React;

const FACTORY = { userThinking: true, why: false, agentThinking: false };

it("factory: your thinking expanded, Why and agent thinking collapsed, on both resolution paths", () => {
	assert.deepEqual(FACTORY_SETTINGS.appearance.expandByDefault, FACTORY);
	for (const appearance of [undefined, {}, { proseFontSize: 20 }, { expandByDefault: {} }]) {
		assert.deepEqual(resolveSettings({ version: 1, appearance }).appearance.expandByDefault, FACTORY);
		assert.deepEqual(resolveAppearance(appearance).expandByDefault, FACTORY);
	}
	assert.deepEqual(resolveSettings(null).appearance.expandByDefault, FACTORY);
});

it("each stored kind overrides only itself", () => {
	const appearance = { expandByDefault: { why: true } };
	const expected = { userThinking: true, why: true, agentThinking: false };
	assert.deepEqual(resolveSettings({ version: 1, appearance }).appearance.expandByDefault, expected);
	assert.deepEqual(resolveAppearance(appearance).expandByDefault, expected);
	const all = { userThinking: false, why: true, agentThinking: true };
	assert.deepEqual(resolveSettings({ version: 1, appearance: { expandByDefault: all } }).appearance.expandByDefault, all);
});

it("the sanitizer keeps known kinds with boolean values and drops everything else", () => {
	const record = sanitizeUserSettings({
		version: 1,
		appearance: { proseFontSize: 20, expandByDefault: { why: true, agentThinking: "yes", userThinking: null, planThinking: true } },
	});
	assert.deepEqual(record?.appearance, { proseFontSize: 20, expandByDefault: { why: true } });
	assert.deepEqual(resolveSettings(record).appearance.expandByDefault, { userThinking: true, why: true, agentThinking: false });
	for (const expandByDefault of [null, true, "why", ["why"]]) {
		const dropped = sanitizeUserSettings({ version: 1, appearance: { proseFontSize: 20, expandByDefault } });
		assert.deepEqual(dropped?.appearance, { proseFontSize: 20 }, JSON.stringify(expandByDefault));
	}
});

it("the appearance PUT accepts per-kind booleans and rejects unknown kinds and non-booleans", () => {
	const body = { fontFamily: "Georgia", expandByDefault: { userThinking: false, why: true, agentThinking: true } };
	const parsed = parseAppearanceSettingsBody(body);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.settings, body);
	for (const expandByDefault of [null, true, [], { planThinking: true }, { why: "true" }, { why: null }]) {
		assert.equal(parseAppearanceSettingsBody({ expandByDefault }).ok, false, JSON.stringify(expandByDefault));
	}
});

it("Start expanded: three switches that write the appearance section and apply live to mounted blocks", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => Response.json({ themes: [DEFAULT_THEME] }),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const writes: AppearanceSettings[] = [];
	function Panel() {
		const { delta, onAppearanceChange } = useAppearance();
		return <AppearanceSection appearance={delta} onSectionChange={next => { writes.push(next); onAppearanceChange(next); return true; }} />;
	}
	const answer = {
		kind: "quiz", questionText: "Which planet is closest to the Sun?",
		options: [{ index: 0, label: "Mercury" }], answers: [{ index: 0, label: "Mercury", value: "Mercury" }],
		correct: true, explanation: "Innermost orbit.", dontKnow: false, answeredAt: "2026-11-16T00:00:00.000Z",
	} as QuestionAnswerData;
	const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
	const rowLabels = () => [...document.querySelectorAll('[data-testid^="row-expand-"]')].map(row => row.querySelector("span span")?.textContent);
	try {
		await act(async () => root.render(
			<InteractionLayersProvider><AppearanceProvider initialAppearance={{ proseFontSize: 20 }} initialTheme={DEFAULT_THEME}>
				<Panel /><ThinkingBlock testId="thinking" text="my thought" /><AnsweredCard answer={answer} />
			</AppearanceProvider></InteractionLayersProvider>,
		));
		assert.ok(document.body.textContent?.includes("Start expanded"));
		assert.deepEqual(rowLabels(), ["Your thinking", "Why explanations", "Agent thinking"]);
		assert.deepEqual(["Your thinking", "Why explanations", "Agent thinking"].map(label => toggle(label).getAttribute("aria-checked")), ["true", "false", "false"]);
		assert.ok(!document.body.textContent?.includes("Innermost orbit."));

		await act(async () => toggle("Why explanations").click());
		assert.deepEqual(writes.at(-1), { proseFontSize: 20, expandByDefault: { why: true } });
		assert.equal(toggle("Why explanations").getAttribute("aria-checked"), "true");
		assert.ok(document.body.textContent?.includes("Innermost orbit."), "the mounted card's Why opens live");

		await act(async () => toggle("Your thinking").click());
		assert.deepEqual(writes.at(-1), { proseFontSize: 20, expandByDefault: { why: true, userThinking: false } });
		assert.equal(document.querySelector('[data-testid="thinking-trigger"]')?.getAttribute("aria-expanded"), "false", "the mounted row collapses live");
		assert.ok(document.body.textContent?.includes("Innermost orbit."), "the other kind is untouched");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
