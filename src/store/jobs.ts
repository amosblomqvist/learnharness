/**
 * JobStore — the fs JSON adapter: one file per background sub-agent job in
 * data/jobs/ (contracts.ts "THE ASYNC PROTOCOL"). Keyed by toolCallId for
 * dedup: the chat-handler spawn hook never creates two jobs for the same
 * tool part. Implements core/ports.ts JobStore. Idioms: sync fs, id-guarded
 * filenames, JSON with tab indentation. Writes are small and rare (activity
 * line updates); read-modify-write sections contain no awaits. Plugin-linked
 * jobs require atomic replacement before linkage is acknowledged. Native jobs
 * retain the Windows held-file compatibility fallback (owner integration q22).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { JobStore } from "../core/ports.ts";
import type { CreateJobInit, JobPatch } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** Background jobs (data/jobs). Not in config.ts PATHS (orchestrator-owned). */
const JOBS_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "jobs");

function jobFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
	return path.join(/* turbopackIgnore: true */ JOBS_DIR, `${id}.json`);
}

/** Use the shared retry/cleanup law, but never truncate a plugin-linked job.
 * Metadata also makes a builtin job strict: accepted plugin linkage must stay
 * readable even when its worker is native. A malformed/missing plugin identity
 * cannot grant plugin-kind jobs permission to fall back in place. */
interface CachedJob {
	mtimeMs: number;
	size: number;
	record: JobRecord;
}

const jobCache = new Map<string, CachedJob>();

function cloneJob(record: JobRecord): JobRecord {
	return { ...record };
}

function writeJob(record: JobRecord): void {
	const file = jobFile(record.id);
	const strict = record.kind === "plugin" || record.plugin !== undefined;
	writeFileAtomicSync(file, JSON.stringify(record, null, "\t"), {
		allowInPlaceFallback: !strict,
		...(strict ? { mode: 0o600 } : {}),
	});
	jobCache.delete(file);
	if (strict && process.platform !== "win32") {
		const directory = fs.openSync(JOBS_DIR, "r");
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
	}
}

/** Writes announce on the events channel AFTER the write lands (the
 *  notify-after-write law, beginTurn precedent) — jobs-changed is what
 *  retires the view's interval poll (push S4, 2026-10-02): dispatch cards,
 *  progress lines, settles, and aborts all surface as one fetch. */
function createJob(init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		...(init.input !== undefined ? { input: init.input } : {}),
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
		...(init.plugin ? { plugin: init.plugin } : {}),
	};
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	writeJob(record);
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function readJobCached(id: string): JobRecord | null {
	let file: string;
	try {
		file = jobFile(id);
	} catch {
		return null;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(/* turbopackIgnore: true */ file);
	} catch {
		jobCache.delete(file);
		return null;
	}
	const cached = jobCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.record;
	}
	try {
		const record = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as JobRecord;
		jobCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record });
		return record;
	} catch {
		jobCache.delete(file);
		return null;
	}
}

function getJob(id: string): JobRecord | null {
	const record = readJobCached(id);
	return record ? cloneJob(record) : null;
}

/** Merge a partial patch into the record (identity fields are immutable).
 *  An explicit patch.updatedAt is honored (tests pin deterministic order);
 *  otherwise the merge bumps it to now. */
function updateJob(id: string, patch: JobPatch): JobRecord | null {
	const record = getJob(id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	writeJob(next);
	// EVERY write, not just status flips: progress-line updates must reach
	// the dispatch cards (the view debounces the fetch bursts). A missing id
	// wrote nothing and stays silent.
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

/** All jobs for a chat, newest activity first. */
function listJobs(chatId: string): JobRecord[] {
	try {
		fs.mkdirSync(JOBS_DIR, { recursive: true });
		const entries = fs.readdirSync(/* turbopackIgnore: true */ JOBS_DIR).filter((f) => f.endsWith(".json"));
		const seen = new Set<string>();
		const matches: JobRecord[] = [];
		for (const f of entries) {
			const id = f.slice(0, -5);
			let file: string;
			try {
				file = jobFile(id);
			} catch {
				continue;
			}
			seen.add(file);
			const record = readJobCached(id);
			if (record && record.chatId === chatId) matches.push(cloneJob(record));
		}
		for (const key of jobCache.keys()) {
			if (!seen.has(key)) jobCache.delete(key);
		}
		return matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
function findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null {
	return listJobs(chatId).find((j) => j.toolCallId === toolCallId) ?? null;
}

/** Delete every job record file for a chat (session-deletion wave 6) —
 *  running or finished, they are the chat's records and die with it.
 *  Returns how many files were removed. The deletion route refuses while
 *  jobs are still running, so every record here is terminal. */
function deleteJobsForChat(chatId: string): number {
	let removed = 0;
	for (const job of listJobs(chatId)) {
		try {
			const file = jobFile(job.id);
			fs.unlinkSync(file);
			jobCache.delete(file);
			removeLeftoverTemps(file);
			removed++;
		} catch {
			/* already gone — the count is best-effort truth */
		}
	}
	// Only when something actually died — a zero-file delete wrote nothing
	// (the endTurn present-entry law).
	if (removed > 0) emit("jobs-changed", { chatId });
	return removed;
}

export const jobStore: JobStore = {
	createJob,
	getJob,
	updateJob,
	listJobs,
	findJobByToolCallId,
	deleteJobsForChat,
};
