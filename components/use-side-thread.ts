"use client";

/**
 * THE OPEN SIDE THREAD (#16) on the client. The server is stateless: the
 * thread lives here until it closes, and every question sends the thread
 * so far. Closing (button, Esc, a new thread, leaving the chat, the page
 * hiding) posts it to the close route, which commits one marker. Nothing
 * reaches the tutor while the thread is open.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
	SIDE_THREAD_MAX_PAIRS,
	SIDE_WORKING_MAX_CHARS,
	type PassageSelector,
	type SideNote,
	type SidePair,
	type SideQuestionDetails,
} from "@/src/core";
import { sseEvents } from "./session-core";

/** Where the popover sits: the selected passage (a live Range), the chip
 *  a closed thread reopens from, or just above the composer (/btw). */
export type SideThreadAnchor = { kind: "range"; range: Range } | { kind: "element"; element: HTMLElement } | { kind: "composer" };

/** A quoted tutor passage and where it sits (its quote links back there). */
export interface SidePassage {
	text: string;
	sourceMessageId: string;
	selector?: PassageSelector;
}

export interface SideDraft {
	question: string;
	passage?: string;
	sourceMessageId?: string;
	selector?: PassageSelector;
	answer: string;
	/** The file tool running now ("read notes.md"). */
	activity?: string;
}

export interface SideThreadState {
	threadId: string;
	pairs: Array<SidePair & SideNote>;
	/** The question being answered now (one at a time). */
	draft: SideDraft | null;
	/** The passage the next question quotes. */
	pendingPassage?: SidePassage;
	/** The learner's last hand-set toggle; null = never flipped (F10). */
	learnerTell: boolean | null;
	mode: "popover" | "panel";
	anchor: SideThreadAnchor;
	/** A failed question, kept so the learner can ask it again. */
	failed?: { question: string; error: string };
	/** A closed thread reopened from its chip. */
	readOnly?: SideQuestionDetails;
	/** A reopened thread the learner asked more in: the thread it continues. */
	continues?: string;
	/** The thread was opened from the question waiting for the learner (its
	 *  tool call id): the side agent nudges instead of answering. */
	questionCallId?: string;
}

export type SideThreadAction =
	| { type: "open"; threadId: string; anchor: SideThreadAnchor; passage?: SidePassage; questionCallId?: string }
	| { type: "open-read-only"; threadId: string; details: SideQuestionDetails; anchor: SideThreadAnchor }
	| { type: "told"; threadId: string }
	| { type: "continue"; threadId: string }
	| { type: "add-passage"; passage: SidePassage }
	| { type: "ask"; question: string }
	| { type: "text"; delta: string }
	| { type: "tool"; name: string; label: string }
	| { type: "note"; tell: boolean; note: string }
	| { type: "error"; error: string }
	| { type: "set-tell"; tell: boolean }
	| { type: "expand" }
	| { type: "close" };

export function sideThreadReducer(state: SideThreadState | null, action: SideThreadAction): SideThreadState | null {
	if (action.type === "open") {
		return {
			threadId: action.threadId, pairs: [], draft: null, learnerTell: null, mode: "popover", anchor: action.anchor,
			...(action.passage ? { pendingPassage: action.passage } : {}),
			// A thread on the waiting question opens beside the lesson, so the
			// question stays in view (a popover would cover the dock).
			...(action.questionCallId ? { questionCallId: action.questionCallId, mode: "panel" as const } : {}),
		};
	}
	if (action.type === "open-read-only") {
		const { details } = action;
		return {
			threadId: action.threadId, draft: null, learnerTell: details.toldTutor, mode: "popover", anchor: action.anchor, readOnly: details,
			pairs: details.thread.map((pair) => ({ ...pair, tell: details.toldTutor, note: details.note })),
		};
	}
	if (!state) return null;
	switch (action.type) {
		case "continue": {
			// A follow-up in a reopened thread: it lives again under a new id
			// and, on close, saves the whole thread in place of the old chip.
			if (!state.readOnly) return state;
			const { readOnly: _readOnly, ...rest } = state;
			return { ...rest, threadId: action.threadId, continues: state.threadId, learnerTell: null };
		}
		case "told":
			return state.readOnly && state.threadId === action.threadId
				? { ...state, learnerTell: true, readOnly: { ...state.readOnly, toldTutor: true } }
				: state;
		case "close":
			return null;
		case "expand":
			return { ...state, mode: "panel" };
		case "set-tell":
			return state.readOnly ? state : { ...state, learnerTell: action.tell };
		case "add-passage":
			return state.readOnly ? state : { ...state, pendingPassage: action.passage };
		case "ask": {
			const question = action.question.trim();
			if (state.readOnly || state.draft || !question || state.pairs.length >= SIDE_THREAD_MAX_PAIRS) return state;
			const { pendingPassage, failed: _failed, ...rest } = state;
			return {
				...rest,
				draft: {
					question,
					answer: "",
					...(pendingPassage ? {
						passage: pendingPassage.text,
						sourceMessageId: pendingPassage.sourceMessageId,
						...(pendingPassage.selector ? { selector: pendingPassage.selector } : {}),
					} : {}),
				},
			};
		}
		case "text": {
			if (!state.draft) return state;
			const { activity: _activity, ...draft } = state.draft;
			return { ...state, draft: { ...draft, answer: draft.answer + action.delta } };
		}
		case "tool":
			return state.draft ? { ...state, draft: { ...state.draft, activity: `${action.name} ${action.label}`.trim() } } : state;
		case "note": {
			if (!state.draft) return state;
			const { activity: _activity, ...draft } = state.draft;
			return { ...state, draft: null, pairs: [...state.pairs, { ...draft, tell: action.tell, note: action.note }] };
		}
		case "error": {
			if (!state.draft) return state;
			const { question, passage, sourceMessageId, selector } = state.draft;
			return {
				...state,
				draft: null,
				failed: { question, error: action.error },
				...(passage && sourceMessageId ? { pendingPassage: { text: passage, sourceMessageId, ...(selector ? { selector } : {}) } } : {}),
			};
		}
	}
	return state;
}

/** The toggle as shown (F2): the learner's setting, else the newest recommendation. */
export function displayedTell(state: SideThreadState): boolean {
	if (state.readOnly) return state.readOnly.toldTutor;
	return state.learnerTell ?? state.pairs[state.pairs.length - 1]?.tell ?? false;
}

/** The close route's body. */
export function sideCloseBody(state: SideThreadState) {
	return {
		threadId: state.threadId,
		thread: state.pairs,
		learnerTell: state.learnerTell,
		...(state.continues ? { continues: state.continues } : {}),
		...(state.draft ? {
			pending: {
				question: state.draft.question,
				...(state.draft.passage !== undefined ? { passage: state.draft.passage } : {}),
				...(state.draft.sourceMessageId !== undefined ? { sourceMessageId: state.draft.sourceMessageId } : {}),
				...(state.draft.selector !== undefined ? { selector: state.draft.selector } : {}),
			},
		} : {}),
	};
}

function newThreadId(): string {
	return `side_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Keepalive requests are capped at 64 KiB; a longer thread uses a plain
 *  request (it still completes on an in-app navigation). */
const KEEPALIVE_MAX_BYTES = 60_000;

function postClose(chatId: string, state: SideThreadState): Promise<void> {
	const body = JSON.stringify(sideCloseBody(state));
	const keepalive = new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
	return fetch(`/api/chats/${encodeURIComponent(chatId)}/side-question/close`, { method: "POST", body, keepalive })
		.then(() => undefined)
		.catch((err) => console.error("side thread close failed:", err));
}

/** How long an answer submit waits for the close to reach the server. */
const CLOSE_BEFORE_ANSWER_MS = 1_200;

export interface SideThreadOpenArgs {
	anchor: SideThreadAnchor;
	passage?: SidePassage;
	question?: string;
	/** Open from the question waiting for the learner (its tool call id). */
	questionCallId?: string;
}

export function useSideThread(chatId: string, getWorking?: () => string) {
	const [state, dispatch] = useReducer(sideThreadReducer, null);
	// The ref is truth for the callbacks (a close right after a toggle or a
	// frame must send it): every change goes through apply, which updates
	// the ref at once; the pure reducer gives React the same result.
	const stateRef = useRef(state);
	const apply = useCallback((action: SideThreadAction) => {
		stateRef.current = sideThreadReducer(stateRef.current, action);
		dispatch(action);
	}, []);
	// The reader of the answer streaming now; closing stops reading only —
	// the server finishes the answer and the close waits for it (F9).
	const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

	const stopReading = useCallback(() => {
		void readerRef.current?.cancel().catch(() => undefined);
		readerRef.current = null;
	}, []);

	const getWorkingRef = useRef(getWorking);
	getWorkingRef.current = getWorking;

	const close = useCallback((): Promise<void> => {
		const current = stateRef.current;
		if (!current) return Promise.resolve();
		stopReading();
		const posted = !current.readOnly && (current.pairs.length || current.draft) ? postClose(chatId, current) : Promise.resolve();
		apply({ type: "close" });
		return posted;
	}, [apply, chatId, stopReading]);

	/** Commit the open thread and wait (briefly) for the server to have it:
	 *  a thread closed before an answer parks behind the waiting question and
	 *  lands right after the answer's result, where the tutor's reaction
	 *  reads its note. */
	const closeBeforeAnswer = useCallback(
		() => Promise.race([close(), new Promise<void>((resolve) => setTimeout(resolve, CLOSE_BEFORE_ANSWER_MS))]),
		[close],
	);

	const ask = useCallback((question: string) => {
		if (stateRef.current?.readOnly && question.trim()) apply({ type: "continue", threadId: newThreadId() });
		const current = stateRef.current;
		if (!current) return;
		apply({ type: "ask", question });
		const next = stateRef.current;
		if (next === current || !next?.draft) return;
		const draft = next.draft;
		const threadId = current.threadId;
		const live = () => stateRef.current?.threadId === threadId;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-question`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						threadId,
						thread: current.pairs.map(({ tell: _tell, note: _note, ...pair }) => pair),
						question: draft.question,
						...(draft.passage !== undefined ? { passage: draft.passage } : {}),
						...(draft.sourceMessageId !== undefined ? { sourceMessageId: draft.sourceMessageId } : {}),
						...(draft.selector !== undefined ? { selector: draft.selector } : {}),
						// F10: the next note rewrites this one to cover the whole thread.
						...(current.pairs.length ? { note: current.pairs[current.pairs.length - 1]!.note } : {}),
						...(current.questionCallId ? { questionCallId: current.questionCallId } : {}),
						...(current.questionCallId && getWorkingRef.current?.().trim() ? { working: getWorkingRef.current!().trim().slice(0, SIDE_WORKING_MAX_CHARS) } : {}),
					}),
				});
				if (!res.ok || !res.body) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					if (live()) apply({ type: "error", error: body?.error ?? "The side question failed. Try asking again." });
					return;
				}
				const reader = res.body.getReader();
				readerRef.current = reader;
				for await (const frame of sseEvents(reader)) {
					if (!live()) return;
					if (frame.type === "text" && typeof frame.delta === "string") apply({ type: "text", delta: frame.delta });
					else if (frame.type === "tool") apply({ type: "tool", name: String(frame.name ?? ""), label: String(frame.label ?? "") });
					else if (frame.type === "note") apply({ type: "note", tell: frame.tell === true, note: String(frame.note ?? "") });
					else if (frame.type === "error") apply({ type: "error", error: String(frame.errorText ?? "The side question failed.") });
				}
			} catch {
				if (live()) apply({ type: "error", error: "The connection dropped. Try asking again." });
			} finally {
				if (live()) readerRef.current = null;
			}
		})();
	}, [apply, chatId]);

	/** Open a new thread; an open one closes (and commits) first (F7). */
	const open = useCallback((args: SideThreadOpenArgs) => {
		close();
		const action: SideThreadAction = {
			type: "open",
			threadId: newThreadId(),
			anchor: args.anchor,
			...(args.passage ? { passage: args.passage } : {}),
			...(args.questionCallId ? { questionCallId: args.questionCallId } : {}),
		};
		apply(action);
		if (args.question?.trim()) ask(args.question);
	}, [apply, ask, close]);

	const reopenReadOnly = useCallback((threadId: string, details: SideQuestionDetails, anchor: SideThreadAnchor) => {
		close();
		const action: SideThreadAction = { type: "open-read-only", threadId, details, anchor };
		apply(action);
	}, [apply, close]);

	const addPassage = useCallback((passage: SidePassage) => apply({ type: "add-passage", passage }), [apply]);
	const setTell = useCallback((tell: boolean) => apply({ type: "set-tell", tell }), [apply]);
	const expand = useCallback(() => apply({ type: "expand" }), [apply]);
	/** "Tell tutor" on a closed thread (its chip or its read-only reopen). */
	const tellTutor = useCallback(async (threadId: string): Promise<boolean> => {
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-question/tell`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ threadId }),
		}).catch(() => null);
		if (!res?.ok) return false;
		apply({ type: "told", threadId });
		return true;
	}, [apply, chatId]);

	// F6: leaving the chat or hiding the page commits the open thread.
	useEffect(() => {
		window.addEventListener("pagehide", close);
		return () => {
			window.removeEventListener("pagehide", close);
			close();
		};
	}, [close]);

	return { state, open, ask, addPassage, setTell, expand, close, closeBeforeAnswer, reopenReadOnly, tellTutor };
}
