/**
 * app/globals.css cascade pins: rules whose LAYER decides whether Tailwind
 * utilities can override them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("globals.css cascade", () => {
	it("the default border color sits in @layer base, so border-* utilities win", () => {
		// Unlayered, `* { border-color }` beat every layered utility
		// (border-white, border-primary, hover:border-…) regardless of
		// specificity.
		assert.match(css, /@layer base \{\s*\* \{\s*border-color: var\(--color-border\);\s*\}\s*\}/);
		assert.ok(!/^\* \{\s*border-color/m.test(css), "no unlayered copy of the rule");
	});
});
