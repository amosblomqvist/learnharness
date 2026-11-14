/** data/mistakes.json — the learner's mistakes (read-modify-write; every
 *  rule lives in core/mistakes.ts). Synchronous on purpose: one call is one
 *  atomic read-modify-write in a single-threaded process. */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { MistakeRecord } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function file(): string {
	return path.join(PATHS.data, "mistakes.json");
}

export function readMistakes(): MistakeRecord[] {
	try {
		const raw = JSON.parse(fs.readFileSync(file(), "utf-8")) as { mistakes?: unknown };
		return Array.isArray(raw.mistakes)
			? (raw.mistakes as MistakeRecord[]).filter((r) => r && typeof r.id === "string" && typeof r.chatId === "string")
			: [];
	} catch {
		return []; // never written / corrupt → empty, never crash the tab
	}
}

function write(records: MistakeRecord[]): void {
	fs.mkdirSync(path.dirname(file()), { recursive: true });
	writeFileAtomicSync(file(), JSON.stringify({ version: 1, mistakes: records }, null, "\t"));
}

/** Transform the stored records and persist; announces the change. */
export function updateMistakes(transform: (records: MistakeRecord[]) => MistakeRecord[]): MistakeRecord[] {
	const next = transform(readMistakes());
	write(next);
	emit("mistakes-changed", {});
	return next;
}
