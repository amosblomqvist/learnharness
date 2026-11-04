/**
 * THE GLOBAL PI SETUP: the user's Pi config complements the app's own
 * providers and models. On by default wherever a pi CLI is found
 * (Settings → Keys); impossible to enable without one, since Pi itself
 * must be there to refresh logins.
 *
 *  - PROVIDERS: Pi's auth.json serves pi-ai as a read-only CredentialStore
 *    for every provider Pi has credentials for — api keys and OAuth logins
 *    alike. The app's own providers win: a provider with an app key (env
 *    or auth.json) is never answered from Pi.
 *  - LOGINS: Pi handles token refresh and credential storage. When pi-ai
 *    finds a login near expiry, the store asks Pi to refresh it (under
 *    Pi's own lock) and re-reads Pi's auth.json. The app never refreshes,
 *    stores, or writes a token.
 *  - MODELS: every models.json provider whose id pi-ai doesn't ship joins
 *    the collection, built the way Pi's own composer builds it. Builtin-id
 *    entries (Pi's override form) are not mirrored.
 *
 * Imported for its side effect by model-catalog.ts — the module every
 * engine/picker path already loads.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Credential,
	type CredentialStore,
	type Model,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { PI_DEFAULT_DIR } from "../../config.ts";
import { configurePiModels, piModels } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS, CUSTOM_PROVIDER, type PiSetupStatus } from "../core/auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { PiGlobalProviderConfig, PiGlobalSetup } from "../core/ports.ts";
import { piGlobalStore } from "../store/pi-global.ts";
import { envKeysIgnored, keyValue, providerKeyPresent } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

// ─── The pi CLI ──────────────────────────────────────────────────────────────

const CLI_PROBE_MS = 60_000;
let cliProbe: { at: number; path: string | null } | undefined;

/** The pi CLI, or null. A GUI-launched app has a minimal PATH, so the
 *  usual install locations are probed after PATH (PI_BIN overrides).
 *  Re-probed at most once a minute — installing pi needs no restart.
 *  Under NODE_ENV=test only PI_BIN counts: tests must never see the
 *  developer's real Pi setup. */
export function findPiCli(): string | null {
	if (cliProbe && Date.now() - cliProbe.at < CLI_PROBE_MS) return cliProbe.path;
	const home = os.homedir();
	const candidates = [process.env.PI_BIN];
	if (process.env.NODE_ENV !== "test") {
		candidates.push(
			...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "pi")),
			path.join(home, ".bun", "bin", "pi"),
			"/opt/homebrew/bin/pi",
			"/usr/local/bin/pi",
			path.join(home, ".local", "bin", "pi"),
			path.join(home, ".npm-global", "bin", "pi"),
			path.join(home, ".volta", "bin", "pi"),
		);
	}
	let found: string | null = null;
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			found = fs.realpathSync(candidate);
			break;
		} catch {
			/* not here */
		}
	}
	cliProbe = { at: Date.now(), path: found };
	return found;
}

/** How to run pi: a JS entry runs on THIS process's runtime (real node in
 *  dev; the app binary under ELECTRON_RUN_AS_NODE when packaged — its
 *  `#!/usr/bin/env node` would find no node on a GUI PATH), carrying over
 *  any --require preloads (e.g. the packaged server's title guard). */
function piCommand(cli: string, args: string[]): [string, string[]] {
	if (!/\.[cm]?js$/.test(cli)) return [cli, args];
	const preload: string[] = [];
	const ea = process.execArgv;
	for (let i = 0; i < ea.length - 1; i++) {
		if (ea[i] === "--require") preload.push(ea[i]!, ea[i + 1]!);
	}
	return [process.execPath, [...preload, cli, ...args]];
}

// ─── The active setup ────────────────────────────────────────────────────────

/** The global Pi setup when it is in use, else null: off under the
 *  fresh-user switch, without a pi CLI, or when the user turned it off. */
export function piSetup(): PiGlobalSetup | null {
	if (envKeysIgnored() || !findPiCli()) return null;
	const { enabled, dir } = effectiveSettings().pi;
	return enabled ? piGlobalStore.read(dir ?? PI_DEFAULT_DIR) : null;
}

/** Does the app itself hold a key for this provider (env or its own
 *  auth.json)? Then the provider is the app's, and Pi stays out of it. */
function appHasKey(providerId: string): boolean {
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === providerId);
	return info !== undefined && keyValue(info.envVar) !== undefined;
}

/**
 * Resolve a Pi config value the way Pi does: "$VAR" / "${VAR}" interpolate
 * from the live env ("$$" and "$!" escape), anything else is literal.
 * "!command" values are NOT executed (no shell from the server) — they
 * read as absent. Exported for tests.
 */
export function resolvePiConfigValue(raw: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (raw.startsWith("!")) return undefined;
	let out = "";
	for (let i = 0; i < raw.length; ) {
		const at = raw.indexOf("$", i);
		if (at < 0) {
			out += raw.slice(i);
			break;
		}
		out += raw.slice(i, at);
		const next = raw[at + 1];
		if (next === "$" || next === "!") {
			out += next;
			i = at + 2;
			continue;
		}
		const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}|^([A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(at + 1));
		if (!m) {
			out += "$";
			i = at + 1;
			continue;
		}
		const value = env[m[1] ?? m[2] ?? ""];
		if (!value) return undefined;
		out += value;
		i = at + 1 + m[0].length;
	}
	return out.trim() || undefined;
}

/** Pi's credential for one provider, as pi-ai consumes it: the auth.json
 *  entry (api key resolved, OAuth login as stored), else a custom
 *  provider's models.json apiKey — Pi's own order. */
function piCredential(setup: PiGlobalSetup, providerId: string): Credential | undefined {
	const stored = setup.credentials[providerId];
	if (stored?.type === "oauth") return stored;
	if (stored?.type === "api_key") {
		const key = stored.key ? resolvePiConfigValue(stored.key) : undefined;
		return key || stored.env ? { ...stored, key } : undefined;
	}
	const custom = setup.providers.find((p) => p.id === providerId)?.apiKey;
	const key = custom ? resolvePiConfigValue(custom) : undefined;
	return key ? { type: "api_key", key } : undefined;
}

/** Provider ids the app owns outright; a same-named Pi entry is ignored. */
const RESERVED_IDS: ReadonlySet<string> = new Set([CUSTOM_PROVIDER.id, CLAUDE_CODE_PROVIDER, "chatgpt"]);

/** Pi's credential for a provider the app has no key for. */
function inheritedCredential(providerId: string): Credential | undefined {
	const setup = piSetup();
	return setup && !RESERVED_IDS.has(providerId) && !appHasKey(providerId) ? piCredential(setup, providerId) : undefined;
}

// ─── Login refresh, delegated to Pi ──────────────────────────────────────────

const refreshing = new Map<string, Promise<void>>();

/** Have Pi refresh one provider's login: print-bearer-token refreshes
 *  under Pi's own lock and persists to Pi's auth.json; its output is
 *  discarded — the credential is re-read from the file. */
function refreshThroughPi(providerId: string, dir: string): Promise<void> {
	const cli = findPiCli();
	if (!cli) return Promise.resolve();
	const [cmd, args] = piCommand(cli, ["auth", "print-bearer-token", "--provider", providerId, "--min-expiry", "10m"]);
	return new Promise((resolve) => {
		execFile(cmd, args, { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, timeout: 30_000 }, (err, _stdout, stderr) => {
			if (err) console.error(`[pi-global] ${providerId}: Pi could not refresh the login: ${(stderr || err.message).slice(0, 300)}`);
			resolve();
		});
	});
}

/**
 * pi-ai's credential store over the global Pi setup. Reads answer only
 * for providers the app has no key for. `modify` is how pi-ai refreshes
 * an expiring login: here it hands the refresh to Pi (concurrent callers
 * share one pi run) and returns what Pi stored — the app never writes.
 */
const piCredentialStore: CredentialStore = {
	async read(providerId) {
		return inheritedCredential(providerId);
	},
	async list() {
		const setup = piSetup();
		if (!setup) return [];
		return Object.entries(setup.credentials)
			.filter(([id]) => !RESERVED_IDS.has(id) && !appHasKey(id))
			.map(([providerId, c]) => ({ providerId, type: c.type }));
	},
	async modify(providerId) {
		const setup = piSetup();
		if (setup?.credentials[providerId]?.type === "oauth") {
			let pending = refreshing.get(providerId);
			if (!pending) {
				pending = refreshThroughPi(providerId, setup.dir).finally(() => refreshing.delete(providerId));
				refreshing.set(providerId, pending);
			}
			await pending;
		}
		return inheritedCredential(providerId);
	},
	async delete() {
		throw new Error("The global Pi setup is read-only — sign out in Pi");
	},
};

// ─── Custom providers (models.json) ──────────────────────────────────────────

/** The chat APIs a models.json entry may name (Pi's plain-key set). */
const STREAMS: Record<string, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
	"mistral-conversations": mistralConversationsApi,
};

const BUILTIN_IDS: ReadonlySet<string> = new Set(getBuiltinProviders());

/** One models.json provider → a pi-ai Provider, or null when it can't be
 *  built (no models, unknown api, no baseUrl). Defaults mirror Pi's
 *  provider composer (modelFromJson). Its key comes through the
 *  credential store. Exported for tests. */
export function customProviderFrom(config: PiGlobalProviderConfig): Provider | null {
	const models: Model<Api>[] = [];
	for (const def of config.models ?? []) {
		const api = def.api ?? config.api;
		const baseUrl = def.baseUrl ?? config.baseUrl;
		if (!def?.id || !api || !STREAMS[api] || !baseUrl) continue;
		models.push({
			id: def.id,
			name: def.name ?? def.id,
			api,
			provider: config.id,
			baseUrl,
			reasoning: def.reasoning ?? false,
			...(def.thinkingLevelMap ? { thinkingLevelMap: def.thinkingLevelMap } : {}),
			input: def.input ?? ["text"],
			cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: def.contextWindow ?? 128000,
			maxTokens: def.maxTokens ?? 16384,
			...(config.compat || def.compat ? { compat: { ...config.compat, ...def.compat } } : {}),
		} as Model<Api>);
	}
	if (models.length === 0) return null;
	const apis = [...new Set(models.map((m) => m.api))];
	const headers = config.headers
		? Object.fromEntries(
				Object.entries(config.headers).flatMap(([k, v]) => {
					const value = resolvePiConfigValue(v);
					return value === undefined ? [] : [[k, value]];
				}),
			)
		: undefined;
	const name = config.name ?? config.id;
	return createProvider({
		id: config.id,
		name,
		...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
		...(headers ? { headers } : {}),
		auth: { apiKey: envApiKeyAuth(`${name} API key`, []) },
		models,
		api: Object.fromEntries(apis.map((api) => [api, STREAMS[api]!()])),
	});
}

const NONE: readonly Provider[] = Object.freeze([]);
let builtFrom: readonly PiGlobalProviderConfig[] | undefined;
let built: readonly Provider[] = NONE;

/** The live custom-provider list — identity-stable while models.json is
 *  unchanged; empty while the setup is not in use. */
export function piGlobalProviders(): readonly Provider[] {
	const configs = piSetup()?.providers;
	if (!configs) return NONE;
	if (configs !== builtFrom) {
		builtFrom = configs;
		built = configs
			.filter((c) => !BUILTIN_IDS.has(c.id) && !RESERVED_IDS.has(c.id))
			.map(customProviderFrom)
			.filter((p): p is Provider => p !== null);
	}
	return built;
}

configurePiModels({ credentials: piCredentialStore, extraProviders: piGlobalProviders });

// ─── Presence + status ───────────────────────────────────────────────────────

/** Would this provider authenticate at request time — through the app's
 *  own setup (keys.ts providerKeyPresent), else the global Pi setup? A
 *  Pi custom provider without a usable key is not. */
export function providerUsable(provider: string): boolean {
	if (inheritedCredential(provider)) return true;
	if (piGlobalProviders().some((p) => p.id === provider)) return false;
	return providerKeyPresent(provider);
}

/** Providers Pi supplies beyond the app's key table: login-only builtins
 *  (e.g. GitHub Copilot) and models.json custom providers. */
export function piExtraProviderIds(): string[] {
	const setup = piSetup();
	if (!setup) return [];
	const ids = new Set<string>(piGlobalProviders().map((p) => p.id));
	for (const id of Object.keys(setup.credentials)) {
		if (BUILTIN_IDS.has(id) && !AUTH_PROVIDER_KEYS.some((p) => p.id === id)) ids.add(id);
	}
	return [...ids];
}

/** The Keys page's view of the global Pi setup — no secrets. */
export function piSetupStatus(): PiSetupStatus {
	const cli = findPiCli();
	const { enabled, dir } = effectiveSettings().pi;
	const setup = piSetup();
	const status: PiSetupStatus = {
		available: cli !== null && !envKeysIgnored(),
		enabled: enabled && cli !== null,
		dir: dir ?? PI_DEFAULT_DIR,
		resolvedDir: setup?.dir ?? null,
		found: setup?.found ?? false,
		providers: [],
	};
	if (!setup) return status;
	const custom = new Map(piGlobalProviders().map((p) => [p.id, p]));
	const ids = new Set([...Object.keys(setup.credentials), ...setup.providers.map((p) => p.id)]);
	for (const id of ids) {
		if (RESERVED_IDS.has(id)) continue;
		const provider = custom.get(id) ?? piModels().getProvider(id);
		if (!provider) continue; // neither a pi-ai provider nor a buildable custom one
		const credential = piCredential(setup, id);
		status.providers.push({
			id,
			label: AUTH_PROVIDER_KEYS.find((p) => p.id === id)?.label ?? provider.name ?? id,
			kind: custom.has(id) ? "models" : credential?.type === "oauth" ? "login" : "api_key",
			models: custom.has(id) ? piModels().getModels(id).length : undefined,
			usable: credential !== undefined,
			overridden: appHasKey(id),
		});
	}
	status.providers.sort((a, b) => a.label.localeCompare(b.label));
	return status;
}
