/**
 * GET /api/keys — the auth page's key list (auth-keys wave, 2026-09-19;
 * providers added by the provider-keys interlude same wave).
 *
 * Every curated key (present or not) plus unknown file vars surfaced as
 * generic rows — ABSENT provider keys deliberately do NOT spam status
 * rows; the provider dropdown is the discovery surface. `providers`
 * carries it: {id, envVar, label} for every pi-ai plain-key provider,
 * derived from pi-ai's own provider→env-var table (no-drift pin in
 * tests/auth-provider-keys.test.ts) — the settings UI reads it optionally
 * with a graceful fallback.
 *
 * Masked only — last 4 + length for ordinary keys; custom keys are fully
 * redacted at every length (no credential suffix). PLAINTEXT NEVER LEAVES THE STORE THROUGH
 * THIS API (owner decision). `source` tells the page whether the live
 * value comes from the environment (dev .env.local / launch env) or the
 * file, and `shadowedByEnv` explains why a saved key is not the live one
 * (env always wins).
 */
import { keyStatuses, providerKeyList } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ keys: keyStatuses(), providers: providerKeyList() });
}
