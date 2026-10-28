/**
 * The Local Claude route's server owner (docs/architecture.md §8.1): finds
 * the user's OWN Claude Code install, gates its version, asks it — through
 * the Agent SDK, without ever sending a prompt — what login it holds and
 * which models the plan offers, and publishes the result to the agent
 * bridge and the Providers card. The Next server owns this in packaged
 * desktop, desktop dev and web/dev alike (the in-process MCP tools need the
 * app's tools and stores; Electron main never hosts inference).
 *
 * NOTHING here touches a credential: Claude Code keeps its login in its
 * own config dir; the app learns only `subscriptionType` / `apiProvider`
 * (never a token, never an email) and refuses the route unless a Claude
 * plan login would be billed — an API key or a third-party provider is a
 * recoverable non-ready state with accurate wording, never a fatal one.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { CLAUDE_LOCAL, type ClaudeLocalState, type ClaudeLocalStatus } from "../core/contracts/claude-local.ts";
import { emit } from "../core/events.ts";
import { piModels } from "../agent/models.ts";
import { claudeChildEnv } from "../agent/claude-local/env.ts";
import { claudeCommand, claudeLaunchOptions, withoutStderr } from "../agent/claude-local/launch.ts";
import { acceptClaudeLocalSnapshot, claudeLocalStatus as bridgeStatus, claudeLocalUsage, onClaudeLocalChange, type ClaudeLocalLaunch } from "../agent/claude-local/bridge.ts";
import { loadClaudeQuery, type AccountInfo, type ClaudeQuery, type ModelInfo } from "../agent/claude-local/sdk.ts";
import type { EffectiveSettings } from "../core/settings-resolution.ts";
import { effectiveSettings } from "./stores.ts";
import { readControlJson, subscriptionRequestAuthorized } from "./web-subscription-http.ts";

// ─── detection ──────────────────────────────────────────────────────────────

export interface DetectedBinary {
	/** What the SDK is pointed at: the native binary, or the npm cli.js. */
	path: string;
	viaNode: boolean;
	source: "override" | "path" | "known-location";
}
export interface DetectOptions {
	override?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** The root the absolute system locations (Homebrew, /usr/local) sit
	 *  under: "/" in production, an isolated directory in tests, so a host's
	 *  own install can never decide a detection test. */
	systemRoot?: string;
}

/** The entries the SDK runs through a JS runtime rather than spawning
 *  directly — its own list, matched case-sensitively as it does
 *  (sdk.mjs: `[".js",".mjs",".tsx",".ts",".jsx"].some(e => path.endsWith(e))`). */
const SDK_SCRIPT_ENTRY = /\.(js|mjs|tsx|ts|jsx)$/;

/** Resolve a candidate file to what the SDK can spawn: a native binary at
 *  the candidate path itself (the native installer's symlink names a
 *  versioned target that an update replaces — the link is the stable
 *  name); an npm shim (symlink or .cmd) to the cli.js behind it (the SDK
 *  runs a .js entry through Node and cannot spawn .cmd shims — no shell).
 *  The target is resolved only to classify. A native candidate that is not
 *  executable is skipped (the search continues past it). */
function launchable(candidate: string, platform: NodeJS.Platform = process.platform): { path: string; viaNode: boolean } | null {
	let real: string;
	try { real = fs.realpathSync(candidate); } catch { return null; }
	let stat: fs.Stats;
	try { stat = fs.statSync(real); } catch { return null; }
	if (!stat.isFile()) return null;
	if (SDK_SCRIPT_ENTRY.test(real)) return { path: real, viaNode: true };
	if (/\.(cmd|bat|ps1)$/i.test(real)) {
		// npm's Windows shim sits beside node_modules/@anthropic-ai/claude-code.
		const cli = path.join(path.dirname(real), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
		return fs.existsSync(cli) ? { path: cli, viaNode: true } : null;
	}
	if (platform !== "win32") { try { fs.accessSync(real, fs.constants.X_OK); } catch { return null; } }
	return { path: path.resolve(candidate), viaNode: false };
}

/** Known install locations (the native installer, Homebrew, npm global,
 *  the legacy ~/.claude/local) — PATH is minimal in a Finder/Dock-launched
 *  app, so these are checked after it. The legacy ~/.claude/local/claude
 *  is a shell wrapper that runs `node`: it works only when `node` is on
 *  the PATH the child inherits (PATH passes through env.ts's allowlist
 *  unchanged); a Dock-launched app's minimal PATH may lack it, which then
 *  shows as "could not be started". */
export function knownClaudeLocations(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, systemRoot = "/"): string[] {
	const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	const system = (...parts: string[]) => path.join(systemRoot, ...parts);
	const dirs = platform === "win32"
		? [path.join(home, ".local", "bin"), env.APPDATA ? path.join(env.APPDATA, "npm") : "", env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "claude") : ""]
		: [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), system("opt", "homebrew", "bin"), system("usr", "local", "bin"), path.join(home, ".npm-global", "bin"), system("usr", "local", "lib", "node_modules", ".bin")];
	const files = dirs.filter(Boolean).flatMap((dir) => names.map((name) => path.join(dir, name)));
	// npm global cli.js entries (no shim needed).
	files.push(...(platform === "win32" && env.APPDATA ? [path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")] : [system("usr", "local", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"), path.join(home, ".npm-global", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")]));
	return files;
}

export function detectClaudeBinary(options: DetectOptions = {}): DetectedBinary | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
	if (options.override) {
		const found = launchable(options.override, platform);
		return found ? { ...found, source: "override" } : null;
	}
	const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const found = launchable(path.join(dir, name), platform);
			if (found) return { ...found, source: "path" };
		}
	}
	for (const candidate of knownClaudeLocations(platform, home, env, options.systemRoot)) {
		const found = launchable(candidate, platform);
		if (found) return { ...found, source: "known-location" };
	}
	return null;
}

// ─── version gate ───────────────────────────────────────────────────────────

export function parseClaudeVersion(output: string): string | null {
	return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.slice(1, 4).join(".") ?? null;
}
/** Semantic triple compare; non-numeric input sorts lowest. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) {
		const diff = (x[i] ?? 0) - (y[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
export function versionSupported(version: string): boolean { return compareVersions(version, CLAUDE_LOCAL.minVersion) >= 0; }

/** The most of `claude --version`'s stdout kept (the version is one line). */
const VERSION_OUTPUT_CAP = 4096;
/** `claude --version` with the scrubbed env, bounded in time and output;
 *  settles on `close` (stdout drained), never throws. */
export function claudeVersion(binary: { path: string; viaNode: boolean }, timeoutMs = 10_000): Promise<string | null> {
	const { command, args, extraEnv } = claudeCommand(binary);
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
		let child: ReturnType<typeof spawn>;
		try { child = spawn(command, [...args, "--version"], { env: claudeChildEnv(process.env, extraEnv) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
		catch { done(null); return; }
		timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } done(null); }, timeoutMs);
		child.stdout?.on("data", (chunk) => { if (output.length < VERSION_OUTPUT_CAP) output = (output + String(chunk)).slice(0, VERSION_OUTPUT_CAP); });
		child.on("error", () => done(null));
		child.on("close", (code) => done(code === 0 ? parseClaudeVersion(output) : null));
	});
}

// ─── the no-prompt account probe ────────────────────────────────────────────

/** Plan logins Claude Code reports for claude.ai subscriptions (its usage
 *  reply documents 'pro' | 'max' | 'team' | 'enterprise'; the Console API
 *  login reads "Claude API"). Matched case-insensitively on the word. */
const PLAN_WORDS = ["pro", "max", "team", "enterprise"];
export function classifyAccount(account: AccountInfo | undefined): { state: Extract<ClaudeLocalState, "ready" | "api-key" | "third-party" | "not-signed-in">; detail?: string } {
	if (!account) return { state: "not-signed-in", detail: "Claude Code did not report a login." };
	if (account.apiProvider && account.apiProvider !== "firstParty") return { state: "third-party", detail: `Claude Code is configured for ${account.apiProvider}; this route only runs on a Claude plan login.` };
	const keySource = account.apiKeySource;
	if (keySource && keySource !== "none") return { state: "api-key", detail: `Claude Code is signed in with an API key (${keySource}); this route only runs on a Claude plan login.` };
	const plan = (account.subscriptionType ?? "").toLowerCase();
	if (PLAN_WORDS.some((word) => new RegExp(`\\b${word}\\b`).test(plan))) return { state: "ready" };
	if (/api/.test(plan)) return { state: "api-key", detail: "Claude Code is signed in to a Claude API (Console) account; this route only runs on a Claude plan login." };
	return { state: "not-signed-in", detail: account.subscriptionType ? `Claude Code reports "${account.subscriptionType}", not a Claude plan login.` : "Claude Code reported no Claude plan login." };
}

/** An iterable that never yields: the CLI starts, initialises, answers
 *  control requests and waits for input it never gets — no prompt, no
 *  model call, no plan usage. It ends when the probe aborts (so no
 *  pending generator outlives the probe). */
async function* silence(signal: AbortSignal): AsyncGenerator<never> {
	await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
}

export interface ProbeResult { account: AccountInfo; models: ModelInfo[] }
/** Ask the install who it is and what it offers, then close it. */
export async function probeAccount(query: ClaudeQuery, launch: ClaudeLocalLaunch, timeoutMs = 20_000): Promise<ProbeResult> {
	const abort = new AbortController();
	const handle = query({
		prompt: silence(abort.signal),
		options: {
			...claudeLaunchOptions(launch),
			maxTurns: 1,
			systemPrompt: "",
			abortController: abort,
		},
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude Code did not answer the account probe in time.")), timeoutMs); });
	// The iterator must be driven for the control channel to pump; a
	// surfaced error (spawn failure, exit) rejects the race.
	const drain = (async () => { for await (const message of handle) { void message; } })();
	const failure = drain.then(() => { throw new Error("Claude Code exited before answering the account probe."); });
	try {
		const [account, models] = await Promise.race([Promise.all([handle.accountInfo(), handle.supportedModels()]), timeout, failure]);
		return { account, models };
	} finally {
		if (timer) clearTimeout(timer);
		abort.abort();
		try { handle.close(); } catch { /* already gone */ }
		await drain.catch(() => undefined);
	}
}

// ─── catalog join ───────────────────────────────────────────────────────────

/** The key pi-ai's catalog knows a Claude Code id by: Claude Code may
 *  resolve to a dated id (`…-YYYYMMDD`) or a long-context variant
 *  (`…[1m]`) of a model pi-ai keys under the bare id. */
function catalogLookupId(id: string): string { return id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, ""); }

/** supportedModels() rows → app models. Joined on resolvedModel with pi-ai's
 *  Anthropic catalog for name, limits, modalities and thinking levels (the
 *  SDK reports a bare alias label — "Opus" — and none of the rest), by the
 *  exact id first and then by its lookup id (catalogLookupId); the model
 *  keeps the id Claude Code resolved (that is what a turn sends back). The
 *  `default` alias and duplicates collapse; a model the catalog does not
 *  know is skipped with one log line and pushed to `skipped` (owner-
 *  approved assumption: never invent a context window). Cost is zero —
 *  plan usage shows as the "Local Claude" label, never as dollars. */
export function claudeLocalCatalog(models: ModelInfo[], skipped: string[] = []): Model<Api>[] {
	const out = new Map<string, Model<Api>>();
	for (const info of models) {
		if (info.value === "default") continue;
		const id = info.resolvedModel ?? info.value;
		if (out.has(id) || skipped.includes(id)) continue;
		const base = piModels().getModel("anthropic", id) ?? piModels().getModel("anthropic", catalogLookupId(id));
		if (!base) { console.info(`[claude-local] skipping ${id}: not in pi-ai's Anthropic catalog (no context window known)`); skipped.push(id); continue; }
		out.set(id, { ...base, id, provider: CLAUDE_LOCAL.providerId, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	}
	return [...out.values()];
}

// ─── the status owner ───────────────────────────────────────────────────────

interface ProbeTicket {
	/** The owner's generation when this probe started. */
	generation: number;
	/** May this probe's transient failure replace a ready status? (force,
	 *  or the settings changed since the last probe.) */
	authoritative: boolean;
}
interface Owner {
	status: ClaudeLocalStatus;
	launch: ClaudeLocalLaunch | null;
	models: Model<Api>[];
	inFlight?: Promise<ClaudeLocalStatus>;
	inFlightTicket?: ProbeTicket;
	/** The settings the last probe ran against (a change re-probes). */
	settingsKey: string;
	/** The latest settings the owner applied (null before the first). */
	settings: EffectiveSettings["claudeLocal"] | null;
	revision: number;
	/** Bumped by every probe start and every synchronous authority change
	 *  (invalidateClaudeLocal, a turn's adopted API-key verdict): a probe
	 *  applies its result only while its ticket is still the latest
	 *  generation — an older, slower probe can never overwrite a newer
	 *  verdict or a "turn it off" — and only a probe of the latest
	 *  generation is joined (a superseded one runs out and is discarded). */
	generation: number;
}
const KEY = Symbol.for("lh.claudeLocal.owner");
/** GET /api/claude-local (the Providers card): a status older than this re-probes. */
const STATUS_TTL_MS = 5 * 60_000;
/** GET /api/models (the picker): a much longer bound — the picker never
 *  needs a fresh boot of Claude Code, and the card's Re-check is the way
 *  to force one. */
export const CLAUDE_LOCAL_CATALOG_TTL_MS = 60 * 60_000;
function owner(): Owner {
	const global = globalThis as typeof globalThis & { [KEY]?: Owner };
	if (!global[KEY]) {
		const state: Owner = { status: initialStatus(effectiveSettings().claudeLocal), launch: null, models: [], settingsKey: "", settings: null, revision: 0, generation: 0 };
		global[KEY] = state;
		onClaudeLocalChange(() => adoptApiKeyVerdict(state));
	}
	return global[KEY];
}
/** A turn's system/init found Claude Code set up to bill an API key
 *  (bridge.noteClaudeLocalApiKeySource): the owner takes that verdict as
 *  its own status — no launch, no models, same revision — so neither the
 *  last-known-good path of a transient probe failure nor an in-place
 *  consent/prompt-mode write can re-publish the ready status the turn
 *  disproved. It is a new generation: a probe started before the note is
 *  discarded when it lands, so only a probe started after it re-admits
 *  (its verdict changes the authority, so the revision moves). */
function adoptApiKeyVerdict(state: Owner): void {
	const noted = bridgeStatus();
	if (!noted || noted.state !== "api-key" || state.status.state !== "ready" || noted.revision !== state.status.revision) return;
	state.generation++;
	state.status = { ...noted }; state.launch = null; state.models = [];
	emit("subscriptions-changed", {});
}
function initialStatus(settings: EffectiveSettings["claudeLocal"]): ClaudeLocalStatus {
	return { providerId: CLAUDE_LOCAL.providerId, enabled: settings.enabled, allowBackgroundUse: settings.allowBackgroundUse, systemPromptMode: settings.systemPromptMode, state: settings.enabled ? "unavailable" : "disabled", binaryPath: settings.binaryPath ?? "", binary: null, account: null, models: 0, probedAt: null, revision: 0 };
}
/** The child's working directory: app-owned, empty, under the data dir. */
export function claudeLocalCwd(): string {
	const dir = path.join(PATHS.data, "claude-local");
	try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the probe */ }
	return dir;
}

const STATE_MESSAGES: Partial<Record<ClaudeLocalState, string>> = {
	"not-found": "Claude Code was not found. Install it, sign in with `claude` in a terminal, or set its path here.",
	"unavailable": "Claude Code could not be started. Check the path and run `claude` in a terminal.",
	"not-signed-in": "Claude Code is not signed in. Run `claude` in a terminal, sign in with your Claude plan, then re-check.",
};

/** SDK error classes (the `errorClass` field the SDK stamps on its
 *  errors) that describe the child process itself — spawn, exit, signal,
 *  startup timeout, abort — and are never a login verdict on their own. */
const PROCESS_ERROR_CLASSES = new Set(["aborted", "executable_not_found", "executable_launch_failed", "process_exited_nonzero", "process_killed_by_signal", "initialize_timeout"]);
/** A failed probe → a non-ready state. The SDK appends the child's stderr
 *  tail after ". stderr:" — that never reaches a client. Classified on the
 *  SDK's error class/name where present; the wording regex is only the
 *  fallback for a control request answered with an error. `transient`:
 *  the failure says nothing definitive about the install or its login. */
function classifyProbeFailure(error: unknown): { state: "not-signed-in" | "unavailable"; error: string; transient: boolean } {
	const raw = error instanceof Error ? error.message : String(error);
	const hasStderr = raw.includes(". stderr:");
	const message = (raw.split(". stderr:")[0] ?? "").split("\n")[0]?.slice(0, 200) ?? "";
	const fields = (error !== null && typeof error === "object" ? error : {}) as { name?: unknown; errorClass?: unknown; exitCode?: unknown };
	const unavailable = { state: "unavailable" as const, error: `${STATE_MESSAGES.unavailable} (${message})`, transient: true };
	if (fields.name === "AbortError") return unavailable;
	if (typeof fields.errorClass === "string" && PROCESS_ERROR_CLASSES.has(fields.errorClass)) {
		// A logged-out CLI may simply exit 1 without a word before answering.
		if (fields.exitCode === 1 && !hasStderr) return { state: "not-signed-in", error: "Claude Code exited before answering — it is probably not signed in, or it could not start. Run `claude` in a terminal, sign in with your Claude plan, then re-check.", transient: true };
		return unavailable;
	}
	if (/auth|log.?in|sign.?in|credential|\b401\b|\b403\b/i.test(message)) return { state: "not-signed-in", error: STATE_MESSAGES["not-signed-in"]!, transient: false };
	return unavailable;
}

async function runProbe(settings: EffectiveSettings["claudeLocal"], state: Owner, ticket: ProbeTicket): Promise<ClaudeLocalStatus> {
	const base = initialStatus(settings);
	let next: ClaudeLocalStatus = { ...base, probedAt: new Date().toISOString() };
	let launch: ClaudeLocalLaunch | null = null;
	let models: Model<Api>[] = [];
	/** A failure that says nothing definitive (timeout, spawn/exit failure). */
	let transient = false;
	if (settings.enabled) {
		try {
			const detected = detectClaudeBinary({ override: settings.binaryPath });
			if (!detected) {
				next = { ...next, state: "not-found", error: settings.binaryPath ? `No Claude Code executable at ${settings.binaryPath}. ${STATE_MESSAGES["not-found"]}` : STATE_MESSAGES["not-found"] };
				// An override that vanished may be an unmounted volume; no override = nothing installed.
				transient = !!settings.binaryPath;
			} else {
				const version = await claudeVersion(detected);
				next = { ...next, binary: { path: detected.path, version, source: detected.source } };
				if (version === null) { next = { ...next, state: "unavailable", error: STATE_MESSAGES.unavailable }; transient = true; }
				else if (!versionSupported(version)) next = { ...next, state: "unsupported-version", error: `Claude Code ${version} is older than the required ${CLAUDE_LOCAL.minVersion}. Update Claude Code and re-check.` };
				else {
					const candidate: ClaudeLocalLaunch = { path: detected.path, viaNode: detected.viaNode, cwd: claudeLocalCwd() };
					const query = await loadClaudeQuery();
					const probe = await probeAccount(query, candidate);
					const verdict = classifyAccount(probe.account);
					next = { ...next, state: verdict.state, account: { ...(probe.account.subscriptionType ? { subscriptionType: probe.account.subscriptionType } : {}), ...(probe.account.apiProvider ? { apiProvider: probe.account.apiProvider } : {}) }, ...(verdict.detail ? { error: verdict.detail } : {}) };
					if (verdict.state === "ready") {
						const skipped: string[] = [];
						models = claudeLocalCatalog(probe.models, skipped);
						launch = candidate;
						next = { ...next, models: models.length, ...(skipped.length > 0 ? { skippedModels: skipped } : {}) };
						if (models.length === 0) next = { ...next, state: "unavailable", error: `Claude Code offered no model this app knows${skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""}. Update LearnHarness or Claude Code and re-check.`, models: 0 };
						if (next.state !== "ready") launch = null;
					}
				}
			}
		} catch (error) {
			console.info(`[claude-local] probe failed: ${withoutStderr(error instanceof Error ? error.message : String(error))}`);
			const failure = classifyProbeFailure(error);
			next = { ...next, state: failure.state, error: failure.error };
			launch = null; models = [];
			transient = failure.transient;
		}
	}
	// A newer probe or a synchronous settings change superseded this one.
	if (ticket.generation !== state.generation) return state.status;
	// Last-known-good: a transient failure never demotes a ready route —
	// only Re-check (force), a settings change or a definitive verdict may.
	if (transient && !ticket.authoritative && settings.enabled && state.status.state === "ready" && state.status.enabled) {
		console.info(`[claude-local] keeping the last ready status after a transient probe failure (${next.error ?? next.state})`);
		next = { ...state.status, probedAt: next.probedAt };
		launch = state.launch; models = state.models;
	}
	// Consent and the prompt mode may have changed while the probe ran
	// (applied in place by invalidateClaudeLocal, no new generation).
	const latest = state.settings ?? settings;
	next = { ...next, allowBackgroundUse: latest.allowBackgroundUse, systemPromptMode: latest.systemPromptMode };
	return applyClaudeLocal(state, next, launch, models);
}

/** Publish a status to the owner and the bridge. Authority = what
 *  admitted turns depend on (install, login, catalog): a change bumps the
 *  revision and invalidates every scope. Consent and the prompt mode are
 *  NOT authority — the bridge handles consent by aborting background runs
 *  only; the binary's version is not either (an in-place update of the
 *  same install keeps admitted turns). */
function applyClaudeLocal(state: Owner, status: ClaudeLocalStatus, launch: ClaudeLocalLaunch | null, models: Model<Api>[]): ClaudeLocalStatus {
	const authority = (s: ClaudeLocalStatus, catalog: Model<Api>[]) => JSON.stringify({ enabled: s.enabled, state: s.state, binary: s.binary ? { path: s.binary.path, source: s.binary.source } : null, account: s.account, models: catalog.map((m) => m.id) });
	if (authority(state.status, state.models) !== authority(status, models)) state.revision++;
	const next = { ...status, revision: state.revision };
	const changed = JSON.stringify({ ...state.status, probedAt: null, usage: undefined }) !== JSON.stringify({ ...next, probedAt: null, usage: undefined });
	state.status = next; state.launch = launch; state.models = models;
	acceptClaudeLocalSnapshot({ status: next, models, launch });
	if (changed) emit("subscriptions-changed", {});
	return next;
}

function settingsKeyOf(settings: EffectiveSettings["claudeLocal"]): string { return JSON.stringify(settings); }

/** Refresh the status. Which paths may spawn a probe (`claude --version`
 *  plus one Claude Code boot that never prompts a model), and the bounds:
 *  - the pre-turn path (`cachedOnly`: chat-handler through
 *    refreshConnectionCatalog(provider)) never probes on a TTL lapse: only
 *    an enabled route never probed (a fresh server) or one whose settings
 *    changed since the last probe (turned on, a new path) — otherwise a
 *    turn is admitted on the cached snapshot and the turn's own child fails
 *    fast if the install is gone;
 *  - GET /api/models probes when the status is older than
 *    CLAUDE_LOCAL_CATALOG_TTL_MS (60 min) or the settings changed;
 *  - GET /api/claude-local probes when older than 5 minutes or the
 *    settings changed; POST /api/claude-local {op:"probe"} (Re-check)
 *    always (`force`).
 *  Every probe is single-flight per settings key and bounded in time
 *  (10 s + 20 s). */
export async function refreshClaudeLocal(options: { force?: boolean; maxAgeMs?: number; cachedOnly?: boolean } = {}): Promise<ClaudeLocalStatus> {
	const state = owner();
	const settings = effectiveSettings().claudeLocal;
	const key = settingsKeyOf(settings);
	// The pre-turn path admits on the cached snapshot: it probes only a route
	// never probed yet, or one whose settings changed since the last probe
	// (turned on, a new path) — never on a mere TTL lapse.
	if (options.cachedOnly && !options.force && (!settings.enabled || (state.status.probedAt !== null && key === state.settingsKey))) return state.status;
	const fresh = state.status.probedAt !== null && Date.now() - Date.parse(state.status.probedAt) < (options.maxAgeMs ?? STATUS_TTL_MS);
	if (!options.force && key === state.settingsKey && fresh) return state.status;
	// Join only a probe of the current generation: one a later authority
	// change superseded (an adopted API-key verdict, "off") is discarded when
	// it lands, so a caller — a Re-check above all — starts a fresh one.
	if (state.inFlight && key === state.settingsKey && state.inFlightTicket?.generation === state.generation) {
		if (options.force && state.inFlightTicket) state.inFlightTicket.authoritative = true;
		return state.inFlight;
	}
	const ticket: ProbeTicket = { generation: ++state.generation, authoritative: !!options.force || key !== state.settingsKey };
	state.settingsKey = key; state.settings = settings;
	const run = runProbe(settings, state, ticket).finally(() => { if (state.inFlight === run) { state.inFlight = undefined; state.inFlightTicket = undefined; } });
	state.inFlight = run; state.inFlightTicket = ticket;
	return run;
}
/** The current status without probing (plus the latest usage report). */
export function claudeLocalStatusNow(): ClaudeLocalStatus {
	const state = owner();
	const usage = claudeLocalUsage();
	return { ...(bridgeStatus() ?? state.status), ...(usage ? { usage } : {}) };
}
/** A claudeLocal settings write landed (PUT /api/settings/claudeLocal).
 *  Applied synchronously, never a probe on the request:
 *  - turned off: the status becomes "disabled" (no launch, no models) and
 *    reaches the bridge now, which aborts every in-flight run;
 *  - only consent / the prompt mode changed: pushed to the owner and the
 *    bridge in place — same revision, no re-probe (the bridge aborts
 *    background runs when consent turns off);
 *  - turned on, or a new binary path: the next status/picker refresh
 *    re-probes (the install is what changed). */
export function invalidateClaudeLocal(): void {
	const state = owner();
	const settings = effectiveSettings().claudeLocal;
	const previous = state.settings;
	if (!settings.enabled) {
		state.generation++;
		state.settings = settings; state.settingsKey = settingsKeyOf(settings);
		applyClaudeLocal(state, { ...initialStatus(settings), probedAt: state.status.probedAt }, null, []);
		return;
	}
	if (!previous || !previous.enabled || previous.binaryPath !== settings.binaryPath) {
		state.generation++;
		state.settingsKey = "";
		return;
	}
	state.settings = settings; state.settingsKey = settingsKeyOf(settings);
	applyClaudeLocal(state, { ...state.status, allowBackgroundUse: settings.allowBackgroundUse, systemPromptMode: settings.systemPromptMode }, state.launch, state.models);
}

// ─── HTTP (GET status / POST probe) ─────────────────────────────────────────

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
/** Same-origin controls only (the subscriptions' checks); identical in
 *  desktop and web — the desktop capability header is enforced upstream
 *  by proxy.ts for every /api route. */
export async function claudeLocalControlsResponse(request: Request): Promise<Response> {
	if (!subscriptionRequestAuthorized(request)) return Response.json({ error: "Local Claude controls require a same-origin LearnHarness request." }, { status: 403, headers: HEADERS });
	if (request.method === "GET") {
		await refreshClaudeLocal();
		return Response.json(claudeLocalStatusNow(), { headers: HEADERS });
	}
	if (request.method !== "POST") return Response.json({ error: "Unsupported method." }, { status: 405, headers: HEADERS });
	// The subscriptions' body guards: JSON only, 16 KB, bounded read.
	let command: unknown;
	try {
		const body = await readControlJson(request);
		if ("error" in body) return body.error;
		command = body.value;
	} catch { command = null; }
	const op = command && typeof command === "object" && !Array.isArray(command) ? (command as { op?: unknown }).op : undefined;
	if (op !== "probe") return Response.json({ error: "Unsupported control." }, { status: 400, headers: HEADERS });
	await refreshClaudeLocal({ force: true });
	return Response.json(claudeLocalStatusNow(), { headers: HEADERS });
}
