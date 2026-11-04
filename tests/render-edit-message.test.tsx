/**
 * SSR pins — the edit-message control (issue #321, owner ruling: a pencil
 * in the "You" row, visible on hover and keyboard focus). The behavior
 * (confirm, abort, rewind) is pinned in session-core.test.ts and
 * rewind.test.ts; this pins the control's own markup.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditMessageButton } from "@/components/edit-message";

describe("EditMessageButton", () => {
	const html = renderToStaticMarkup(<EditMessageButton onEdit={() => {}} />);

	it("is a real button with an accessible name, never a submit", () => {
		assert.match(html, /^<button /);
		assert.match(html, /type="button"/);
		assert.match(html, /aria-label="Edit message"/);
		assert.match(html, /data-testid="edit-message"/);
	});

	it("is hidden until hover or keyboard focus reveals it", () => {
		assert.match(html, /opacity-0/);
		assert.match(html, /group-hover:opacity-100/);
		assert.match(html, /focus-visible:opacity-100/);
	});
});
