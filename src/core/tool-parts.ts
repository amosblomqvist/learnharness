/**
 * The UI parse seam — parse, don't cast (the rule born of the 2026-09-12
 * live crashes).
 *
 * WHY THIS EXISTS. Validation IS first at the model-facing boundary — pi
 * validates arguments against the tool's TypeBox schema before execute,
 * and the authoring refinements run in the execute seam; a failure
 * returns to the model as an error tool result, same turn. But the same bytes have two other consumers, and there they
 * exist UNVALIDATED BY DESIGN:
 *
 *   - the live wire streams raw tool-input deltas while the model is still
 *     typing the call (validation cannot run before the call is complete);
 *   - the transcript keeps the raw input of REJECTED calls too (transcript
 *     honesty + the replay invariant: every toolCall followed by a result).
 *
 * So invalid input is always observable, and part STATES carry the verdict
 * (input-streaming = partial, input-available = validated, output-error =
 * garbage). The flaw that made the crashes possible: consumers trusted
 * those shapes via TypeScript CASTS — `part.input as X` is a compile-time
 * lie the checker believes, with no runtime check behind it.
 *
 * THE RULE (mechanical, not vigilance): model-authored INPUT is consumed
 * only through these parsers, each running the SAME TypeBox schema the model
 * faced — boundary-valid ⇔ consumer-parseable, structurally. Server- and
 * learner-authored OUTPUT stays trusted (our own code authors it: the
 * execute acks, the learner's buildAnswer). A parse failure renders the
 * quiet fallback, never a crash.
 */

import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { quizDisplayInputSchema, askInputSchema, askOptionProblems, quizInputProblems, explainInputProblems, explainDisplayInputSchema, type AskToolInput, type QuizToolInput, type ExplainToolInput } from "./question-core.ts";
import { repairMathForDisplay } from "./math-delims.ts";
import { healEncodedArguments } from "./argument-heal.ts";
import { probeDoneInputSchema, type ProbeDoneInput } from "./contracts/probe.ts";

/** The pi-boundary parse step, mirrored here (live-smoke fix, 2026-09-26):
 *  pi-ai's validateToolArguments runs TypeBox's Value.Convert on the model's
 *  raw arguments before Value.Check — a correctAnswer sent as the NUMBER 17
 *  (what the live smoke's model actually emitted) converts to "17" at the
 *  boundary, so the tool poses the quiz fine. But the persisted record keeps
 *  the RAW arguments, so a parse seam that skips Convert would reject the
 *  exact input the boundary accepted — an invisible pending quiz and a
 *  learner lockout. Every display parse converts first, exactly like the
 *  boundary; Convert mutates, so the input is cloned before touching. */
function boundaryParse<T>(schema: TSchema, input: unknown): T | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const converted = structuredClone(input);
	Value.Convert(schema, converted);
	if (!Value.Check(schema, converted)) return undefined;
	return Value.Clean(schema, converted) as T;
}

/** Decode one extra JSON string layer only when an escaped code fence identifies it.
 * Real multiline Markdown and literal backslashes in ordinary questions stay intact. */
function restoreQuestionCode(text: string): string {
	if (text.includes("\n") || !/(?:^|\\n)[ \t]{0,3}(?:`{3,}|~{3,})[^\s\\]*\\n/.test(text)) return text;
	try {
		const decoded: unknown = JSON.parse(`"${text}"`);
		return typeof decoded === "string" ? decoded : text;
	} catch {
		return text;
	}
}

/**
 * Quiz parse for DISPLAY: the shared authoring base, pre-refinement.
 * Both boundaries (the prober's quizInputBase, the teacher's quizInputObject
 * over base + optional nodeId) share THE SAME quizInputBase fields, so
 * anything that passed either boundary parses here; the teacher-only
 * `nodeId` is an unknown key Value.Clean strips (zod's old strip behavior,
 * kept so the display shape stays exactly what the dock always saw). This
 * is deliberately the LENIENT common core — the strict per-agent authoring
 * checks are the boundary's job — but it runs the shared grading
 * refinement (quizInputProblems) after Convert, mirroring the boundary's
 * full chain: pi accepts `correctAnswer: 17` structurally (Convert →
 * "17") and execute's refinement is what makes it a posed-or-rejected
 * call. The display parse follows the same order so an input that could
 * never have been posed (e.g. `correctAnswer: undefined`, which Convert
 * widens to "") renders as a quiet fallback, not a broken quiz.
 */
/** LaTeX-escape restoration, deep over every string field (the JSON-debris
 *  fix, owner ruling 2026-09-26): records persist RAW call args, so
 *  single-backslash LaTeX eaten by JSON escape resolution (FF ate the 'f' of
 *  \forall, VT the 'v' of \varphi, TAB the 't' of \to) survives to the
 *  display path. This is the ONE seam every rendered question passes
 *  through — new turns and already-poisoned records alike heal here.
 *  healOverescapedCommands (owner ruling 2026-10-15) rides the same walk:
 *  the same models also stochastically DOUBLE command backslashes
 *  (`\\nabla` saved where `\nabla` was meant — KaTeX shows the row break
 *  plus "nabla" as letters), so even runs before a command start inside
 *  balanced math spans collapse to one backslash. */
function restoreQuestionTextDeep(value: unknown): unknown {
	if (typeof value === "string") return repairMathForDisplay(value);
	if (Array.isArray(value)) return value.map(restoreQuestionTextDeep);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = restoreQuestionTextDeep(k === "question" && typeof v === "string" ? restoreQuestionCode(v) : v);
		}
		return out;
	}
	return value;
}

export function parseQuizInput(input: unknown): QuizToolInput | undefined {
	// quizDisplayInputSchema (question-core, owner 2026-10-03): base + the
	// OPTIONAL `type` — new teach-phase records carry predict|check and the
	// dock renders/gates by it (normalizeQuizType at the read seam); old and
	// probe records carry none. nodeId stays an unknown key Value.Clean
	// strips, exactly as before.
	// The display mirror of the boundary heal (whitehead, 2026-10-09): the
	// record keeps RAW arguments, so the recorded `type: "\"predict\""`
	// wobble must heal HERE too or a posed quiz renders invisible (the
	// tool-parts law). healEncodedArguments is the same pure pass the
	// boundary's withArgumentHeal runs.
	const healedInput = healEncodedArguments(restoreQuestionTextDeep(input), quizDisplayInputSchema);
	const cleaned = boundaryParse<QuizToolInput>(quizDisplayInputSchema, healedInput);
	if (!cleaned) return undefined;
	if (quizInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

/**
 * Ask parse for DISPLAY: the full ask schema (options optional — free-text
 * mode is the options-less shape), plus the option-sanity refinement the
 * boundary enforced (askOptionProblems — duplicate values break the dock's
 * keying, so they parse to undefined exactly like the zod seam did).
 */
export function parseAskInput(input: unknown): AskToolInput | undefined {
	const cleaned = boundaryParse<AskToolInput>(askInputSchema, restoreQuestionTextDeep(input));
	if (!cleaned) return undefined;
	if (askOptionProblems(cleaned.options ?? []).length > 0) return undefined;
	return cleaned;
}

/** Explain parse for DISPLAY: the display schema (base + OPTIONAL
 *  lenient `type`, exactly the quiz pattern — teach explain calls carry
 *  the role since 2026-10-09; the commitment refinement
 *  (explainInputProblems) mirrors the boundary chain). Both explain
 *  variants share the same fields; the teacher's nodeId is an unknown
 *  key Value.Clean strips, same as the quiz seam. */
export function parseExplainInput(input: unknown): ExplainToolInput | undefined {
	const cleaned = boundaryParse<ExplainToolInput>(explainDisplayInputSchema, restoreQuestionTextDeep(input));
	if (!cleaned) return undefined;
	if (explainInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

/** probe_done parse — the core-owned schema the tool itself declares. */
export function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined {
	return boundaryParse<ProbeDoneInput>(probeDoneInputSchema, input);
}