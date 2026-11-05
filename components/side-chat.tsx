"use client";

/**
 * SIDE QUESTIONS — the inline windows (owner design 2026-11-02).
 *
 * A side window opens right after the paragraph-level block it is about,
 * splitting the teacher's passage: the text above, the window, the rest
 * of the passage below. Closed, it is a one-line bar in place. Two ways
 * in: the hover question-mark icon in each prose block's corner, and
 * "Ask about this" on a text selection inside teacher prose. EVERY Ask
 * opens a new window; a block's windows stack in opening order.
 *
 * Mechanics: Streamdown's `BlockComponent` seam renders every markdown
 * block of TEACHER PROSE through SideAskBlock (chat.tsx passes it only
 * there). Streamdown's memo ignores BlockComponent changes, so the block
 * is a stable module component reading its passage from context and its
 * windows through a per-block store subscription (side-chat-state.tsx).
 */

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Block, type BlockProps } from "streamdown";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CornerDownLeftIcon, MessageCircleQuestionIcon, MessageCircleReplyIcon, RotateCcwIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react";
import type { SideChatAnchor, SideChatMessage } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";
import { sideBlockKey, useSideChatStore, useSideWindows, type SideChatStore, type SideWindowView } from "@/components/side-chat-state";

// ─── the passage seam ────────────────────────────────────────────────────────

interface SidePassageValue {
	messageId: string;
	partId: string;
	/** False while the passage is still streaming (not yet in the record). */
	enabled: boolean;
}

const SidePassageContext = createContext<SidePassageValue | null>(null);

/** Marks one teacher prose part for its blocks (chat.tsx wraps the part's
 *  MessageResponse in this and passes `BlockComponent={SideAskBlock}`). */
export function SidePassage({ messageId, partId, enabled, children }: SidePassageValue & { children: ReactNode }) {
	const value = useMemo(() => ({ messageId, partId, enabled }), [messageId, partId, enabled]);
	return <SidePassageContext.Provider value={value}>{children}</SidePassageContext.Provider>;
}

/** One markdown block of teacher prose: the block itself, the hover pill,
 *  and — when one exists — its side window right after it. */
export function SideAskBlock(props: BlockProps) {
	const passage = useContext(SidePassageContext);
	const store = useSideChatStore();
	// Streamdown splits the blank lines between blocks into their own
	// whitespace-only blocks; they render nothing, and a wrapper there would
	// add an empty spaced box (doubling the paragraph gap). Indices still
	// count them — anchors use Streamdown's own numbering.
	if (!passage || !store || !props.content.trim()) return <Block {...props} />;
	return <SideBlock passage={passage} store={store} block={props} />;
}

function SideBlock({ passage, store, block }: { passage: SidePassageValue; store: SideChatStore; block: BlockProps }) {
	const key = sideBlockKey(passage.partId, block.index);
	const windows = useSideWindows(key);
	const anchor = useMemo<SideChatAnchor>(
		() => ({ messageId: passage.messageId, partId: passage.partId, blockIndex: block.index, blockText: block.content }),
		[passage.messageId, passage.partId, block.index, block.content],
	);
	// The selection popover resolves its anchor through this registry.
	useEffect(() => {
		if (!passage.enabled) return;
		store.blocks.set(key, anchor);
		return () => {
			if (store.blocks.get(key) === anchor) store.blocks.delete(key);
		};
	}, [store, key, anchor, passage.enabled]);
	return (
		<>
			<div
				data-side-block={key}
				data-side-enabled={passage.enabled ? "" : undefined}
				// The first block keeps Streamdown's first-child trim (a leading
				// heading's top margin would collapse through this wrapper).
				className={cn("group/sideblock relative", block.index === 0 && "[&>*:first-child]:mt-0")}
			>
				<Block {...block} />
				{passage.enabled && (
					// Every click opens a NEW window after this block (owner,
					// 2026-11-02 follow-up). Icon only — the quiet affordance.
					// Inside the block's bottom-right corner: MessageContent clips
					// overflow, so an icon hung below the LAST block would vanish.
					<button
						type="button"
						data-testid="side-ask"
						aria-label="Ask a side question about this paragraph"
						title="Ask a side question"
						onClick={(e) => {
							blurAfterPointerClick(e);
							store.openAt(anchor);
						}}
						className="absolute bottom-0 right-0 z-10 flex size-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/sideblock:opacity-100"
					>
						<MessageCircleQuestionIcon className="size-3.5" />
					</button>
				)}
			</div>
			{windows.map((view) => (
				<SideChatWindow key={view.renderKey} view={view} store={store} />
			))}
		</>
	);
}

// ─── the window ──────────────────────────────────────────────────────────────

/** One-line, markdown-light excerpt for the closed bar and header. */
export function sideExcerpt(text: string, max = 80): string {
	const flat = text.replace(/[#>*_`]+/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const SideChatWindow = memo(function SideChatWindow({ view, store }: { view: SideWindowView; store: SideChatStore }) {
	const messages = view.thread?.messages ?? [];
	const questions = messages.filter((m) => m.role === "user").length;
	const firstQuote = messages.find((m) => m.role === "user")?.quotes?.[0] ?? view.quotes[0];
	const excerpt = sideExcerpt(firstQuote ?? view.anchor.blockText);

	if (!view.open) {
		return (
			<button
				type="button"
				data-testid="side-chat-bar"
				data-side-window={view.renderKey}
				aria-expanded={false}
				aria-label={`Open side question: ${excerpt}`}
				onClick={(e) => {
					blurAfterPointerClick(e);
					store.setOpen(view.key, true);
				}}
				className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<ChevronRightIcon className="size-3 shrink-0" />
				<MessageCircleQuestionIcon className="size-3 shrink-0" />
				<span className="min-w-0 truncate">“{excerpt}”</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
					{view.answering && <BrailleSpinner label="Answering" />}
					{questions}
				</span>
			</button>
		);
	}
	return <OpenWindow view={view} store={store} messages={messages} excerpt={excerpt} />;
});

function OpenWindow({ view, store, messages, excerpt }: { view: SideWindowView; store: SideChatStore; messages: readonly SideChatMessage[]; excerpt: string }) {
	const [confirming, setConfirming] = useState(false);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const last = messages.at(-1);
	const busy = view.answering || view.sending;
	return (
		<section
			data-testid="side-chat-window"
			data-side-window={view.renderKey}
			aria-label="Side question"
			className="overflow-hidden rounded-xl border bg-card text-card-foreground"
		>
			{/* THE WHOLE BAR TOGGLES (owner, 2026-11-02): the header is the
			    window's handle — a click anywhere but its controls collapses
			    it, mirroring the closed bar that opens on any click. A draft
			    (never asked) has no collapsed form — closing discards it — so
			    its header stays inert and only its × discards. */}
			<header className="flex min-h-9 items-stretch border-b transition-colors has-[[data-side-toggle]:hover]:bg-accent/50">
				{view.thread ? (
					<button
						type="button"
						data-side-toggle=""
						data-testid="side-chat-toggle"
						aria-expanded
						aria-label="Collapse side question"
						onClick={(e) => {
							blurAfterPointerClick(e);
							store.setOpen(view.key, false);
						}}
						className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-2 text-left"
					>
						<ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
						<SideHeaderTitle excerpt={excerpt} />
					</button>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-2">
						<SideHeaderTitle excerpt={excerpt} />
					</div>
				)}
				<div className="flex shrink-0 items-center gap-1 pr-3">
					{confirming ? (
						<>
							<span className="font-ui text-xs text-muted-foreground">Delete this side question?</span>
							<Button
								size="xs"
								variant="destructive"
								data-testid="side-chat-delete-confirm"
								onClick={() => {
									setConfirming(false);
									void store.remove(view.key);
								}}
							>
								Delete
							</Button>
							<Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
								Cancel
							</Button>
						</>
					) : (
						<>
							{messages.length > 0 && (
								// Jump to the follow-up box at the window's end (owner,
								// 2026-11-02): the window opens at its top for reading.
								<Button
									size="icon-xs"
									variant="ghost"
									data-testid="side-chat-jump"
									aria-label="Jump to follow-up question"
									title="Ask a follow-up"
									onClick={(e) => {
										blurAfterPointerClick(e);
										const input = composerRef.current;
										if (!input) return;
										// Centered, clear of the bottom dock overlay.
										input.scrollIntoView({ block: "center", behavior: "smooth" });
										input.focus({ preventScroll: true });
									}}
								>
									<MessageCircleReplyIcon />
								</Button>
							)}
							{view.thread && (
								<Button
									size="icon-xs"
									variant="ghost"
									data-testid="side-chat-delete"
									aria-label="Delete side question"
									onClick={(e) => {
										blurAfterPointerClick(e);
										setConfirming(true);
									}}
								>
									<Trash2Icon />
								</Button>
							)}
							{/* A saved window collapses from its bar or the bottom ↑ (owner,
							    2026-11-05: no top-right ↑). A draft has neither: its × discards. */}
							{!view.thread && (
								<Button
									size="icon-xs"
									variant="ghost"
									data-testid="side-chat-close"
									aria-label="Discard side question"
									onClick={(e) => {
										blurAfterPointerClick(e);
										store.setOpen(view.key, false);
									}}
								>
									<XIcon />
								</Button>
							)}
						</>
					)}
				</div>
			</header>
			{(messages.length > 0 || view.answering || view.error) && (
				<div className="flex flex-col gap-3 px-4 py-3">
					{messages.map((m, i) =>
						m.role === "user" ? (
							<SideQuestionRow key={m.id} message={m} />
						) : (
							<SideAnswer
								key={m.id}
								message={m}
								onRetry={i === messages.length - 1 && m.error !== undefined && !busy ? () => void store.ask(view.key, { retry: true }) : undefined}
							/>
						),
					)}
					{view.answering &&
						(view.streamText ? (
							<div data-testid="side-chat-streaming">
								<MessageResponse isAnimating>{view.streamText}</MessageResponse>
							</div>
						) : (
							<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
								<BrailleSpinner label="Answering" />
								<Shimmer duration={1}>ANSWERING…</Shimmer>
							</span>
						))}
					{last?.role === "user" && !busy && (
						// The answer never arrived (e.g. the app restarted mid-answer).
						<div className="flex items-center gap-2" data-testid="side-chat-unanswered">
							<p className="font-ui text-xs text-muted-foreground">No answer arrived.</p>
							<Button size="xs" variant="outline" data-testid="side-chat-retry" onClick={() => void store.ask(view.key, { retry: true })}>
								<RotateCcwIcon />
								Retry
							</Button>
						</div>
					)}
					{view.error && (
						<p role="alert" data-testid="side-chat-error" className="text-sm text-destructive">
							{view.error}
						</p>
					)}
				</div>
			)}
			<SideComposer
				view={view}
				store={store}
				hasMessages={messages.length > 0}
				lastIsQuestion={last?.role === "user"}
				inputRef={composerRef}
				onCollapse={
					view.thread
						? () => {
								store.setOpen(view.key, false);
								// Collapsing from the BOTTOM shrinks the window into its bar
								// above the reader's eyes: keep that bar in view.
								window.requestAnimationFrame(() => {
									document.querySelector(`[data-side-window="${CSS.escape(view.renderKey)}"]`)?.scrollIntoView({ block: "nearest" });
								});
							}
						: undefined
				}
			/>
		</section>
	);
}

function SideHeaderTitle({ excerpt }: { excerpt: string }) {
	return (
		<>
			{/* The icon IS the label (owner, 2026-11-02); screen readers get
			    the window's aria-label. */}
			<MessageCircleQuestionIcon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 truncate font-ui text-xs text-muted-foreground">“{excerpt}”</span>
		</>
	);
}

function SideQuestionRow({ message }: { message: SideChatMessage }) {
	return (
		<div
			data-testid="side-chat-question"
			className="w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-background/60 py-1 pl-[14px] pr-3 font-ui text-xs"
		>
			<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
			{(message.quotes ?? []).map((q, i) => (
				<blockquote key={i} className="lh-prose my-1 line-clamp-4 whitespace-pre-wrap italic text-muted-foreground">
					“{q}”
				</blockquote>
			))}
			<div className="lh-prose whitespace-pre-wrap text-foreground">{message.text}</div>
		</div>
	);
}

function SideAnswer({ message, onRetry }: { message: SideChatMessage; onRetry?: () => void }) {
	return (
		<div data-testid="side-chat-answer" className="min-w-0">
			{message.text && <MessageResponse>{message.text}</MessageResponse>}
			{message.stopped && <p className="mt-1 font-ui text-xs text-muted-foreground">Stopped.</p>}
			{message.error !== undefined && (
				<div className="mt-1 flex items-center gap-2">
					<p role="alert" className="text-sm text-destructive">
						The answer failed: {message.error}
					</p>
					{onRetry && (
						<Button size="xs" variant="outline" data-testid="side-chat-retry" onClick={onRetry}>
							<RotateCcwIcon />
							Retry
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

function SideComposer({
	view,
	store,
	hasMessages,
	lastIsQuestion,
	inputRef,
	onCollapse,
}: {
	view: SideWindowView;
	store: SideChatStore;
	hasMessages: boolean;
	lastIsQuestion: boolean;
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Saved windows only: collapse from the bottom (a draft's only close discards). */
	onCollapse?: () => void;
}) {
	const [text, setText] = useState(() => store.composerText.get(view.key) ?? "");
	// A NEW window takes the cursor, without scrolling: the page stays where
	// the learner is reading (owner, 2026-11-02). Reopened windows never do.
	useEffect(() => {
		if (store.consumeFocus(view.key)) inputRef.current?.focus({ preventScroll: true });
	}, [store, view.key, inputRef]);
	const busy = view.answering || view.sending;
	const canSend = !busy && text.trim().length > 0 && !lastIsQuestion;
	const send = async () => {
		if (!canSend) return;
		const sent = text;
		setText("");
		const accepted = await store.ask(view.key);
		// Refused: put the question back (the store kept its copy).
		if (!accepted) setText(store.composerText.get(view.key) ?? sent);
	};
	const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		// The side composer owns its keys: the question dock's Tab walk, the
		// Enter-submits seam and the Esc abort chain must never see them.
		if (e.key === "Tab" || e.key === "Escape" || e.key === "Enter") e.stopPropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			inputRef.current?.blur();
			return;
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
			e.preventDefault();
			void send();
		}
	};
	return (
		<div className={cn("px-3 pb-3", !hasMessages && !view.error && "pt-3")}>
			{view.quotes.length > 0 && (
				<div className="mb-2 flex flex-col gap-1" data-testid="side-chat-quotes">
					{view.quotes.map((q, i) => (
						<div key={i} className="flex items-start gap-2 rounded-md border bg-background/60 px-2 py-1">
							<span className="lh-prose line-clamp-2 min-w-0 flex-1 text-sm italic text-muted-foreground">“{q}”</span>
							<button
								type="button"
								aria-label="Remove quote"
								onClick={() => store.removeQuote(view.key, i)}
								className="mt-0.5 shrink-0 rounded text-muted-foreground hover:text-foreground"
							>
								<XIcon className="size-3.5" />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="flex items-center gap-1">
			{onCollapse && (
				// OUTSIDE the follow-up box (owner, 2026-11-02): it acts on the
				// window, not on the question — the bottom twin of the top
				// collapse. LEFT of the box (owner, 2026-11-05), where the
				// cursor usually is.
				<Button
					size="icon-xs"
					variant="ghost"
					className="-ml-1.5"
					data-testid="side-chat-collapse-bottom"
					aria-label="Collapse side question"
					title="Collapse"
					onClick={(e) => {
						blurAfterPointerClick(e);
						onCollapse();
					}}
				>
					<ChevronUpIcon />
				</Button>
			)}
			<form
				className="flex min-w-0 flex-1 items-end gap-1.5 rounded-lg border bg-background p-1"
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<textarea
					ref={inputRef}
					data-testid="side-chat-input"
					rows={1}
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						store.composerText.set(view.key, e.target.value);
					}}
					onKeyDown={onKeyDown}
					placeholder={hasMessages ? "Ask a follow-up…" : "Ask about this paragraph…"}
					className="field-sizing-content lh-input max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 font-prose text-sm outline-none placeholder:text-muted-foreground"
				/>
				{view.answering ? (
					<button
						type="button"
						data-testid="side-chat-stop"
						aria-label="Stop answer"
						onClick={() => store.stop(view.key)}
						className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground transition-colors hover:bg-accent"
					>
						<SquareIcon className="size-3.5" />
					</button>
				) : (
					<button
						type="submit"
						data-testid="side-chat-send"
						aria-label="Send side question"
						disabled={!canSend}
						className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-4" />
					</button>
				)}
			</form>
			</div>
		</div>
	);
}

// ─── text selection → "Ask about this" ──────────────────────────────────────

function elementOf(node: Node | null): Element | null {
	if (!node) return null;
	return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** The selection as quotable text — KaTeX formulas become their TeX
 *  source (`$…$`, `$$…$$`) instead of the doubled MathML/HTML text. */
export function selectionQuote(range: Range, plain: string): string {
	const fragment = range.cloneContents();
	if (!fragment.querySelector(".katex")) return plain.trim();
	const texOf = (el: Element) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
	for (const display of Array.from(fragment.querySelectorAll(".katex-display"))) {
		const tex = texOf(display);
		if (tex !== null) display.replaceWith(`\n$$${tex}$$\n`);
	}
	for (const inline of Array.from(fragment.querySelectorAll(".katex"))) {
		const tex = texOf(inline);
		if (tex !== null) inline.replaceWith(`$${tex}$`);
		else inline.querySelector(".katex-mathml")?.remove();
	}
	for (const block of Array.from(fragment.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr"))) {
		block.append("\n");
	}
	return (fragment.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

interface SelectionTarget {
	x: number;
	y: number;
	anchor: SideChatAnchor;
	quote: string;
}

/** The floating "Ask about this" button for selections in teacher prose.
 *  Both ends of the selection must sit in side-enabled prose blocks; the
 *  window opens after the block where the selection ENDS. */
export function SideSelectionAsk() {
	const store = useSideChatStore();
	const [target, setTarget] = useState<SelectionTarget | null>(null);
	useEffect(() => {
		if (!store) return;
		const resolve = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setTarget(null);
				return;
			}
			const range = selection.getRangeAt(0);
			const end = elementOf(range.endContainer)?.closest("[data-side-block]");
			const start = elementOf(range.startContainer)?.closest("[data-side-block]");
			if (!end || !start || !end.hasAttribute("data-side-enabled")) {
				setTarget(null);
				return;
			}
			const anchor = store.blocks.get(end.getAttribute("data-side-block") ?? "");
			const quote = selectionQuote(range, selection.toString());
			if (!anchor || !quote) {
				setTarget(null);
				return;
			}
			const rects = range.getClientRects();
			const rect = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
			setTarget({ x: rect.right, y: rect.bottom, anchor, quote });
		};
		const onPointerUp = () => window.requestAnimationFrame(resolve);
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.shiftKey || e.key === "Shift") window.requestAnimationFrame(resolve);
		};
		const onSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) setTarget(null);
		};
		const onScroll = () => setTarget(null);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keyup", onKeyUp);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [store]);
	if (!store || !target || typeof document === "undefined") return null;
	const width = 132;
	const left = Math.max(8, Math.min(target.x - width / 2, window.innerWidth - width - 8));
	const top = Math.min(target.y + 6, window.innerHeight - 36);
	return createPortal(
		<button
			type="button"
			data-testid="side-selection-ask"
			// Keep the selection alive through the press.
			onPointerDown={(e) => e.preventDefault()}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => {
				store.openAt(target.anchor, target.quote);
				window.getSelection()?.removeAllRanges();
				setTarget(null);
			}}
			style={{ position: "fixed", left, top, width }}
			className="z-50 flex h-7 items-center justify-center gap-1.5 rounded-md border bg-popover font-ui text-xs font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
		>
			<MessageCircleQuestionIcon className="size-3.5" />
			Ask about this
		</button>,
		document.body,
	);
}
