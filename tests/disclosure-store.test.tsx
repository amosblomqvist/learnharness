import React, { act } from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_THEME, type AppearanceSettings, type DisclosureKind, type QuestionAnswerData } from "../src/core/index.ts";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { toggleAllDisclosures } from "../components/disclosure-store.ts";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../components/ai-elements/reasoning.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => Response.json({ themes: [DEFAULT_THEME] }),
	getComputedStyle: () => ({ animationName: "none", getPropertyValue: () => "" }),
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
});

type ExpandByDefault = AppearanceSettings["expandByDefault"];

const quizAnswer = (explanation: string) => ({
	kind: "quiz", questionText: "Which planet is closest to the Sun?",
	options: [{ index: 0, label: "Mercury" }, { index: 1, label: "Venus" }],
	answers: [{ index: 0, label: "Mercury", value: "Mercury" }],
	correct: true, explanation, dontKnow: false, answeredAt: "2026-11-16T00:00:00.000Z",
}) as QuestionAnswerData;

function ssr(expandByDefault: ExpandByDefault, node: React.ReactNode) {
	return renderToStaticMarkup(
		<AppearanceProvider initialAppearance={expandByDefault && { expandByDefault }} initialTheme={DEFAULT_THEME}>{node}</AppearanceProvider>,
	);
}

let live!: ReturnType<typeof useAppearance>;
function Probe() {
	live = useAppearance();
	return null;
}

async function mount(expandByDefault: ExpandByDefault, node: React.ReactNode) {
	const { createRoot } = await import("react-dom/client");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = (next: React.ReactNode) => act(async () => root.render(
		<AppearanceProvider initialAppearance={{ expandByDefault }} initialTheme={DEFAULT_THEME}><Probe />{next}</AppearanceProvider>,
	));
	await render(node);
	return {
		host,
		render,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const keyboardToggle = (kind: DisclosureKind) =>
	act(async () => toggleAllDisclosures(kind, live.appearance.expandByDefault[kind]));

const setExpandByDefault = (expandByDefault: ExpandByDefault) =>
	act(async () => live.onAppearanceChange({ expandByDefault }));

describe("blocks start at their Start expanded setting", () => {
	it("your thinking: one rule for transcript and in-card rows; factory expanded", () => {
		for (const [setting, open] of [[undefined, true], [{ userThinking: true }, true], [{ userThinking: false }, false]] as const) {
			for (const inCard of [false, true]) {
				const html = ssr(setting, <ThinkingBlock text="my thought" inCard={inCard} />);
				assert.ok(html.includes(`aria-expanded="${open}"`), `${JSON.stringify(setting)} inCard=${inCard}`);
				assert.equal(html.includes("my thought"), open);
			}
		}
	});

	it("Why: factory collapsed, open when the setting says so", () => {
		for (const [setting, open] of [[undefined, false], [{ why: false }, false], [{ why: true }, true]] as const) {
			const html = ssr(setting, <AnsweredCard answer={quizAnswer("Mercury orbits innermost.")} />);
			assert.equal(html.includes("Mercury orbits innermost."), open, JSON.stringify(setting));
			assert.equal(html.includes("Hide why"), open);
		}
	});

	it("agent thinking: factory collapsed, open when the setting says so", () => {
		for (const [setting, open] of [[undefined, false], [{ agentThinking: false }, false], [{ agentThinking: true }, true]] as const) {
			const html = ssr(setting, <Reasoning><ReasoningTrigger /><ReasoningContent>The agent weighs it.</ReasoningContent></Reasoning>);
			assert.ok(html.includes(`aria-expanded="${open}"`), JSON.stringify(setting));
			assert.equal(html.includes("The agent weighs it."), open);
		}
	});
});

describe("keyboard toggles and setting changes", () => {
	it("a toggle sets every row for this page load; a setting change takes over again", async () => {
		const rows = (count: number) => Array.from({ length: count }, (_, i) => (
			<ThinkingBlock key={i} testId={`t${i}`} text={`thought ${i}`} inCard={i % 2 === 1} />
		));
		const view = await mount({ userThinking: false }, rows(2));
		const open = () => [...view.host.querySelectorAll('[data-testid$="-trigger"]')].map((b) => b.getAttribute("aria-expanded") === "true");
		const click = (i: number) => act(async () => view.host.querySelector<HTMLButtonElement>(`[data-testid="t${i}-trigger"]`)!.click());
		try {
			assert.deepEqual(open(), [false, false], "both placements start at the setting");
			await click(0);
			assert.deepEqual(open(), [true, false], "a click toggles one row");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [true, true], "the first press flips from the setting");
			await view.render(rows(3));
			assert.deepEqual(open(), [true, true, true], "a late mount honors the keyboard set over the setting");
			assert.ok(ssr({ userThinking: false }, <ThinkingBlock text="late" />).includes('aria-expanded="true"'), "from its first render, before any effect");
			await click(1);
			assert.deepEqual(open(), [true, false, true], "a click still toggles one row after a keyboard set");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [false, false, false], "the next press flips from the last keyboard set");
			await setExpandByDefault({ userThinking: true });
			assert.deepEqual(open(), [true, true, true], "a setting change applies to every mounted row");
			await view.render(rows(4));
			assert.deepEqual(open(), [true, true, true, true], "the setting change cleared the keyboard set for later mounts");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [false, false, false, false], "the next press flips from the new setting");
			await setExpandByDefault({ userThinking: true, why: true });
			assert.deepEqual(open(), [false, false, false, false], "another kind's setting change leaves these rows alone");
		} finally {
			await view.unmount();
		}
	});

	it("Toggle all Why opens every card; each card's own Why button still works", async () => {
		const cards = (count: number) => Array.from({ length: count }, (_, i) => <AnsweredCard key={i} answer={quizAnswer(`Reason ${i}.`)} />);
		const view = await mount({ why: false }, cards(2));
		const shown = () => [...view.host.querySelectorAll('[data-testid="tucked-explanation"]')].map((card) => card.textContent?.includes("Why: ") ?? false);
		const click = (i: number) => act(async () => view.host.querySelectorAll<HTMLButtonElement>('[data-testid="tucked-explanation"] > button')[i]!.click());
		try {
			assert.deepEqual(shown(), [false, false]);
			await click(1);
			assert.deepEqual(shown(), [false, true]);
			await keyboardToggle("why");
			assert.deepEqual(shown(), [true, true]);
			await click(0);
			assert.deepEqual(shown(), [false, true]);
			await keyboardToggle("why");
			assert.deepEqual(shown(), [false, false]);
			await keyboardToggle("why");
			await view.render(cards(3));
			assert.deepEqual(shown(), [true, true, true], "a late card honors the keyboard set");
		} finally {
			await view.unmount();
		}
	});

	it("Toggle all agent thinking opens every block; each block's own trigger still works", async () => {
		const blocks = (count: number) => Array.from({ length: count }, (_, i) => (
			<Reasoning key={i}><ReasoningTrigger data-testid={`r${i}`} /><ReasoningContent>{`step ${i}`}</ReasoningContent></Reasoning>
		));
		const view = await mount({ agentThinking: false }, blocks(2));
		const open = () => [0, 1].map((i) => view.host.querySelector(`[data-testid="r${i}"]`)!.getAttribute("aria-expanded") === "true");
		try {
			assert.deepEqual(open(), [false, false]);
			await keyboardToggle("agentThinking");
			assert.deepEqual(open(), [true, true]);
			await act(async () => view.host.querySelector<HTMLButtonElement>('[data-testid="r0"]')!.click());
			assert.deepEqual(open(), [false, true]);
		} finally {
			await view.unmount();
		}
	});
});

describe("agent thinking after its stream ends", () => {
	const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 1300)));
	const streamed = async (agentThinking: boolean) => {
		const block = (isStreaming: boolean) => (
			<Reasoning isStreaming={isStreaming}><ReasoningTrigger data-testid="streamed" /><ReasoningContent>streamed</ReasoningContent></Reasoning>
		);
		const view = await mount({ agentThinking }, block(true));
		const trigger = () => view.host.querySelector<HTMLButtonElement>('[data-testid="streamed"]')!;
		if (trigger().getAttribute("aria-expanded") !== "true") await act(async () => trigger().click());
		assert.equal(trigger().getAttribute("aria-expanded"), "true", "open while streaming");
		await view.render(block(false));
		await settled();
		const stayedOpen = trigger().getAttribute("aria-expanded") === "true";
		await view.unmount();
		return stayedOpen;
	};

	it("setting on: the block stays open", async () => {
		assert.equal(await streamed(true), true);
	});

	it("setting off: a block the learner opened still collapses", async () => {
		assert.equal(await streamed(false), false);
	});
});
