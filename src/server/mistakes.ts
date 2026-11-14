import { findMistakes, mergeMistakes, sameSources, type MistakeDraft, type MistakeRecord } from "../core/mistakes.ts";
import type { PiEngine } from "../agent/models.ts";
import { readMistakes, updateMistakes } from "../store/mistakes.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { analyzeMistake } from "./mistake-analysis.ts";

/**
 * Finding and analyzing the learner's mistakes. A scan reads a session's saved
 * record, adds misses it has not seen (keyed by the answer's tool call so
 * scanning twice never duplicates), and queues each new one for the short
 * error analysis. The same scan serves the after-every-turn trigger and the
 * "scan past sessions" backfill.
 *
 * COST: the analyst is a cheap-slot model call per miss, so agent settings
 * carry an opt-out (`auto`) and a rolling 24-hour attempt cap (`dailyCap`).
 * Both are enforced here; explicit scans record misses either way while
 * still honoring the cap.
 */

/** Test seam: a scripted engine for the analyst. */
export const analysisEngineOverride: { current?: PiEngine } = {};

const DAY_MS = 24 * 60 * 60 * 1000;

interface AnalysisState {
	running: Set<string>;
	total: number;
	done: number;
	controller: AbortController | null;
}

/** One queue per process (globalThis: Next compiles each route as its own module). */
function state(): AnalysisState {
	const g = globalThis as typeof globalThis & { __lhMistakeAnalysis?: AnalysisState };
	return (g.__lhMistakeAnalysis ??= { running: new Set(), total: 0, done: 0, controller: null });
}

export interface AnalysisProgress {
	/** Analyses queued or running right now. */
	active: number;
	/** Of the current batch: how many have finished / how many there were. */
	done: number;
	total: number;
}

export function analysisProgress(): AnalysisProgress {
	const s = state();
	return { active: s.running.size, done: s.done, total: s.total };
}

function kindOf(kind: string | undefined): "teach" | "practice" | "chat" {
	return kind === "practice" || kind === "chat" ? kind : "teach";
}

/** How many model calls the analyst has started in the rolling 24 hours.
 *  Every finished attempt stamps `analyzedAt` (ready or failed), so the cap
 *  counts real spend, not just successes. */
export function analysesInLastDay(now = Date.now(), records = readMistakes()): number {
	const cutoff = now - DAY_MS;
	return records.filter((r) => r.analyzedAt && Date.parse(r.analyzedAt) >= cutoff).length;
}

/** The agent settings gate: auto analysis ON unless explicitly opted out. */
export function autoAnalysisEnabled(): boolean {
	return effectiveSettings().agent.mistakeAnalysis.auto;
}

/** How many misses a session holds that are not recorded yet (no writes). */
export function countNewMistakes(chatId: string, knownIds?: ReadonlySet<string>): number {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return 0;
	const known = knownIds ?? new Set(readMistakes().map((r) => r.id));
	return findMistakes(chatId, record.messages).filter((d) => !known.has(d.id)).length;
}

/** How many unrecorded misses exist across every saved session (single store read). */
export function countAllNewMistakes(): number {
	const known = new Set(readMistakes().map((r) => r.id));
	let total = 0;
	for (const chat of stores.chatStore.listChats()) total += countNewMistakes(chat.id, known);
	return total;
}

/** Record a session's new misses; returns their ids (analysis NOT started). */
export function recordChatMistakes(chatId: string): string[] {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return [];
	const drafts = findMistakes(chatId, record.messages);
	const existing = readMistakes();
	const known = new Set(existing.map((r) => r.id));
	const sources: string[] = [];
	const kind = kindOf(record.kind);
	const stale = existing.some(
		(r) => r.chatId === chatId && (r.sessionTitle !== record.title || r.sessionKind !== kind || !sameSources(r.sources, sources)),
	);
	if (!stale && drafts.every((d) => known.has(d.id))) return [];
	let added: MistakeRecord[] = [];
	updateMistakes((records) => {
		const merged = mergeMistakes(records, drafts, { chatId, title: record.title, kind, sources, now: new Date().toISOString() });
		added = merged.added;
		return merged.records;
	});
	return added.map((r) => r.id);
}

/** Record every session's misses in a single store update; returns the new ids. */
export function recordAllMistakes(): string[] {
	const batches: {
		chatId: string;
		title: string;
		kind: "teach" | "practice" | "chat";
		sources: string[];
		drafts: MistakeDraft[];
	}[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		if (!record) continue;
		batches.push({
			chatId: summary.id,
			title: record.title,
			kind: kindOf(record.kind),
			sources: [],
			drafts: findMistakes(summary.id, record.messages),
		});
	}
	if (batches.length === 0) return [];
	const existing = readMistakes();
	const known = new Set(existing.map((r) => r.id));
	const byChat = new Map(batches.map((b) => [b.chatId, b]));
	const hasStale = existing.some((r) => {
		const meta = byChat.get(r.chatId);
		return meta ? r.sessionTitle !== meta.title || r.sessionKind !== meta.kind || !sameSources(r.sources, meta.sources) : false;
	});
	const hasNew = batches.some((b) => b.drafts.some((d) => !known.has(d.id)));
	if (!hasStale && !hasNew) return [];

	const now = new Date().toISOString();
	const addedIds: string[] = [];
	updateMistakes((records) => {
		let next = records;
		for (const b of batches) {
			if (b.drafts.length === 0 && !next.some((r) => r.chatId === b.chatId)) continue;
			const merged = mergeMistakes(next, b.drafts, { chatId: b.chatId, title: b.title, kind: b.kind, sources: b.sources, now });
			next = merged.records;
			for (const item of merged.added) addedIds.push(item.id);
		}
		return next;
	});
	return addedIds;
}

function patch(id: string, fields: Partial<MistakeRecord>): void {
	updateMistakes((records) => records.map((r) => (r.id === id ? { ...r, ...fields } : r)));
}

/** Queue analyses for these mistakes (pending ones not already running),
 *  honoring the settings' rolling-24h attempt cap. */
export function enqueueAnalyses(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const s = state();
	const records = readMistakes();
	const byId = new Map(records.map((r) => [r.id, r]));
	const fresh = [...new Set(ids)].filter((id) => !s.running.has(id) && byId.has(id));
	if (fresh.length === 0) return;
	const cap = effectiveSettings().agent.mistakeAnalysis.dailyCap;
	// In-flight calls have not stamped `analyzedAt` yet — count them too so
	// two near-simultaneous scans cannot both spend the last permit.
	let used = analysesInLastDay(Date.now(), records) + s.running.size;
	const allowed: string[] = [];
	const cappedIds = new Set<string>();
	for (const id of fresh) {
		if (used >= cap) {
			cappedIds.add(id);
			continue;
		}
		used += 1;
		allowed.push(id);
	}
	if (cappedIds.size > 0) {
		// No call, no `analyzedAt` (that would count non-attempts against
		// tomorrow's budget too). The tab explains and allows retrying.
		const capError = `Daily analysis limit reached (${cap} in the last 24 hours). Raise it in Settings → Agent, or retry tomorrow.`;
		updateMistakes((current) =>
			current.map((r) => (cappedIds.has(r.id) ? { ...r, status: "failed", analysis: undefined, error: capError } : r)),
		);
	}
	if (allowed.length === 0) return;
	if (s.running.size === 0) {
		s.total = 0;
		s.done = 0;
	}
	if (!s.controller || s.controller.signal.aborted) {
		s.controller = new AbortController();
	}
	const controller = s.controller;
	for (const id of allowed) {
		const record = byId.get(id)!;
		s.running.add(id);
		s.total += 1;
		void (async () => {
			try {
				const analysis = await analyzeMistake(record, { engine: analysisEngineOverride.current, signal: controller.signal });
				patch(id, { status: "ready", analysis, error: undefined, analyzedAt: new Date().toISOString() });
			} catch (err) {
				const aborted = err instanceof Error && err.name === "AbortError";
				patch(id, {
					status: "failed",
					error: aborted ? "Cancelled." : err instanceof Error ? err.message : "Analysis failed.",
					analyzedAt: new Date().toISOString(),
				});
			} finally {
				s.running.delete(id);
				s.done += 1;
				if (s.running.size === 0) s.controller = null;
			}
		})();
	}
}

/** After a turn settles: record the session's new misses and analyze them
 *  (unless the user opted out of the automatic cheap-model calls). */
export function mistakesAfterTurn(chatId: string): void {
	if (process.env.NODE_ENV === "test") return; // scripted chats are fixtures
	try {
		if (!autoAnalysisEnabled()) return;
		enqueueAnalyses(recordChatMistakes(chatId));
	} catch (err) {
		console.error(`[chat ${chatId}] mistakes scan failed:`, err);
	}
}

/** Re-run one mistake's analysis (a failed or stale one). */
export function retryMistake(id: string): boolean {
	if (!readMistakes().some((r) => r.id === id)) return false;
	patch(id, { status: "pending", error: undefined });
	enqueueAnalyses([id]);
	return true;
}

/** Abort every queued/running analysis (they land as failed: Cancelled). */
export function cancelAnalyses(): void {
	state().controller?.abort();
}

export function deleteMistake(id: string): boolean {
	let found = false;
	updateMistakes((records) => records.filter((r) => (r.id === id ? ((found = true), false) : true)));
	return found;
}
