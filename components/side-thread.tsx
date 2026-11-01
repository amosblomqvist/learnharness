"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVertical, MessageCirclePlus, MessageCircleQuestion, PanelRightOpen, TextQuote, X } from "lucide-react";
import { SIDE_PASSAGE_MAX_CHARS, SIDE_THREAD_MAX_PAIRS, type PassageSelector, type TutorCitation } from "@/src/core";
import { CitationActionsContext } from "./citation-chip";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { clampDragged, placeSideThread, resizedHeight, type SideThreadPlacement } from "./side-thread-float";
import type { CapturedSelection } from "./selection-text";
import type { SelectionAction } from "./selection-toolbar";
import { displayedTell, type SidePassage, type SideThreadAnchor, type SideThreadOpenArgs, type SideThreadState } from "./use-side-thread";

/** `/btw <question>` in the composer (teaching sessions): the question, or
 *  "" for a bare `/btw`; null when the text is not the command. */
export function parseBtw(text: string): { question: string } | null {
	const match = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(text);
	return match ? { question: (match[1] ?? "").trim() } : null;
}

/** The selection toolbar's side-question buttons (teaching sessions): "Ask"
 *  with no thread open; "New question" and "Add to question" with one (F7). */
export function createSideQuestionActions({ threadOpen, open, addPassage }: {
	threadOpen: () => boolean;
	open: (args: SideThreadOpenArgs) => void;
	addPassage: (passage: SidePassage) => void;
}): SelectionAction[] {
	const passageOf = (capture: CapturedSelection): SidePassage => {
		const { text, start, end, prefix, suffix } = capture.selector;
		return { text, sourceMessageId: capture.messageId, selector: { start, end, prefix, suffix } };
	};
	const tooLong = (capture: CapturedSelection) => (capture.selector.text.length > SIDE_PASSAGE_MAX_CHARS ? "Shorten selection" : null);
	const openFrom = (capture: CapturedSelection) => {
		open({ anchor: { kind: "range", range: capture.range.cloneRange() }, passage: passageOf(capture) });
		return true;
	};
	return [
		{ id: "side-ask", label: "Ask", ariaLabel: "Ask a side question about this selection", icon: MessageCircleQuestion, disabledLabel: tooLong, visible: () => !threadOpen(), onSelect: openFrom },
		{ id: "side-new", label: "New question", ariaLabel: "Ask a new side question about this selection", icon: MessageCirclePlus, disabledLabel: tooLong, visible: () => threadOpen(), onSelect: openFrom },
		{
			id: "side-add", label: "Add to question", ariaLabel: "Quote this selection in the next side question", icon: TextQuote, disabledLabel: tooLong, visible: () => threadOpen(),
			onSelect: (capture) => { addPassage(passageOf(capture)); return true; },
		},
	];
}

export function sideThreadPlaceholder(state: SideThreadState): string {
	if (state.pairs.length >= SIDE_THREAD_MAX_PAIRS) return "This side thread is full. Close it to start a new one.";
	if (state.pendingPassage) return "Ask about this passage…";
	if (state.questionCallId && !state.pairs.length && !state.draft) return "Stuck? Ask for a nudge (it won't give the answer)…";
	return state.pairs.length || state.draft ? "Ask a follow-up…" : "Ask a side question…";
}

export interface SideThreadHandlers {
	onAsk: (question: string) => void;
	onSetTell: (tell: boolean) => void;
	onExpand: () => void;
	onClose: () => void;
	/** A closed thread reopened read-only and kept private: tell the tutor now. */
	onTellTutor?: () => void;
}

/** What happens to the note, and the one action that changes it. */
export function noteStatus(state: SideThreadState): { text: string; action?: { label: string; tell: boolean } } {
	const tell = displayedTell(state);
	if (state.readOnly) return tell ? { text: "Told the tutor" } : { text: "Kept private", action: { label: "Tell tutor", tell: true } };
	return tell
		? { text: "Sent to the tutor when you close", action: { label: "Don't send", tell: false } }
		: { text: "Kept private", action: { label: "Send to tutor", tell: true } };
}

/** Roughly two lines of the note at the popover's width, before layout
 *  can measure (static renders, the first paint). */
const NOTE_CLAMP_GUESS_CHARS = 110;

function SideNoteBlock({ state, onSetTell, onTellTutor }: { state: SideThreadState; onSetTell: (tell: boolean) => void; onTellTutor?: () => void }) {
	const note = state.pairs[state.pairs.length - 1]!.note;
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(note.length > NOTE_CLAMP_GUESS_CHARS);
	const textRef = useRef<HTMLParagraphElement>(null);
	useLayoutEffect(() => {
		const el = textRef.current;
		if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
	}, [note, expanded, state.mode]);
	const status = noteStatus(state);
	const act = () => {
		if (!status.action) return;
		if (state.readOnly) onTellTutor?.();
		else onSetTell(status.action.tell);
	};
	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-2" data-testid="side-note">
			<p ref={textRef} className={`font-prose text-xs text-muted-foreground ${expanded ? "" : "line-clamp-2"}`}>{note}</p>
			{(overflows || expanded) && (
				<button type="button" className="self-start font-ui text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setExpanded(!expanded)}>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
			<div className="flex items-center gap-1.5 font-ui text-xs" data-testid="side-note-status">
				<span className="text-foreground">{status.text}</span>
				{status.action && (state.readOnly ? onTellTutor : true) && (
					<>
						<span aria-hidden="true" className="text-muted-foreground">·</span>
						<button type="button" className="cursor-pointer text-foreground underline underline-offset-2 hover:text-primary" onClick={act}>
							{status.action.label}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

/** A quoted tutor passage. With its source message it is a link: clicking
 *  jumps to the tutor text and highlights it (Cite's reveal). Without a
 *  selector (threads saved before quotes kept one) the text alone finds
 *  it when it occurs once; otherwise the reveal lands on the message. */
function Passage({ text, chatId, sourceMessageId, selector }: { text: string; chatId?: string; sourceMessageId?: string; selector?: PassageSelector }) {
	const actions = useContext(CitationActionsContext);
	const quote = <blockquote className="line-clamp-4 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">{text}</blockquote>;
	if (!chatId || !sourceMessageId || !actions?.openSource) return quote;
	const at = selector ?? { start: 0, end: text.length, prefix: "", suffix: "" };
	const citation: TutorCitation = { version: 1, chatId, messageId: sourceMessageId, text, ...at };
	return (
		<button
			type="button"
			data-testid="side-passage-link"
			aria-label="Show the quoted tutor text"
			title="Show in the lesson"
			className="cursor-pointer rounded-sm text-left hover:bg-accent/50 [&_blockquote]:hover:border-foreground/40"
			onClick={(event) => actions.openSource!(citation, event.currentTarget)}
		>
			{quote}
		</button>
	);
}

/** The thread itself: header, Q&A pairs, the note with its toggle, the
 *  follow-up input. Shared by the popover and the panel. */
export function SideThreadBody({ state, chatId, onAsk, onSetTell, onExpand, onClose, onTellTutor, onDragStart }: {
	state: SideThreadState;
	/** The lesson's chat: quotes link back into it. */
	chatId?: string;
	/** The popover's header is its drag handle. */
	onDragStart?: (event: React.PointerEvent<HTMLElement>) => void;
} & SideThreadHandlers) {
	const [question, setQuestion] = useState(state.failed?.question ?? "");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const failedQuestion = state.failed?.question;
	useEffect(() => { if (failedQuestion) setQuestion(failedQuestion); }, [failedQuestion]);
	// The input stays focused through asking and expanding.
	useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [state.mode]);

	const full = state.pairs.length >= SIDE_THREAD_MAX_PAIRS;
	const hasNote = state.pairs.length > 0;
	const submit = () => {
		if (!question.trim() || state.draft || full) return;
		onAsk(question);
		setQuestion("");
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="side-thread">
			<div
				className={`flex items-center gap-1.5 ${onDragStart ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
				data-testid="side-thread-header"
				onPointerDown={onDragStart}
			>
				{onDragStart && <GripVertical aria-hidden="true" className="-ml-1 size-3.5 text-muted-foreground" />}
				<MessageCircleQuestion aria-hidden="true" className="size-3.5 text-muted-foreground" />
				<span className="flex-1 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Side question</span>
				{state.mode === "popover" && (
					<Button type="button" size="icon-xs" variant="ghost" aria-label="Expand" title="Expand" onClick={onExpand}>
						<PanelRightOpen aria-hidden="true" />
					</Button>
				)}
				<Button type="button" size="icon-xs" variant="ghost" aria-label="Close" title="Close" onClick={onClose}>
					<X aria-hidden="true" />
				</Button>
			</div>

			<div data-side-scroll="" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto font-prose">
				{state.pairs.map((pair, i) => (
					<div key={i} className="flex flex-col gap-1.5" data-testid="side-pair">
						{pair.passage && <Passage text={pair.passage} chatId={chatId} sourceMessageId={pair.sourceMessageId} selector={pair.selector} />}
						<p className="text-sm font-medium">{pair.question}</p>
						<div className="text-sm"><MessageResponse>{pair.answer}</MessageResponse></div>
					</div>
				))}
				{state.draft && (
					<div className="flex flex-col gap-1.5" data-testid="side-draft">
						{state.draft.passage && <Passage text={state.draft.passage} chatId={chatId} sourceMessageId={state.draft.sourceMessageId} selector={state.draft.selector} />}
						<p className="text-sm font-medium">{state.draft.question}</p>
						{state.draft.answer ? (
							<div className="text-sm"><MessageResponse>{state.draft.answer}</MessageResponse></div>
						) : null}
						{(state.draft.activity || !state.draft.answer) && (
							<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
								<BrailleSpinner label="Answering" />
								<Shimmer duration={1}>{state.draft.activity ?? "THINKING…"}</Shimmer>
							</span>
						)}
					</div>
				)}
				{state.failed && <p role="alert" className="text-sm text-destructive">{state.failed.error}</p>}
			</div>

			{hasNote && <SideNoteBlock state={state} onSetTell={onSetTell} onTellTutor={onTellTutor} />}

			<div className="flex flex-col gap-1.5 font-prose">
				{state.pendingPassage && <Passage text={state.pendingPassage.text} chatId={chatId} sourceMessageId={state.pendingPassage.sourceMessageId} selector={state.pendingPassage.selector} />}
				<Textarea
					ref={inputRef}
					aria-label="Side question"
					data-testid="side-thread-input"
					className="min-h-9 resize-none font-prose text-sm"
					rows={1}
					value={question}
					disabled={full}
					placeholder={sideThreadPlaceholder(state)}
					onChange={(event) => setQuestion(event.target.value)}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							event.stopPropagation();
							submit();
						} else if (event.key === "Escape") {
							// F11: Esc closes the thread before anything else.
							event.preventDefault();
							event.stopPropagation();
							onClose();
						}
					}}
				/>
			</div>
		</div>
	);
}

function anchorRect(anchor: SideThreadAnchor, composer: () => HTMLElement | null) {
	if (anchor.kind === "range") {
		// A re-rendered transcript can detach the range: keep the last spot.
		const lines = Array.from(anchor.range.getClientRects()).filter((r) => r.width || r.height);
		return lines.at(-1) ?? null;
	}
	// The composer's visible box: the form's bordered frame.
	const element = anchor.kind === "element" ? anchor.element : (composer()?.closest('[data-testid="composer"]')?.parentElement ?? composer());
	return element?.isConnected ? element.getBoundingClientRect() : null;
}

/** The popover: anchored to the passage, the chip, or right above the
 *  composer at its width (/btw). It follows its anchor and its own growth
 *  until the learner moves it (header) or resizes it (bottom edge); from
 *  then on it keeps that frame, and longer content scrolls inside. */
export function SideThreadPopover({ state, chatId, composer, ...handlers }: { state: SideThreadState; chatId: string; composer: () => HTMLElement | null } & SideThreadHandlers) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [placement, setPlacement] = useState<SideThreadPlacement | null>(null);
	const [frame, setFrame] = useState<{ x: number; y: number; height: number } | null>(null);
	const frameRef = useRef(frame);
	frameRef.current = frame;
	const stateRef = useRef(state);
	stateRef.current = state;

	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const box = boxRef.current;
			if (!box || frameRef.current) return;
			const current = stateRef.current;
			const rect = anchorRect(current.anchor, composer);
			if (!rect) return;
			// Natural height: the body's inner scroll area is capped, so add
			// back what it hides.
			const content = box.firstElementChild as HTMLElement | null;
			const scroller = box.querySelector<HTMLElement>("[data-side-scroll]");
			const natural = (content?.scrollHeight ?? 0) + (scroller ? scroller.scrollHeight - scroller.clientHeight : 0);
			setPlacement(placeSideThread({
				kind: current.anchor.kind === "composer" ? "composer" : "rect",
				rect,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				contentHeight: natural + 26, // the box's padding and border
			}));
		};
		const rePlace = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
		place();
		// The answer streams in: re-place as the content grows (flip, cap).
		const observer = new MutationObserver(rePlace);
		if (boxRef.current) observer.observe(boxRef.current, { childList: true, subtree: true, characterData: true });
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	}, [composer]);

	// The first frame renders hidden while it measures, and a hidden input
	// can't take focus: focus it once the popover is placed.
	const placed = placement !== null;
	useEffect(() => {
		if (placed) boxRef.current?.querySelector<HTMLElement>('[data-testid="side-thread-input"]')?.focus({ preventScroll: true });
	}, [placed]);

	// Keep a moved popover inside the window when the window shrinks.
	useEffect(() => {
		const onResize = () => {
			const current = frameRef.current;
			if (!current) return;
			const viewport = { width: window.innerWidth, height: window.innerHeight };
			const height = Math.min(current.height, viewport.height - 16);
			const at = clampDragged(current, { width: boxRef.current?.getBoundingClientRect().width ?? 0, height }, viewport);
			setFrame({ ...at, height });
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	/** Track one pointer gesture from `handle` until it is released. */
	const track = (event: React.PointerEvent<HTMLElement>, onMove: (e: PointerEvent) => void) => {
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const end = () => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};

	// The frame the gesture starts from: the popover as it is on screen now.
	const currentFrame = () => {
		const rect = boxRef.current!.getBoundingClientRect();
		return frameRef.current ?? { x: rect.left, y: rect.top, height: rect.height };
	};

	const startDrag = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || (event.target as Element).closest("button") || !boxRef.current) return;
		event.preventDefault();
		const start = currentFrame();
		const width = boxRef.current.getBoundingClientRect().width;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		setFrame(start);
		track(event, (e) => setFrame({
			...clampDragged({ x: e.clientX - dx, y: e.clientY - dy }, { width, height: start.height }, { width: window.innerWidth, height: window.innerHeight }),
			height: start.height,
		}));
	};

	const startResize = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || !boxRef.current) return;
		event.preventDefault();
		const start = currentFrame();
		const originY = event.clientY;
		setFrame(start);
		track(event, (e) => setFrame({ ...start, height: resizedHeight(start.height, e.clientY - originY, start.y, window.innerHeight) }));
	};

	const style: React.CSSProperties = frame && placement
		? { left: frame.x, top: frame.y, width: placement.style.width, height: frame.height }
		: placement
			? { ...placement.style, maxHeight: placement.maxHeight }
			: { left: 0, top: 0, visibility: "hidden" };
	return createPortal(
		<div
			ref={boxRef}
			role="dialog"
			aria-label="Side question"
			data-testid="side-thread-popover"
			style={{ position: "fixed", zIndex: 60, ...style }}
			// lh-no-drag: over the desktop window's drag strip (the top bar)
			// the popover stays clickable and draggable itself.
			className="lh-no-drag flex flex-col overflow-hidden rounded-xl border bg-popover p-3 text-sm shadow-xl"
		>
			<SideThreadBody state={state} chatId={chatId} {...handlers} onDragStart={startDrag} />
			<div
				aria-hidden="true"
				data-testid="side-thread-resize"
				className="absolute inset-x-3 bottom-0 h-2 cursor-ns-resize touch-none"
				onPointerDown={startResize}
			/>
		</div>,
		document.body,
	);
}

/** The expanded thread: a panel beside the lesson, below the top bar (F8). */
export function SideThreadPanel({ children }: { children: ReactNode }) {
	return (
		<aside aria-label="Side question" data-testid="side-thread-panel" className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-background p-3">
			{children}
		</aside>
	);
}
