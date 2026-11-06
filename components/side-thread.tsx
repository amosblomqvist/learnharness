"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, GripVertical, MessageCircleQuestion, Mic, Pin, PinOff, Square, X } from "lucide-react";
import { actionForBinding, eventBinding, SIDE_QUOTE_MAX_CHARS, SIDE_QUESTION_MAX_CHARS, type TextSelector, type TutorCitation } from "@/src/core";
import type { DictationPhase } from "./dictation";
import { CitationActionsContext } from "./citation-chip";
import { MessageResponse } from "./ai-elements/message";
import { BrailleSpinner } from "./braille-spinner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { clampDragged, placeSideThread, resizedHeight, type SideThreadPlacement } from "./side-thread-float";
import type { SelectionAction } from "./selection-toolbar";
import type { SideThreadAnchor, SideThreadOpenArgs, SideThreadState } from "./use-side-thread";

export function parseBtw(text: string): { question: string } | null {
	const match = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(text);
	return match ? { question: (match[1] ?? "").trim() } : null;
}

/** Ask always opens the selected teaching segment's ONE conversation. Cite
 * is an independent action that inserts a chip into the main/thinking field. */
export function createSideQuestionActions({ open }: { open: (args: SideThreadOpenArgs) => void }): SelectionAction[] {
	return [{
		id: "side-ask", label: "Ask", ariaLabel: "Ask a side question about this selection", icon: MessageCircleQuestion, visible: () => true,
		disabledLabel: (capture) => capture.selector.text.length > SIDE_QUOTE_MAX_CHARS ? "Shorten selection" : null,
		onSelect: (capture) => {
			const { text, start, end, prefix, suffix } = capture.selector;
			open({ anchor: { kind: "range", range: capture.range.cloneRange() }, passage: {
				text, sourceMessageId: capture.messageId, selector: { start, end, prefix, suffix },
			} });
			return true;
		},
	}];
}
export function sideThreadPlaceholder(state: SideThreadState): string {
	return state.pendingPassage ? "Ask about this passage…" : state.messages.length ? "Ask a follow-up…" : "Ask a side question…";
}
export interface SideThreadHandlers {
	dictation?: { phase: DictationPhase; active: boolean; blocked: boolean; error: string | null; toggle: () => void; finish: () => Promise<void> };
	readDraft?: () => string;
	draft?: string;
	onDraftChange?: (text: string) => void;
	onAsk: (question: string, retry?: boolean) => Promise<boolean>;
	onStop: () => void;
	onExpand: () => void;
	onFloat: () => void;
	onClose: () => void;
}
function Passage({ text, chatId, sourceMessageId, selector }: { text: string; chatId?: string; sourceMessageId?: string; selector?: Omit<TextSelector, "text"> }) {
	const actions = useContext(CitationActionsContext);
	const quote = <blockquote className="line-clamp-3 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">{text}</blockquote>;
	if (!chatId || !sourceMessageId || !actions?.openSource) return quote;
	const citation: TutorCitation = { version: 1, chatId, messageId: sourceMessageId, text,
		...(selector ?? { start: 0, end: text.length, prefix: "", suffix: "" }) };
	return <button type="button" data-testid="side-passage-link" aria-label="Show the quoted tutor text" title="Show in the lesson"
		className="cursor-pointer rounded-sm text-left hover:bg-accent/50" onClick={(event) => actions.openSource!(citation, event.currentTarget)}>{quote}</button>;
}

/** #451's companion body, rendering the durable raw messages supplied by
 * #487's service. There is no sharing toggle, generated note, or deletion. */
export function SideThreadBody({ state, chatId, draft, readDraft, dictation, onDraftChange, onAsk, onStop, onExpand, onFloat, onClose, onDragStart }: {
	state: SideThreadState; chatId?: string; onDragStart?: (event: React.PointerEvent<HTMLElement>) => void;
} & SideThreadHandlers) {
	const [question, setQuestion] = useState(draft || state.failedQuestion || "");
	const draftRef = useRef(question);
	const draftWriter = useRef(onDraftChange); draftWriter.current = onDraftChange;
	const changeDraft = (text: string) => { draftRef.current = text; setQuestion(text); draftWriter.current?.(text); };
	useEffect(() => {
		if (state.failedQuestion && !draftRef.current.trim()) {
			draftRef.current = state.failedQuestion; setQuestion(state.failedQuestion); draftWriter.current?.(state.failedQuestion);
		}
	}, [state.failedQuestion]);
	useLayoutEffect(() => {
		if (draft !== undefined && draft !== draftRef.current) { draftRef.current = draft; setQuestion(draft); }
	}, [draft]);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [state.mode]);
	useEffect(() => {
		const scroll = scrollRef.current;
		if (scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160) scroll.scrollTop = scroll.scrollHeight;
	}, [state.messages, state.streamText]);
	const submit = async () => {
		if (state.answering) return;
		if (dictation?.active) await dictation.finish();
		// A dictation flush updates the saved draft synchronously, before
		// React commits its new prop. Never submit the pre-flush local text.
		const sent = readDraft?.() ?? draftRef.current;
		if (!sent.trim()) return;
		if (await onAsk(sent) && (readDraft?.() ?? draftRef.current) === sent) changeDraft("");
	};
	const last = state.messages.at(-1);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="side-thread" onKeyDown={(event) => {
				if (dictation && actionForBinding(eventBinding(event.nativeEvent)) === "toggle-dictation") {
					event.preventDefault(); event.stopPropagation(); dictation.toggle();
				}
			}}>
			<div className={`flex items-center gap-1.5 ${onDragStart ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
				data-testid="side-thread-header" onPointerDown={onDragStart}>
				{onDragStart && <GripVertical aria-hidden="true" className="-ml-1 size-3.5 text-muted-foreground" />}
				<MessageCircleQuestion aria-hidden="true" className="size-3.5 text-muted-foreground" />
				<span className="flex-1 font-ui text-xs text-muted-foreground">Side question</span>
				<Button type="button" size="icon-xs" variant="ghost" aria-label={state.mode === "popover" ? "Dock side conversation" : "Float side conversation"}
					title={state.mode === "popover" ? "Pin to side" : "Unpin to float"} onClick={state.mode === "popover" ? onExpand : onFloat}>
					{state.mode === "popover" ? <Pin aria-hidden="true" /> : <PinOff aria-hidden="true" />}
				</Button>
				<Button type="button" size="icon-xs" variant="ghost" aria-label="Close side conversation" title="Close" onClick={onClose}><X aria-hidden="true" /></Button>
			</div>
			<div ref={scrollRef} data-side-scroll="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto font-prose">
				{state.messages.map((message) => (
					<div key={message.id} data-testid={message.role === "user" ? "side-learner-message" : "side-helper-message"} className={message.role === "user" ? "ml-auto flex w-fit max-w-[70%] flex-col gap-1.5 rounded-xl bg-muted px-3 py-2 text-sm [overflow-wrap:anywhere]" : "flex flex-col gap-1.5 text-sm"}>
						{message.quotes?.map((quote, index) => <Passage key={index} text={quote} chatId={chatId} sourceMessageId={state.segmentId} />)}
						{message.role === "user" ? <p className="whitespace-pre-wrap font-medium">{message.text}</p> : <MessageResponse>{message.text}</MessageResponse>}
						{message.stopped && <span className="font-ui text-xs text-muted-foreground">Stopped</span>}
						{message.error && <span role="alert" className="text-xs text-destructive">{message.error}</span>}
					</div>
				))}
				{state.answering && <div data-testid="side-streaming-answer" className="text-sm">
					{state.streamText ? <MessageResponse>{state.streamText}</MessageResponse> : <BrailleSpinner label="Answering" />}
				</div>}
				{state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
				{!state.answering && (last?.role === "user" || (last?.role === "assistant" && last.error !== undefined)) && (
					<button type="button" className="self-start font-ui text-xs text-muted-foreground hover:text-foreground" onClick={() => void onAsk("", true)}>Retry answer</button>
				)}
			</div>
			<div className="flex flex-col gap-1.5 font-prose">
				{state.pendingPassage && <Passage text={state.pendingPassage.text} chatId={chatId} sourceMessageId={state.pendingPassage.sourceMessageId} selector={state.pendingPassage.selector} />}
				{dictation?.error && <p role="alert" className="font-ui text-xs text-destructive">{dictation.error}</p>}
				<div className="flex items-end gap-1.5">
					<div className="relative min-w-0 flex-1 rounded-[10px] border bg-input/20 focus-within:border-primary/50">
					<Textarea ref={inputRef} aria-label="Side question" data-testid="side-thread-input" className="min-h-9 resize-none border-0 bg-transparent pr-10 font-prose text-sm shadow-none focus-visible:ring-0" rows={1}
						value={question} maxLength={SIDE_QUESTION_MAX_CHARS} placeholder={sideThreadPlaceholder(state)} onChange={(event) => changeDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); void submit(); }
							else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
						}} />
					{dictation && <button type="button" data-testid="side-dictation-toggle"
						aria-label={dictation.active ? "Stop side dictation" : "Start side dictation"} aria-pressed={dictation.active}
						title={dictation.error ?? (dictation.active ? "Stop side dictation" : "Dictate side question")}
						disabled={dictation.blocked || dictation.phase === "stopping"} onClick={dictation.toggle}
						className={`absolute right-1 bottom-1 flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${dictation.active ? "bg-red-500/15 text-red-500" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
						<Mic aria-hidden="true" className="size-3.5" />
					</button>}
					</div>
					<button type="button" aria-label={state.answering ? "Stop side answer" : "Send side question"}
						disabled={!state.answering && !question.trim() && !dictation?.active} onClick={state.answering ? onStop : () => void submit()}
						className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] transition-colors ${state.answering ? "bg-secondary text-foreground hover:bg-accent" : "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"}`}>
						{state.answering ? <Square aria-hidden="true" className="size-4" /> : <CornerDownLeft aria-hidden="true" className="size-5" />}
					</button>
				</div>
			</div>
		</div>
	);
}

function anchorRect(anchor: SideThreadAnchor, composer: () => HTMLElement | null) {
	if (anchor.kind === "range") {
		const lines = Array.from(anchor.range.getClientRects()).filter((rect) => rect.width || rect.height);
		if (lines.length) return lines.at(-1)!;
	}
	const element = anchor.kind === "element" ? anchor.element : composer()?.closest('[data-testid="composer"]')?.parentElement ?? composer();
	return element?.isConnected ? element.getBoundingClientRect() : new DOMRect(Math.max(8, window.innerWidth - 440), 80, 400, 0);
}

/** Retains #451's anchored placement, draggable header and resize handle. */
export function SideThreadPopover({ state, chatId, composer, ...handlers }: { state: SideThreadState; chatId: string; composer: () => HTMLElement | null } & SideThreadHandlers) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [placement, setPlacement] = useState<SideThreadPlacement | null>(null);
	const [frame, setFrame] = useState<{ x: number; y: number; height: number } | null>(null);
	const frameRef = useRef(frame); frameRef.current = frame;
	const stateRef = useRef(state); stateRef.current = state;
	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const box = boxRef.current;
			if (!box || frameRef.current) return;
			const current = stateRef.current;
			const rect = anchorRect(current.anchor, composer);
			const content = box.firstElementChild as HTMLElement | null;
			const scroller = box.querySelector<HTMLElement>("[data-side-scroll]");
			const natural = (content?.scrollHeight ?? 0) + (scroller ? scroller.scrollHeight - scroller.clientHeight : 0);
			setPlacement(placeSideThread({ kind: current.anchor.kind === "composer" ? "composer" : "rect", rect,
				viewport: { width: window.innerWidth, height: window.innerHeight }, contentHeight: natural + 26 }));
		};
		const rePlace = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
		place();
		const observer = new MutationObserver(rePlace);
		if (boxRef.current) observer.observe(boxRef.current, { childList: true, subtree: true, characterData: true });
		window.addEventListener("scroll", rePlace, true); window.addEventListener("resize", rePlace);
		return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener("scroll", rePlace, true); window.removeEventListener("resize", rePlace); };
	}, [composer]);
	const placed = placement !== null;
	useEffect(() => { if (placed) boxRef.current?.querySelector<HTMLElement>('[data-testid="side-thread-input"]')?.focus({ preventScroll: true }); }, [placed]);
	useEffect(() => {
		const onResize = () => {
			const current = frameRef.current;
			if (!current) return;
			const viewport = { width: window.innerWidth, height: window.innerHeight };
			const height = Math.min(current.height, viewport.height - 16);
			setFrame({ ...clampDragged(current, { width: boxRef.current?.getBoundingClientRect().width ?? 0, height }, viewport), height });
		};
		window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize);
	}, []);
	const track = (event: React.PointerEvent<HTMLElement>, onMove: (event: PointerEvent) => void) => {
		const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
		const end = () => { handle.removeEventListener("pointermove", onMove); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
		handle.addEventListener("pointermove", onMove); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
	};
	const currentFrame = () => { const rect = boxRef.current!.getBoundingClientRect(); return frameRef.current ?? { x: rect.left, y: rect.top, height: rect.height }; };
	const startDrag = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || (event.target as Element).closest("button") || !boxRef.current) return;
		event.preventDefault(); const start = currentFrame(); const width = boxRef.current.getBoundingClientRect().width;
		const dx = event.clientX - start.x; const dy = event.clientY - start.y; setFrame(start);
		track(event, (move) => setFrame({ ...clampDragged({ x: move.clientX - dx, y: move.clientY - dy },
			{ width, height: start.height }, { width: window.innerWidth, height: window.innerHeight }), height: start.height }));
	};
	const startResize = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || !boxRef.current) return;
		event.preventDefault(); const start = currentFrame(); const originY = event.clientY; setFrame(start);
		track(event, (move) => setFrame({ ...start, height: resizedHeight(start.height, move.clientY - originY, start.y, window.innerHeight) }));
	};
	const style: React.CSSProperties = frame && placement ? { left: frame.x, top: frame.y, width: placement.style.width, height: frame.height }
		: placement ? { ...placement.style, maxHeight: placement.maxHeight } : { left: 0, top: 0, visibility: "hidden" };
	return createPortal(<div ref={boxRef} role="dialog" aria-label="Side question" data-testid="side-thread-popover"
		style={{ position: "fixed", zIndex: 60, ...style }} className="lh-no-drag flex flex-col overflow-hidden rounded-xl border bg-popover p-3 text-sm shadow-xl">
		<SideThreadBody state={state} chatId={chatId} {...handlers} onDragStart={startDrag} />
		<div aria-hidden="true" data-testid="side-thread-resize" className="absolute inset-x-3 bottom-0 h-2 cursor-ns-resize touch-none" onPointerDown={startResize} />
	</div>, document.body);
}
export function SideThreadPanel({ children }: { children: ReactNode }) {
	return <aside aria-label="Side question" data-testid="side-thread-panel" className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-background p-3">{children}</aside>;
}
