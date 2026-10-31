/**
 * Output language: every conversational agent writes in the learner's
 * language. The rule lives in shared/10-voice.md, the one fragment that
 * prober, teacher and practice all compose. Without it the agents follow
 * the conversation only by inference, and the turn after an English tool
 * result (the probe_done ack) could come out in English.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeInstructions } from "../src/agent/teacher-agent.ts";

describe("learner language rule", () => {
	for (const kind of ["prober", "teacher", "practice"] as const) {
		it(`${kind} is told to write in the learner's language`, () => {
			assert.match(composeInstructions(kind), /in the language he writes in/);
		});
	}
});
