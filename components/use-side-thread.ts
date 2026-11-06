"use client";

/** #451's single floating/docked companion, backed by #487's durable service.
 * Closing detaches a view; messages are already saved, and returning can
 * subscribe to a still-running answer. No close-time commits or tutor notes. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { sideSegmentId, type LhMessage, type TextSelector, type SideChatMessage, type SideChatThread } from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";

export type SideThreadAnchor = { kind: "range"; range: Range } | { kind: "element"; element: HTMLElement } | { kind: "composer" };
export interface SidePassage { text: string; sourceMessageId: string; selector?: Omit<TextSelector, "text"> }
export interface SideThreadOpenArgs {
	anchor: SideThreadAnchor;
	passage?: SidePassage;
	sourceMessageId?: string;
	questionCallId?: string;
	question?: string;
}
export interface SideThreadState {
	threadId: string;
	segmentId: string;
	messages: SideChatMessage[];
	answering: boolean;
	streamText: string;
	pendingPassage?: SidePassage;
	contextFrozen: boolean;
	mode: "popover" | "panel";
	anchor: SideThreadAnchor;
	error?: string;
	failedQuestion?: string;
}
export type SideThreadAction =
	| { type: "open"; segmentId: string; anchor: SideThreadAnchor; passage?: SidePassage; thread?: SideChatThread; contextFrozen?: boolean }
	| { type: "snapshot"; thread: SideChatThread; answering?: boolean; text?: string }
	| { type: "start"; threadId: string }
	| { type: "accepted"; threadId: string }
	| { type: "text"; threadId: string; text: string }
	| { type: "error"; threadId: string; error: string; question?: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "mode"; mode: "popover" | "panel" }
	| { type: "close" };
export function sideThreadReducer(state: SideThreadState | null, action: SideThreadAction): SideThreadState | null {
	if (action.type === "close") return null;
	if (action.type === "open") {
		const threadId = action.thread?.id ?? `side_${action.segmentId}`;
		if (state?.threadId === threadId) return { ...state, ...(action.passage ? { pendingPassage: action.passage } : {}) };
		return { threadId, segmentId: action.segmentId, messages: action.thread?.messages ?? [], answering: false, streamText: "",
			contextFrozen: action.contextFrozen ?? (action.thread?.contextSnapshot !== undefined), mode: "popover", anchor: action.anchor, pendingPassage: action.passage };
	}
	if (!state) return state;
	if (action.type === "mode") return { ...state, mode: action.mode };
	const threadId = "thread" in action ? action.thread.id : action.threadId;
	if (threadId !== state.threadId) return state;
	if (action.type === "snapshot" || action.type === "done") return {
		...state, messages: action.thread.messages, contextFrozen: state.contextFrozen || action.thread.contextSnapshot !== undefined,
		...(action.type === "done" || (action.type === "snapshot" && action.answering === false && action.thread.messages.at(-1)?.role === "assistant") ? { error: undefined } : {}),
		...(action.type === "done" ? { answering: false, streamText: "" } : {
			...(action.answering !== undefined ? { answering: action.answering } : {}),
			...(action.text !== undefined ? { streamText: action.text } : {}),
		}),
	};
	if (action.type === "start") return { ...state, answering: true, streamText: "", error: undefined, failedQuestion: undefined };
	if (action.type === "accepted") return { ...state, pendingPassage: undefined };
	if (action.type === "text") return { ...state, answering: true, streamText: action.text };
	return { ...state, answering: false, error: action.error, failedQuestion: action.question };
}

export function useSideThread(chatId: string, messages: readonly LhMessage[], getWorking?: () => string) {
	const [state, dispatch] = useReducer(sideThreadReducer, null);
	const [threads, setThreads] = useState<SideChatThread[]>([]);
	const stateRef = useRef(state); stateRef.current = state;
	const messagesRef = useRef(messages); messagesRef.current = messages;
	const threadsRef = useRef(threads); threadsRef.current = threads;
	const workingRef = useRef(getWorking); workingRef.current = getWorking;
	const connection = useRef<{ controller: AbortController; token: number } | null>(null);
	const serial = useRef(0);
	const revision = useRef(0);
	const refreshSerial = useRef(0);
	const uncertain = useRef<{ segmentId: string; text: string; quote?: string; requestId: string } | null>(null);
	const initialQuestion = useRef<string | null>(null);
	const drafts = useRef(new Map<string, string>());
	const [, syncExternalDraft] = useState(0);
	const draftFor = useCallback((threadId: string) => drafts.current.get(threadId) ?? "", []);
	const saveDraft = useCallback((threadId: string, text: string, notify = false) => {
		drafts.current.set(threadId, text);
		if (notify) syncExternalDraft((revision) => revision + 1);
	}, []);
	const adopt = useCallback((thread: SideChatThread) => {
		revision.current++;
		setThreads((current) => current.some((entry) => entry.id === thread.id)
			? current.map((entry) => entry.id === thread.id ? thread : entry) : [...current, thread]);
	}, []);
	const refresh = useCallback(async () => {
		const request = ++refreshSerial.current;
		const before = revision.current;
		try {
			const response = await fetch(`/api/chats/${chatId}/side-chats`, { cache: "no-store" });
			if (!response.ok) return;
			const payload = await response.json() as { threads: SideChatThread[]; answering: Record<string, string> };
			if (request !== refreshSerial.current || before !== revision.current) return;
			setThreads(payload.threads);
			const current = stateRef.current;
			const thread = current && payload.threads.find((entry) => entry.id === current.threadId);
			if (thread) dispatch({ type: "snapshot", thread,
				answering: Object.hasOwn(payload.answering, thread.id), text: payload.answering[thread.id] ?? "" });
		} catch { /* a later change/resync retries a detached view's read */ }
	}, [chatId]);
	useEffect(() => { void refresh(); return () => { refreshSerial.current++; connection.current?.controller.abort(); }; }, [refresh]);
	useServerEvent("side-chats-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerEvent("record-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerResync(() => { void refresh(); });

	const consume = useCallback(async (response: Response, threadId: string, token: number) => {
		if (token !== connection.current?.token) { await response.body?.cancel(); return; }
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
			throw new Error(typeof body?.error === "string" ? body.error : body?.error?.message ?? "The side conversation could not be reached.");
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("The side answer had no response stream.");
		const decoder = new TextDecoder(); let buffer = ""; let terminal = false;
		const apply = (line: string) => {
			if (!line.trim() || token !== connection.current?.token) return;
			const event = JSON.parse(line) as { type: string; thread?: SideChatThread; text?: string; error?: string };
			if (event.type === "done" || event.type === "error") terminal = true;
			if (event.thread) {
				adopt(event.thread);
				dispatch({ type: event.type === "done" ? "done" : "snapshot", thread: event.thread });
				uncertain.current = null;
			} else if (event.type === "text") dispatch({ type: "text", threadId, text: event.text ?? "" });
			else if (event.type === "error") throw new Error(event.error ?? "The side answer failed.");
		};
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) { buffer += decoder.decode(); if (buffer.trim()) apply(buffer); break; }
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) { apply(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
			}
			if (!terminal && token === connection.current?.token) throw new Error("The side answer disconnected. Reopen the conversation to reconnect.");
		} finally { reader.releaseLock(); }
	}, [adopt]);

	const attach = useCallback((thread: SideChatThread) => {
		connection.current?.controller.abort();
		const controller = new AbortController(); const token = ++serial.current;
		connection.current = { controller, token };
		void fetch(`/api/chats/${chatId}/side-chats/${thread.id}`, { cache: "no-store", signal: controller.signal })
			.then((response) => consume(response, thread.id, token))
			.catch((error) => { if (!controller.signal.aborted && token === connection.current?.token) dispatch({ type: "error", threadId: thread.id, error: String(error.message ?? error) }); });
	}, [chatId, consume]);
	const open = useCallback(({ anchor, passage, sourceMessageId, questionCallId, question }: SideThreadOpenArgs) => {
		const source = sourceMessageId ?? passage?.sourceMessageId ?? (questionCallId ? messagesRef.current.find((message) => message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && block.id === questionCallId))?.id : undefined);
		const segmentId = sideSegmentId(messagesRef.current, source);
		if (!segmentId) return;
		const thread = threadsRef.current.find((entry) => entry.anchor.messageId === segmentId);
		initialQuestion.current = question?.trim() || null;
		dispatch({ type: "open", segmentId, anchor, passage, thread, contextFrozen: thread?.contextSnapshot !== undefined || segmentId !== sideSegmentId(messagesRef.current) });
		if (thread) attach(thread);
	}, [attach]);
	const close = useCallback((expectedThreadId?: string) => {
		if (expectedThreadId && stateRef.current?.threadId !== expectedThreadId) return;
		connection.current?.controller.abort(); connection.current = null;
		dispatch({ type: "close" });
	}, []);
	const ask = useCallback(async (text: string, retry = false, expectedThreadId?: string): Promise<boolean> => {
		const current = stateRef.current;
		if (!current || (expectedThreadId && expectedThreadId !== current.threadId) || current.answering || (!text.trim() && !retry)) return false;
		const previous = uncertain.current;
		const requestId = previous?.segmentId === current.segmentId && previous.text === text && previous.quote === current.pendingPassage?.text
			? previous.requestId : `ask_${crypto.randomUUID().replaceAll("-", "")}`;
		uncertain.current = { segmentId: current.segmentId, text, quote: current.pendingPassage?.text, requestId };
		connection.current?.controller.abort();
		const controller = new AbortController(); const token = ++serial.current;
		connection.current = { controller, token };
		dispatch({ type: "start", threadId: current.threadId });
		try {
			const existing = threadsRef.current.some((thread) => thread.id === current.threadId);
			const working = current.segmentId === sideSegmentId(messagesRef.current) ? workingRef.current?.() : undefined;
			const response = await fetch(`/api/chats/${chatId}/side-chats`, {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ ...(existing ? { threadId: current.threadId } : { anchor: {
					messageId: current.segmentId, partId: `${current.segmentId}-t0`, blockIndex: 0, blockText: "This teaching segment and its question.",
				} }), text, quotes: current.pendingPassage ? [current.pendingPassage.text] : [], requestId, ...(retry ? { retry: true, threadId: current.threadId } : {}), ...(working ? { working } : {}) }),
			});
			if (!response.ok) { await consume(response, current.threadId, token); return false; }
			// Accepted and durable before streaming: the UI can clear its draft.
			dispatch({ type: "accepted", threadId: current.threadId });
			void consume(response, current.threadId, token).catch((error) => {
				if (!controller.signal.aborted && token === connection.current?.token) {
					dispatch({ type: "error", threadId: current.threadId, error: String(error.message ?? error) }); void refresh();
				}
			});
			return true;
		} catch (error) {
			if (!controller.signal.aborted && token === connection.current?.token) dispatch({ type: "error", threadId: current.threadId, error: String((error as Error).message ?? error), question: text });
			return false;
		}
	}, [chatId, consume, refresh]);
	useEffect(() => {
		if (!state || !initialQuestion.current || state.answering) return;
		const question = initialQuestion.current; initialQuestion.current = null;
		void ask(question);
	}, [state, ask]);
	const stop = useCallback(() => {
		const current = stateRef.current;
		if (current) void fetch(`/api/chats/${chatId}/side-chats/${current.threadId}/stop`, { method: "POST" }).catch(() => {});
	}, [chatId]);
	return { state, threads, open, close, ask, stop, draftFor, saveDraft,
		expand: () => dispatch({ type: "mode", mode: "panel" }),
		float: () => dispatch({ type: "mode", mode: "popover" }),
		hasHistory: (sourceMessageId: string) => {
			const segmentId = sideSegmentId(messages, sourceMessageId);
			return threads.some((thread) => thread.anchor.messageId === segmentId && thread.messages.length > 0);
		},
	};
}
