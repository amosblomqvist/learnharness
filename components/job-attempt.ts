import type { JobRecord } from "@/src/core";

/** Activity updates on an older attempt must not hide its retry. */
export function latestJobAttempt(jobs: readonly JobRecord[], toolCallId: string): JobRecord | null {
	const matches = jobs.filter((job) => job.toolCallId === toolCallId);
	const superseded = new Set(matches.map((job) => job.retryOf).filter(Boolean));
	return matches.filter((job) => !superseded.has(job.id))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
