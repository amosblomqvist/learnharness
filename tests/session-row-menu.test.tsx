/**
 * The session row's touch menu (lh-m5s.2): a coarse pointer gets a visible
 * control that opens the same rename / export / delete menu right-click
 * opens. A fine pointer's row is unchanged.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

const chat = {
	id: "c1",
	title: "Wave mechanics",
	kind: "teach",
	updatedAt: "2026-01-02T00:00:00.000Z",
	busy: false,
} as unknown as ChatListItem;

describe("SessionRow touch menu", () => {
	it("a row given a menu handler (coarse pointer) shows a visible session-actions button", () => {
		const html = renderToStaticMarkup(
			<SessionRow chat={chat} active={false} onOpen={() => {}} onMenu={() => {}} />,
		);
		assert.match(html, /data-testid="session-row-menu"/);
		assert.match(html, /aria-label="Session actions for Wave mechanics"/);
	});

	it("a row without a menu handler (fine pointer) has no extra button", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.doesNotMatch(html, /session-row-menu/);
		assert.equal(html.match(/<button/g)?.length, 1);
	});
});
