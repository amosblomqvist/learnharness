/**
 * runSubmitAgent — the shared single-submit agent seam (moved verbatim from
 * extraction.ts): one TypeBox-validated submit
 * call is the whole deliverable (a pi agent purely so the model can retry a
 * schema-invalid call). The submitted value is captured from the execute
 * seam, which only fires on a schema-valid call — the ??-fill (the old zod
 * defaults) applies at the capture.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { messageUsagePresence, type UsagePresence } from "../../core/contracts/chat.ts";
import { healToolRecord } from "../tools/heal.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";

// ── the weak-model string-heal (owner, 2026-09-28; moved here from
// extraction.ts with the digest-aware redesign, 2026-09-30 — the heal
// is wire-format medicine shared by every submit agent) ──
//
// OpenRouter log evidence: weak models under a big submit payload often
// emit a whole array as ONE JSON-STRING instead of a native array
// ("propositions.0: must be object"). pi-agent-core runs
// `prepareArguments` BEFORE TypeBox validation — the sanctioned shim
// point (same doctrine as restoreMathEscapes at the display seam: heal
// weak-model wire behavior, don't punish it with a retry). Best-effort:
// heal only a string that parses to an array; anything else passes
// through untouched and fails validation exactly as before.
export function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "chains"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	/** Weak-model tolerance: the old zod `.default()`s, applied to the
	 *  schema-valid raw input at the submit seam. */
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string, presence: boolean | Partial<UsagePresence>) => void;
	neverSubmitted: string;
	/** Extra tools beside the submit call (the auditor's graph-exploration
	 *  set, 2026-09-27): a small agentic loop instead of a bare retry. */
	extraTools?: Record<string, AgentTool<any>>;
	/** Turn budget for the loop (default 4 = retry-only; the auditor runs
	 *  an exploration loop instead — 16). */
	maxTurns?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** Weak-model argument heal at pi's prepareArguments seam (runs BEFORE
	 *  TypeBox validation — the sanctioned shim point). Identity by
	 *  default; extraction wires healStringifiedArrays here. */
	prepareArguments?: (args: unknown) => unknown;
	/** Semantic validation at the submit seam: the value is schema-valid
	 *  but may violate a PIPELINE law (coverage, echo-equality). Returning
	 *  a problem string yields an isError result (invalidInputResult) →
	 *  the model retries within maxTurns. null = accept. */
	validate?: (value: T) => string | null;
}): Promise<T> {
	let submitted: T | undefined;
	const result = await runSubagent(
		[
			// healToolRecord (owner, 2026-10-09): the standard argument heal
		// over the extra tools (the auditor's graph set) — same as every
		// registry.
		...(opts.extraTools ? Object.values(healToolRecord(opts.extraTools)) : []),
			{
				name: opts.toolName,
				label: opts.toolName,
				description: opts.toolDescription,
				parameters: opts.parameters,
				prepareArguments: (args) =>
					// The standard heal composes AFTER the caller's shim (the
					// whitehead generalization, 2026-10-09) — extraction's
					// healStringifiedArrays stays the inner pass.
					healEncodedArguments(
						opts.prepareArguments ? opts.prepareArguments(args) : args,
						opts.parameters,
					) as never,
				execute: async (_toolCallId, input) => {
					const value = opts.fill(input);
					const problem = opts.validate?.(value) ?? null;
					if (problem) return invalidInputResult(opts.toolName, [problem]);
					submitted = value;
					return toToolResult(submitted);
				},
			} satisfies AgentTool<any>,
		],
		{
			role: opts.role,
			engine: opts.engine,
			systemPrompt: opts.systemPrompt,
			prompt: opts.prompt,
			maxTurns: opts.maxTurns ?? 4,
			abortSignal: opts.signal,
			chatId: opts.chatId,
			onAssistantMessage: (message, step) =>
				opts.onStep(
					message.usage,
					// Provider-qualified stamp (model slots wave, 2026-09-20):
					// pi reports the bare id; usage stamps carry provider:id to
					// match the price table's uniform keys.
					`${message.provider}:${message.model}`,
					step,
					message.stopReason,
					message.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name).join(", ") || "(none)",
					// Usage presence (contracts/chat.ts): the capture keeps an
					// unreported call unknown instead of a priced zero.
					messageUsagePresence(message),
				),
			shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
		},
	);
	void result;
	if (!submitted) throw new Error(opts.neverSubmitted);
	return submitted;
}
