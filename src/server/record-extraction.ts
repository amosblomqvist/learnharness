/**
 * Plugin record extraction — the host side (session/record kinds, stage B;
 * owner principle P3 with the 2026-11-17 raw-transcript refinement).
 *
 * The host owns everything except the extraction itself: it derives what is
 * uncovered (raw saved messages, rawCoverageSlots), batches it under the
 * record's chunk budget, triggers after turns, shows each batch as a job in
 * the shared extraction registry (dock row, abort, ring "running", deletion
 * wind-down — one truth with the native pipeline), and writes coverage.
 * The plugin's extract(batch) folds a batch into its own record.
 *
 * Coverage = exactly what the extractor saw, per batch: rows are appended
 * only after extract() resolves (and the run is still live). A rejection,
 * abort, deactivation or crash leaves the batch uncovered, so it is
 * redelivered later with the SAME batchId (batchTag over the member
 * fingerprints) — at-least-once; plugins make writes idempotent by batchId.
 * Batches of one record kind run one at a time, process-wide (the plugin's
 * write is inside extract — the audit-lock analog).
 */

import { batchRuns, batchTag, coverageOf, rawCoverageSlots } from "../core/coverage.ts";
import type { ChatStore } from "../core/ports.ts";
import { claimExtraction, extractionRunSignal, finishExtractionRun, releaseExtraction, setExtractionPhase } from "../agent/subagents/extraction.ts";
import type { ChatRecordTarget } from "./record-kinds.ts";

type PluginTarget = Extract<ChatRecordTarget, { status: "plugin" }>;

export type RecordExtractionOutcome =
	| { status: "done"; batches: number }
	| { status: "busy" | "below-threshold" | "nothing" | "missing" }
	| { status: "failed" | "aborted"; batches: number; error: unknown };

interface RecordLocks { __lhRecordExtractionLocks?: Map<string, Promise<void>> }
/** Process-wide FIFO per record kind (globalThis: one truth across Next
 *  route module instances — the extraction-registry idiom). */
async function withRecordLock<T>(recordKindId: string, signal: AbortSignal, critical: () => Promise<T>): Promise<T> {
	const g = globalThis as typeof globalThis & RecordLocks;
	const locks = (g.__lhRecordExtractionLocks ??= new Map());
	const prev = locks.get(recordKindId) ?? Promise.resolve();
	let release!: () => void;
	const mine = new Promise<void>((resolve) => (release = resolve));
	const tail = prev.then(() => mine);
	locks.set(recordKindId, tail);
	try {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(signal.reason ?? Object.assign(new Error("extraction aborted while waiting"), { name: "AbortError" }));
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			void prev.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
		});
		signal.throwIfAborted();
		return await critical();
	} finally {
		release();
		if (locks.get(recordKindId) === tail) locks.delete(recordKindId);
	}
}

/**
 * Run one chat's uncovered raw transcript through a plugin record.
 * mode "trigger": only once uncovered tokens reach the record's chunk budget
 * (the post-turn trigger); "manual": everything uncovered (Extract button).
 */
export async function runRecordExtraction(
	deps: { chatStore: ChatStore; now?: () => Date },
	chatId: string,
	target: PluginTarget,
	mode: "trigger" | "manual",
): Promise<RecordExtractionOutcome> {
	if (!claimExtraction(chatId)) return { status: "busy" };
	const jobKeys: string[] = [];
	let completed = 0;
	try {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return { status: "missing" };
		const coverage = coverageOf(record.messages, target.coverage.read(), chatId, rawCoverageSlots);
		if (coverage.uncovered.length === 0) return { status: "nothing" };
		if (mode === "trigger" && coverage.uncoveredTokens < target.chunkTokens) return { status: "below-threshold" };
		const runs = batchRuns(coverage.slots, coverage.uncovered, target.chunkTokens);
		runs.forEach((_, i) => {
			const jobKey = runs.length > 1 ? `${chatId}#${i + 1}` : chatId;
			jobKeys.push(jobKey);
			setExtractionPhase(jobKey, "queued", "chat", undefined, runs.length > 1 ? { i: i + 1, n: runs.length } : undefined);
		});
		for (let i = 0; i < runs.length; i++) {
			const batch = runs[i]!, jobKey = jobKeys[i]!;
			const signal = AbortSignal.any([extractionRunSignal(jobKey) ?? new AbortController().signal, target.signal]);
			try {
				setExtractionPhase(jobKey, "waiting", "chat");
				await withRecordLock(target.recordKindId, signal, async () => {
					target.requireActive();
					setExtractionPhase(jobKey, "extracting", "chat");
					await target.definition.extract(Object.freeze({
						recordKindId: target.recordKindId,
						chatId,
						sessionKindId: target.sessionKindId,
						batchId: batchTag(batch),
						messages: Object.freeze(batch.map((slot) => slot.message)),
						signal,
					}));
					// Coverage is written only for a live, unaborted success —
					// a deactivation or cancellation during extract leaves the
					// batch uncovered for redelivery.
					signal.throwIfAborted();
					target.requireActive();
					if (!deps.chatStore.getChat(chatId)) throw new Error("The session was deleted during extraction");
					const foldedAt = (deps.now?.() ?? new Date()).toISOString();
					for (const slot of batch) target.coverage.append({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt });
				});
				completed++;
			} catch (error) {
				const aborted = signal.aborted;
				if (!aborted) console.error(`[chat ${chatId}] record extraction (${target.recordKindId}) failed:`, error);
				return { status: aborted ? "aborted" : "failed", batches: completed, error };
			} finally {
				finishExtractionRun(jobKey);
			}
		}
		return { status: "done", batches: completed };
	} finally {
		for (const jobKey of jobKeys) if (extractionRunSignal(jobKey)) finishExtractionRun(jobKey);
		releaseExtraction(chatId);
	}
}

/** The post-turn trigger for a plugin record (fire-and-forget; skipped under
 *  NODE_ENV=test like the graph trigger — tests drive runRecordExtraction). */
export function triggerRecordExtraction(deps: { chatStore: ChatStore }, chatId: string, target: PluginTarget): void {
	if (process.env.NODE_ENV === "test") return;
	void runRecordExtraction(deps, chatId, target, "trigger").catch((err) => {
		console.error(`[chat ${chatId}] record extraction trigger failed:`, err);
	});
}
