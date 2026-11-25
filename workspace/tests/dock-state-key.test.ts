/**
 * The dock shell's variant key — the WAAPI height-morph trigger. Pinned
 * after the practice-fold fix (owner, 2026-10-06): the expanded term
 * belongs to every docked variant, so a practice dock's fold/unfold
 * morphs exactly like a teaching question's. Before the fix the key
 * read `pending ? expanded : "-"` — pending is null in practice, the
 * key never changed on the fold, and the practice dock's height jumped
 * instantly between form and bar while teaching morphed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dockStateKey } from "../components/dock-state-key.ts";

describe("dockStateKey (the height-morph trigger)", () => {
	it("a docked variant carries its fold state — practice included", () => {
		assert.equal(dockStateKey("practice:call_p1", true, true), "practice:call_p1:true");
		assert.equal(dockStateKey("practice:call_p1", true, false), "practice:call_p1:false");
		assert.equal(dockStateKey("question:call_q1", true, true), "question:call_q1:true");
		assert.equal(dockStateKey("question:call_q1", true, false), "question:call_q1:false");
	});

	it("the fold toggling the key is what animates: same variant + same fold = same key (typing growth never morphs)", () => {
		assert.equal(
			dockStateKey("practice:call_p1", true, true),
			dockStateKey("practice:call_p1", true, true),
		);
		assert.notEqual(
			dockStateKey("practice:call_p1", true, true),
			dockStateKey("practice:call_p1", true, false),
		);
	});

	it("an undocked band (the composer) has no fold term", () => {
		assert.equal(dockStateKey("chat", false, true), "chat:-");
		assert.equal(dockStateKey("chat", false, false), "chat:-");
	});
});
