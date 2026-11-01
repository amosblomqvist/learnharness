/**
 * question-gate — the PRE-DELIVERY semantic gate for authored question cards
 * (#417, owner-approved increment 1, 2026-11-01).
 *
 * Structural validation (core/question-core) proves a card is GRADEABLE; it
 * cannot know the key is WRONG. This seam asks a cheap verifier model to
 * check the card's internal consistency before the learner can see it:
 * stem ↔ correctAnswer ↔ explanation ↔ options agreement, exactly one
 * defensible answer, no arithmetic/factual error in the explanation.
 *
 * Placement: the TEACH question tools call it inside `execute` AFTER their
 * structural contract passes and only when there are no problems — so a
 * malformed call never spends a verifier call. The wire defers the learner-
 * facing part to `tool_execution_end` (server/pi/ui-stream.ts), so an awaited
 * verdict keeps the card in `input-streaming`: a rejection returns the SAME
 * invalid-input error result the tutor already retries on, in the SAME turn,
 * and the card cannot arm. The projection HIDES the rejected attempt
 * (core/view.ts); the record keeps it and the model context is untouched.
 *
 * FAIL-OPEN is the law (owner decision): no engine, no verdict, verifier
 * error, or the 8s timeout all ACCEPT the card — a quality aid must never
 * wedge a lesson. Only a PARENT ABORT propagates (a cancelled turn stays
 * cancelled). The verdict is a background-purpose model call on the hidden
 * `questionVerifier` role (cheap slot); its usage folds into the turn's money
 * channel through the injected onUsage callback.
 */

import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { runSubmitAgent } from "./subagents/submit-agent.ts";
import type { PiEngine } from "./models.ts";

/** Owner-approved increment-1 budget: the card waits behind the existing
 *  "Writing a question…" shimmer; past this we deliver unverified. */
export const QUESTION_GATE_TIMEOUT_MS = 8_000;

/** The rejection head is the SHARED contract string (core/contracts/chat.ts):
 *  this module writes it into the model-facing problem list, and the
 *  client-safe projection (core/view.ts) matches it to hide the rejected
 *  attempt from the learner. Re-exported because the question tools import it
 *  from THIS module (one question-gate vocabulary). */
export { QUESTION_GATE_REJECTION_HEAD } from "../core/contracts/chat.ts";

/** Per tool instance (one turn): after this many rejected cards the next pose
 *  is delivered unverified — the gate can never trap a lesson in a retry
 *  loop the model can't satisfy (false-positive guard, owner decision). */
export const QUESTION_GATE_MAX_BOUNCES = 2;

export interface QuestionGateRequest {
	/** The model-facing tool name (quiz / explain — v1 gates TEACH only). */
	tool: string;
	/** The validated tool input (the card). */
	input: Record<string, unknown>;
	/** The live turn's abort signal (pi passes it to every tool execute). */
	signal?: AbortSignal;
}

export type QuestionGateOutcome =
	| { accepted: true; skipped?: string }
	| { accepted: false; problems: string[] };

export type QuestionGateFn = (req: QuestionGateRequest) => Promise<QuestionGateOutcome>;

export interface QuestionGateOptions {
	/** Settings-resolved cheap-slot engine (server resolves it; absent =
	 *  no gate — fail-open, BYOK installs without a cheap model behave
	 *  exactly like today). */
	engine?: PiEngine;
	/** Money channel: one callback per verifier model call. */
	onUsage?: (usage: Usage) => void;
	timeoutMs?: number;
	/** Debug tooling key (provider-event recording when enabled). */
	chatId?: string;
}

/** Test seam (the researchModelOverride idiom): lets a scripted engine drive
 *  createQuestionGate without production wiring. Never set in production. */
export const questionGateEngineOverride: { current?: PiEngine } = {};

/** The settings switch's resolved value: absent = ENABLED (the repo's toggle
 *  discipline); explicit false is the escape hatch. Exported so the
 *  composition root and tests share ONE truth. */
export function questionGateEnabled(settings?: { enabled?: boolean }): boolean {
	return settings?.enabled !== false;
}

const gateVerdictSchema = Type.Object({
	verdict: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
	problems: Type.Array(Type.String()),
});

interface GateVerdict {
	verdict: "accept" | "reject";
	problems: string[];
}

/** The old zod-default idempotent fill (runSubmitAgent seam): a schema-valid
 *  submit always yields a complete verdict. */
function fillVerdict(input: GateVerdict): GateVerdict {
	return {
		verdict: input.verdict,
		problems: Array.isArray(input.problems)
			? input.problems.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean)
			: [],
	};
}

/** Semantic validation at the submit seam (runSubmitAgent: a returned
 *  problem is an isError result → the verifier retries within maxTurns). */
function validateVerdict(verdict: GateVerdict): string | null {
	if (verdict.verdict === "reject" && verdict.problems.length === 0) {
		return "A reject verdict needs at least one definite problem — accept when uncertain.";
	}
	if (verdict.verdict === "accept" && verdict.problems.length > 0) {
		return "An accept verdict lists no problems — use reject for definite defects.";
	}
	if (verdict.problems.length > 3) {
		return "List at most 3 definite problems — fix the load-bearing defect first.";
	}
	return null;
}

/** The verifier contract, tightened for false-positive-averse judgment:
 *  internal consistency only (no style, difficulty, curriculum fit, or
 *  outside lookups), definite defects only, uncertainty accepts. */
const QUESTION_GATE_INSTRUCTIONS = `You review ONE question card before it reaches a learner. Verify ONLY the card's internal correctness:
1. The stem has exactly one defensible answer.
2. correctAnswer actually answers the stem.
3. The explanation is consistent with the key and contains no arithmetic or factual error.
4. No other option is also defensible as correct (for multi-select, the exact set is the correct one).
5. The answer is not inferable from option length, formatting, or wording alone.

Do NOT judge style, difficulty, pedagogy, curriculum fit, or whether the question is worth asking. Do not use outside knowledge beyond what is required to check the card's own claim. If you are uncertain, ACCEPT. Report only DEFINITE defects.

Call submit_verification — a prose message does not submit a verdict. On reject, list 1-3 concrete problems: what is wrong and what to fix.`;

/** The card subset the verifier sees — never learner history, transcripts,
 *  or plan prose. */
export function buildGatePrompt(tool: string, input: Record<string, unknown>): string {
	const card: Record<string, unknown> = { tool, question: input.question };
	if (Array.isArray(input.options)) {
		card.options = input.options.map((option) => {
			const o = (option ?? {}) as { label?: unknown; value?: unknown };
			const out: Record<string, unknown> = { label: typeof o.label === "string" ? o.label : String(o.label ?? "") };
			if (typeof o.value === "string" && o.value.length > 0) out.value = o.value;
			return out;
		});
	}
	if (input.correctAnswer !== undefined) card.correctAnswer = input.correctAnswer;
	if (input.explanation !== undefined) card.explanation = input.explanation;
	if (input.multiSelect !== undefined) card.multiSelect = input.multiSelect;
	if (input.type !== undefined) card.type = input.type;
	if (input.nodeId !== undefined) card.nodeId = input.nodeId;
	return `Review this question card before it is shown to the learner:\n${JSON.stringify(card, null, 1)}`;
}

function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

/**
 * One verdict for one card. Fail-open everywhere except a parent abort.
 * Exported (not just used by createQuestionGate) so the tool-boundary and
 * timeout tests can drive it directly.
 */
export async function verifyQuestion(args: {
	tool: string;
	input: Record<string, unknown>;
	engine?: PiEngine;
	signal?: AbortSignal;
	timeoutMs?: number;
	chatId?: string;
	onUsage?: (usage: Usage) => void;
}): Promise<QuestionGateOutcome> {
	const { tool, input, engine, signal } = args;
	// No verifier model = no gate. The record's callers treat this as an
	// ordinary clean pose (fail-open), never as an error the tutor must fix.
	if (!engine) return { accepted: true, skipped: "no-engine" };
	if (signal?.aborted) throw abortError();

	const timeoutMs = args.timeoutMs ?? QUESTION_GATE_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const onParentAbort = () => controller.abort();
	signal?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const verdict = await runSubmitAgent<GateVerdict>({
			role: "questionVerifier",
			toolName: "submit_verification",
			toolDescription:
				"Submit the verdict for this ONE question card: accept (no definite defect), or reject with 1-3 concrete problems.",
			parameters: gateVerdictSchema,
			fill: fillVerdict,
			validate: validateVerdict,
			systemPrompt: QUESTION_GATE_INSTRUCTIONS,
			prompt: buildGatePrompt(tool, input),
			engine,
			signal: controller.signal,
			onStep: (usage) => args.onUsage?.(usage),
			neverSubmitted: "the verifier submitted no verdict",
			maxTurns: 2,
			chatId: args.chatId,
		});
		if (verdict.verdict === "reject") return { accepted: false, problems: verdict.problems };
		return { accepted: true };
	} catch (error) {
		// A cancelled TURN is not a quality decision: propagate so the abort
		// path owns the record exactly as it does for every other tool.
		if (signal?.aborted) throw abortError();
		const reason = timedOut
			? `timeout after ${timeoutMs}ms`
			: error instanceof Error
				? error.message
				: "verifier error";
		console.warn(`[question-gate] fail-open (${tool}): ${reason}`);
		return { accepted: true, skipped: timedOut ? "timeout" : "verifier-error" };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onParentAbort);
	}
}

/** The turn-scoped gate: dedupes an identical re-pose (a model retrying the
 *  same card byte-for-byte does not buy a second verdict) and falls back to
 *  the test override. undefined = no verifier engine → tools see no gate. */
export function createQuestionGate(options: QuestionGateOptions = {}): QuestionGateFn | undefined {
	const engine = options.engine ?? questionGateEngineOverride.current;
	if (!engine) return undefined;
	const verdicts = new Map<string, QuestionGateOutcome>();
	return async (request) => {
		const key = `${request.tool}\n${JSON.stringify(request.input)}`;
		const cached = verdicts.get(key);
		if (cached) return cached;
		const outcome = await verifyQuestion({
			tool: request.tool,
			input: request.input,
			engine,
			signal: request.signal,
			timeoutMs: options.timeoutMs,
			chatId: options.chatId,
			onUsage: options.onUsage,
		});
		verdicts.set(key, outcome);
		return outcome;
	};
}
