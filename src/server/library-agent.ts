/**
 * THE COURSE LIBRARY ↔ AGENT SEAM (course library wave, 2026-10-29):
 * builds the agent layer's LibraryReadable views from the store (the agent
 * never imports the store), scopes them to a chat's attachments, renders
 * the per-turn COURSE MATERIALS manifest, and runs the summary service —
 * a summary per file, written on first attach by the pdf-reader's model
 * slot, cached by content hash, and awaited before the next turn.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { stores } from "./stores.ts";
import { emit } from "../core/events.ts";
import type { CallUsage, LibraryItem } from "../core/contracts.ts";
import { effectiveTag, LIBRARY_TAG_LABELS, libraryPath, resolveAttachmentFiles } from "../core/contracts.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { unitLabel, type LibraryReadable } from "../agent/library/readable.ts";
import { runLibraryReader } from "../agent/subagents/library-reader.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { providerKeyPresent } from "./keys.ts";
import { processLibraryFile, readExtracted, summaryStatusOverride } from "./library.ts";

const library = () => stores.libraryStore;

// ─── Readables ────────────────────────────────────────────────────────────────

function toReadable(items: LibraryItem[], item: LibraryItem): LibraryReadable {
	const file = item.file!;
	const tag = effectiveTag(items, item.id);
	const summary = library().readSummary(item.id);
	return {
		id: item.id,
		name: item.name,
		path: libraryPath(items, item.id),
		...(tag ? { tag } : {}),
		format: file.format,
		status: file.status,
		...(file.via ? { via: file.via } : {}),
		...(file.pages !== undefined ? { pages: file.pages } : {}),
		...(file.error ? { error: file.error } : {}),
		mime: file.mime,
		originalPath: library().originalPath(item.id),
		...(file.via === "pdf" ? { pdfPath: library().originalPath(item.id) } : {}),
		...(file.via === "converted-pdf" ? { pdfPath: library().derivedPath(item.id, "converted.pdf") } : {}),
		...(file.via === "extracted" ? { extracted: () => readExtracted(item.id) } : {}),
		...(summary && summary.sha256 === file.sha256 ? { summary: summary.text } : {}),
	};
}

/** The chat's in-scope files as readables (fresh library view). */
export function chatLibraryReadables(chatId: string): LibraryReadable[] {
	const attachments = stores.chatStore.getChat(chatId)?.attachments ?? [];
	if (attachments.length === 0) return [];
	const items = library().listItems();
	return resolveAttachmentFiles(items, attachments).map((f) => toReadable(items, f));
}

/** One in-scope file, or null when it's gone or not attached (the
 *  library_brief job's scope check — attachments may change mid-job). */
export function chatLibraryReadable(chatId: string, fileId: string): LibraryReadable | null {
	return chatLibraryReadables(chatId).find((f) => f.id === fileId) ?? null;
}

// ─── The manifest ─────────────────────────────────────────────────────────────

/** The per-turn COURSE MATERIALS block appended to the agent's system
 *  prompt — undefined when nothing is attached (no block, no tokens). */
export function materialsManifest(chatId: string): string | undefined {
	const files = chatLibraryReadables(chatId);
	if (files.length === 0) return undefined;
	const lines = files.map((f) => {
		const label = unitLabel(f);
		const size = label === "image" ? "image" : `${f.pages ?? "?"} ${label}${f.pages === 1 ? "" : "s"}`;
		const head = `- [${f.tag ? LIBRARY_TAG_LABELS[f.tag] : "Reference"}] ${f.path} (id ${f.id}; ${f.format.toUpperCase()}, ${size})`;
		const state =
			f.status === "processing" ? "  (still importing — not readable yet)"
			: f.status === "failed" ? `  (import failed: ${f.error ?? "unknown"} — unreadable)`
			: f.summary ? `  Summary: ${f.summary.replace(/\s*\n\s*/g, " ")}`
			: "  (no summary available — read it directly)";
		return `${head}\n${state}`;
	});
	return [
		"# COURSE MATERIALS (attached to this chat)",
		"The learner attached these files from their course library. Read them with library_read / library_search / library_view (or library_brief for a background digest); nothing outside this list is in scope.",
		"",
		...lines,
	].join("\n");
}

// ─── Summaries ────────────────────────────────────────────────────────────────

interface SummaryGlobal {
	__lhLibrarySummaries?: {
		/** In-flight summaries by file id. */
		pending: Map<string, Promise<void>>;
		/** Last failure by file id, keyed to the content hash it was for. */
		failed: Map<string, { sha256: string; error: string }>;
	};
}

/** globalThis-backed (the turn-liveness rationale: one registry across
 *  Next's per-route module instances). */
function registry() {
	const g = globalThis as typeof globalThis & SummaryGlobal;
	return (g.__lhLibrarySummaries ??= { pending: new Map(), failed: new Map() });
}

summaryStatusOverride.current = (fileId) => {
	const r = registry();
	if (r.pending.has(fileId)) return "pending";
	const item = library().getItem(fileId);
	const failure = r.failed.get(fileId);
	return failure && failure.sha256 === item?.file?.sha256 ? "failed" : undefined;
};

/** Test seam: replaces the summary writer (no model in tests). */
export const summaryWriterOverride: {
	current?: (file: LibraryReadable) => Promise<{ text: string; model: string; steps: CallUsage[] }>;
} = {};

function toCallUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}

async function writeSummary(file: LibraryReadable): Promise<{ text: string; model: string; steps: CallUsage[] }> {
	if (summaryWriterOverride.current) return summaryWriterOverride.current(file);
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	if (!spec) throw new Error("No model is set for document reading (Settings → Models)");
	if (!providerKeyPresent(spec.provider)) throw new Error(`No API key for ${spec.provider} (document reading model)`);
	const engine = piEngineForSpec(spec);
	const steps: CallUsage[] = [];
	const result = await withBgLlmSlot(undefined, () =>
		runLibraryReader(file, "summary", "", { engine, onUsage: (u) => steps.push(toCallUsage(u)) }),
	);
	if (result.failed) throw new Error(result.text.replace(/^Reading failed:\s*/i, ""));
	return { text: result.text, model: `${engine.model.provider}:${engine.model.id}`, steps };
}

/** Ensure one file has a summary for its current content; idempotent
 *  while in flight. Waits for import processing first. Never rejects. */
function ensureSummary(fileId: string): Promise<void> {
	const r = registry();
	const inFlight = r.pending.get(fileId);
	if (inFlight) return inFlight;
	const item = library().getItem(fileId);
	if (!item?.file) return Promise.resolve();
	if (library().readSummary(fileId)?.sha256 === item.file.sha256) return Promise.resolve();
	const run = (async () => {
		try {
			if (item.file!.status === "processing") await processLibraryFile(fileId);
			const items = library().listItems();
			const current = items.find((i) => i.id === fileId);
			if (!current?.file || current.file.status !== "ready") return; // failed import: nothing to summarize
			const sha256 = current.file.sha256;
			try {
				const written = await writeSummary(toReadable(items, current));
				if (!library().getItem(fileId)) return;
				library().writeSummary(fileId, { sha256, text: written.text, model: written.model, steps: written.steps, generatedAt: new Date().toISOString() });
				r.failed.delete(fileId);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				console.error(`[library ${fileId}] summary failed:`, error);
				r.failed.set(fileId, { sha256, error });
			}
		} finally {
			r.pending.delete(fileId);
			emit("library-changed", {});
		}
	})();
	r.pending.set(fileId, run);
	emit("library-changed", {});
	return run;
}

/** The files in a chat's scope that still owe a summary. A failure for
 *  the current content is not retried here (it would re-fail and stall
 *  every turn) — re-attaching retries it (requestAttachmentSummaries). */
function owedSummaries(chatId: string, retryFailed: boolean): string[] {
	const attachments = stores.chatStore.getChat(chatId)?.attachments ?? [];
	if (attachments.length === 0) return [];
	const r = registry();
	return resolveAttachmentFiles(library().listItems(), attachments)
		.filter((f) => f.file!.status !== "failed")
		.filter((f) => library().readSummary(f.id)?.sha256 !== f.file!.sha256)
		.filter((f) => retryFailed || r.failed.get(f.id)?.sha256 !== f.file!.sha256)
		.map((f) => f.id);
}

/** Start every owed summary for a chat (the attach route's kick). Retries
 *  earlier failures — attaching again is the learner's retry. */
export function requestAttachmentSummaries(chatId: string): void {
	const owed = owedSummaries(chatId, true);
	for (const id of owed) registry().failed.delete(id);
	if (owed.length > 0) void awaitAttachmentSummaries(chatId);
}

/** THE TURN WAIT (owner ruling 2026-10-29): resolve once every attached
 *  file has a summary (or a recorded failure). Announces running=true/
 *  false for the chat so its view shows progress. Never rejects. */
export async function awaitAttachmentSummaries(chatId: string): Promise<void> {
	const owed = owedSummaries(chatId, false);
	if (owed.length === 0) return;
	emit("library-summaries-changed", { chatId, running: true });
	try {
		await Promise.all(owed.map(ensureSummary));
	} finally {
		emit("library-summaries-changed", { chatId, running: false });
	}
}

/** Whether summaries for this chat are being written right now (the chat
 *  view's initial state; the event keeps it live). */
export function attachmentSummariesRunning(chatId: string): boolean {
	const attachments = stores.chatStore.getChat(chatId)?.attachments ?? [];
	if (attachments.length === 0) return false;
	const r = registry();
	return resolveAttachmentFiles(library().listItems(), attachments).some((f) => r.pending.has(f.id));
}
