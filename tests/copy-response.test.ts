/**
 * The copy-response button's text: assistant prose only, in order, blank
 * separated. Reasoning, tool calls and data parts must never leak into the
 * clipboard; whitespace-only text parts must not create empty paragraphs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { responseTextOf } from "../components/chat.tsx";

describe("responseTextOf", () => {
	it("joins text parts in order and skips reasoning, tools and data", () => {
		assert.equal(
			responseTextOf([
				{ type: "reasoning", text: "thinking" },
				{ type: "text", text: "First paragraph." },
				{ type: "tool-quiz" },
				{ type: "text", text: "  \n " },
				{ type: "data-plan-block" },
				{ type: "text", text: "  Second paragraph. \n" },
			]),
			"First paragraph.\n\nSecond paragraph.",
		);
	});

	it("is empty when the response has no prose", () => {
		assert.equal(responseTextOf([]), "");
		assert.equal(responseTextOf([{ type: "reasoning", text: "hmm" }, { type: "step-start" }]), "");
	});
});
