/**
 * THE NO-DRIFT PIN (provider-keys interlude, 2026-09-19): core/auth-keys.ts
 * AUTH_PROVIDER_KEYS claims to be exactly pi-ai's provider→env-var table
 * (minus the owner-spec exclusions). This test re-derives the TRUTH from
 * pi-ai itself and asserts exact equality — so a pi-ai upgrade that adds,
 * renames, or re-labels a provider key FAILS the gate loudly instead of
 * the table drifting silently from what pi actually reads.
 *
 * Derivation (same mechanism that generated the table): pi-ai's exports
 * map doesn't expose env-api-keys.js as a subpath, so this test
 * deep-imports it by RELATIVE path — tests may; runtime code never does.
 * findEnvKeys with a Proxy env that resolves every var name truthy returns
 * ALL the env vars a provider reads as API keys.
 *
 * Owner-spec exclusions (asserted ABSENT): github-copilot (OAuth),
 * amazon-bedrock (AWS creds), google-vertex (ADC), azure
 * (needs base URL), the cloudflare account-scoped pair; anthropic keeps
 * ANTHROPIC_API_KEY only (AUTH_TOKEN/OAUTH_TOKEN stay env-only).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH_PROVIDER_KEYS, isProviderEnvVar } from "../src/core/auth-keys.ts";
import { builtinProviders } from "../node_modules/@earendil-works/pi-ai/dist/providers/all.js";
import { findEnvKeys } from "../node_modules/@earendil-works/pi-ai/dist/env-api-keys.js";

/** pi-ai reads anthropic via AUTH_TOKEN/OAUTH_TOKEN alternates too — those
 *  stay env-only by owner spec; asserted absent below. */
const ANTHROPIC_ALTERNATES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"];

const EXCLUDED_PROVIDERS = new Set([
	"github-copilot",
	"amazon-bedrock",
	"google-vertex",
	"azure",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
]);

/** A proxy env where EVERY var name resolves truthy — findEnvKeys then
 *  returns every env var the provider reads as an API-key source. */
const truthyEnv = new Proxy({} as Record<string, string>, {
	get: (_t, key) => (typeof key === "string" ? "x" : undefined),
	has: () => true,
});

/** The truth, derived from pi-ai at test time. */
function deriveProviders() {
	const rows: Array<{ id: string; envVar: string; label: string }> = [];
	for (const p of builtinProviders()) {
		const keys = findEnvKeys(p.id, truthyEnv);
		if (!keys || EXCLUDED_PROVIDERS.has(p.id)) continue;
		const first = keys[0];
		if (!first) continue; // unreachable with the truthy proxy — satisfies the checker
		const envVar = p.id === "anthropic" ? "ANTHROPIC_API_KEY" : first;
		rows.push({ id: p.id, envVar, label: p.name });
	}
	rows.sort((a, b) => a.id.localeCompare(b.id));
	return rows;
}

describe("AUTH_PROVIDER_KEYS — the no-drift pin against pi-ai", () => {
	it("is EXACTLY pi-ai's plain-key provider table (id, envVar, label), exclusions applied", () => {
		const truth = deriveProviders();
		const mine = [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
		assert.deepEqual(
			mine.map((p) => [p.id, p.envVar, p.label]),
			truth.map((p) => [p.id, p.envVar, p.label]),
			"pi-ai's provider env-key table changed — regenerate AUTH_PROVIDER_KEYS (src/core/auth-keys.ts) from the derivation in this test",
		);
	});

	it("the owner-spec exclusions are absent", () => {
		const ids = new Set(AUTH_PROVIDER_KEYS.map((p) => p.id));
		for (const excluded of EXCLUDED_PROVIDERS) assert.ok(!ids.has(excluded), `${excluded} must not be listed`);
		for (const p of AUTH_PROVIDER_KEYS) {
			assert.ok(!ANTHROPIC_ALTERNATES.includes(p.envVar), `${p.envVar} must not appear`);
		}
	});

	it("openrouter IS in the table (it graduated from the curated catalog)", () => {
		const row = AUTH_PROVIDER_KEYS.find((p) => p.id === "openrouter");
		assert.ok(row);
		assert.equal(row.envVar, "OPENROUTER_API_KEY");
	});

	it("isProviderEnvVar: exactly the table's distinct env vars", () => {
		for (const p of AUTH_PROVIDER_KEYS) assert.ok(isProviderEnvVar(p.envVar), `${p.envVar} is a provider var`);
		assert.ok(!isProviderEnvVar("OPENROUTER_API_KEYS"), "typo'd name is not one");
		assert.ok(!isProviderEnvVar("DEEPGRAM_API_KEY"), "curated ≠ provider — separate surfaces");
	});
});
