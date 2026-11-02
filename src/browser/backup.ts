/**
 * Phone backup / restore (mobile Phase 1). A backup is a zip of the data
 * folder in the DESKTOP layout — `data/chats/*.json`, `data/graph/*.jsonl`,
 * `data/settings.json`, … — so the same zip moves sessions between the
 * desktop app's data folder and the phone in either direction.
 *
 * The files the learner added ("Your files", ./files.ts) ride along in a
 * sibling `files/` folder (owner decision). A restore replaces them only
 * when the zip carries a `files/` folder — a zipped desktop data folder
 * has none, and leaves the phone's added files alone.
 *
 * API keys are not data: on desktop they live beside the data folder
 * (userData/auth.json), so a backup never contains them and a restore
 * never touches the phone's keys. Restore REPLACES the phone's data
 * (owner decision): the caller saves a backup of the current data first.
 */

import fs from "./shims/fs.ts";
import { allFiles } from "./shims/vfs.ts";
import { BROWSER_DATA_DIR } from "./shims/process.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";
import { FILES_DIR, listAddedFiles } from "./files.ts";

const KEYS_FILE = `${BROWSER_DATA_DIR}/auth.json`;
/** Entries a desktop data folder may hold at its top level. */
const MARKERS = ["chats/", "graph/", "jobs/", "practice/", "prompts/", "settings.json"];
const TEXT = /\.(json|jsonl|md|txt|csv|svg|html)$/i;

/** Where to find the desktop data folder, for the restore instructions. */
export const DESKTOP_DATA_FOLDER = {
	mac: "~/Library/Application Support/LearnHarness/data",
	windows: "%APPDATA%\\LearnHarness\\data",
	linux: "~/.config/LearnHarness/data",
};

function dataFiles(): string[] {
	const prefix = `${BROWSER_DATA_DIR}/`;
	return allFiles().filter((p) => p.startsWith(prefix) && p !== KEYS_FILE);
}

/** Every phone data file (keys excluded) under `data/`, and the added
 *  files under `files/`. */
export async function exportBackup(): Promise<{ blob: Blob; files: number }> {
	const entries: ZipEntry[] = dataFiles().map((p) => {
		const content = fs.readFileSync(p) as Uint8Array;
		return { path: `data/${p.slice(BROWSER_DATA_DIR.length + 1)}`, data: new Uint8Array(content) };
	});
	for (const f of listAddedFiles()) {
		entries.push({ path: `files/${f.name}`, data: new Uint8Array(fs.readFileSync(`${FILES_DIR}/${f.name}`) as Uint8Array) });
	}
	return { blob: await writeZip(entries), files: entries.length };
}

export function backupFileName(now = new Date()): string {
	const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
	return `learnharness-backup-${stamp}.zip`;
}

export type RestorePlan = {
	files: { rel: string; data: Uint8Array }[];
	sessions: number;
	/** The zip's `files/` folder (added files), or null when it has none. */
	added: { name: string; data: Uint8Array }[] | null;
};

/** Find the data folder inside a zip (it may be zipped as `data/`, as its
 *  contents, or nested deeper) and list the files to restore. Throws a
 *  readable error when the zip holds no LearnHarness data. */
export async function planRestore(zip: Uint8Array): Promise<RestorePlan> {
	const entries = (await readZip(zip)).filter(
		(e) => !e.path.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(e.path) && !/(^|\/)Thumbs\.db$/i.test(e.path),
	);
	const prefixes = new Map<string, number>();
	for (const e of entries) {
		for (const m of MARKERS) {
			let at: number;
			if (e.path.startsWith(m)) at = 0;
			else {
				const i = e.path.indexOf(`/${m}`);
				if (i === -1) continue;
				at = i + 1;
			}
			const prefix = e.path.slice(0, at);
			prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
			break;
		}
	}
	const best = [...prefixes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
	if (!best) {
		throw new Error("This zip doesn’t contain LearnHarness data (no chats/, graph/ or settings.json found). Zip the desktop app’s data folder.");
	}
	const prefix = best[0];
	// Added files sit beside the data folder: <parent of prefix>files/<name>
	// (never part of the data, even when the data was zipped at the root).
	const parent = prefix.replace(/[^/]+\/$/, "");
	const filesPrefix = `${parent}files/`;
	const files = entries
		.filter((e) => e.path.startsWith(prefix) && !e.path.startsWith(filesPrefix))
		.map((e) => ({ rel: e.path.slice(prefix.length), data: e.data }))
		.filter((f) => f.rel && f.rel !== "auth.json" && !f.rel.split("/").includes(".."));
	const sessions = files.filter((f) => /^chats\/[^/]+\.json$/.test(f.rel)).length;
	const added = entries
		.filter((e) => e.path.startsWith(filesPrefix))
		.map((e) => ({ name: e.path.slice(filesPrefix.length), data: e.data }))
		.filter((f) => f.name && !f.name.includes("/"));
	return { files, sessions, added: added.length > 0 ? added : null };
}

/** Replace every phone data file (keys kept) with the plan's files. */
export function applyRestore(plan: RestorePlan): void {
	if (plan.added) {
		for (const f of listAddedFiles()) fs.unlinkSync(`${FILES_DIR}/${f.name}`);
		fs.mkdirSync(FILES_DIR, { recursive: true });
		for (const f of plan.added) fs.writeFileSync(`${FILES_DIR}/${f.name}`, f.data);
	}
	for (const p of dataFiles()) fs.unlinkSync(p);
	const decoder = new TextDecoder();
	for (const f of plan.files) {
		const target = `${BROWSER_DATA_DIR}/${f.rel}`;
		fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
		fs.writeFileSync(target, TEXT.test(f.rel) ? decoder.decode(f.data) : f.data);
	}
}
