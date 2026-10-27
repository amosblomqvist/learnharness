/**
 * The Omarchy theme file (2026-10-26) — the response and the live-retint
 * watch live in the server seam (system-theme.ts); the route stays thin.
 */
import { systemThemeResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
	return systemThemeResponse();
}
