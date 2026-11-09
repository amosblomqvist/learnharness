/**
 * The session-references PUT body parser + admission (issue #63) — the
 * settings-body.ts house pattern: one seam per mutation surface, parsed or
 * rejected with the route's 400 text, replace-whole semantics (the panel
 * sends the complete desired list; no merges, so a stale client can never
 * resurrect a removed reference).
 *
 * Admission is the existing source-access law, not a new policy: file
 * values go through resolveSourcePath (sensitive-path/policy denials — the
 * pdf dispatch tool's precedent: "admission uses the current boundary; the
 * reader checks again per read") and must exist when added, so a typo
 * grounds nothing silently. URL values follow web.ts's rule (http/https
 * only). The agent-side read still re-checks everything per call — this is
 * add-time UX, not a security boundary.
 */

import * as fs from "node:fs";
import type { SessionReference } from "../core/contracts.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";

/** Parsed-or-rejected — the SettingsBodyResult shape. */
export type ReferencesBodyResult =
	| { ok: true; references: SessionReference[] }
	| { ok: false; error: string };

/** Shelf size cap: grounding hints, not a corpus (notes import is the
 *  bulk path). Reversible: raise without a migration. */
export const MAX_SESSION_REFERENCES = 20;
const MAX_VALUE_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;

export function parseReferencesBody(body: unknown): ReferencesBodyResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = (body as { references?: unknown }).references;
	if (!Array.isArray(raw)) {
		return { ok: false, error: "references must be an array" };
	}
	if (raw.length > MAX_SESSION_REFERENCES) {
		return { ok: false, error: `a session can hold at most ${MAX_SESSION_REFERENCES} references` };
	}
	const references: SessionReference[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return { ok: false, error: "each reference must be an object" };
		}
		const { id, kind, value, name, addedAt } = entry as Record<string, unknown>;
		if (typeof id !== "string" || id.length === 0 || id.length > 128) {
			return { ok: false, error: "reference id must be a non-empty string" };
		}
		if (kind !== "file" && kind !== "url") {
			return { ok: false, error: 'reference kind must be "file" or "url"' };
		}
		if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_VALUE_LENGTH) {
			return { ok: false, error: "reference value must be a non-empty string" };
		}
		if (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME_LENGTH)) {
			return { ok: false, error: "reference name must be a string" };
		}
		if (typeof addedAt !== "string" || Number.isNaN(Date.parse(addedAt))) {
			return { ok: false, error: "reference addedAt must be an ISO date string" };
		}
		const trimmed = value.trim();
		if (seen.has(`${kind}:${trimmed}`)) {
			return { ok: false, error: "duplicate reference" };
		}
		seen.add(`${kind}:${trimmed}`);
		if (kind === "url") {
			try {
				const parsed = new URL(trimmed);
				// web.ts's rule exactly (the WHATWG protocol carries a colon).
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					throw new Error("protocol");
				}
			} catch {
				return { ok: false, error: `reference URL must be an http(s) URL: ${trimmed.slice(0, 100)}` };
			}
		} else {
			// File admission: the read tool's resolver (protected locations,
			// optional folder boundary) + existence at add time. Throws on
			// denial — surfaced as the 400 text verbatim (it is already the
			// user-facing wording the tools use).
			try {
				resolveSourcePath(trimmed);
				fs.statSync(resolveSourcePath(trimmed));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { ok: false, error: `reference file cannot be used: ${message}` };
			}
		}
		references.push({ id, kind, value: trimmed, ...(name !== undefined ? { name } : {}), addedAt });
	}
	return { ok: true, references };
}
