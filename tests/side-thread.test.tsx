import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createSideQuestionActions, SideThreadBody, sideThreadPlaceholder, type SideThreadHandlers } from "../components/side-thread.tsx";
import type { SideThreadState } from "../components/use-side-thread.ts";

const state: SideThreadState = { threadId: "side_lesson", segmentId: "lesson", messages: [
	{ id: "question", role: "user", text: "Why?", quotes: ["Selected words"], at: "2026-11-05T00:00:01Z" },
	{ id: "answer", role: "assistant", text: "Because it is continuous.", at: "2026-11-05T00:00:02Z" },
], answering: false, streamText: "", mode: "popover", anchor: { kind: "composer" } };
const handlers = { onAsk: async () => true, onStop() {}, onExpand() {}, onFloat() {}, onClose() {} };
const render = (s = state, dictation?: SideThreadHandlers["dictation"], onCurrentStep?: () => void) => parseHTML(`<html><body>${renderToStaticMarkup(<SideThreadBody state={s} dictation={dictation} onCurrentStep={onCurrentStep} {...handlers} />)}</body></html>`).document;

describe("floating/docked raw side conversation", () => {
	it("shows raw questions and replies, with no summary, tutor toggle, or delete action", () => {
		const doc = render();
		assert.equal(doc.querySelector('[data-testid="side-learner-message"]')!.textContent, "Selected wordsWhy?");
		assert.match(doc.querySelector('[data-testid="side-helper-message"]')!.textContent!, /Because it is continuous/);
		assert.equal(doc.querySelector('[data-testid="side-context-status"]'), null);
		assert.ok(doc.querySelector('[data-testid="side-learner-message"]')!.classList.contains("max-w-[70%]"));
		assert.ok(doc.querySelector('[data-testid="side-learner-message"]')!.classList.contains("ml-auto"));
		assert.equal(doc.querySelector('[data-testid="side-helper-message"]')!.classList.contains("bg-muted"), false);
		assert.ok(doc.querySelector('[aria-label="发送旁支提问"]')!.classList.contains("bg-primary"));
		assert.ok(doc.querySelector('[title="固定到侧边"] svg.lucide-pin'));
		assert.ok(doc.querySelector('[aria-label="关闭旁支提问"]'));
		assert.ok(doc.querySelector('[aria-label="将旁支提问停靠到侧边"]'));
		assert.equal(doc.querySelector('[data-testid="side-note"]'), null);
		assert.doesNotMatch(doc.body.textContent!, /Tell tutor|Send to tutor|Delete|删除/);
	});
	it("keeps an old conversation editable without adding a context-status line", () => {
		const doc = render(state, undefined, () => {});
		assert.equal(doc.querySelector('[data-testid="side-context-status"]'), null);
		assert.equal(doc.querySelector('textarea')!.hasAttribute("disabled"), false);
		assert.equal(doc.querySelector('[data-testid="side-current-step"]')!.textContent?.trim(), "前往当前步骤");
		assert.equal(render().querySelector('[data-testid="side-current-step"]'), null, "current conversations need no navigation row");
	});
	it("offers Stop while streaming, never blocks the main answer, and preserves draft editing", () => {
		const doc = render({ ...state, answering: true, streamText: "Partial helper reply" });
		assert.match(doc.querySelector('[data-testid="side-streaming-answer"]')!.textContent!, /Partial helper reply/);
		assert.ok(doc.querySelector('[aria-label="停止旁支回答"]'));
		assert.equal(doc.querySelector('textarea')!.hasAttribute("disabled"), false);
	});
	it("can return a docked conversation to its floating window", () => {
		const doc = render({ ...state, mode: "panel" });
		assert.ok(doc.querySelector('[aria-label="将旁支提问设为浮动"]'));
		assert.ok(doc.querySelector('[title="取消固定，改为浮动"] svg.lucide-pin-off'));
	});
	it("places the side microphone inside the input and uses the error token while recording", () => {
		const dictation = { phase: "idle" as const, active: false, blocked: false, error: null, toggle() {}, finish: async () => {} };
		const idle = render(state, dictation);
		assert.ok(idle.querySelector("textarea")!.parentElement!.querySelector('[aria-label="开始旁支提问语音听写"]'));
		const active = render(state, { ...dictation, phase: "recording", active: true });
		assert.equal(active.querySelector('[data-testid="side-dictation-toggle"]')!.getAttribute("aria-pressed"), "true");
		assert.ok(active.querySelector('[data-testid="side-dictation-toggle"]')!.classList.contains("text-error"));
	});
	it("keeps failed partial replies and offers an explicit retry", () => {
		const doc = render({ ...state, messages: [...state.messages, { id: "failed", role: "assistant", text: "Partial…", error: "Request failed", at: "" }] });
		assert.match(doc.body.textContent!, /Partial…/);
		assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Request failed/);
		assert.ok(Array.from(doc.querySelectorAll("button")).some((button) => button.textContent === "重试回答"));
	});
	it("uses short contextual placeholders without a create-new-thread limit", () => {
		assert.equal(sideThreadPlaceholder({ ...state, messages: [] }), "发起旁支提问…");
		assert.equal(sideThreadPlaceholder(state), "继续追问…");
		assert.equal(sideThreadPlaceholder({ ...state, pendingPassage: { text: "Quote", sourceMessageId: "lesson" } }), "就这段内容提问…");
	});
});

describe("side entry points", () => {
	it("has one quiet selection Ask action, independent of whether a companion is already open", () => {
		const actions = createSideQuestionActions({ open() {} });
		assert.deepEqual(actions.map((action) => action.label), ["提问"]);
		assert.equal(actions[0]!.visible({ messageId: "lesson", range: render().createRange(), selector: { text: "Words", start: 0, end: 5, prefix: "", suffix: "" } }), true);
	});
});
