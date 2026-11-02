/**
 * Side questions UI (owner design 2026-11-02): the per-anchor view
 * derivation, the NDJSON splitter, and static renders of the block seam,
 * the open window and the closed bar.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { SideChatProvider, deriveSideWindows, emptySideCanonical, sideBlockKey, splitNdjson, type SideWindowView } from "../components/side-chat-state.tsx";
import { SideAskBlock, SideChatWindow, SidePassage, sideExcerpt } from "../components/side-chat.tsx";
import type { SideChatAnchor, SideChatThread } from "../src/core/index.ts";

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

const anchor: SideChatAnchor = { messageId: "m", partId: "m-t0", blockIndex: 1, blockText: "The **slope** at a point." };
const thread: SideChatThread = {
	id: "side_1",
	anchor,
	open: true,
	createdAt: "",
	messages: [
		{ id: "u1", role: "user", text: "Why the limit?", quotes: ["slope at a point"], at: "" },
		{ id: "a1", role: "assistant", text: "Because a secant needs two points.", at: "" },
		{ id: "u2", role: "user", text: "And for |x|?", at: "" },
		{ id: "a2", role: "assistant", text: "", error: "upstream 500", at: "" },
	],
};
const fakeStore = { composerText: new Map<string, string>() } as never;
const view = (over: Partial<SideWindowView> = {}): SideWindowView => ({
	key: thread.id,
	renderKey: thread.id,
	blockKey: sideBlockKey("m-t0", 1),
	anchor,
	thread,
	open: true,
	quotes: [],
	answering: false,
	streamText: "",
	sending: false,
	error: null,
	...over,
});

describe("side window derivation", () => {
	it("stacks a block's windows in opening order: saved threads, then drafts", () => {
		const c = emptySideCanonical();
		const later: SideChatThread = { ...thread, id: "side_2", createdAt: "2" };
		c.threads = [{ ...thread, createdAt: "1" }, later];
		c.drafts = new Map([
			["draft_a", anchor],
			["draft_b", { ...anchor, blockIndex: 4 }],
		]);
		const windows = deriveSideWindows(c, new Map());
		assert.deepEqual(windows.get("m-t0#1")!.map((v) => v.key), ["side_1", "side_2", "draft_a"]);
		assert.deepEqual(windows.get("m-t0#4")!.map((v) => v.key), ["draft_b"]);
		assert.equal(windows.get("m-t0#1")![2]!.thread, undefined);
		assert.equal(windows.get("m-t0#1")![2]!.open, true);
	});

	it("a promoted draft keeps its render key (the window never remounts)", () => {
		const c = emptySideCanonical();
		c.threads = [thread];
		c.aliases = new Map([["side_1", "draft_x"]]);
		const [win] = deriveSideWindows(c, new Map()).get("m-t0#1")!;
		assert.equal(win!.key, "side_1");
		assert.equal(win!.renderKey, "draft_x");
	});

	it("reuses unchanged views and unchanged stacks (one block re-renders per change)", () => {
		const c = emptySideCanonical();
		const sibling: SideChatThread = { ...thread, id: "side_3" };
		const elsewhere: SideChatThread = { ...thread, id: "side_2", anchor: { ...anchor, blockIndex: 3 } };
		c.threads = [thread, sibling, elsewhere];
		const first = deriveSideWindows(c, new Map());
		const second = deriveSideWindows({ ...c, answering: new Map([["side_1", "partial"]]) }, first);
		assert.notEqual(second.get("m-t0#1"), first.get("m-t0#1"), "the changed block gets a new stack");
		assert.equal(second.get("m-t0#1")![0]!.streamText, "partial");
		assert.equal(second.get("m-t0#1")![1], first.get("m-t0#1")![1], "its untouched sibling keeps identity");
		assert.equal(second.get("m-t0#3"), first.get("m-t0#3"), "an untouched block keeps its stack");
	});

	it("splits NDJSON on complete lines only", () => {
		assert.deepEqual(splitNdjson('{"a":1}\n{"b":2}\n{"c"'), { lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
		assert.deepEqual(splitNdjson(""), { lines: [], rest: "" });
	});

	it("excerpts flatten markdown and clip", () => {
		assert.equal(sideExcerpt("## The **slope**\n\n at a point"), "The slope at a point");
		assert.equal(sideExcerpt("x".repeat(100), 10), `${"x".repeat(9)}…`);
	});
});

describe("side window render", () => {
	it("open: header, quotes, answers, the failed answer's Retry, delete + close controls", () => {
		const document = documentFor(<SideChatWindow view={view()} store={fakeStore} />);
		const win = document.querySelector('[data-testid="side-chat-window"]')!;
		assert.ok(win);
		assert.equal(win.getAttribute("aria-label"), "Side question");
		assert.doesNotMatch(document.querySelector("header")!.textContent!, /Side question/i, "the icon is the label");
		assert.equal(document.querySelectorAll('[data-testid="side-chat-question"]').length, 2);
		assert.match(document.querySelector('[data-testid="side-chat-question"]')!.textContent!, /slope at a point/);
		assert.match(win.textContent!, /a secant needs two points/);
		assert.match(win.textContent!, /The answer failed: upstream 500/);
		assert.ok(document.querySelector('[data-testid="side-chat-retry"]'), "the last failed answer offers Retry");
		assert.ok(document.querySelector('[data-testid="side-chat-delete"]'));
		const jump = document.querySelector('[data-testid="side-chat-jump"]')!;
		assert.equal(jump.getAttribute("aria-label"), "Jump to follow-up question");
		assert.equal(jump.closest('[data-testid="side-chat-toggle"]'), null, "the jump never collapses the window");
		assert.equal(document.querySelector('[data-testid="side-chat-close"]')!.getAttribute("aria-label"), "Close side question");
		// The whole bar is the handle: a header-wide toggle, separate from (never wrapping) its controls.
		const toggle = document.querySelector('[data-testid="side-chat-toggle"]')!;
		assert.equal(toggle.tagName, "BUTTON");
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		assert.match(toggle.textContent!, /“slope at a point”/);
		assert.equal(toggle.querySelector("button"), null, "no nested buttons");
		assert.equal(toggle.parentElement!.tagName, "HEADER");
		assert.equal(document.querySelector('[data-testid="side-chat-input"]')!.getAttribute("placeholder"), "Ask a follow-up…");
		assert.ok(document.querySelector('[data-testid="side-chat-send"]'));
		// The bottom collapse: right of the follow-up box, OUTSIDE it.
		const bottom = document.querySelector('[data-testid="side-chat-collapse-bottom"]')!;
		assert.equal(bottom.getAttribute("aria-label"), "Collapse side question");
		assert.equal(bottom.closest("form"), null, "never inside the follow-up box");
		assert.equal(bottom.previousElementSibling!.tagName, "FORM", "right after the box");
		assert.ok(bottom.previousElementSibling!.querySelector('[data-testid="side-chat-send"]'));
		// Both collapse controls show the upward "fold up" chevron.
		for (const control of [bottom, document.querySelector('[data-testid="side-chat-close"]')!]) {
			assert.ok(control.querySelector("svg.lucide-chevron-up"), control.getAttribute("data-testid")!);
		}
	});

	it("answering: streamed text and the Stop control; no Retry while busy", () => {
		const document = documentFor(<SideChatWindow view={view({ answering: true, streamText: "Partial **answer**" })} store={fakeStore} />);
		assert.match(document.querySelector('[data-testid="side-chat-streaming"]')!.textContent!, /Partial answer/);
		assert.ok(document.querySelector('[data-testid="side-chat-stop"]'));
		assert.equal(document.querySelector('[data-testid="side-chat-send"]'), null);
		assert.equal(document.querySelector('[data-testid="side-chat-retry"]'), null);
	});

	it("draft: no delete, a discard control, the attached quotes, the first-question placeholder", () => {
		const document = documentFor(<SideChatWindow view={view({ key: "draft_1", renderKey: "draft_1", thread: undefined, quotes: ["a highlighted bit"] })} store={fakeStore} />);
		assert.match(document.querySelector("header")!.textContent!, /“a highlighted bit”/, "a selection names its window");
		assert.equal(document.querySelector('[data-testid="side-chat-delete"]'), null);
		assert.equal(document.querySelector('[data-testid="side-chat-close"]')!.getAttribute("aria-label"), "Discard side question");
		assert.equal(document.querySelector('[data-testid="side-chat-toggle"]'), null, "a draft's header never discards on a stray click");
		assert.equal(document.querySelector('[data-testid="side-chat-jump"]'), null, "nothing to jump past in an empty window");
		assert.equal(document.querySelector('[data-testid="side-chat-collapse-bottom"]'), null, "a draft only discards, from its ×");
		assert.match(document.querySelector('[data-testid="side-chat-quotes"]')!.textContent!, /a highlighted bit/);
		assert.equal(document.querySelector('[data-testid="side-chat-input"]')!.getAttribute("placeholder"), "Ask about this paragraph…");
	});

	it("closed: a one-line bar with the quote and the question count", () => {
		const document = documentFor(<SideChatWindow view={view({ open: false })} store={fakeStore} />);
		assert.equal(document.querySelector('[data-testid="side-chat-window"]'), null);
		const bar = document.querySelector('[data-testid="side-chat-bar"]')!;
		assert.equal(bar.tagName, "BUTTON", "the whole closed bar opens it");
		assert.equal(bar.getAttribute("aria-expanded"), "false");
		assert.doesNotMatch(bar.textContent!, /Side question/i, "icon, quote and count only");
		assert.equal(bar.getAttribute("aria-label"), "Open side question: slope at a point");
		assert.match(bar.textContent!, /“slope at a point”/);
		assert.match(bar.textContent!, /2$/);
	});
});

describe("side block seam", () => {
	const prose = "First paragraph.\n\nSecond paragraph.";
	const render = (enabled: boolean) =>
		documentFor(
			<ServerEventsProvider connect={() => ({ onEvent() {}, onOpen() {}, close() {} }) as never}>
				<SideChatProvider chatId="chat_x">
					<SidePassage messageId="m" partId="m-t0" enabled={enabled}>
						<MessageResponse BlockComponent={SideAskBlock}>{prose}</MessageResponse>
					</SidePassage>
				</SideChatProvider>
			</ServerEventsProvider>,
		);

	it("wraps every content block with its anchor key and an Ask pill (blank-line blocks stay bare)", () => {
		const document = render(true);
		const blocks = document.querySelectorAll("[data-side-block]");
		// Streamdown's split: ["First paragraph.", "\n\n", "Second paragraph."] —
		// the whitespace block keeps its index but gets no wrapper.
		assert.deepEqual(Array.from(blocks).map((b) => b.getAttribute("data-side-block")), ["m-t0#0", "m-t0#2"]);
		const asks = document.querySelectorAll('[data-testid="side-ask"]');
		assert.equal(asks.length, 2);
		for (const ask of Array.from(asks)) {
			assert.equal(ask.textContent, "", "icon only — no label text");
			assert.ok(ask.querySelector("svg"));
			assert.equal(ask.getAttribute("aria-label"), "Ask a side question about this paragraph");
		}
		assert.match(blocks[1]!.textContent!, /Second paragraph\./);
	});

	it("a streaming passage renders no Ask affordance", () => {
		const document = render(false);
		assert.equal(document.querySelectorAll("[data-side-block]").length, 2);
		assert.equal(document.querySelectorAll("[data-side-enabled]").length, 0);
		assert.equal(document.querySelectorAll('[data-testid="side-ask"]').length, 0);
	});

	it("outside a passage/provider the block renders exactly as before", () => {
		const document = documentFor(<MessageResponse BlockComponent={SideAskBlock}>{prose}</MessageResponse>);
		assert.equal(document.querySelectorAll("[data-side-block]").length, 0);
		assert.match(document.body.textContent!, /First paragraph\.\s*Second paragraph\./);
	});
});
