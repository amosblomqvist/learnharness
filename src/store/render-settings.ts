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
import { renderSettingsFile } from "../../config.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

/** The persisted settings, or null when no file exists yet (first boot). */
export function readRenderSettings(): GraphRenderSettings | null {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(renderSettingsFile(), "utf-8");
	} catch {
		return null; // never booted / unreadable → caller uses defaults
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
	fs.mkdirSync(path.dirname(renderSettingsFile()), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	fs.writeFileSync(renderSettingsFile(), JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

export { DEFAULT_RENDER_SETTINGS };
