/**
 * THE ASIDE SERVICE (issue #16 — "/btw"-style side questions): quick
 * clarifications answered OUTSIDE the main conversation.
 *
 * WHAT AN ASIDE IS NOT: it is not a turn. It never enters
 * ChatRecord.messages, so the main projection (toLlmMessages), compaction,
 * and context accounting never see it; it holds no turn liveness, fires no
 * turn-started/turn-settled, and wakes nothing.
 *
 * WHAT IT DOES: one synchronous request → refuse while a main turn runs
 * (the chat file's messages field belongs to that turn's read-modify-write
 * window — asking after the current reply is the honest contract), build a
 * BOUNDED SNAPSHOT of the session (core/asides.ts: last
 * ASIDE_CONTEXT_MESSAGES user-facing exchanges + the current plan tree),
 * answer it with a ONE-SHOT sub-agent on the chat's own conversation
 * engine (the compaction seam: runSubagent, dedicated system prompt,
 * read-only learner-file tools, bounded turns + wall clock), then persist
 * the {question, answer} pair to ChatRecord.asides through the normal
 * store path and announce it with record-changed (the notify-then-fetch
 * law for cross-view updates).
 *
 * Liveness discipline (the asymmetry is deliberate): the aside REFUSES
 * while a main turn runs, but a main turn does not refuse while an aside
 * runs. saveAsides replaces only the asides field over a FRESH record
 * read, and a settling turn's saveMessages replaces only messages the same
 * way — neither can clobber the other, so blocking main turns (and
 * flickering every view with turn-started) would buy nothing.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { healToolRecord } from "../agent/tools/heal.ts";
import { createReadTool } from "../agent/tools/read.ts";
import { lsTool } from "../agent/tools/ls.ts";
import { findTool } from "../agent/tools/find.ts";
import { grepTool } from "../agent/tools/grep.ts";
import {
	asideContextExcerpt,
	buildAsidePrompt,
	newAsideThreadId,
} from "../core/asides.ts";
import type { AsideThread } from "../core/contracts.ts";
import { planTreeToText } from "../core/compaction.ts";
import { emit } from "../core/events.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import {
	modelsNotConfigured,
	providerKeyMissing as providerKeyMissingEnvelope,
} from "../core/settings.ts";
import { awaitCompaction } from "./compaction.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** The aside answerer's doctrine — a DISTINCT composition, not the teaching
 *  prompt (the design law: the aside must not continue the lesson). */
const ASIDE_SYSTEM_PROMPT =
	"You answer quick aside questions for a learner who is mid-session with a tutoring agent. You are not that agent, and nothing you write enters the lesson.\n" +
	"\n" +
	"How to answer:\n" +
	"- Answer directly and concisely: usually a few sentences, at most one short worked example. Match the level and notation the session excerpt uses.\n" +
	"- Stay on the question. Do not quiz the learner, do not change or extend the session's plan, do not introduce new topics, and do not continue the lesson.\n" +
	"- You may read the learner's files with the read-only tools (read, ls, find, grep) when the question is about them; paths resolve from the learner's home folder.\n" +
	"- If the excerpt shows a question still waiting for the learner's answer, never answer it for them — clarify terms or notation instead.\n" +
	"- Reply with the answer itself in plain prose (no headings); it is shown in a small side panel, not the main lesson.";

/** Bounded turns: an answer plus a few file-check rounds — an aside must
 *  not grow into a research session. */
const ASIDE_MAX_TURNS = 6;
/** Wall-clock bound for the synchronous request (the search-fetch
 *  precedent is 30s; file reads justify more, but a quick clarification
 *  must stay quick). */
export const ASIDE_TIMEOUT_MS = 120_000;

/** The one-shot answer seam (compaction's Summarizer pattern): the route
 *  and tests drive the same gates; tests inject an answerer or a scripted
 *  engine to assert the snapshot and persistence without a provider. */
export interface AsideAnswerInput {
	systemPrompt: string;
	prompt: string;
	engine: PiEngine;
	chatId: string;
	abortSignal: AbortSignal;
}

export type AsideAnswerer = (input: AsideAnswerInput) => Promise<{ text: string; usage: Usage }>;

/** The read-only learner-file set (the prober's always-on subset — no
 *  question, plan, job, or graph tools: an aside cannot teach or mutate). */
function asideTools(engine: PiEngine): AgentTool<any, any>[] {
	return Object.values(
		healToolRecord({
			read: createReadTool(engine.model),
			ls: lsTool,
			find: findTool,
			grep: grepTool,
		}),
	);
}

/** The production answerer over the sub-agent seam (the compaction
 *  precedent): fresh stateless agent, driven to completion, usage
 *  collected per model call. */
const subagentAnswerer: AsideAnswerer = async (input) => {
	let usage: Usage = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { text } = await runSubagent(asideTools(input.engine), {
		// The engine override is always present (the chat's own conversation
		// engine), so the role label never resolves one — the same dead-path
		// cast compaction makes.
		role: "researcher" as never,
		engine: input.engine,
		systemPrompt: input.systemPrompt,
		prompt: input.prompt,
		maxTurns: ASIDE_MAX_TURNS,
		abortSignal: input.abortSignal,
		chatId: input.chatId,
		onUsage: (u) => {
			usage = u;
		},
	});
	return { text, usage };
};

// ─── the aside-busy registry (globalThis, turn-liveness's channel) ───────────

interface LhAsideGlobal {
	__lhAsideRuns?: Set<string>;
}

function asideRuns(): Set<string> {
	const g = globalThis as typeof globalThis & LhAsideGlobal;
	return (g.__lhAsideRuns ??= new Set<string>());
}

/** Is an aside being answered for the chat right now? (One at a time, v1:
 *  the request is synchronous — a second question queues behind the UI.) */
export function asideInFlight(chatId: string): boolean {
	return asideRuns().has(chatId);
}

// ─── the request ─────────────────────────────────────────────────────────────

export interface AsideRunOptions {
	/** Test seam: a scripted engine replaces the resolved conversation one. */
	engine?: PiEngine;
	/** Test seam: bypass the sub-agent entirely (snapshot/persistence pins). */
	answerer?: AsideAnswerer;
}

/**
 * One aside question → one synchronous answer. Framework-free (plain
 * Request/Response semantics — returns a Response like handleChatInput),
 * so tests drive it directly and the Next route is a one-line wrapper.
 */
export async function askAside(chatId: string, rawText: string, opts: AsideRunOptions = {}): Promise<Response> {
	const text = rawText.trim();
	if (!text) return Response.json({ error: "The aside question is empty." }, { status: 400 });
	let record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	// THE MAIN-TURN REFUSAL (issue #16's non-interference law): while a
	// turn runs, the record's message list belongs to that turn, and the
	// aside's snapshot would read a transcript still being written. Refuse
	// with the 409-family busy answer — the UI copy tells the learner to
	// ask after the current reply. No liveness effects on this path.
	if (isTurnRunning(chatId)) {
		return Response.json(
			{ error: "A reply is being written right now — ask your aside after the current reply." },
			{ status: 409 },
		);
	}
	// One aside at a time (synchronous v1): a second question would double
	// the run's engine cost and race the thread append.
	if (asideInFlight(chatId)) {
		return Response.json({ error: "An aside is already being answered — wait for its reply." }, { status: 409 });
	}

	// The turn gates' mirrors, same placement discipline (before any state
	// change): the conversation chain (chat.model → strong slot, no factory
	// floor) and the provider key. Honest 503 envelopes, never a guess.
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] aside refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] aside refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// The compaction structural gate: nothing model-facing interleaves with
	// a running compaction for the chat — the aside waits it out like a
	// turn does, then re-reads durable truth (compaction appends markers).
	await awaitCompaction(chatId);
	record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	// Claim aside-busy for the run's duration (the double-begin race guard:
	// a concurrent aside slipped past the check above lands here).
	if (!claimAside(chatId)) {
		return Response.json({ error: "An aside is already being answered — wait for its reply." }, { status: 409 });
	}
	try {
		const engine =
			opts.engine ??
			piEngineForSpec(conversation, true, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
		// The bounded snapshot (NEVER the live record): recent user-facing
		// exchange + the current plan. The main transcript stays unread
		// beyond the bound — an aside is not a continuation.
		const prompt = buildAsidePrompt({
			excerpt: asideContextExcerpt(record.messages),
			planTreeText: planTreeToText(record.tree, record.messages),
			question: text,
			kind: record.kind ?? "teach",
		});
		const answerer = opts.answerer ?? subagentAnswerer;
		const { text: answer, usage } = await answerer({
			systemPrompt: ASIDE_SYSTEM_PROMPT,
			prompt,
			engine,
			chatId,
			abortSignal: AbortSignal.timeout(ASIDE_TIMEOUT_MS),
		});
		const trimmed = answer.trim();
		if (!trimmed) return Response.json({ error: "The aside produced no answer — try asking again." }, { status: 502 });

		// Persist the pair: v1 appends to the session's single thread (the
		// record's last), creating it on first ask. The whole pair lands in
		// ONE write or not at all — no half-exchanges.
		const threads = record.asides ?? [];
		const now = new Date().toISOString();
		const pair = [
			{ role: "user" as const, text, at: now },
			{ role: "assistant" as const, text: trimmed, at: new Date().toISOString() },
		];
		let thread: AsideThread;
		let asides: AsideThread[];
		const last = threads[threads.length - 1];
		if (last) {
			thread = { ...last, messages: [...last.messages, ...pair] };
			asides = threads.with(threads.length - 1, thread);
		} else {
			thread = { id: newAsideThreadId(), createdAt: now, messages: [...pair] };
			asides = [...threads, thread];
		}
		stores.chatStore.saveAsides(chatId, asides);

		// The money channel (the compaction precedent): the aside is real
		// spend on the session's engine — file it under the thread id so
		// the stats bar's aggregates include it. Bookkeeping failure must
		// not misreport the saved answer as lost.
		try {
			stores.chatStore.appendTurnUsage(chatId, {
				id: crypto.randomUUID(),
				messageId: thread.id,
				at: now,
				model: `${engine.model.provider}:${engine.model.id}`,
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
		} catch (err) {
			console.error(`[chat ${chatId}] aside usage bookkeeping failed:`, err);
		}

		// Notify-then-fetch: other views of this chat refetch the record
		// and see the thread; our own caller adopts the response directly.
		emit("record-changed", { chatId });
		return Response.json({ ok: true, thread });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return Response.json({ error: "The aside took too long and was stopped — try a shorter question." }, { status: 504 });
		}
		console.error(`[chat ${chatId}] aside failed:`, err);
		return Response.json({ error: "The aside could not be answered. Please try again." }, { status: 500 });
	} finally {
		releaseAside(chatId);
	}
}

function claimAside(chatId: string): boolean {
	if (asideInFlight(chatId)) return false;
	asideRuns().add(chatId);
	return true;
}

function releaseAside(chatId: string): void {
	asideRuns().delete(chatId);
}
