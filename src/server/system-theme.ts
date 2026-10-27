/**
 * THE OMARCHY THEME SEAM (2026-10-26): GET /api/theme/omarchy returns the
 * desktop palette Omarchy's theme-set hook wrote to SYSTEM_THEME_FILE, and
 * a directory watch emits "theme-changed" whenever that file is replaced —
 * open windows refetch and retint without a reload (the T3 Code behavior).
 *
 * The hook only follows an install that already exists (it never creates
 * LearnHarness's config dir), so on Linux the server creates the themes
 * directory itself: running LearnHarness once is what opts a machine in.
 * Other platforms have no Omarchy — nothing is created there.
 *
 * The watch is on the DIRECTORY, not the file: the hook writes atomically
 * (temp file + rename), which replaces the inode a file watch would hold.
 */
import fs from "node:fs";
import path from "node:path";
import { SYSTEM_THEME_FILE } from "../../config.ts";
import { emit } from "../core/events.ts";
import { sanitizeSystemTheme, type SystemTheme } from "../core/system-theme.ts";

/** The current theme, or null (no file, unreadable, or incomplete). */
export function readSystemTheme(file: string = SYSTEM_THEME_FILE): SystemTheme | null {
	try {
		// turbopackIgnore: the file lives in the user's config dir, not the build.
		return sanitizeSystemTheme(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf-8")));
	} catch {
		return null;
	}
}

interface LhThemeWatchGlobal {
	/** The watched file — one watch per process (globalThis: Next dev gives
	 *  each route its own module instance, see core/events.ts). */
	__lhThemeWatch?: string;
}

/** Start the directory watch once per process. Returns false when it could
 *  not start (no directory on a non-Linux machine, or fs.watch refused) —
 *  the theme still reads on every request, only the live retint is lost. */
export function watchSystemTheme(file: string = SYSTEM_THEME_FILE): boolean {
	const g = globalThis as typeof globalThis & LhThemeWatchGlobal;
	if (g.__lhThemeWatch === file) return true;
	const dir = path.dirname(file);
	const name = path.basename(file);
	try {
		// turbopackIgnore: runtime config dir, not a build input.
		if (process.platform === "linux") fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
		let pending: ReturnType<typeof setTimeout> | undefined;
		const watcher = fs.watch(/*turbopackIgnore: true*/ dir, (_event, changed) => {
			if (changed !== null && changed !== name) return;
			// One rename fires several events; coalesce them into one retint.
			clearTimeout(pending);
			pending = setTimeout(() => emit("theme-changed", {}), 100);
		});
		watcher.on("error", () => {
			watcher.close();
			if (g.__lhThemeWatch === file) delete g.__lhThemeWatch;
		});
		watcher.unref();
		g.__lhThemeWatch = file;
		return true;
	} catch {
		return false;
	}
}

/** GET /api/theme/omarchy → { theme: SystemTheme | null }. */
export function systemThemeResponse(): Response {
	watchSystemTheme();
	return Response.json({ theme: readSystemTheme() }, { headers: { "Cache-Control": "no-store" } });
}
