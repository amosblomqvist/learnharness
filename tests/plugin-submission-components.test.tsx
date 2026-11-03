import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SubmittedImages } from "../components/submitted-images.tsx";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { ThinkingCard } from "../components/practice-cards.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ChatSessionComposer, enterAction } from "../components/composer.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { buildAnswer, validatePluginBuiltinSubmissionAnswer, type QuestionData, type AnswerRequest } from "../src/core/index.ts";

Object.assign(globalThis, { React });
const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const qd: QuestionData = { id: "call", kind: "explain", question: "Question?", mode: "text", options: [], createdAt: "now" };
const answer = buildAnswer(qd, { text: "" });

test("submitted images use explicit bytes, centered natural-width figures, and no image controls", () => {
	const html = renderToStaticMarkup(<SubmittedImages images={[image]} />);
	assert.match(html, /<figure[^>]*mx-auto[^>]*w-fit/); assert.match(html, /alt="Submitted image"/); assert.match(html, /data:image\/png;base64,iVBORw0KGgo=/);
	assert.match(html, /max-w-full opacity-100/); assert.doesNotMatch(html, /<button|download|invert/);
	assert.equal(renderToStaticMarkup(<SubmittedImages />), "");
});

test("image-only practice thinking, question thinking, reading and answer containers remain visible at full pixel opacity", () => {
	const thinking = renderToStaticMarkup(<ThinkingBlock text="" images={[image]} defaultOpen />);
	assert.match(thinking, /Submitted image/); assert.doesNotMatch(thinking, /text-foreground\/50[^>]*><[^>]*img/);
	assert.match(renderToStaticMarkup(<ThinkingCard data={{ text: "", problemCallId: "problem", images: [image] }} />), /Submitted image/);
	const html = renderToStaticMarkup(<AnsweredCard answer={{ ...answer, images: { answer: [image], thinking: [image], readingThinking: [image] } }} />);
	assert.match(html, /reading-thinking-block/); assert.match(html, /your-thinking/);
	// Answer and reading are open initially; question thinking retains its native collapse policy.
	assert.equal((html.match(/alt="Submitted image"/g) ?? []).length, 2);
	assert.match(renderToStaticMarkup(<ThinkingBlock text="drawing.png" defaultOpen />), /drawing.png/);
	assert.doesNotMatch(renderToStaticMarkup(<ThinkingBlock text="drawing.png" defaultOpen />), /<img/);
});

test("pending image input makes an empty between-problems composer send rather than Next", () => {
	assert.equal(enterAction({ busy: false, canSend: true, nextProblem: true }), "send");
	const html = renderToStaticMarkup(<ChatSessionComposer busy={false} value="" revision={0} pendingInput onChange={() => {}} onSend={() => {}} onStop={() => {}} sendAllowed dictationActive={false} nextProblem />);
	assert.match(html, /aria-label="Send"/); assert.doesNotMatch(html, /next-problem-button/);
});

let cleanup: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await cleanup?.(); restore?.(); cleanup = undefined; restore = undefined; });

test("builtin pending input enables an initially empty selection and crosses preparation as raw rendered/shuffled input", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, navigator: { userAgent: "", platform: "" }, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; };
	const { createRoot } = await import("react-dom/client"); const root = createRoot(document.getElementById("root")!);
	cleanup = async () => { await act(async () => root.unmount()); };
	let rendered: QuestionData | undefined, raw: AnswerRequest | undefined, pending = false;
	const render = async () => { await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId="shuffle-call" input={{ question: "Which?", options: [{ label: "Left", value: "left" }, { label: "Right", value: "right" }], correctAnswer: "right", explanation: "Because" }} expanded onExpand={() => {}} onSubmit={() => assert.fail("must not pregrade before hooks")}
		hasPendingInput={question => { rendered = question; return pending; }} onPrepareSubmission={capture => { rendered = capture.question; assert.equal(capture.isCurrent(), true); raw = capture.capture(); }} />)); };
	await render(); const button = () => document.querySelector('button[type="submit"]')!;
	assert.equal(button().hasAttribute("disabled"), true);
	pending = true; await render(); assert.equal(button().hasAttribute("disabled"), false);
	await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
	assert.ok(rendered); assert.ok(raw); assert.deepEqual(raw.values, []); assert.equal("correct" in raw, false);
	const transformed = validatePluginBuiltinSubmissionAnswer(rendered, { values: ["right"], confidence: 67.8, images: [] });
	const graded = buildAnswer(rendered, transformed, "quiz"); assert.equal(graded.correct, true); assert.equal(graded.confidence, 68);
	assert.equal(graded.answers[0]!.index, rendered.options.findIndex(option => option.value === "right") + 1);
	assert.throws(() => validatePluginBuiltinSubmissionAnswer(rendered!, { values: ["unknown"], images: [] }), /unknown/);
});
