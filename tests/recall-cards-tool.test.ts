/**
 * The `recall_cards` tool (owner, 2026-11-01): schema boundary and the
 * execute ack. The cards ride the call ARGUMENTS (the export reads them
 * from history — core/anki-cards.ts); the tool itself stores nothing, so
 * a valid call needs no record fixture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { recallCardsTool } from "../src/agent/tools/recall-cards.ts";
import { RECALL_CARDS_TOOL } from "../src/core/native-messages.ts";

const CARDS = [{ front: "What is the product rule?", back: "(fg)' = f'g + fg'" }, { front: "HTTP 201 means?", back: "Created" }];

describe("recall_cards tool", () => {
	it("acks with the card count and never terminates the turn", async () => {
		assert.equal(recallCardsTool.name, RECALL_CARDS_TOOL);
		assert.equal(Value.Check(recallCardsTool.parameters, { cards: CARDS }), true);
		const result = await recallCardsTool.execute("call_rc", { cards: CARDS });
		assert.ok(!result.isError);
		assert.ok(!result.terminate, "quiet bookkeeping — the turn continues");
		assert.deepEqual(result.content, [{ type: "text", text: "Saved 2 recall card(s)." }]);
	});

	it("rejects empty cards, more than 8, and a blank front", () => {
		assert.equal(Value.Check(recallCardsTool.parameters, { cards: [] }), false);
		assert.equal(
			Value.Check(recallCardsTool.parameters, { cards: Array.from({ length: 9 }, (_, i) => ({ front: `F${i}`, back: "B" })) }),
			false,
		);
		assert.equal(Value.Check(recallCardsTool.parameters, { cards: [{ front: "  ", back: "B" }] }), false);
		assert.equal(Value.Check(recallCardsTool.parameters, { cards: [{ front: "F", back: "" }] }), false);
	});
});
