/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing around core/compaction's pure cuts and markers.
 *
 * TOPOLOGY (why this is simple): question and problem poses TERMINATE
 * their runs, so the "user is thinking" pause is always a BETWEEN-RUNS
 * window. Compaction therefore never touches a live run:
 *
 *   - SETTLE KICK — a turn settles (onFinish, after persist) and the
 *     projected context is over threshold: the summary starts NOW, in
 *     the background, while the learner reads/answers — usually done
 *     long before the next input arrives.
 *   - TURN-START GATE — every turn (client POST or wake) awaits any
 *     in-flight compaction for its chat BEFORE appends or beginTurn;
 *     if the record is STILL over threshold (cold sessions, kicks that
 *     lost their engine), compaction runs synchronously inside the
 *     request. Structurally gated: nothing model-facing for the chat
 *     interleaves with a running compaction (owner ruling — minimal
 *     surface for anything to go wrong).
 *   - OVERFLOW RECOVERY — a run that dies on context length needs no
 *     special path: the next turn's gate compacts and the fresh run
 *     starts small.
 *
 * The summary is written by the session's OWN conversation model (owner
 * ruling) via the zero-tool one-shot sub-agent seam; its usage lands in
 * the chat's append-only turns log (the money channel) keyed by the
 * marker's id.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	COMPACTION_RESERVE_TOKENS,
	estimateContextTokens,
	estimateTokens,
	newCompactionMarker,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	type CompactionDetails,
	type LhMessage,
	type LhMarkerMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

/** The summarizer's system prompt — server-owned operational framing,
 *  not model-facing doctrine (buildCompactionPrompt carries the shape). */
const SUMMARIZER_SYSTEM_PROMPT =
	"You are the session-compaction summarizer for a tutoring agent. You receive the transcript span to summarize and write exactly the summary the instructions demand — nothing else, no preamble, no meta-commentary.";

/** The one-shot summary call: zero tools, one turn, text out. The engine
 *  is the chat's own conversation engine (owner ruling: the session's
 *  model writes its own summary). Injectable for tests. */
export type Summarizer = (prompt: string, engine: PiEngine) => Promise<{ summary: string; usage: Usage }>;

/** The production summarizer over the sub-agent seam. */
async function subagentSummarizer(prompt: string, engine: PiEngine): Promise<{ summary: string; usage: Usage }> {
	let usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { text, newMessages } = await runSubagent([], {
		// The engine override is always present (the chat's own conversation
		// engine — owner ruling), so the role label never resolves an
		// engine; "researcher" is the least-wrong existing ModelRole label
		// for a one-shot text job (the cast documents the dead path).
		role: "researcher" as never,
		prompt,
		engine,
		systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
		maxTurns: 1,
		onUsage: (u) => {
			usage = u;
		},
	});
	// A provider-declared incomplete response is not a usable checkpoint,
	// even when it contains nonempty text. Match Pi's compaction failure
	// semantics: leave the existing history and prior summary untouched.
	if (newMessages.some((message) => message.role === "assistant" && message.stopReason === "length")) {
		throw new Error("Compaction summary hit the output limit and is incomplete");
	}
	return { summary: text, usage };
}

/** Everything the service needs from its host (chat-handler wires the
 *  production versions; tests inject). */
export interface CompactionDeps {
	/** Eligibility only for NEW runs; structural waits still apply. */
	canStart?: () => boolean;
	chatStore: ChatStore;
	/** The chat's conversation engine — also the summarizer's. */
	engine: PiEngine;
	/** provider:id of the engine (usage + marker provenance). */
	modelId: string;
	/** The session kind (summarizer wording: tutor vs practice). */
	kind: "teach" | "practice" | "probe";
	/** The effective trigger threshold, RESOLVED by the caller:
	 *  min(settings threshold, contextWindow − reserve) — the owner's
	 *  effective-trigger ruling. The catalog window lookup is the
	 *  caller's (chat-handler has the model id at hand). */
	thresholdTokens: number;
	/** The composed system prompt's token estimate (chars/4) — the
	 *  projection the provider actually receives starts with it. */
	systemPromptTokens: number;
	/** Injectable summarizer (tests); default = the sub-agent one-shot. */
	summarize?: Summarizer;
}

// ─── the registry (module-global on globalThis, jobs.ts's pattern) ─────────

interface CompactionState {
	inFlight: Map<string, Promise<void>>;
}
const g = globalThis as typeof globalThis & { __lhCompaction?: CompactionState };
function state(): CompactionState {
	return (g.__lhCompaction ??= { inFlight: new Map() });
}

/** Is a compaction running for this chat? (The client status event's
 *  server-side twin — tests and the SSE emitter read it.) */
export function compactionInFlight(chatId: string): boolean {
	return state().inFlight.has(chatId);
}

/** Await any in-flight compaction for the chat — the structural gate
 *  every model interaction for the chat passes through. */
export async function awaitCompaction(chatId: string): Promise<void> {
	const running = state().inFlight.get(chatId);
	if (running) await running;
}

// ─── the effective threshold (owner ruling: min(setting, window − reserve)) ─

/** Resolve the effective trigger. Unknown window → the setting alone
 *  (honest: no fake window — the catalog-index precedent). */
export function effectiveThresholdTokens(settingTokens: number | undefined, contextWindowTokens: number | undefined): number {
	const setting = settingTokens ?? 150_000;
	if (contextWindowTokens === undefined) return setting;
	return Math.min(setting, Math.max(contextWindowTokens - COMPACTION_RESERVE_TOKENS, 1));
}

// ─── the estimate over the ACTIVE projection ────────────────────────────────

/** The projected context estimate: what the next LLM call would carry.
 *  THE TRIGGER LAW (pi's, verified 2026-10-05): anchor on the last
 *  assistant message's provider-reported usage — it already counted
 *  the system prompt, tool declarations, and the provider's own
 *  tokenizer — and chars/4-estimate ONLY messages appended after it.
 *  estimateContextTokens refuses anchors that predate a compaction
 *  marker (that usage described context the next request will NOT
 *  carry), so the fallback path runs the plain heuristic over the
 *  CUT-HONORED projection (never the dropped span) plus the additive
 *  prompt term the anchor would have covered. */
export function projectedContextTokens(messages: readonly LhMessage[], systemPromptTokens: number): number {
	const est = estimateContextTokens(messages);
	if (est.lastUsageIndex !== null) return est.tokens;
	return estimateTokens(toLlmMessages(messages as readonly AgentMessage[]) as unknown as readonly LhMessage[]) + systemPromptTokens;
}

// ─── the compaction run ─────────────────────────────────────────────────────

/** Run one compaction for the chat (the registry mutex is HELD by the
 *  caller — ensureCompacted). Reads the record fresh, cuts, summarizes,
 *  appends the marker, records usage, notifies. Never throws upward
 *  past the registry cleanup. */
async function compact(deps: CompactionDeps, chatId: string): Promise<void> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	const messages = record.messages;
	const tokensBefore = projectedContextTokens(messages, deps.systemPromptTokens);
	if (tokensBefore <= deps.thresholdTokens) return; // settled beneath while we waited

	const cut = compactionCutIndex(messages);
	if (cut <= 0 || cut >= messages.length) return; // no history can be dropped

	// The previous compaction's kept boundary (chained compactions
	// summarize the old summary + what rode after it).
	const previous = activeCompactionOf(messages);
	const prevKept = previous ? messages.findIndex((m) => m.id === previous.details.firstKeptMessageId) : -1;
	// ANTI-CHURN GUARD: when the cut cannot advance past the previous
	// kept boundary, the span is empty (or repeats it) — the kept tail
	// alone carries the projection and re-summarizing the same span
	// cannot shrink it. Reachable only when the threshold sits below
	// kept-tail + summary (a hand-edited record below the settings
	// floor); skipping keeps the loop honest instead of churning.
	if (previous && prevKept !== -1 && cut <= prevKept) {
		console.info(
			`[chat ${chatId}] compaction skipped — the kept tail alone exceeds the threshold (raise it or shrink the tail)`,
		);
		return;
	}

	// The span: from the PREVIOUS kept boundary through the cut.
	let spanStart = 0;
	let priorSummary: string | null = null;
	if (previous && prevKept > 0) {
		spanStart = prevKept;
		priorSummary = previous.content;
	}
	const span = messages.slice(spanStart, cut);
	// The separately supplied prior summary replaces all summary markers
	// in this span. Without a resolved prior boundary, retain the existing
	// legacy fallback rather than silently discarding summary-only context.
	const summaryMessages = priorSummary
		? span.filter((m) => m.role !== "custom" || m.customType !== "compaction")
		: span;
	const spanText = serializeForSummary(summaryMessages);
	const fullSpan = priorSummary ? `[SYSTEM NOTE — prior compaction summary, still authoritative where not superseded]\n${priorSummary}\n\n${spanText}` : spanText;

	const prompt = buildCompactionPrompt({
		spanText: fullSpan,
		planTreeText: planTreeToText(record.tree, messages),
		kind: deps.kind,
	});

	emit("compaction-changed", { chatId, running: true });
	try {
		const summarize = deps.summarize ?? subagentSummarizer;
		const { summary, usage } = await summarize(prompt, deps.engine);
		const trimmed = summary.trim();
		if (!trimmed) return; // an empty summary is a refusal artifact — leave the record honest

		const firstKept = messages[cut]!;
		const details: CompactionDetails = {
			firstKeptMessageId: firstKept.id,
			tokensBefore,
			model: deps.modelId,
			at: new Date().toISOString(),
		};
		const marker = newCompactionMarker(trimmed, details);
		deps.chatStore.saveMessages(chatId, [...messages, marker]);
		// The money channel: the summary is a real model call on the
		// session's own engine — its usage keys to the marker (provenance:
		// the transcript shows the compaction divider at the marker).
		deps.chatStore.appendTurnUsage(chatId, {
			id: crypto.randomUUID(),
			messageId: marker.id,
			at: details.at,
			model: deps.modelId,
			steps: [
				{
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
					reasoningTokens: usage.reasoning ?? 0,
				},
			],
		});
		// Notify-then-fetch: the record gained the marker (the client's
		// dividers appear) and the status event ends the send gate.
		emit("record-changed", { chatId });
	} catch (err) {
		// A failed compaction leaves the record untouched — the next
		// turn-start gate retries (the same self-healing law as the
		// extraction trigger).
		console.error(`[chat ${chatId}] compaction failed:`, err);
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}

/**
 * The gate + trigger in one: await any in-flight compaction, then — if
 * the record is STILL over threshold — run one synchronously (the
 * caller's request waits; the owner's structural-gate ruling). Idempotent
 * under concurrency through the registry mutex.
 */
export async function ensureCompacted(deps: CompactionDeps, chatId: string): Promise<void> {
	// Skipped under tests, the extraction-trigger precedent: scripted
	// chats are fixtures — the service itself is tested directly with an
	// injected summarizer.
	if (process.env.NODE_ENV === "test" && !deps.summarize) return;
	await awaitCompaction(chatId);
	if (deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	if (state().inFlight.has(chatId)) return; // a concurrent caller started it while we awaited
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	try {
		await run;
	} finally {
		state().inFlight.delete(chatId);
	}
}

/**
 * The settle kick (fire-and-forget): the turn settled, the learner is
 * about to read/answer — if the projection is over threshold, the
 * summary starts NOW and finishes inside the pause. Wired at
 * chat-handler's onFinish tail; engineless or over-threshold-nothing
 * are silent no-ops. The next turn's ensureCompacted gate picks up
 * whatever this leaves running.
 */
export function kickCompaction(buildDeps: () => CompactionDeps | null, chatId: string): void {
	if (state().inFlight.has(chatId)) return;
	const deps = buildDeps();
	if (!deps || deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	void run.finally(() => state().inFlight.delete(chatId));
}
