import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { PluginQuestionPresentation } from "../components/plugin-question-slots.tsx";
import type { QuestionRendererRegistration } from "../components/plugin-manager.ts";
import type { PluginQuestionSnapshot, PluginQuestionAnswer } from "../src/core/index.ts";

const saved: PluginQuestionSnapshot = { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" }, input: { question: "Public question", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };
const accepted: PluginQuestionAnswer = { kind: "plugin-question", questionId: "q1", pluginId: "fixture", typeId: "code", contractVersion: 1, answer: "Accepted learner answer", answeredAt: "2026-01-01T00:00:00Z" };

for (const slot of ["question", "answered"] as const) test(`${slot} rich presentation recovers after a failed generation without losing its stable mount root`, async () => {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window, document, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const root = createRoot(document.getElementById("root")!);
	let replacements = 0;
	const registration = (mount: (container: HTMLElement) => void): QuestionRendererRegistration => ({ pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], ...(slot === "question" ? { mountQuestion: mount } : { mountAnswered: mount }), mountAnswerEditor() { return { update() {}, focus() {}, dispose() {} }; } } });
	try {
		await act(async () => { root.render(<PluginQuestionPresentation snapshot={saved} chatId="chat" answer={slot === "answered" ? accepted : undefined} registration={registration(() => { throw new Error("failed renderer"); })} />); });
		assert.match(document.body.textContent ?? "", slot === "question" ? /Public question/ : /Accepted learner answer/);
		const replacement = registration(container => { replacements++; container.textContent = `Recovered rich ${slot}`; });
		await act(async () => { root.render(<PluginQuestionPresentation snapshot={saved} chatId="chat" answer={slot === "answered" ? accepted : undefined} registration={replacement} />); });
		assert.equal(replacements, 1); assert.match(document.body.textContent ?? "", new RegExp(`Recovered rich ${slot}`));
		assert.equal(document.querySelector("[hidden]"), null);
	} finally {
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
	}
});
