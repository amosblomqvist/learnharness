/**
 * The auth/keys composition (auth-keys wave, 2026-09-19): the server-side
 * key manager behind GET/PUT/DELETE /api/keys.
 *
 * THE ENV SEAM (the architecture keystone): every consumer — models.ts's
 * openRouterApiKey(), the sub-agents, web.ts, the STT route — reads
 * process.env directly, and the agent layer may not import the store
 * layer. Instead of rewiring five consumers across lanes, the store
 * REFLECTS itself into the child's env: at boot (idempotent, anchored on
 * globalThis like the extraction registry) every file var UNSET in the
 * real env is fill-gapped into process.env, and each save/delete updates
 * file + env together. Keys therefore take effect immediately — no restart
 * — which is also why main.cjs's old spawn-time injection HAD to retire:
 * an env copy made at spawn would shadow every settings-page change until
 * restart (env wins over file).
 *
 * PRECEDENCE (owner decision): real environment variables (incl.
 * .env.local in dev) always win over the file. Boot-time real-env vars
 * are snapshotted once per process and never mutated; a PUT to one of
 * them persists to the file (for when the env goes away) and the status
 * honestly reports shadowedByEnv — the page explains why the saved key
 * is not the live one.
 *
 * Unknown vars in the file are preserved verbatim and surfaced as
 * generic status rows (no catalog form to edit through — only curated
 * keys have shapes and docs; core/auth-keys.ts).
 *
 * THE FRESH-USER SWITCH (owner, interlude 2026-09-22): LH_IGNORE_ENV_KEYS=1
 * makes every env key invisible APP-WIDE — the exact new-user simulation
 * (a fresh empty data dir + the switch = zero keys, zero federated
 * providers, setup stage 1). Under the switch real env vars are DELETED
 * from the process (not merely ignored by this seam): pi-ai resolves
 * provider keys from process.env NATIVELY at every request
 * (auth/context.js's defaultProviderAuthContext reads live env), so
 * deletion is the one mechanism that hides keys from every consumer —
 * model engines included. Only the file store (auth.json) counts; the
 * fill-gap still reflects file keys so a fresh user can add keys
 * mid-session and the engines see them with no restart. Unset switch =
 * today's behavior, byte-for-byte.
 */

import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	AUTH_PROVIDER_ENV_VARS,
	type AuthKeyInfo,
	type AuthKeyStatus,
	genericProviderKeyGuard,
	isKnownAuthKey,
	isProviderEnvVar,
	maskKey,
	validateKeyShape,
} from "../core/auth-keys.ts";
import { authStore } from "../store/auth.ts";
import { isSubscriptionProvider, subscriptionConnected } from "../agent/subscription-connections.ts";

// The once-per-process boot record — globalThis anchor (HMR re-imports the
// module; the snapshot must not re-run and misread fill-gapped vars as real
// env). Same pattern as globalThis.__lhExtractionRuns.
interface AuthBoot {
	/** Vars that were in the REAL env at first init — env precedence's
	 *  untouchable set. Fill-gapped vars are everything else we set. */
	realEnv: Set<string>;
	/** Vars WE put into process.env (the file's reflection) — deletable. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/** Is `id` a WRITABLE key name — curated catalog or model-provider env
 *  var (provider-keys interlude: PUT/DELETE accept both). */
export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

/** The settings page's provider dropdown: every pi-ai provider that takes
 *  a plain key ({id, envVar, label} — no-drift-pinned, see the table's doc
 *  in core/auth-keys.ts and tests/auth-provider-keys.test.ts). Sorted by
 *  id for a stable payload. */
export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

/** The fresh-user switch (owner, interlude 2026-09-22): env keys are
 *  invisible app-wide — deleted from the process at boot, file keys only.
 *  Read live per call (the launcher exports it before boot). */
export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/**
 * The boot fill-gap — idempotent. First call snapshots which managed names
 * are real env; later calls (HMR re-import, or after a hand-edit) only fill
 * vars still unset in the env, so a var deleted through the API never
 * resurrects (its file entry is gone too).
 */
export function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([
		...Object.keys(fileVars),
		...AUTH_KEYS.map((k) => k.id),
		// Provider env vars are managed names too (provider-keys interlude):
		// an env-exported OPENAI_API_KEY with a file copy gets honest shadow
		// semantics, exactly like the curated vars.
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
	]);
	if (envKeysIgnored()) {
		// THE FRESH-USER SWITCH: delete every managed env var (re-run on
		// every call — a reintroduced var never resurrects). realEnv stays
		// EMPTY (nothing counts as env); the fill-gap below then reflects
		// auth.json keys so engines still see mid-session additions.
		for (const name of managed) {
			delete process.env[name];
		}
	} else if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		// First init in this process: what's already in the env is REAL env.
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

/** Is this env-var name one the keys system manages (curated, provider,
 *  or held in the file)? */
function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

/**
 * The pure status projection — exported for tests. `env` is the live
 * process env view; `realEnv` the boot snapshot (env precedence).
 */
export function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
	/** The model-provider env vars (provider-keys interlude): PRESENT ones
	 *  join the status rows — absent ones never spam (the dropdown is the
	 *  discovery surface). Curated keys always get rows, present or not. */
	providerEnvVars: ReadonlySet<string> = new Set(),
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars)]);
	for (const envVar of providerEnvVars) {
		if (env[envVar] !== undefined || fileVars[envVar] !== undefined) ids.add(envVar);
	}
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		// Env wins: the live value is the env's when set (real or reflected —
		// post fill-gap the file's values LIVE in env, so realEnv is what
		// distinguishes a REAL env var from the store's own reflection).
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

/** The GET view: every curated key (present or not) + unknown file vars. */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

/** The live value for one var, env-first (the env-wins rule) — the canonical
 *  read for consumers that don't live behind the @/src/server barrel (the
 *  STT route was the one cold-boot hole: a first-ever request to it would
 *  otherwise read env before any fill-gap ran). */
export function keyValue(id: string): string | undefined {
	// The fresh-user switch: ONLY the file store counts (belt-and-
	// suspenders — the boot deletion already emptied the env; this guards
	// any env key reintroduced after boot).
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}

/** The key-presence truth for one model provider (provider-key interlude,
 * 2026-09-25): would this provider's key be present at request time?
 * Reads through keyValue — the SAME env-first lookup pi-ai performs
 * natively at every request — so an env-shadowed key counts as present
 * (gate by what would run). Providers absent from AUTH_PROVIDER_KEYS take
 * no key at all: nothing to gate, present by definition. */
export function providerKeyPresent(provider: string): boolean {
	if (isSubscriptionProvider(provider)) return subscriptionConnected(provider);
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}

/**
 * Save one key (PUT). Shape gate first (owner decision: bad pastes are
 * 400s, never stored), then the file write, then the env reflection. A
 * var that the REAL env owns is not reflected (env wins — the status row
 * reports shadowedByEnv so the page can explain it).
 */
export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = isProviderEnvVar(id) ? genericProviderKeyGuard(id, value) : validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	const trimmed = value.trim();
	authStore.setAuthVar(id, trimmed);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = trimmed;
		record.fillGap.add(id);
	}
	// validateKeyShape guarantees catalog membership, so the row exists.
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

/**
 * Remove one key (DELETE): gone from the file always; gone from the env
 * only when the env copy was OURS (fill-gap) — a real env var stays (env
 * wins) and the status shows the key still present from env.
 */
export function deleteKey(id: string): AuthKeyStatus {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
	return keyStatuses().find((s) => s.id === id)!;
}

// Reflect the file into the env at first import (idempotent; the module is
// imported by every route/handler path that touches keys).
initAuthEnv();
