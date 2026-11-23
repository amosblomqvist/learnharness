import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { KEYBOARD_ACTIONS } from "../src/core/keyboard.ts";

/**
 * docs/keyboard.md's "Default key map" table is written by hand, so a new
 * registry action can ship without a row. Every dispatched (not displayOnly)
 * default binding must appear there, spelled the way the table spells it.
 */

const docs = readFileSync(new URL("../docs/keyboard.md", import.meta.url), "utf8");
const table = docs.slice(docs.indexOf("## Default key map"), docs.indexOf("\n## ", docs.indexOf("## Default key map") + 1));
const documented = new Set(
	table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Action") && !line.startsWith("|---"))
		.map((line) => line.split("|")[2]!.trim()),
);

const spell = (binding: string) => binding.split("+")
	.map((part) => part === "mod" ? "Mod" : part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
	.join("+");

it("documents every default binding the dispatcher fires", () => {
	assert.ok(documented.size > 0, "the Default key map table was not found");
	const missing = KEYBOARD_ACTIONS.filter((action) => !action.displayOnly && !documented.has(spell(action.binding)))
		.map((action) => `${action.id} (${spell(action.binding)})`);
	assert.deepEqual(missing, []);
});
