/**
 * Writes the folder-level data format stamp (core/data-format.ts). Called
 * once at server startup, after the beforeLoad hooks. Never downgrades: a
 * stamp with any newer value is left untouched (a newer build wrote the
 * folder; the per-file guards refuse what this build cannot read).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { CURRENT_DATA_FORMATS, DATA_FORMAT_KEYS, newerDataFormats, parseDataFormats } from "../core/data-format.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const DATA_FORMAT_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "data-format.json");

export type DataFormatStampResult = "written" | "current" | "newer";

export function stampDataFormat(file: string = DATA_FORMAT_FILE): DataFormatStampResult {
	let existing: unknown = null;
	try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) {
		// Missing is the ordinary first run. An unreadable stamp is replaced.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[data-format] replacing unreadable ${file}:`, error);
	}
	const stamp = parseDataFormats(existing);
	const newer = newerDataFormats(stamp);
	if (newer.length) {
		console.warn(`[data-format] ${file} was written by a newer LearnHarness (${newer.map((k) => `${k} ${stamp[k]} > ${CURRENT_DATA_FORMATS[k]}`).join(", ")}); leaving it unchanged`);
		return "newer";
	}
	if (DATA_FORMAT_KEYS.every((key) => stamp[key] === CURRENT_DATA_FORMATS[key])) return "current";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify({ ...CURRENT_DATA_FORMATS }, null, "\t")}\n`, { allowInPlaceFallback: true });
	return "written";
}
