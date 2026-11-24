/**
 * streamingToolActivity (2026-09-19, the "Writing a question…" fix): a
 * tool part stays input-streaming for its WHOLE execution (the bridge
 * defers input-available to tool_execution_end), so the transcript
 * activity line must name the ACTUAL running tool — the old code shimmered
 * "Writing a question…" over minutes-long greps.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { streamingToolActivity } from "../src/core/pending.ts";

function msg(role: string, parts: unknown[]): LhViewMessage {
	return { id: "m1", role, parts } as unknown as LhViewMessage;
}

function toolPart(tool: string, state: string) {
	return { type: `tool-${tool}`, toolCallId: "c1", state, input: {} };
}

describe("streamingToolActivity (the turn-activity label)", () => {
	it("question tools keep their question shimmer", () => {
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("quiz", "input-streaming")])]), "Writing a question…");
		assert.equal(
			streamingToolActivity([msg("assistant", [toolPart("ask_user_question", "input-streaming")])]),
			"Writing a question…",
		);
	});

	it("local tools name their actual activity", () => {
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("grep", "input-streaming")])]), "Searching file contents…");
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("read", "input-streaming")])]), "Reading a file…");
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("find", "input-streaming")])]), "Finding files…");
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("ls", "input-streaming")])]), "Listing a directory…");
	});

	it("job dispatch tools get their own labels; unknown tools stay generic", () => {
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("pdf", "input-streaming")])]), "Reading a PDF…");
		assert.equal(
			streamingToolActivity([msg("assistant", [toolPart("mystery_tool", "input-streaming")])]),
			"Working…",
		);
	});

	it("no activity once the call settles or the turn ends", () => {
		// output-available = done executing → no shimmer (the transcript
		// shows the settled card instead).
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("grep", "output-available")])]), null);
		// the last message being the user's = nothing running.
		assert.equal(streamingToolActivity([msg("user", [{ type: "text", text: "hi" }])]), null);
		assert.equal(streamingToolActivity([]), null);
	});

	it("the SECOND streaming part wins only if the first settles — parts scan forward", () => {
		// A settled call followed by a live one: the live one is the activity.
		const parts = [toolPart("read", "output-available"), toolPart("grep", "input-streaming")];
		assert.equal(streamingToolActivity([msg("assistant", parts)]), "Searching file contents…");
	});
});
