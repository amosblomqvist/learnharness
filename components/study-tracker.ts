/**
 * THE STUDY TRACKER (design: docs/designs/study-time.md): the React-free
 * client half of study time. It tells the server two things — "the learner
 * is active in this chat" and "the learner stopped" — and the server keeps
 * the intervals. Clock, timers, focus and fetch are injected so the logic
 * is testable under node:test, the way components/session-core.ts is.
 *
 * One tracker per page (studyTracker()): windowId and the request queue
 * survive chat switches (`<Chat key={chat.id}>` remounts the view). The
 * hook (use-study-tracker.ts) only points it at the current chat.
 */

import { isStudyInput, STUDY_PING_MS, type StudyInput } from "../src/core";

export type StudySendResult = { ok: true } | { ok: false; error?: string };

export interface StudyTrackerDeps {
	setInterval: (fn: () => void, ms: number) => unknown;
	clearInterval: (handle: unknown) => void;
	setTimeout: (fn: () => void, ms: number) => unknown;
	hasFocus: () => boolean;
	randomId: () => string;
	send: (input: StudyInput, opts: { bypassQueue: boolean }) => Promise<StudySendResult>;
}

export function createStudyTracker(deps: StudyTrackerDeps) {
	const windowId = deps.randomId();
	let chatId: string | null = null;
	let started = false;
	/** An "active" went out for the current chat and no "stop" since. */
	let active = false;
	let inputSince = false;
	/** "active" was refused chat_not_started: retry on every tick. */
	let retry = false;
	/** chat_not_found for this chat id: silent until the id changes. */
	let silenced: string | null = null;
	let last: { screenX: number; screenY: number } | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	function dispatch(input: StudyInput, bypassQueue: boolean): Promise<StudySendResult> {
		const run = async (): Promise<StudySendResult> => {
			try {
				return await deps.send(input, { bypassQueue });
			} catch {
				return { ok: false };
			}
		};
		if (bypassQueue) return run();
		const result = queue.then(run);
		queue = result;
		return result;
	}

	function sendActive(): void {
		if (!chatId || !started || silenced === chatId) return;
		const id = chatId;
		active = true;
		inputSince = false;
		void dispatch({ type: "active", chatId: id, windowId }, false).then((res) => {
			if (res.ok) {
				if (chatId === id) retry = false;
			} else if (res.error === "chat_not_started") {
				if (chatId === id) retry = true;
			} else if (res.error === "chat_not_found") {
				silenced = id;
			}
		});
	}

	function sendStop(bypassQueue: boolean): void {
		if (!chatId || !active) return;
		active = false;
		void dispatch({ type: "stop", chatId, windowId }, bypassQueue);
	}

	function checkFocus(): void {
		if (active && !deps.hasFocus()) sendStop(false);
	}

	const timer = deps.setInterval(() => {
		if (!chatId || !started) return;
		checkFocus();
		if (!deps.hasFocus()) return;
		if (retry || inputSince) sendActive();
	}, STUDY_PING_MS);

	return {
		windowId,
		setChat(nextId: string | null, nextStarted: boolean): void {
			if (nextId !== chatId) {
				sendStop(false);
				chatId = nextId;
				started = nextStarted;
				active = false;
				inputSince = false;
				retry = false;
				silenced = null;
				if (chatId && started && deps.hasFocus()) sendActive();
				return;
			}
			const wasStarted = started;
			started = nextStarted;
			if (!wasStarted && started && deps.hasFocus()) sendActive();
		},
		focus(): void {
			if (chatId && started) sendActive();
		},
		blur(): void {
			deps.setTimeout(checkFocus, 0);
		},
		visibility(hidden: boolean): void {
			if (hidden) sendStop(false);
			else if (deps.hasFocus() && chatId && started) sendActive();
		},
		unload(): void {
			sendStop(true);
		},
		checkFocus,
		input(event: { type: string; screenX?: number; screenY?: number }): void {
			if (isStudyInput(event, last)) inputSince = true;
			if (event.type === "pointermove" && typeof event.screenX === "number" && typeof event.screenY === "number") {
				last = { screenX: event.screenX, screenY: event.screenY };
			}
		},
		noteInput(): void {
			inputSince = true;
		},
		dispose(): void {
			deps.clearInterval(timer);
			sendStop(false);
		},
	};
}

export type StudyTracker = ReturnType<typeof createStudyTracker>;

async function postStudy(input: StudyInput): Promise<StudySendResult> {
	try {
		const res = await fetch("/api/study", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
			keepalive: true,
		});
		if (res.ok) return { ok: true };
		const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
		return { ok: false, error: typeof body?.error === "string" ? body.error : undefined };
	} catch {
		return { ok: false };
	}
}

let singleton: StudyTracker | null = null;

/** The page's one tracker, created on first use. Never call during SSR. */
export function studyTracker(): StudyTracker {
	singleton ??= createStudyTracker({
		setInterval: (fn, ms) => window.setInterval(fn, ms),
		clearInterval: (h) => window.clearInterval(h as number),
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		hasFocus: () => document.hasFocus(),
		randomId: () => crypto.randomUUID(),
		send: (input) => postStudy(input),
	});
	return singleton;
}

/** Dictated transcript and demo input count as learner input. A no-op when
 *  no chat page has created the tracker (nothing is being tracked). */
export function noteStudyInput(): void {
	singleton?.noteInput();
}

/** A demo iframe lost focus: run the deferred focus check. */
export function checkStudyFocus(): void {
	singleton?.blur();
}
