/**
 * The status-color law (theme wave, 2026-11-04): error / success / warning
 * chrome uses the theme tokens (text-error, bg-success/15, …) — never a
 * fixed Tailwind palette class, which would ignore the active theme.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

describe("status colors are theme tokens", () => {
	it("no red/green/amber palette class is left under components/ or app/", () => {
		let out = "";
		try {
			out = execFileSync(
				"git",
				["grep", "--untracked", "-n", "-E", "\\b(text|bg|border|fill|stroke|ring)-(red|green|amber)-[0-9]{3}", "--", "components", "app"],
				{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
			).trim();
		} catch (e) {
			// git grep exits 1 when nothing matches — the passing case.
			if ((e as { status?: number }).status !== 1) throw e;
		}
		assert.equal(out, "");
	});
});
