/**
 * Server-side persistence for the graph render settings (the settings-panel
 * controls): data/render-settings.json — read-modify-write, NOT a ledger.
 *
 * The shape, defaults, and sanitizer live in src/core/render-settings.ts
 * (pure, shared with the client); this module only moves bytes. Whatever
 * comes off disk is sanitized by the caller on load — and we sanitize on
 * write too, so the file can never hold an out-of-range value that would
 * silently shift a slider.
 */

import fs from "node:fs";
import path from "node:path";
import { RENDER_SETTINGS_FILE } from "../../config.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** The persisted settings, or null when no file exists yet (first boot).
 *  Any other read error throws: null would let the next save overwrite
 *  settings that are still on disk. */
export function readRenderSettings(): GraphRenderSettings | null {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(RENDER_SETTINGS_FILE, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // never booted → caller uses defaults
		throw error;
	}
	try {
		return sanitizeRenderSettings(JSON.parse(raw));
	} catch {
		return null; // corrupt → defaults, never crash the view
	}
}

/** Persist settings (sanitized). Returns what was written. */
export function writeRenderSettings(raw: unknown): GraphRenderSettings {
	const settings = sanitizeRenderSettings(raw);
	fs.mkdirSync(path.dirname(RENDER_SETTINGS_FILE), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	writeFileAtomicSync(RENDER_SETTINGS_FILE, JSON.stringify(settings, null, "\t"), { allowInPlaceFallback: true });
	return settings;
}

export { DEFAULT_RENDER_SETTINGS };
