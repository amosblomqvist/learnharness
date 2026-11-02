/**
 * "Your files" (mobile Phase 4, owner: managed in Settings → Phone data).
 * Files the learner adds live in the phone's virtual home folder — the
 * folder the agent's learner-file tools (read / ls / find / grep, the pdf
 * job) already search on desktop — so those tools work on them unchanged.
 * They persist to IndexedDB like everything else (./persist.ts).
 */
import fs from "./shims/fs.ts";
import { list, stat } from "./shims/vfs.ts";
import { BROWSER_HOME } from "./shims/process.ts";

export const FILES_DIR = BROWSER_HOME;

export type AddedFile = { name: string; size: number; addedAt: number };

export function listAddedFiles(): AddedFile[] {
	try {
		return list(FILES_DIR)
			.filter((e) => !e.isDirectory)
			.map((e) => {
				const s = stat(`${FILES_DIR}/${e.name}`);
				return { name: e.name, size: s.size, addedAt: s.mtimeMs };
			});
	} catch {
		return [];
	}
}

/** A name that is safe as a single path segment and not taken yet
 *  ("notes.md" → "notes (2).md"). */
export function freeName(wanted: string, taken: ReadonlySet<string>): string {
	const clean = wanted.replace(/[/\\\0]/g, "_").replace(/^\.+/, "").trim() || "file";
	if (!taken.has(clean)) return clean;
	const dot = clean.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
	for (let n = 2; ; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Store one file; returns the name it was saved under. */
export function addFile(name: string, bytes: Uint8Array): string {
	fs.mkdirSync(FILES_DIR, { recursive: true });
	const saved = freeName(name, new Set(listAddedFiles().map((f) => f.name)));
	fs.writeFileSync(`${FILES_DIR}/${saved}`, bytes);
	return saved;
}

export function removeAddedFile(name: string): void {
	fs.unlinkSync(`${FILES_DIR}/${name}`);
}
