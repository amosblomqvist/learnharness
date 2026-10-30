/**
 * Auto-read (ElevenLabs voice slice 10): decides whether the turn that just
 * ended is read aloud. Framework-free and fed by what chat.tsx already knows
 * each render, so every rule is testable without React.
 *
 * A turn is only eligible if this view SAW it begin (busy false -> true) and
 * see it end (true -> false). That one rule is what keeps history out: a
 * session opened or reloaded with replies already in it, a record adopted
 * from the server, and a turn that was already running when the view mounted
 * never play. What plays is the prose blocks the turn ADDED (proseBlocks: one
 * Listen source per text part, in order), never ones that existed when it began,
 * so a teaching group that keeps growing is not reread from its top. The verdict
 * is taken once, at the end; a skipped reply (setting
 * off, aborted, failed, dictating, nothing to say) is never revisited.
 *
 * Dock questions (slice 11) ride the same controller. A question counts as
 * new when it first appears during a turn this view watched (or in the very
 * observation that ends it); one already pending at mount, restored with a
 * reopened session or adopted from the server is "known" and never plays. Its
 * prompt plays AFTER the turn's reply: the player reads one source at a time,
 * so the controller queues it behind the reply's play() and starts it only if
 * that source played to its end. A Stop, Esc, another Listen, a failure,
 * dictation, the question being answered or a new turn all cancel it.
 */

import { parseAskInput, parseExplainInput, parseQuizInput, questionPromptMarkdown } from "@/src/core";

/** The slice of a projected view message the controller needs. */
export interface AutoReadMessage {
	id: string;
	role: string;
	parts: ReadonlyArray<{ type: string; id?: string; text?: string }>;
}

/** The pending dock question, as the controller needs it. */
export interface AutoReadQuestion {
	/** Identifies this occurrence (a reused tool call id in a newer message is a new question). */
	key: string;
	/** The dock Listen button's source id (questionSourceId). */
	sourceId: string;
	/** The prompt, as markdown (questionPromptMarkdown). */
	markdown: string;
	/** A teach-phase check still behind its "Check your understanding" reveal
	 *  (owner 2026-10-29): reading it aloud would give away what the collapse
	 *  hides, so it is known but never announced, and revealing it later does
	 *  not change that (only the manual Listen button reads it then). */
	collapsed?: boolean;
}

export interface AutoReadObservation {
	/** A turn is in flight: local stream or a server-side turn being watched. */
	busy: boolean;
	/** The turn ended in a failure the view shows (error status or banner). */
	failed: boolean;
	/** The read-aloud setting, as loaded; false until it has loaded. */
	enabled: boolean;
	/** stopReason of the final native assistant message (see finalAssistantStop). */
	finalStop: string | undefined;
	/** The projected transcript, as rendered. */
	messages: readonly AutoReadMessage[];
	/** The pending dock question, if any. */
	question?: AutoReadQuestion | null;
}

/** One prose block of a message: what one Listen button reads. */
export interface ProseBlock {
	/** Stable and unique per block: the view part id (`<native message id>-t<n>`),
	 *  which survives re-projection. A part without one falls back to its position. */
	sourceId: string;
	markdown: string;
	/** Where the text part sits in the message, so a renderer can put the button under it. */
	partIndex: number;
}

/** The message's prose blocks, in order: its text parts only (never reasoning
 *  or tool cards), blank ones dropped. A teaching group merges several native
 *  messages into one view message, so the Listen button and the auto-read
 *  controller both work per block (never the whole group) through this one
 *  function and so can never disagree about ids or text. */
export function proseBlocks(message: { id: string; parts: AutoReadMessage["parts"] }, index: number): ProseBlock[] {
	const owner = message.id || `m-${index}`;
	return message.parts.flatMap((part, i) =>
		part.type === "text" && part.text?.trim() ? [{ sourceId: part.id || `${owner}-p${i}`, markdown: part.text, partIndex: i }] : [],
	);
}

/** The block that may still be streaming: the newest message's final one while
 *  a turn is busy (the view marks every text part "done", so position is the
 *  only signal). Its Listen button waits; settled blocks above it keep theirs. */
export function blockInProgress(blocks: readonly ProseBlock[], newest: boolean, busy: boolean): string | null {
	return newest && busy ? (blocks[blocks.length - 1]?.sourceId ?? null) : null;
}

/** The dock Listen button's source id for a question: never a message's id. */
export function questionSourceId(toolCallId: string): string {
	return `q-${toolCallId}`;
}

/** The dock's pending question as the controller sees it, parsed like the dock
 *  parses it (probe/recall are the quiz/explain twins). null when there is none
 *  or its input is malformed (the dock shows its fallback then). */
export function pendingQuestionSource(
	pending: { key: string; toolCallId: string; tool: string; input: unknown } | null,
): AutoReadQuestion | null {
	if (!pending) return null;
	const parsed =
		pending.tool === "quiz" || pending.tool === "probe"
			? parseQuizInput(pending.input)
			: pending.tool === "explain" || pending.tool === "recall"
				? parseExplainInput(pending.input)
				: parseAskInput(pending.input);
	if (!parsed) return null;
	return {
		key: pending.key,
		sourceId: questionSourceId(pending.toolCallId),
		markdown: questionPromptMarkdown({ question: parsed.question, context: parsed.details }),
	};
}

/** Marks the question as a still-collapsed teach check (see AutoReadQuestion.collapsed). */
export function withCollapsed(question: AutoReadQuestion | null, collapsed: boolean): AutoReadQuestion | null {
	return question && collapsed ? { ...question, collapsed: true } : question;
}

/** stopReason of the last assistant message in the native record. */
export function finalAssistantStop(native: ReadonlyArray<{ role: string; stopReason?: string }>): string | undefined {
	for (let i = native.length - 1; i >= 0; i--) {
		if (native[i]!.role === "assistant") return native[i]!.stopReason;
	}
	return undefined;
}

export interface AutoRead {
	observe(observation: AutoReadObservation): void;
}

interface QueuedRead {
	sourceId: string;
	markdown: string;
	/** Set on a question: it only plays while that question is still pending. */
	questionKey?: string;
}

export function createAutoRead({ play, dictating }: {
	/** Start reading `markdown` as `sourceId` (the window player, in the app).
	 *  May return a promise that settles when the source ended: `false` means it
	 *  was cut off or failed, and nothing queued behind it then plays. */
	play: (sourceId: string, markdown: string) => Promise<boolean> | void;
	dictating: () => boolean;
}): AutoRead {
	let seen = false;
	let wasBusy = false;
	/** The ids of every prose block when the turn began; null for a turn the
	 *  view did not see begin. */
	let before: Set<string> | null = null;
	const played = new Set<string>();
	/** Every question occurrence this view has observed. */
	const knownQuestions = new Set<string>();
	/** The question that appeared during the turn in flight, awaiting its end. */
	let freshQuestion: string | null = null;
	/** The question pending right now. */
	let currentQuestion: string | null = null;
	/** Bumped when a turn begins: a prompt queued by an earlier one is stale. */
	let epoch = 0;

	const spokenById = (messages: readonly AutoReadMessage[]) => {
		const ids = new Set<string>();
		messages.forEach((m, i) => { if (m.role === "assistant") for (const b of proseBlocks(m, i)) ids.add(b.sourceId); });
		return ids;
	};

	/** The prose blocks the turn added, in order: none that existed when it began
	 *  or that were played already. */
	const blocksToRead = (o: AutoReadObservation, start: Set<string>): QueuedRead[] =>
		o.messages.flatMap((m, i) => (m.role === "assistant" ? proseBlocks(m, i) : []))
			.filter((b) => !start.has(b.sourceId) && !played.has(b.sourceId));

	/** Play in order; each step starts only if the one before it played to its end. */
	const playInOrder = (queue: readonly QueuedRead[]) => {
		const mine = epoch;
		const step = (i: number) => {
			const item = queue[i]!;
			const result = play(item.sourceId, item.markdown);
			const next = queue[i + 1];
			if (!next) return;
			void Promise.resolve(result).then((finished) => {
				if (finished === false || epoch !== mine || dictating()) return;
				if (next.questionKey !== undefined && next.questionKey !== currentQuestion) return;
				step(i + 1);
			}, () => {});
		};
		step(0);
	};

	return {
		observe(o) {
			// A collapsed check is recorded as known and otherwise treated as no
			// question, so no later observation (revealed or not) can announce it.
			const question = o.question && !o.question.collapsed ? o.question : null;
			const isNew = question !== null && !knownQuestions.has(question.key);
			if (o.question) knownQuestions.add(o.question.key);
			currentQuestion = question?.key ?? null;
			if (o.busy) {
				if (!wasBusy) {
					before = seen ? spokenById(o.messages) : null;
					freshQuestion = null;
					epoch++;
				}
				wasBusy = true;
				seen = true;
				if (isNew && before) freshQuestion = question.key;
				return;
			}
			seen = true;
			if (!wasBusy) return;
			wasBusy = false;
			const start = before;
			before = null;
			if (isNew && start) freshQuestion = question.key;
			const announce = question !== null && freshQuestion === question.key ? question : null;
			freshQuestion = null;
			if (!start || !o.enabled || o.failed) return;
			if (o.finalStop === "error" || o.finalStop === "aborted") return;
			if (dictating()) return;
			const queue: QueuedRead[] = [];
			for (const block of blocksToRead(o, start)) {
				played.add(block.sourceId);
				queue.push(block);
			}
			if (announce) queue.push({ sourceId: announce.sourceId, markdown: announce.markdown, questionKey: announce.key });
			if (queue.length > 0) playInOrder(queue);
		},
	};
}
