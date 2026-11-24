import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { CONCLUDE_ACK_TEXT } from "../core/contracts/chat.ts";

/**
 * tool-execute — the execution machinery every server-side lh tool shares,
 * expressed natively (Wave A of the pi-native migration, 2026-09-26): tools
 * are authored as pi-agent-core AgentTools (TypeBox parameters, native
 * execute), and this module owns the semantics the old LhTool wrapper
 * (lh-tool.ts, deleted) used to add around every execute:
 *
 * - the system-level per-call timeout + abort cascade (runWithAbortGuard),
 * - the authoring-refinement failure shape (invalidInputResult —
 *   returned from execute as an isError result; pi 1.0's convention, the
 *   model sees the same retryable problem list it always did, and
 *   `details` keeps the problems as data),
 * - the result mapping (string verbatim / object JSON / image results to
 *   native content parts; details carries the record-facing value),
 * - the question-tool placeholder (quiz / ask_user_question): a synthetic
 *   "question posed" result that is NEVER persisted — the record keeps the
 *   tool part output-less until the client answers; the learner's answer
 *   re-enters the next turn as this call's result. terminate: true (owner
 *   Option A, 2026-09-25) ends single-question batches natively; the slim
 *   shouldStopAfterTurn stopper (teacher-agent.ts) holds the belt-and-
 *   suspenders rule for mixed batches.
 *
 * Structural validation is NOT here: pi's loop validates arguments against
 * the tool's TypeBox parameters before execute ever runs (pi-ai's
 * validateToolArguments — the fast TypeBox path). Refinements that no
 * schema can carry (quizInputProblems, the live-tree nodeId check) run at
 * the top of the tool's own execute and throw ToolInputError.
 */

/**
 * System-level per-call timeout (2026-09-19, the abort-cascade fix): pi
 * passes every run's AbortSignal to tool execute, but the signal only
 * lands at a step boundary — so a long-running local tool (the grep that
 * outlived its turn by minutes) could hold the turn hostage until the dev
 * server's memory restart killed the run mid-tool, freezing the record at
 * its write-ahead state (the "went back in time" rollback). The guard
 * races every execute against (a) the run's signal and (b) this timeout,
 * rejecting with pi's own wording ("Operation aborted") on abort and a
 * clear timeout message otherwise — pi turns the throw into an error tool
 * result the model can see.
 */
const TOOL_TIMEOUT_MS = 30_000;
/** Test seam (runner.ts's pdfModelOverride idiom). */
export const toolTimeoutMs = { current: TOOL_TIMEOUT_MS };

/** How long an aborted/timed-out call may take to settle on its own before
 *  the hard reject lands — cooperative tools poll the signal and return
 *  partial results within a tick or two (the fs tools check per file). */
const TOOL_ABORT_GRACE_MS = 250;

function runWithAbortGuard<T>(
	toolName: string,
	run: (signal: AbortSignal) => T | Promise<T>,
	parent: AbortSignal | undefined,
): Promise<T> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
	}
	const timeoutMs = toolTimeoutMs.current;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const humanTimeout = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		clearTimeout(timer);
		if (graceTimer) clearTimeout(graceTimer);
		parent?.removeEventListener("abort", forwardAbort);
	};
	return new Promise<T>((resolve, reject) => {
		const settle = (fn: () => void) => {
			controller.signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
			fn();
		};
		const onAbort = () => {
			// Cooperative tools poll the signal and settle with partial
			// results within a tick or two (the fs tools check per file) —
			// give them a brief grace to deliver those before the hard
			// reject, so abort KILLS a stuck tool without racing away a
			// graceful one's partial result.
			graceTimer = setTimeout(
				() =>
					reject(
						new Error(
							parent?.aborted
								? "Operation aborted"
								: `Tool "${toolName}" timed out after ${humanTimeout} — the result was discarded`,
						),
					),
				TOOL_ABORT_GRACE_MS,
			);
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		if (controller.signal.aborted) onAbort(); // an already-aborted signal never fires listeners
		Promise.resolve()
			.then(() => run(controller.signal))
			.then(
				(v) => settle(() => resolve(v)),
				(e) => settle(() => reject(e)),
			);
	})
		.finally(cleanup);
}

/** The 1.0-native authoring-failure result (pi convention, agent-core
 *  1.0): return an isError result instead of throwing — the model sees the
 *  same retryable problem list it always did (pi minted exactly this shape
 *  from a thrown ToolInputError), but `details` now keeps the problems as
 *  DATA for the record and the UI instead of the throw path's empty {}.
 *  Content text is byte-identical to the old thrown message. */
export function invalidInputResult(
	toolName: string,
	problems: string[],
): AgentToolResult<{ tool: string; problems: string[] }> {
	return {
		content: [
			{
				type: "text",
				text: `Invalid tool input for tool "${toolName}":\n${problems.map((p) => `- ${p}`).join("\n")}`,
			},
		],
		isError: true,
		details: { tool: toolName, problems },
	};
}

/**
 * Rich tool-result escape hatch (2026-09 sources v0): a tool whose result
 * includes IMAGES (the read tool reading an image file) returns this shape
 * instead of a plain value — toToolResult maps it to pi's native
 * tool-result content parts (TextContent | ImageContent)[] so the
 * vision-capable model actually SEES the image. `images` carries base64
 * data + mimeType, exactly as pi's ImageContent wants. `details` rides
 * through to the record untouched.
 */
export interface ImageFileResult {
	text: string;
	images?: { data: string; mimeType: string }[];
	/** The record-facing result (client rendering / persistence). */
	details?: unknown;
}

function isImageResult(v: unknown): v is ImageFileResult {
	return (
		typeof v === "object" && v !== null && "text" in v && typeof (v as ImageFileResult).text === "string"
	);
}

/**
 * Map a tool body's return to the native AgentToolResult — the parity the
 * old toPiTool tail owned: string results pass verbatim to the model,
 * objects as JSON; `details` carries the RAW value (the record's tool part
 * output reads it, ui-stream), and image results become native content
 * parts with details ?? null.
 */
export function toToolResult(result: unknown): AgentToolResult<unknown> {
	if (isImageResult(result)) {
		return {
			content: [
				{ type: "text", text: result.text },
				...(result.images ?? []).map((img) => ({
					type: "image" as const,
					data: img.data,
					mimeType: img.mimeType,
				})),
			],
			details: result.details ?? null,
		};
	}
	return {
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

/** What a server-executed tool's body receives: the call id + the guard's
 *  combined signal (run abort + per-call timeout) for cooperative polling. */
export interface ToolExecuteContext {
	toolCallId: string;
	signal?: AbortSignal;
}

/**
 * Build a native AgentTool execute from a tool body — the guard (timeout +
 * abort cascade) plus the shared result mapping, byte-identical to the old
 * toPiTool pipeline for every server-side tool. Question tools do NOT use
 * this: their placeholder is instant (questionResult below) and their
 * refinement checks run before it.
 */
export function serverExecute<P extends TSchema>(
	toolName: string,
	schema: P,
	run: (input: Static<P>, ctx: ToolExecuteContext) => unknown,
): AgentTool<any>["execute"] {
	// The returned execute is deliberately typed loose (params: unknown) so
	// it satisfies every AgentTool slot — heterogeneous registries type
	// AgentTool<any>, whose Static is unknown, and strictFunctionTypes
	// rejects a params-narrower function against it. The loop has already
	// validated arguments against `schema` (runtime) and `run` keeps the
	// precise Static<P> input; `schema` exists in the signature precisely so
	// P infers from the call site, not the loose surface.
	return async (toolCallId, input: unknown, signal) =>
		toToolResult(
			await runWithAbortGuard(toolName, (toolSignal) => run(input as Static<P>, { toolCallId, signal: toolSignal }), signal),
		);
}

/**
 * The synthetic question-tool result (in-memory only; the record's tool
 * part keeps no output until the learner answers). terminate: true ends
 * the batch natively — pi stops the loop when every finalized result in
 * the batch terminates; the shouldStopAfterTurn stopper covers the mixed
 * batch (question + other calls in one message) that terminate-only
 * semantics would let run on (owner Option A, 2026-09-25).
 */
export function questionResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.",
			},
		],
		details: null,
		terminate: true,
	};
}

/** The practice pose's ack (practice sessions, owner 2026-10-04): unlike
 *  a question, this result is FINAL — it persists (persistTurn filters
 *  only QUESTION_TOOLS placeholders), because the learner's submissions
 *  arrive as MESSAGES, never as this call's result. terminate: true ends
 *  the turn at the pose; the commitment rides the call's arguments. */
export function problemResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Problem posed — the turn ends here; the learner's thinking traces and answer commits arrive as labeled messages.",
			},
		],
		details: null,
		terminate: true,
	};
}

/** The conclude ack: NOT terminate — the turn continues so the same reply
 *  can reveal + pose the next problem. Text single-sourced in contracts
 *  (CONCLUDE_ACK_TEXT — shared with the dismissal-synthesized pair). */
export function concludeResult(): AgentToolResult<null> {
	return {
		content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
		details: null,
	};
}
