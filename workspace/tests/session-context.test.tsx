import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenameRow, SessionRow } from "../components/sidebar.tsx";
import { DeleteSessionBody, DeleteSessionDialog, TRACES_COPY } from "../components/delete-session-dialog.tsx";
import type { ChatListItem } from "../src/core/index.ts";

/**
 * Wave 6 chunk A — the deletion + context-menu seams on the sidebar:
 * SessionRow's right-click seam (always carries the row testid now), the
 * inline RenameRow (same geometry, select-all entry), and the two-option
 * delete dialog's plain-language copy (the locked design: both options
 * name their reach, the graph-touching one says so).
 */

const chat: ChatListItem = {
	id: "c1",
	title: "Wave mechanics",
	updatedAt: new Date().toISOString(),
	busy: false,
} as unknown as ChatListItem;

describe("SessionRow — the right-click seam", () => {
	it("rows carry the session-row testid (context menu anchors to it)", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.ok(html.includes('data-testid="session-row"'));
	});
});

describe("RenameRow — the inline rename surface", () => {
	it("renders the draft input with the current title, keeping the meta line", () => {
		const html = renderToStaticMarkup(
			<RenameRow chat={chat} onCommit={() => {}} onCancel={() => {}} />,
		);
		assert.ok(html.includes('data-testid="session-rename-input"'));
		// controlled draft starts from the current title
		assert.ok(html.includes(`value="${chat.title}"`));
		// the meta line rides along (row never changes height mid-edit)
		assert.ok(html.includes("session-rename-row"));
		// (owner, polish round) NOTHING MOVES: no status spacer, no input
		// border/padding — the draft text sits at the idle row's title x,
		// and the input is the ONLY shift-proof editing cue (underline).
		assert.ok(!html.includes("w-3.5 shrink-0"), "no always-on spacer (idle rows have none)");
		const input = html.split('data-testid="session-rename-input"')[1]?.split("/>")[0] ?? "";
		assert.ok(input.includes("px-0"), "input carries no left padding");
		assert.ok(input.includes("border-b"), "the underline is the editing cue");
		assert.ok(!input.includes("bg-background"), "no filled field box — text stays put");
	});
});

describe("DeleteSessionDialog — the node-dialog shape (owner flow rework 2026-09-24; portals no-op in SSR; pin the pure body)", () => {
	it("closed (chat=null) renders nothing", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionDialog chat={null} onClose={() => {}} onDeleted={() => {}} />,
		);
		assert.equal(html, "");
	});

	it("red mono title 'Delete session?' (abort-turn look), the session name below in mono at normal size, no code-block chrome", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={false}
				busy={false}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /Delete session\?/);
		const title = html.match(/<h2[^>]*>/)?.[0] ?? "";
		assert.match(title, /text-sm font-semibold text-destructive/); // red, abort-turn look (owner, 2026-10-13)
		assert.ok(!title.includes("font-title"), "no serif display title");
		// the name: mono, normal text-sm size (owner, 2026-10-13), NO bg-muted code-block chrome
		const name = html.match(/data-testid="session-name-code"[^>]*>/)?.[0] ?? "";
		assert.match(name, /font-mono text-sm/);
		assert.ok(!name.includes("bg-muted"), "no code-block chrome");
		assert.match(html, /data-testid="session-name-code"[^>]*>Orbital mechanics</);
	});

	it("one unchecked-by-default checkbox for the graph traces — the graph-touching consequence says so", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={false}
				busy={false}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		// unchecked by default (preserve-graph) — React SSR omits the
		// attribute when false, so pin its ABSENCE on the rendered input
		assert.ok(!/"checked"/.test(html), "unchecked by default");
		// plain-language consequences on the checkbox body
		assert.ok(html.includes(TRACES_COPY.title));
		assert.ok(html.includes("leave the graph too"));
		assert.ok(html.includes("survive"));
		// the old two-button design is gone
		assert.ok(!html.includes("delete-option-preserve"));
		assert.ok(!html.includes("delete-option-nodes"));
	});

	it("bottom row matches the node dialog: quiet Cancel + destructive-red Delete", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={true}
				busy={true}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /data-testid="delete-cancel"[^>]*>Cancel</);
		const del = html.match(/data-testid="delete-confirm"[^>]*>/)?.[0] ?? "";
		assert.match(del, /border-destructive\/50/);
		assert.match(html, /data-testid="delete-confirm"[^>]*>Deleting…</); // busy label on Delete
		// the checkbox survives a busy render (disabled, not unmounted)
		assert.match(html, /data-testid="delete-traces-checkbox"[^>]*disabled=""/);
	});
});