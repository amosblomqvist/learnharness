"use client";

import { ChevronRightIcon, ClipboardCheckIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/core";

/**
 * The probe conclusion card (docs/archive/probe-teach-split.md §2): renders the
 * prober's probe_done call. The INPUT is the learner assessment — strand by
 * strand, where his edge sits — and it belongs to the learner as much as to
 * the transcript. The completed assessment is a collapsed handoff artifact;
 * expanding it reveals the full formatted input. The live-tool row while
 * writing is owned by chat.tsx. The OUTPUT is the seam's ack (ok) or the refusal
 * the prober retried on (rendered quiet and small — it is model-facing
 * bookkeeping, kept only for transcript honesty).
 *
 * The input preview is only trustworthy while the call is pending — an
 * input-available input cleared schema validation at the boundary, and a
 * mid-stream partial is guarded below. An output-error part's input was
 * REJECTED by validation and can be any shape (live crash: the model
 * stringified `assessment`); never render it.
 *
 * Native disclosure state is local to this mounted card, not persisted.
 * Refusals, malformed calls and the writing fallback remain visible/plain.
 */
export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const output = part.output as ProbeDoneResult | undefined;
	const state = typeof part.state === "string" ? part.state : "";

	// Parse, don't cast (the seam rule, src/core/tool-parts.ts): the model
	// authored this input — it is consumer-trustworthy only if the SAME
	// schema the tool declared says so. The parse subsumes the old state
	// reasoning and shape guards: an errored call's stringified assessment,
	// a mid-stream partial — anything that doesn't parse falls to the
	// fallback branch. Output stays a cast: OUR execute authored it.
	const input = parseProbeDoneInput(part.input);

	// The assessment is the CALL's input (owner, context diet 2026-10-09):
	// the result's echo is gone — details is {ok:true} only, and the refusal
	// branch below still reads output.error.
	const assessment = input?.assessment;
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;

	const heading = <>
		<ClipboardCheckIcon className="size-3.5 text-primary" />
		<span className="min-w-0 truncate">Probe assessment</span>
	</>;
	const note = output && !output.ok ? <>
		The prober retried: {output.error}
	</> : state === "output-error" ? "The assessment was malformed — the prober retried with a corrected one."
		: !strands ? "Writing the assessment…" : null;

	if (note || !strands) return (
		<div data-testid="probe-done-card" className="my-3 rounded-xl border bg-card/60 p-3">
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{heading}
			</div>
			<p className="text-sm text-muted-foreground">{note}</p>
		</div>
	);

	return (
		<details data-testid="probe-done-card" className="group my-3 overflow-hidden rounded-xl border bg-card/60">
			<summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl p-3 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/40 group-open:rounded-b-none group-open:border-b [&::-webkit-details-marker]:hidden">
				{heading}
				<span className="ml-auto shrink-0 font-normal normal-case tracking-normal text-muted-foreground/70">
					{strands.length} strand{strands.length === 1 ? "" : "s"}
				</span>
				<ChevronRightIcon className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="divide-y">
				{strands.map((s, i) => (
					<div key={i} className="px-3 py-2">
						<ToolContentResponse className="text-sm font-medium">{s.strand}</ToolContentResponse>
						<ToolContentResponse className="mt-0.5 text-sm text-muted-foreground">{s.assessment}</ToolContentResponse>
					</div>
				))}
				{assessment?.summary && (
					<div className="px-3 py-2">
						<ToolContentResponse className="text-sm text-muted-foreground">{assessment.summary}</ToolContentResponse>
					</div>
				)}
			</div>
		</details>
	);
}
