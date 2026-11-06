import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampNotesWidth, NOTES_DEFAULT_WIDTH, NOTES_MAX_WIDTH, NOTES_MIN_WIDTH } from "../components/notes-layout";

describe("notes layout", () => {
	it("clamps widths", () => {
		assert.equal(clampNotesWidth(100), NOTES_MIN_WIDTH);
		assert.equal(clampNotesWidth(9999), NOTES_MAX_WIDTH);
		assert.equal(clampNotesWidth(400.4), 400);
		assert.equal(clampNotesWidth(Number.NaN), NOTES_DEFAULT_WIDTH);
	});
});
