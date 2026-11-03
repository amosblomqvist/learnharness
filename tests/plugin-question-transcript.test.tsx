import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PluginQuestionAnswered } from "../components/plugin-question-slots.tsx";
import { readPluginQuestionAnswer, type PluginQuestionAnswer, type PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import type { QuestionRendererRegistration } from "../components/plugin-manager.ts";

(globalThis as Record<string, unknown>).React = React;

const snapshot: PluginQuestionSnapshot = {
	protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach", questionId: "q1", contractVersion: 1,
	occurrence: { messageId: "assistant", contentIndex: 0, toolCallId: "call", toolName: "code" },
	input: { question: "Saved public question", payload: { reference: "PRIVATE_REFERENCE" }, type: "check", nodeId: "node" },
	questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: true, requiresAnswerRefinement: false,
};
const code = "  function answer() {\n    return 42;\n  }\n";
function savedAnswer(channels: Partial<PluginQuestionAnswer> = {}): PluginQuestionAnswer {
	const persisted = { kind: "plugin-question" as const, questionId: snapshot.questionId, pluginId: snapshot.pluginId, typeId: snapshot.typeId,
		contractVersion: snapshot.contractVersion, answer: code, answeredAt: "2026-11-03T12:00:00.000Z", ...channels };
	const answer = readPluginQuestionAnswer(persisted, snapshot);
	assert.ok(answer, "fixture is a readable saved answer, not an unsaved draft");
	assert.deepEqual(answer, persisted, "saved channels remain lossless before presentation");
	return answer;
}
function ssr(answer: PluginQuestionAnswer) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<PluginQuestionAnswered snapshot={snapshot} answer={answer} chatId="chat" />)}</body></html>`).document;
}
const image = (data: string) => ({ type: "image" as const, mimeType: "image/png", data: Buffer.from(data).toString("base64") });
const imageSrc = (value: ReturnType<typeof image>) => `data:${value.mimeType};base64,${value.data}`;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
async function mount(answer: PluginQuestionAnswer, registration?: QuestionRendererRegistration) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.getElementById("root")!);
	cleanup = async () => {
		try { await act(async () => { root.unmount(); }); }
		finally { for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		} }
	};
	await act(async () => { root.render(<PluginQuestionAnswered snapshot={snapshot} answer={answer} chatId="chat" registration={registration} />); });
	return dom.document;
}
async function expandAnswer(document: Document) {
	const trigger = document.querySelector<HTMLButtonElement>('[data-testid="your-thinking-trigger"]')!;
	assert.ok(trigger); assert.equal(trigger.getAttribute("aria-expanded"), "false");
	await act(async () => { trigger.click(); });
	assert.equal(trigger.getAttribute("aria-expanded"), "true");
}

test("saved reading thinking is above the actual answered card; answer thinking is a native in-card row", () => {
	const answer = savedAnswer({ readingThinking: "  reading first\n then decide  ", thinking: "  answering now\n keep indent  " });
	const before = structuredClone(answer);
	const document = ssr(answer);
	const card = document.querySelector('[data-testid="plugin-question-answered"]')!;
	const reading = document.querySelector('[data-testid="reading-thinking-block"]')!;
	const thinking = document.querySelector('[data-testid="your-thinking"]')!;
	assert.ok(card); assert.ok(reading); assert.ok(thinking);
	assert.equal(reading.nextElementSibling, card, "reading is before the host card, not merely before a plugin subtree");
	assert.equal(card.contains(reading), false); assert.equal(card.contains(thinking), true);
	assert.equal(reading.querySelector("button")?.textContent, "YOUR THINKING");
	assert.equal(thinking.querySelector("button")?.textContent, "YOUR THINKING");
	assert.equal(reading.querySelector("button")?.getAttribute("aria-expanded"), "true");
	assert.equal(thinking.querySelector("button")?.getAttribute("aria-expanded"), "false");
	assert.ok(reading.classList.contains("bg-card"));
	assert.equal(thinking.classList.contains("bg-card"), false, "inCard rows add no second background band");
	assert.equal(reading.querySelector(".whitespace-pre-wrap")?.textContent, answer.readingThinking);
	assert.ok(card.textContent?.includes(code), "saved answer whitespace is not rewritten");
	assert.deepEqual(answer, before, "rendering never rewrites persisted channels");
	assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_REFERENCE/);
});

for (const value of [undefined, "", "  "]) test(`defined channel presence is authoritative for ${JSON.stringify(value)}`, async () => {
	const answer = savedAnswer(value === undefined ? {} : { readingThinking: value, thinking: value });
	const before = structuredClone(answer);
	const document = await mount(answer);
	const reading = document.querySelector('[data-testid="reading-thinking-block"]');
	const thinking = document.querySelector('[data-testid="your-thinking"]');
	if (value === undefined) { assert.equal(reading, null); assert.equal(thinking, null); }
	else {
		assert.ok(reading); assert.ok(thinking);
		assert.equal(reading.querySelector("button")?.getAttribute("aria-expanded"), "true");
		await expandAnswer(document);
		assert.equal(reading.querySelector(".whitespace-pre-wrap")?.textContent ?? "", value);
		assert.equal(thinking.querySelector(".whitespace-pre-wrap")?.textContent ?? "", value);
	}
	assert.deepEqual(answer, before, "even blank and whitespace-only saved channels are retained verbatim");
});

test("nonblank thinking preserves leading/trailing whitespace and line breaks in both native rows", async () => {
	const answer = savedAnswer({ readingThinking: " \n reading  \n", thinking: "  answer\n  thought \n" });
	const document = await mount(answer);
	await expandAnswer(document);
	assert.equal(document.querySelector('[data-testid="reading-thinking-block"] .whitespace-pre-wrap')?.textContent, answer.readingThinking);
	assert.equal(document.querySelector('[data-testid="your-thinking"] .whitespace-pre-wrap')?.textContent, answer.thinking);
});

for (const imageOnly of [false, true]) test(`${imageOnly ? "image-only" : "text and image"} channels each use one host thinking block with no loss or duplication`, async () => {
	const images = { readingThinking: [image("reading one"), image("reading two")], thinking: [image("thinking one"), image("thinking two")], answer: [image("answer only")] };
	const answer = savedAnswer({ images, ...(imageOnly ? {} : { readingThinking: "reading with images", thinking: "thinking with images" }) });
	const before = structuredClone(answer);
	const document = await mount(answer);
	assert.equal(document.querySelectorAll('[data-testid="reading-thinking-block"]').length, 1);
	assert.equal(document.querySelectorAll('[data-testid="your-thinking"]').length, 1);
	assert.equal(document.querySelectorAll('[data-testid="your-thinking"] img').length, 0, "answer thinking keeps the existing closed default");
	await expandAnswer(document);
	for (const [testId, channel] of [["reading-thinking-block", "readingThinking"], ["your-thinking", "thinking"]] as const) {
		const row = document.querySelector(`[data-testid="${testId}"]`)!;
		assert.deepEqual(Array.from(row.querySelectorAll("img"), img => img.getAttribute("src")), images[channel].map(imageSrc));
		assert.equal(row.querySelectorAll('[data-testid="submitted-images"]').length, 1, "text and images share the same native block");
		assert.equal(row.querySelector(".whitespace-pre-wrap")?.textContent ?? "", answer[channel] ?? "");
	}
	assert.equal(document.querySelectorAll("img").length, 4);
	assert.equal(document.querySelector(`img[src="${imageSrc(images.answer[0]!)}"]`), null, "answer images remain Part-owned outside the answered card");
	assert.deepEqual(answer, before);
});

test("empty image arrays do not invent absent thinking channels", () => {
	const document = ssr({ ...savedAnswer(), images: { readingThinking: [], thinking: [], answer: [] } });
	assert.equal(document.querySelector('[data-testid="reading-thinking-block"]'), null);
	assert.equal(document.querySelector('[data-testid="your-thinking"]'), null);
});

test("custom answered code owns only its slot; native thinking and images remain host-owned", async () => {
	let slot!: HTMLElement;
	let contextKeys: string[] = [];
	let disposed = 0;
	const images = { readingThinking: [image("custom reading")], thinking: [image("custom thinking")], answer: [image("custom answer")] };
	const answer = savedAnswer({ readingThinking: "host reading", thinking: "host thinking", images });
	const registration: QuestionRendererRegistration = { pluginId: "fixture", renderer: {
		id: "code", supportedContractVersions: [1], mountAnswerEditor() { throw new Error("answered transcript must not mount an editor"); },
		mountAnswered(container, context) {
			slot = container; contextKeys = Object.keys(context);
			assert.equal(context.answer, code); assert.ok(Object.isFrozen(context));
			const pre = container.ownerDocument.createElement("pre"); const content = container.ownerDocument.createElement("code");
			content.textContent = String(context.answer); pre.append(content); container.append(pre);
			return () => { disposed++; };
		},
	} };
	const document = await mount(answer, registration);
	const card = document.querySelector('[data-testid="plugin-question-answered"]')!;
	assert.ok(card.contains(slot));
	assert.equal(slot.querySelector("code")?.textContent, code);
	assert.equal(slot.querySelector('[data-testid="reading-thinking-block"]'), null);
	assert.equal(slot.querySelector('[data-testid="your-thinking"]'), null);
	assert.equal(slot.querySelector("img"), null);
	for (const key of ["thinking", "readingThinking", "images"]) assert.equal(contextKeys.includes(key), false, `${key} is host-owned, not plugin answered-slot context`);
	await expandAnswer(document);
	assert.equal(document.querySelectorAll("img").length, 2);
	slot.replaceChildren();
	assert.match(document.querySelector('[data-testid="reading-thinking-block"]')?.textContent ?? "", /host reading/);
	assert.match(document.querySelector('[data-testid="your-thinking"]')?.textContent ?? "", /host thinking/);
	assert.equal(document.querySelectorAll("img").length, 2, "plugin slot replacement cannot erase host thinking images");
	await cleanup!(); cleanup = undefined; assert.equal(disposed, 1);
});

test("SourcePart delegates thinking once and preserves answer images outside the host card", () => {
	// The direct component tests above exercise rendering and expansion. This
	// structural boundary assertion avoids importing the private plugin runtime
	// merely to prove Part does not add a second image-only ThinkingBlock.
	const source = readFileSync(new URL("../components/plugin-question-part.tsx", import.meta.url), "utf8");
	assert.equal((source.match(/<PluginQuestionAnswered\b/g) ?? []).length, 1);
	assert.match(source, /<PluginQuestionAnswered\b[^>]*snapshot=\{snapshot\}[^>]*answer=\{answer\}/);
	assert.doesNotMatch(source, /\bThinkingBlock\b|answer\.images\?\.(?:readingThinking|thinking)/);
	assert.match(source, /<PluginQuestionAnswered\b[^>]*\/>\s*<SubmittedImages images=\{answer\.images\?\.answer\}\s*\/>/);
	assert.equal((source.match(/<SubmittedImages\b/g) ?? []).length, 1);
});
