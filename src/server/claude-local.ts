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
import { claudeCommand, claudeLaunchOptions } from "../agent/claude-local/launch.ts";
import { acceptClaudeLocalSnapshot, claudeLocalStatus as bridgeStatus, claudeLocalUsage, type ClaudeLocalLaunch } from "../agent/claude-local/bridge.ts";
import { loadClaudeQuery, type AccountInfo, type ClaudeQuery, type ModelInfo } from "../agent/claude-local/sdk.ts";
import type { EffectiveSettings } from "../core/settings-resolution.ts";
import { effectiveSettings } from "./stores.ts";
import { subscriptionRequestAuthorized } from "./web-subscription-http.ts";

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
}

/** Resolve a candidate file to what the SDK can spawn: a native binary as
 *  is; an npm shim (symlink or .cmd) to the cli.js behind it (the SDK runs
 *  a .js entry through Node and cannot spawn .cmd shims — no shell). */
function launchable(candidate: string): { path: string; viaNode: boolean } | null {
	let real: string;
	try { real = fs.realpathSync(candidate); } catch { return null; }
	let stat: fs.Stats;
	try { stat = fs.statSync(real); } catch { return null; }
	if (!stat.isFile()) return null;
	if (/\.(c?js|mjs)$/i.test(real)) return { path: real, viaNode: true };
	if (/\.(cmd|bat|ps1)$/i.test(real)) {
		// npm's Windows shim sits beside node_modules/@anthropic-ai/claude-code.
		const cli = path.join(path.dirname(real), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
		return fs.existsSync(cli) ? { path: cli, viaNode: true } : null;
	}
	return { path: real, viaNode: false };
}

/** Known install locations (the native installer, Homebrew, npm global,
 *  the legacy ~/.claude/local) — PATH is minimal in a Finder/Dock-launched
 *  app, so these are checked after it. */
export function knownClaudeLocations(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
	const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	const dirs = platform === "win32"
		? [path.join(home, ".local", "bin"), env.APPDATA ? path.join(env.APPDATA, "npm") : "", env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "claude") : ""]
		: [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), "/usr/local/lib/node_modules/.bin"];
	const files = dirs.filter(Boolean).flatMap((dir) => names.map((name) => path.join(dir, name)));
	// npm global cli.js entries (no shim needed).
	files.push(...(platform === "win32" && env.APPDATA ? [path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")] : ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", path.join(home, ".npm-global", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")]));
	return files;
}

export function detectClaudeBinary(options: DetectOptions = {}): DetectedBinary | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
	if (options.override) {
		const found = launchable(options.override);
		return found ? { ...found, source: "override" } : null;
	}
	const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const found = launchable(path.join(dir, name));
			if (found) return { ...found, source: "path" };
		}
	}
	for (const candidate of knownClaudeLocations(platform, home, env)) {
		const found = launchable(candidate);
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

/** `claude --version` with the scrubbed env, bounded. */
export function claudeVersion(binary: { path: string; viaNode: boolean }, timeoutMs = 10_000): Promise<string | null> {
	const { command, args, extraEnv } = claudeCommand(binary);
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		const done = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
		let child: ReturnType<typeof spawn>;
		try { child = spawn(command, [...args, "--version"], { env: claudeChildEnv(process.env, extraEnv) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
		catch { done(null); return; }
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } done(null); }, timeoutMs);
		child.stdout?.on("data", (chunk) => { output += String(chunk); });
		child.on("error", () => done(null));
		child.on("exit", (code) => done(code === 0 ? parseClaudeVersion(output) : null));
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
 *  model call, no plan usage. */
async function* silence(): AsyncGenerator<never> { await new Promise<never>(() => {}); }

export interface ProbeResult { account: AccountInfo; models: ModelInfo[] }
/** Ask the install who it is and what it offers, then close it. */
export async function probeAccount(query: ClaudeQuery, launch: ClaudeLocalLaunch, timeoutMs = 20_000): Promise<ProbeResult> {
	const abort = new AbortController();
	const handle = query({
		prompt: silence(),
		options: {
			...claudeLaunchOptions(launch),
			tools: [],
			settingSources: [],
			persistSession: false,
			strictMcpConfig: true,
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

/** supportedModels() rows → app models. Joined on resolvedModel with pi-ai's
 *  Anthropic catalog for name, limits, modalities and thinking levels (the
 *  SDK reports a bare alias label — "Opus" — and none of the rest); the
 *  `default` alias and duplicates collapse; a model the catalog does not
 *  know is skipped with one log line (owner-approved assumption: never
 *  invent a context window). Cost is zero — plan usage shows as the
 *  "Local Claude" label, never as dollars. */
export function claudeLocalCatalog(models: ModelInfo[]): Model<Api>[] {
	const out = new Map<string, Model<Api>>();
	for (const info of models) {
		if (info.value === "default") continue;
		const id = info.resolvedModel ?? info.value;
		if (out.has(id)) continue;
		const base = piModels().getModel("anthropic", id);
		if (!base) { console.info(`[claude-local] skipping ${id}: not in pi-ai's Anthropic catalog (no context window known)`); continue; }
		out.set(id, { ...base, id, provider: CLAUDE_LOCAL.providerId, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	}
	return [...out.values()];
}

// ─── the status owner ───────────────────────────────────────────────────────

interface Owner {
	status: ClaudeLocalStatus;
	launch: ClaudeLocalLaunch | null;
	models: Model<Api>[];
	inFlight?: Promise<ClaudeLocalStatus>;
	/** The settings the last probe ran against (a change re-probes). */
	settingsKey: string;
	revision: number;
}
const KEY = Symbol.for("lh.claudeLocal.owner");
const PROBE_TTL_MS = 5 * 60_000;
function owner(): Owner {
	const global = globalThis as typeof globalThis & { [KEY]?: Owner };
	return global[KEY] ??= { status: initialStatus(effectiveSettings().claudeLocal), launch: null, models: [], settingsKey: "", revision: 0 };
}
function initialStatus(settings: EffectiveSettings["claudeLocal"]): ClaudeLocalStatus {
	return { providerId: CLAUDE_LOCAL.providerId, enabled: settings.enabled, allowBackgroundUse: settings.allowBackgroundUse, systemPromptMode: settings.systemPromptMode, state: settings.enabled ? "unavailable" : "disabled", binary: null, account: null, models: 0, probedAt: null, revision: 0 };
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
};

async function runProbe(settings: EffectiveSettings["claudeLocal"], state: Owner): Promise<ClaudeLocalStatus> {
	const base = initialStatus(settings);
	let next: ClaudeLocalStatus = { ...base, probedAt: new Date().toISOString() };
	let launch: ClaudeLocalLaunch | null = null;
	let models: Model<Api>[] = [];
	if (settings.enabled) {
		const detected = detectClaudeBinary({ override: settings.binaryPath });
		if (!detected) next = { ...next, state: "not-found", error: settings.binaryPath ? `No Claude Code executable at ${settings.binaryPath}. ${STATE_MESSAGES["not-found"]}` : STATE_MESSAGES["not-found"] };
		else {
			const version = await claudeVersion(detected);
			next = { ...next, binary: { path: detected.path, version, source: detected.source } };
			if (version === null) next = { ...next, state: "unavailable", error: STATE_MESSAGES.unavailable };
			else if (!versionSupported(version)) next = { ...next, state: "unsupported-version", error: `Claude Code ${version} is older than the required ${CLAUDE_LOCAL.minVersion}. Update Claude Code and re-check.` };
			else {
				const candidate: ClaudeLocalLaunch = { path: detected.path, viaNode: detected.viaNode, cwd: claudeLocalCwd() };
				try {
					const query = await loadClaudeQuery();
					const probe = await probeAccount(query, candidate);
					const verdict = classifyAccount(probe.account);
					next = { ...next, state: verdict.state, account: { ...(probe.account.subscriptionType ? { subscriptionType: probe.account.subscriptionType } : {}), ...(probe.account.apiProvider ? { apiProvider: probe.account.apiProvider } : {}) }, ...(verdict.detail ? { error: verdict.detail } : {}) };
					if (verdict.state === "ready") {
						models = claudeLocalCatalog(probe.models);
						launch = candidate;
						next = { ...next, models: models.length };
						if (models.length === 0) next = { ...next, state: "unavailable", error: "Claude Code offered no model this app knows. Update LearnHarness or Claude Code and re-check." , models: 0 };
						if (next.state !== "ready") launch = null;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.info(`[claude-local] probe failed: ${message}`);
					next = /auth|login|sign.?in|credential|token|401|403/i.test(message)
						? { ...next, state: "not-signed-in", error: "Claude Code is not signed in. Run `claude` in a terminal, sign in with your Claude plan, then re-check." }
						: { ...next, state: "unavailable", error: `${STATE_MESSAGES.unavailable} (${message.split("\n")[0]?.slice(0, 200)})` };
				}
			}
		}
	}
	// Authority = what admitted turns depend on (install, login, catalog):
	// a change bumps the revision and invalidates every scope. Consent and
	// the prompt mode are NOT authority — the bridge handles consent by
	// aborting background runs only.
	const authority = (status: ClaudeLocalStatus, catalog: Model<Api>[]) => JSON.stringify({ enabled: status.enabled, state: status.state, binary: status.binary, account: status.account, models: catalog.map((m) => m.id) });
	if (authority(state.status, state.models) !== authority(next, models)) state.revision++;
	next = { ...next, revision: state.revision };
	const changed = JSON.stringify({ ...state.status, probedAt: null, usage: undefined }) !== JSON.stringify({ ...next, probedAt: null, usage: undefined });
	state.status = next; state.launch = launch; state.models = models;
	acceptClaudeLocalSnapshot({ status: next, models, launch });
	if (changed) emit("subscriptions-changed", {});
	return next;
}

function settingsKeyOf(settings: EffectiveSettings["claudeLocal"]): string { return JSON.stringify(settings); }

/** Refresh the status: a cached result within the TTL and for unchanged
 *  settings is returned as is (the pre-turn catalog refresh and GET
 *  /api/models call this; neither may spawn a probe per request); a
 *  settings change, a stale result or `force` re-probes, single-flight. */
export async function refreshClaudeLocal(options: { force?: boolean } = {}): Promise<ClaudeLocalStatus> {
	const state = owner();
	const settings = effectiveSettings().claudeLocal;
	const key = settingsKeyOf(settings);
	const fresh = state.status.probedAt !== null && Date.now() - Date.parse(state.status.probedAt) < PROBE_TTL_MS;
	if (!options.force && key === state.settingsKey && fresh) return state.status;
	if (state.inFlight && key === state.settingsKey) return state.inFlight;
	state.settingsKey = key;
	const run = runProbe(settings, state).finally(() => { if (state.inFlight === run) state.inFlight = undefined; });
	state.inFlight = run;
	return run;
}
/** The current status without probing (plus the latest usage report). */
export function claudeLocalStatusNow(): ClaudeLocalStatus {
	const state = owner();
	const usage = claudeLocalUsage();
	return { ...(bridgeStatus() ?? state.status), ...(usage ? { usage } : {}) };
}
/** A settings write landed: the next refresh must re-probe. */
export function invalidateClaudeLocal(): void { owner().settingsKey = ""; }

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
	let command: unknown;
	try { command = await request.json(); } catch { command = null; }
	const op = command && typeof command === "object" && !Array.isArray(command) ? (command as { op?: unknown }).op : undefined;
	if (op !== "probe") return Response.json({ error: "Unsupported control." }, { status: 400, headers: HEADERS });
	await refreshClaudeLocal({ force: true });
	return Response.json(claudeLocalStatusNow(), { headers: HEADERS });
}
