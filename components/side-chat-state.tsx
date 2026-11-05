"use client";

/**
 * SIDE QUESTIONS — the browser state (inline side questions, owner design
 * 2026-11-02). One small external store per chat view, read per BLOCK
 * through useSyncExternalStore: a streaming answer re-renders the windows
 * of ITS block only, never the transcript's other block wrappers (the
 * typing-never-rerenders-the-transcript law, tests/chat-input-performance).
 *
 * MANY WINDOWS PER BLOCK (owner, 2026-11-02 follow-up): every Ask — the
 * hover icon or a text selection — opens a NEW window after its block;
 * a block's windows stack in the order they were opened. A window is
 * keyed by its thread id, or by a client draft id until its first
 * question is saved; the draft id stays the window's RENDER key after
 * that, so the window (and its focused composer) never remounts.
 *
 * Canonical server truth is GET /api/chats/:id/side-chats, refetched on
 * the `side-chats-changed` notification (notify-then-fetch). Client-only
 * state: draft windows (opened, never asked), attached quotes, the live
 * answer text of a stream this view started, request-level refusals.
 * Composer text lives in a ref map (never store state) so keystrokes stay
 * local to their window.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { SideChatAnchor, SideChatThread } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** One prose block: `${partId}#${blockIndex}` — the windows stack after it. */
export function sideBlockKey(partId: string, blockIndex: number): string {
	return `${partId}#${blockIndex}`;
}

/** Everything one window renders. Object identity is stable while
 *  nothing it shows changes (the per-block subscription contract). */
export interface SideWindowView {
	/** The thread id, or the draft id of a never-asked window. */
	key: string;
	/** Stable across draft → saved thread (the React key). */
	renderKey: string;
	/** The block this window follows. */
	blockKey: string;
	anchor: SideChatAnchor;
	/** The saved thread — absent for a draft window (never asked). */
	thread?: SideChatThread;
	open: boolean;
	/** Quotes waiting to ride the next question. */
	quotes: readonly string[];
	/** An answer is running on the server. */
	answering: boolean;
	/** The answer text so far (live stream, or the server's snapshot). */
	streamText: string;
	/** A POST is in flight and its thread line has not arrived yet. */
	sending: boolean;
	/** A request-level refusal/failure to show in the window. */
	error: string | null;
}

export interface SideCanonical {
	threads: readonly SideChatThread[];
	/** draftId → anchor, in opening order. */
	drafts: ReadonlyMap<string, SideChatAnchor>;
	/** window key → quotes for the next question. */
	quotes: ReadonlyMap<string, readonly string[]>;
	/** threadId → answer text so far. */
	answering: ReadonlyMap<string, string>;
	/** window keys with a POST in flight. */
	sending: ReadonlySet<string>;
	errors: ReadonlyMap<string, string>;
	/** threadId → the draft id it was born from (its render key). */
	aliases: ReadonlyMap<string, string>;
}

export function emptySideCanonical(): SideCanonical {
	return {
		threads: [],
		drafts: new Map(),
		quotes: new Map(),
		answering: new Map(),
		sending: new Set(),
		errors: new Map(),
		aliases: new Map(),
	};
}

const EMPTY_QUOTES: readonly string[] = [];
const EMPTY_WINDOWS: readonly SideWindowView[] = [];

function sameView(a: SideWindowView, b: SideWindowView): boolean {
	return (
		a.renderKey === b.renderKey &&
		a.anchor === b.anchor &&
		a.thread === b.thread &&
		a.open === b.open &&
		a.quotes === b.quotes &&
		a.answering === b.answering &&
		a.streamText === b.streamText &&
		a.sending === b.sending &&
		a.error === b.error
	);
}

/** Derive every block's window stack — saved threads in record (opening)
 *  order, then drafts in opening order — reusing every unchanged view
 *  object and every unchanged stack array. */
export function deriveSideWindows(
	c: SideCanonical,
	prev: ReadonlyMap<string, readonly SideWindowView[]>,
): Map<string, readonly SideWindowView[]> {
	const prevViews = new Map<string, SideWindowView>();
	for (const stack of prev.values()) for (const v of stack) prevViews.set(v.key, v);
	const stacks = new Map<string, SideWindowView[]>();
	const put = (view: SideWindowView) => {
		const old = prevViews.get(view.key);
		const kept = old && sameView(old, view) ? old : view;
		const stack = stacks.get(view.blockKey);
		if (stack) stack.push(kept);
		else stacks.set(view.blockKey, [kept]);
	};
	for (const thread of c.threads) {
		const live = c.answering.get(thread.id);
		put({
			key: thread.id,
			renderKey: c.aliases.get(thread.id) ?? thread.id,
			blockKey: sideBlockKey(thread.anchor.partId, thread.anchor.blockIndex),
			anchor: thread.anchor,
			thread,
			open: thread.open,
			quotes: c.quotes.get(thread.id) ?? EMPTY_QUOTES,
			answering: live !== undefined,
			streamText: live ?? "",
			sending: c.sending.has(thread.id),
			error: c.errors.get(thread.id) ?? null,
		});
	}
	for (const [key, anchor] of c.drafts) {
		put({
			key,
			renderKey: key,
			blockKey: sideBlockKey(anchor.partId, anchor.blockIndex),
			anchor,
			open: true,
			quotes: c.quotes.get(key) ?? EMPTY_QUOTES,
			answering: false,
			streamText: "",
			sending: c.sending.has(key),
			error: c.errors.get(key) ?? null,
		});
	}
	const next = new Map<string, readonly SideWindowView[]>();
	for (const [blockKey, stack] of stacks) {
		const old = prev.get(blockKey);
		next.set(blockKey, old && old.length === stack.length && old.every((v, i) => v === stack[i]) ? old : stack);
	}
	return next;
}

/** Split an NDJSON byte stream into complete lines (the rest carries over). */
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

type StreamEvent =
	| { type: "thread"; thread: SideChatThread }
	| { type: "text"; text: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "error"; error: string };

let draftSeq = 0;

class SideChatStore {
	private canonical: SideCanonical = emptySideCanonical();
	private windows = new Map<string, readonly SideWindowView[]>();
	private listeners = new Set<() => void>();
	/** Threads whose answer THIS view is streaming — local text wins. */
	private liveThreads = new Set<string>();
	/** Composer drafts by window key (never store state — keystrokes stay local). */
	readonly composerText = new Map<string, string>();
	/** Rendered prose blocks, for the selection popover's anchor lookup. */
	readonly blocks = new Map<string, SideChatAnchor>();

	constructor(readonly chatId: string) {}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** One block's window stack (a stable empty array when there is none). */
	windowsAt = (blockKey: string): readonly SideWindowView[] => this.windows.get(blockKey) ?? EMPTY_WINDOWS;

	private set(patch: Partial<SideCanonical>): void {
		this.canonical = { ...this.canonical, ...patch };
		this.windows = deriveSideWindows(this.canonical, this.windows);
		for (const listener of [...this.listeners]) listener();
	}

	private base(): string {
		return `/api/chats/${encodeURIComponent(this.chatId)}/side-chats`;
	}

	private threadFor(key: string): SideChatThread | undefined {
		return this.canonical.threads.find((t) => t.id === key);
	}

	private upsertThread(thread: SideChatThread): void {
		const others = this.canonical.threads.filter((t) => t.id !== thread.id);
		this.set({ threads: [...others, thread].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
	}

	private setError(key: string, error: string | null): void {
		if (error === null && !this.canonical.errors.has(key)) return;
		const errors = new Map(this.canonical.errors);
		if (error === null) errors.delete(key);
		else errors.set(key, error);
		this.set({ errors });
	}

	/** Windows whose composer should take focus once, when it mounts. */
	private pendingFocus = new Set<string>();

	/** One-shot: true exactly once after a NEW window was opened. Reopening
	 *  a closed window never focuses — it opens in place, read from the top
	 *  (owner, 2026-11-02); the jump control takes you to the follow-up. */
	consumeFocus(key: string): boolean {
		return this.pendingFocus.delete(key);
	}

	/** Adopt the server list (refetch on mount, notification, resync). */
	async refresh(): Promise<void> {
		let body: { threads?: SideChatThread[]; answering?: Record<string, string> };
		try {
			const res = await fetch(this.base(), { cache: "no-store" });
			if (!res.ok) return;
			body = await res.json();
		} catch {
			return; // transient: the next notification/resync heals
		}
		const threads = Array.isArray(body.threads) ? body.threads : [];
		const answering = new Map<string, string>();
		for (const [id, text] of Object.entries(body.answering ?? {})) {
			answering.set(id, this.liveThreads.has(id) ? (this.canonical.answering.get(id) ?? text) : text);
		}
		// A stream this view still reads keeps its slot until its terminal.
		for (const id of this.liveThreads) {
			if (!answering.has(id) && this.canonical.answering.has(id)) answering.set(id, this.canonical.answering.get(id)!);
		}
		this.set({ threads, answering });
	}

	/** Open a NEW window after the anchor's block (every Ask is its own
	 *  window), optionally with a quote attached to its first question. */
	openAt(anchor: SideChatAnchor, quote?: string): string {
		const key = `draft_${Date.now().toString(36)}_${(draftSeq++).toString(36)}`;
		const drafts = new Map(this.canonical.drafts);
		drafts.set(key, anchor);
		const patch: Partial<SideCanonical> = { drafts };
		const text = quote?.trim();
		if (text) {
			const quotes = new Map(this.canonical.quotes);
			quotes.set(key, [text]);
			patch.quotes = quotes;
		}
		this.pendingFocus.add(key);
		this.set(patch);
		return key;
	}

	removeQuote(key: string, index: number): void {
		const current = this.canonical.quotes.get(key) ?? EMPTY_QUOTES;
		const quotes = new Map(this.canonical.quotes);
		quotes.set(key, current.filter((_, i) => i !== index));
		this.set({ quotes });
	}

	private discardDraft(key: string): void {
		const drafts = new Map(this.canonical.drafts);
		drafts.delete(key);
		const quotes = new Map(this.canonical.quotes);
		quotes.delete(key);
		const errors = new Map(this.canonical.errors);
		errors.delete(key);
		this.composerText.delete(key);
		this.pendingFocus.delete(key);
		this.set({ drafts, quotes, errors });
	}

	setOpen(key: string, open: boolean): void {
		const thread = this.threadFor(key);
		if (!thread) {
			// Closing a never-asked draft discards it (nothing was saved).
			if (!open && this.canonical.drafts.has(key)) this.discardDraft(key);
			return;
		}
		this.set({ threads: this.canonical.threads.map((t) => (t.id === thread.id ? { ...t, open } : t)) });
		void fetch(`${this.base()}/${encodeURIComponent(thread.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ open }),
		}).catch(() => undefined);
	}

	async remove(key: string): Promise<void> {
		const thread = this.threadFor(key);
		if (!thread) {
			this.discardDraft(key);
			return;
		}
		const quotes = new Map(this.canonical.quotes);
		quotes.delete(key);
		this.composerText.delete(key);
		this.set({ threads: this.canonical.threads.filter((t) => t !== thread), quotes });
		try {
			await fetch(`${this.base()}/${encodeURIComponent(thread.id)}`, { method: "DELETE" });
		} finally {
			void this.refresh();
		}
	}

	stop(key: string): void {
		const thread = this.threadFor(key);
		if (!thread) return;
		void fetch(`${this.base()}/${encodeURIComponent(thread.id)}/stop`, { method: "POST" }).catch(() => undefined);
	}

	/** Send the composer's question (or a retry). Resolves as soon as the
	 *  server accepted (true) or refused (false); the answer stream is read
	 *  in the background. */
	async ask(key: string, opts: { retry?: boolean } = {}): Promise<boolean> {
		if (this.canonical.sending.has(key)) return false;
		const thread = this.threadFor(key);
		const anchor = thread?.anchor ?? this.canonical.drafts.get(key);
		if (!anchor) return false;
		if (thread && this.canonical.answering.has(thread.id)) return false;
		const text = (this.composerText.get(key) ?? "").trim();
		const quotes = this.canonical.quotes.get(key) ?? EMPTY_QUOTES;
		if (!opts.retry && !text) return false;
		if (opts.retry && !thread) return false;
		const body = opts.retry
			? { threadId: thread!.id, retry: true }
			: thread
				? { threadId: thread.id, text, quotes }
				: { anchor, text, quotes };
		const sending = new Set(this.canonical.sending);
		sending.add(key);
		this.set({ sending });
		this.setError(key, null);
		let res: Response;
		try {
			res = await fetch(this.base(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			this.clearSending(key);
			this.setError(key, "Could not reach the app server.");
			return false;
		}
		if (!res.ok || !res.body) {
			const failure = (await res.json().catch(() => null)) as { error?: string } | null;
			this.clearSending(key);
			this.setError(key, failure?.error ?? `The side question failed (${res.status}).`);
			void this.refresh();
			return false;
		}
		// Accepted: the question is saved — clear what was sent.
		if (!opts.retry) {
			this.composerText.delete(key);
			const q = new Map(this.canonical.quotes);
			q.delete(key);
			this.set({ quotes: q });
		}
		void this.readStream(key, res.body);
		return true;
	}

	private clearSending(key: string): void {
		if (!this.canonical.sending.has(key)) return;
		const sending = new Set(this.canonical.sending);
		sending.delete(key);
		this.set({ sending });
	}

	/** A draft's first saved question: the window becomes its thread,
	 *  keeping the draft id as render key (no remount, focus kept). */
	private promoteDraft(draftKey: string, thread: SideChatThread): void {
		const drafts = new Map(this.canonical.drafts);
		drafts.delete(draftKey);
		const aliases = new Map(this.canonical.aliases);
		aliases.set(thread.id, draftKey);
		const sending = new Set(this.canonical.sending);
		sending.delete(draftKey);
		const others = this.canonical.threads.filter((t) => t.id !== thread.id);
		this.set({
			drafts,
			aliases,
			sending,
			threads: [...others, thread].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		});
	}

	private async readStream(key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
		let threadId: string | undefined;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const apply = (event: StreamEvent) => {
			if (event.type === "thread") {
				threadId = event.thread.id;
				this.liveThreads.add(threadId);
				const answering = new Map(this.canonical.answering);
				answering.set(threadId, "");
				this.set({ answering });
				if (this.canonical.drafts.has(key)) this.promoteDraft(key, event.thread);
				else {
					this.upsertThread(event.thread);
					this.clearSending(key);
				}
			} else if (event.type === "text" && threadId) {
				const answering = new Map(this.canonical.answering);
				answering.set(threadId, event.text);
				this.set({ answering });
			} else if (event.type === "done") {
				const answering = new Map(this.canonical.answering);
				answering.delete(event.thread.id);
				this.set({ answering });
				this.upsertThread(event.thread);
			} else if (event.type === "error") {
				this.setError(threadId ?? key, event.error);
			}
		};
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { lines, rest } = splitNdjson(buffer);
				buffer = rest;
				for (const line of lines) {
					try {
						apply(JSON.parse(line) as StreamEvent);
					} catch {
						/* a malformed line is skipped; the refetch below heals */
					}
				}
			}
		} catch {
			/* the view lost its stream; the server keeps answering and saves */
		} finally {
			this.clearSending(key);
			if (threadId) {
				this.liveThreads.delete(threadId);
				const answering = new Map(this.canonical.answering);
				answering.delete(threadId);
				this.set({ answering });
			}
			void this.refresh();
		}
	}
}

interface SideChatContextValue {
	store: SideChatStore;
}

const SideChatContext = createContext<SideChatContextValue | null>(null);

/** One store per chat view. Refetches on mount, on `side-chats-changed`
 *  for this chat, and on event-channel resync. */
export function SideChatProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
	const storeRef = useRef<SideChatStore | null>(null);
	// `instanceof`: a dev hot reload re-runs this module with a NEW class
	// while Fast Refresh keeps the ref — an old-class store would keep the
	// old behavior (it once merged a second selection into the first
	// window). Production never reloads modules; this costs nothing there.
	if (storeRef.current === null || storeRef.current.chatId !== chatId || !(storeRef.current instanceof SideChatStore)) {
		storeRef.current = new SideChatStore(chatId);
	}
	const store = storeRef.current;
	useEffect(() => {
		void store.refresh();
	}, [store]);
	useServerEvent("side-chats-changed", (p) => {
		if (p.chatId === chatId) void store.refresh();
	});
	useServerResync(() => {
		void store.refresh();
	});
	const value = useMemo(() => ({ store }), [store]);
	return <SideChatContext.Provider value={value}>{children}</SideChatContext.Provider>;
}

/** The store (null outside a provider — prose renders without side chats). */
export function useSideChatStore(): SideChatStore | null {
	return useContext(SideChatContext)?.store ?? null;
}

const NO_STORE_SUBSCRIBE = () => () => {};
const NO_WINDOWS = () => EMPTY_WINDOWS;

/** One block's window stack; re-renders only when that stack changes. */
export function useSideWindows(blockKey: string): readonly SideWindowView[] {
	const store = useSideChatStore();
	const getSnapshot = useCallback(() => store?.windowsAt(blockKey) ?? EMPTY_WINDOWS, [store, blockKey]);
	return useSyncExternalStore(store?.subscribe ?? NO_STORE_SUBSCRIBE, store ? getSnapshot : NO_WINDOWS, store ? getSnapshot : NO_WINDOWS);
}

/** Exported for the end-to-end flow test (tests/side-chat-flow.test.tsx). */
export { SideChatStore };
