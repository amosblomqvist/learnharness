import assert from "node:assert/strict";
import { test } from "node:test";
import { faLiterals } from "../lib/i18n/messages/fa-literals.ts";
import { translateLiteral } from "../lib/i18n/translate.ts";

const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("every Persian literal keeps the same {slots} as its English key", () => {
	for (const [en, fa] of Object.entries(faLiterals)) {
		assert.equal(slots(fa), slots(en), `slot mismatch: ${en}`);
		assert.notEqual(fa.trim(), "", `empty translation: ${en}`);
	}
});

test("translateLiteral falls back to English and interpolates", () => {
	assert.equal(translateLiteral("en", "Save failed ({status})", { status: 500 }), "Save failed (500)");
	assert.equal(translateLiteral("fa", "Not in dictionary {x}", { x: "1" }), "Not in dictionary 1");
	assert.match(translateLiteral("fa", "Save failed ({status})", { status: 500 }), /500/);
});
