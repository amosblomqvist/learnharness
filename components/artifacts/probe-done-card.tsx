"use client";

import { ClipboardCheckIcon } from "lucide-react";
import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/core";
import { useT } from "@/components/i18n";

/**
 * The probe conclusion card (docs/probe-teach-split.md §2): renders the
 * prober's probe_done call. The INPUT is the learner assessment — strand by
 * strand, where his edge sits — and it belongs to the learner as much as to
 * the transcript: it streams live while the prober writes it and stays as
 * the handoff artifact. The OUTPUT is the seam's ack (ok) or the refusal
 * the prober retried on (rendered quiet and small — it is model-facing
 * bookkeeping, kept only for transcript honesty).
 *
 * The input preview is only trustworthy while the call is pending — an
 * input-available input cleared schema validation at the boundary, and a
 * mid-stream partial is guarded below. An output-error part's input was
 * REJECTED by validation and can be any shape (live crash: the model
 * stringified `assessment`); never render it.
 *
 * Deliberately plain v1: the proper assessment viewer design is deferred to
 * the UI wave; this card just guarantees the data is never invisible.
 */
export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const t = useT();
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

	return (
		<div data-testid="probe-done-card" className="my-3 rounded-xl border bg-card/60 p-3">
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<ClipboardCheckIcon className="size-3.5 text-primary" />
				{t("artifacts.probeDone.title")}
			</div>
			{output && !output.ok ? (
				<p className="text-sm text-muted-foreground">{t("artifacts.probeDone.retried", { error: output.error ?? "" })}</p>
			) : state === "output-error" ? (
				<p className="text-sm text-muted-foreground">{t("artifacts.probeDone.malformed")}</p>
			) : strands ? (
				<div className="space-y-2">
					{strands.map((s, i) => (
						<div key={i} className="rounded-lg bg-background/60 px-3 py-2">
							<div className="text-sm font-medium">{s.strand}</div>
							<div className="mt-0.5 text-sm text-muted-foreground">{s.assessment}</div>
						</div>
					))}
					{assessment?.summary && (
						<p className="px-1 text-sm text-muted-foreground">{assessment.summary}</p>
					)}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">{t("artifacts.probeDone.writing")}</p>
			)}
		</div>
	);
}