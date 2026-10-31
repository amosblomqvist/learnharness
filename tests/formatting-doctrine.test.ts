/** The math doctrine scopes JSON escaping to tool arguments: ordinary
 *  replies are raw text, so a doubled backslash there renders as a row
 *  break followed by a bare command name (#111). */
import assert from "node:assert/strict";
import { it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

for (const kind of ["prober", "teacher", "practice"] as const) {
	it(`${kind} doctrine keeps single backslashes in ordinary replies`, () => {
		const text = composeInstructions(kind);
		assert.match(text, /In ordinary response text, write LaTeX exactly as in a \.tex file: a single backslash per command/);
		assert.match(text, /Escape only inside JSON strings \(tool arguments\)/);
	});
}
