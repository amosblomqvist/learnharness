/**
 * MODEL-VALUE DEBRIS STRIP (owner, 2026-10-09 — the whitehead incident):
 * glm-5.3 emitted `correctAnswer: [":parmenides"]` — the option value with
 * the JSON key-value COLON glued on — across four rejected quiz calls
 * (and `type: "\"predict\""` — the literal with QUOTES baked in — across a
 * ten-retry death loop; see tools/heal.ts for that half). Membership
 * fields (correctAnswer against option values, quiz type against the
 * literal pair, practice targets against proposition ids) are copied by
 * the model from its own context, and the copy picks up surrounding
 * syntax: colons, quotes, backticks, whitespace.
 *
 * THE SEAM: strip at every MEMBERSHIP comparison — never on free text
 * (statements, questions, explanations may legitimately carry any of
 * these characters). Pure + browser-safe: shared by the call boundary
 * (quizInputProblems), the display parse (tool-parts), and grading
 * (question-dock) — the three consumers the tool-parts law keeps in
 * lockstep. Idempotent by construction.
 */

/** Strip the copy-syntax debris a model glues onto a membership value:
 * any run of surrounding whitespace, colons, double/single quotes, and
 * backticks, in any interleaving (`":value"`, `: value`, `` `value` ``).
 * The interior is untouched. */
export function stripModelValueDebris(value: string): string {
	return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
