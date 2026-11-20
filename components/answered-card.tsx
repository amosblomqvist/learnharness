"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ConfidenceRail } from "@/components/confidence-rail";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { StatusBadge } from "@/components/ui/status-badge";
import { SubmittedImages } from "./submitted-images";
import { ThinkingBlock } from "@/components/thinking-block";
import { PathText } from "@/components/file-path-chip";
import { cn } from "@/lib/utils";
import { ToolContentResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import { answeredOptionLetters, answerForPresentation, parseAskInput, parseQuizInput } from "@/src/core";
import { useAppearance } from "@/components/settings/appearance";
import { questionCardLabel, questionCardStandIn } from "@/components/question-dock";
import {
	ANSWER_COLUMN_INSET_CSS,
	COLUMN_GAP_CSS,
	layoutFontKey,
	questionCardGeometry,
	rootRem,
} from "@/components/question-layout";
import { useQuestionLayout, type QuestionLayoutRequest } from "@/components/use-question-layout";

/** The nearest scrolling ancestor (the transcript), for "near the screen". */
function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
	}
	return null;
}

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer: savedAnswer, input, toolCallId }: { answer: QuestionAnswerData; input?: unknown; toolCallId?: string }) {
	const answer = answerForPresentation(savedAnswer, input);
	const optionLetters = answeredOptionLetters(savedAnswer, input);
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)

	// ADAPT QUESTION LAYOUT on the record (owner, session-appearance-layout):
	// an answered question gets two columns exactly when its question card
	// did — the same solver, measured on a stand-in of the question card
	// (questionCardStandIn) built from this card's own rendered markdown,
	// at the same reference width. The card stays full transcript width:
	// the answer column keeps the question card's width, the question takes
	// the rest. Measured once, the first time the card nears the screen.
	const { appearance } = useAppearance();
	const cardRef = useRef<HTMLDivElement>(null);
	const questionColRef = useRef<HTMLDivElement>(null);
	const questionTextRef = useRef<HTMLDivElement>(null);
	const detailsRef = useRef<HTMLDivElement>(null);
	const optionsRef = useRef<HTMLDivElement>(null);
	const adaptable = appearance.adaptiveQuestions && !!toolCallId && !answer.dismissed
		&& (answer.kind === "quiz" || answer.kind === "ask") && (answer.options?.length ?? 0) > 0;
	const [near, setNear] = useState(false);
	const [cardInner, setCardInner] = useState(0);
	const [rem, setRem] = useState(16);
	useEffect(() => {
		const card = cardRef.current;
		if (!adaptable || near || !card) return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) setNear(true);
		}, { root: scrollParent(card), rootMargin: "100% 0px" });
		io.observe(card);
		return () => io.disconnect();
	}, [adaptable, near]);
	useEffect(() => {
		const card = cardRef.current;
		if (!adaptable || !near || !card) return;
		// The card's inner width (its padding included, borders not) is the
		// question card's budget in the dock: the same transcript width.
		const measure = () => {
			setCardInner(card.clientWidth);
			setRem(rootRem(card.ownerDocument));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(card);
		return () => ro.disconnect();
	}, [adaptable, near]);
	const fontKey = layoutFontKey(appearance);
	const geometry = questionCardGeometry(rem);
	const request: QuestionLayoutRequest | null = adaptable && near && cardInner > 0
		? { available: cardInner, base: geometry.base, floor: geometry.floor, key: fontKey }
		: null;
	const multiSelect = (answer.kind === "quiz" ? parseQuizInput(input)?.multiSelect : parseAskInput(input)?.multiSelect) ?? false;
	const label = questionCardLabel(answer.tool, answer.kind, answer.questionType);
	const layout = useQuestionLayout({
		cacheId: `answered|${toolCallId ?? ""}`,
		request,
		identity: toolCallId,
		live: () => {
			const card = cardRef.current;
			const question = questionColRef.current;
			const text = questionTextRef.current;
			if (!card || !question || !text) return null;
			return { root: card, question, options: optionsRef.current, observe: [text, detailsRef.current, optionsRef.current] };
		},
		parts: (live) => {
			const labels = [...(live.options?.querySelectorAll<HTMLElement>("[data-answered-option-label]") ?? [])];
			const standIn = questionCardStandIn(live.root.ownerDocument, {
				label,
				kind: answer.kind === "quiz" ? "quiz" : "ask",
				multiSelect,
				question: questionTextRef.current!,
				context: detailsRef.current,
				options: labels,
				optionLetters: answer.options?.map(({ index }) => optionLetters.get(index)),
			});
			return { root: live.root, ...standIn, media: { question: live.question, options: live.options } };
		},
	});
	const columns = layout?.kind === "columns" ? layout : null;
	const columnStyle: CSSProperties | undefined = columns
		? { gridTemplateColumns: `minmax(0, 1fr) calc(${columns.answer}px - ${ANSWER_COLUMN_INSET_CSS})`, columnGap: COLUMN_GAP_CSS }
		: undefined;

	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees, compactAnswerForModel) is untouched;
	// any parse failure or absent input renders exactly the older card.
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const parsedDetails = askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

	return (
		<>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    rendered as its own user-side block ABOVE the card, the unified
		    ThinkingBlock, instead of an inset inside the answer. Same muted
		    rail as before; the label is now plain "Your thinking". */}
		{(answer.readingThinking || answer.images?.readingThinking?.length) && (
			<ThinkingBlock testId="reading-thinking-block" label="YOUR THINKING" text={answer.readingThinking ?? ""} images={answer.images?.readingThinking} defaultOpen />
		)}
		{/* [&>*:last-child]:mb-0 (owner round, 2026-10-07): on ask cards the
		    thinking row is the last child — its my-3 stacked with the card's
		    p-4 into a 28px void below (12px above); the card's own padding is
		    the bottom rhythm when a row ends the card. */}
		<div
			ref={cardRef}
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
			data-question-layout={columns ? "columns" : "stacked"}
		>
			{/* Two columns (Adapt question layout): question left; options,
			    confidence and the answer right, centered; everything else full
			    width below. Stacked, the wrappers are display: contents — the
			    card is exactly the stacked one. */}
			<div className={columns ? "grid" : "contents"} style={columnStyle}>
			<div ref={questionColRef} className={columns ? "min-w-0 [&>*:last-child]:mb-0" : "contents"}>
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The tool's OWN name first (owner 2026-10-09): probe-phase
			    cards label Probe/Recall — the phase boundary visible in the
			    transcript. No `tool` on old records: kind labels as before. */}
				{label}
				{isQuiz &&
					(answer.dontKnow ? (
						<StatusBadge text="didn't know" />
					) : answer.correct ? (
						<StatusBadge text="correct" color="var(--lh-success)" />
					) : (
						<StatusBadge text="incorrect" color="var(--lh-error)" />
					))}
			</div>
			<div ref={questionTextRef} className="mb-3 font-medium">
				<ToolContentResponse>{answer.questionText}</ToolContentResponse>
			</div>
			{parsedDetails && (
				// The details line, same paint as the pending dock (owner,
				// 2026-10-12): full markdown, LaTeX included.
				<div ref={detailsRef} className="mb-3 text-sm text-muted-foreground">
					<ToolContentResponse>{parsedDetails}</ToolContentResponse>
				</div>
			)}
			</div>
			<div className={columns ? "flex min-w-0 flex-col justify-center" : "contents"}>

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div ref={optionsRef} className="flex flex-col gap-1.5 text-sm">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						const letter = optionLetters.get(opt.index);
						return (
							<div
								key={opt.index}
								className={cn(
									"flex items-center gap-2 rounded-lg border px-3 py-1.5",
									sel && key && "border-success/60 bg-success/10",
									sel && !key && isQuiz && "border-error/60 bg-error/10",
									sel && !isQuiz && "border-primary bg-accent",
									!sel && key && "border-success/40",
								)}
							>
								{letter && <span data-option-letter={letter} className="w-3 shrink-0 text-center text-xs font-medium text-muted-foreground/70">{letter}</span>}
								{isQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-success",
											sel && !key && "text-error",
											!sel && key && "text-success",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span data-answered-option-label="" className={cn(!sel && "text-muted-foreground")}>
									<ToolContentResponse>{opt.label}</ToolContentResponse>
									{descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
											{descByIndex.get(opt.index)}
										</ToolContentResponse>
									)}
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"
						>
							<span>“<PathText text={answer.other} />”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-prose mt-2 whitespace-pre-wrap">“<PathText text={answer.text} />”</div>}
			<SubmittedImages images={answer.images?.answer} />

			{/* The confidence record (owner round 6): the slider's rail, disc
			    removed — the missing handle itself says "this is a record, not a
			    control". Same paint, same ticks, same ramp, same % read-out as the
			    live dock. Quiz answers only, and only when a confidence exists:
			    "I don't know" sent none (its slider was grayed out), explain and
			    ask never had one, and records from before the feature carry no
			    field — nothing to show, nothing rendered. */}
			{isQuiz && answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					{/* Sized for "100%", shorter values centered (as on the question card). */}
					<span className="w-[4ch] shrink-0 text-center font-mono text-sm tabular-nums text-muted-foreground">
						{answer.confidence}%
					</span>
				</div>
			)}
			{answer.dontKnow && isQuiz && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
			)}
			</div>
			</div>

			{((answer.thinking ?? answer.note) || answer.images?.thinking?.length) && (
				/* The SAME unified row (owner round, 2026-10-05): the quiz answer's
				    thinking is the identical collapsible ThinkingBlock — one
				    geometry, but NO band on the card (owner round five, 2026-10-07:
				    the accent lift read too light); rail only, heights identical. */
				<ThinkingBlock
					testId="your-thinking"
					label="YOUR THINKING"
					text={answer.thinking ?? answer.note ?? ""}
					images={answer.images?.thinking}
					inCard
				/>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{isQuiz && answer.explanation && (
				/* The TUCKED explanation — ALL questions (owner, 2026-10-07): the
				   verdict shows, the explanation sits collapsed behind the Why
				   toggle — viewable, never center stage. Identical to the
				   prediction pattern it generalizes (owner, 2026-10-03). */
				<div className="mt-2" data-testid="tucked-explanation">
					<button
						type="button"
						onClick={() => setWhyOpen((v) => !v)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</button>
					{whyOpen && (
						<div className="mt-1.5 rounded-lg bg-muted py-2 text-sm text-foreground/50">
							<span className="font-medium text-muted-foreground">Why: </span>
							{/* Keep the first paragraph beside the label, not every paragraph:
							   later paragraphs must retain their recovered document structure. */}
							<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.explanation}</ToolContentResponse>
						</div>
					)}
				</div>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && answer.committed && (
				<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">The answer: </span>
					<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.committed}</ToolContentResponse>
				</div>
			)}
		</div>
		</>
	);
}
