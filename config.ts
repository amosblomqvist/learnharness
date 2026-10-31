import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopedDataRoot } from "./src/server/scope.ts";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): LH_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 *
 * MULTI-USER (mobile-web, 2026-10-29): the base root below is now only the
 * FALLBACK. Inside a signed-in request, src/server/scope.ts supplies the
 * account's own root (`<base>/users/<id>/`), so chats, ledgers, jobs and
 * settings resolve per user. Provider keys (AUTH_FILE) stay machine-global
 * by owner decision.
 */
const BASE_DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/** The account-relative root for this call (scope-aware), else the base. */
function dataRoot(): string {
	return scopedDataRoot(BASE_DATA_ROOT);
}

function pathsFor(root: string) {
	return {
		root: ROOT,
		/** Teacher system prompt — the agent's instructions (src/agent/). */
		teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
		data: root,
		/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
		chats: path.join(root, "chats"),
		graph: path.join(root, "graph"),
		/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
		 * raw provider stream recordings (src/agent/provider-events.ts). */
		debug: path.join(root, "debug"),
	};
}

export type Paths = {
	root: string;
	teacherPrompt: string;
	data: string;
	chats: string;
	graph: string;
	debug: string;
};

/** Scope-aware paths. Read a property per use — never capture at module load. */
export const PATHS: Paths = new Proxy({} as Paths, {
	get(_target, property): string | undefined {
		if (typeof property !== "string") return undefined;
		return (pathsFor(dataRoot()) as Record<string, string>)[property];
	},
});

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export type LedgerFiles = {
	nodes: string;
	chains: string;
	sessions: string;
	coverage: string;
};

/** Scope-aware: every property resolves against the caller's graph dir. */
export const LEDGER_FILES: LedgerFiles = new Proxy({} as LedgerFiles, {
	get(_target, property): string | undefined {
		if (typeof property !== "string") return undefined;
		return path.join(PATHS.graph, `${property}.jsonl`);
	},
});

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export function sourcesFile(): string {
	return path.join(PATHS.graph, "sources.json");
}
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export function positionsFile(): string {
	return path.join(PATHS.graph, "positions.json");
}

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export function renderSettingsFile(): string {
	return path.join(PATHS.graph, "render-settings.json");
}

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export function graphFormatFile(): string {
	return path.join(PATHS.graph, "format.json");
}

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — auth.json /
 * .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export function settingsFile(): string {
	return path.join(PATHS.data, "settings.json");
}

/**
 * User prompt-override files (settings-storage wave, 2026-09-19): the
 * per-segment system-prompt overrides mirroring the SOURCE layout
 * (src/agent/prompts/) — the shared base as prompts/system-prompt.md,
 * fragments as prompts/teacher/<file> / prompts/prober/<file>. File
 * PRESENCE alone is not the override: settings.json's agent.prompts map
 * (segmentPath → boolean) is the explicit switch, so a user can keep a
 * customized file on disk but run the source default to compare. The
 * segment list itself is ALWAYS derived from source at runtime (the
 * loader in src/store/prompt-overrides.ts) — code updates that add,
 * remove, or reorder fragments adapt automatically; an override keyed to
 * a vanished segment stops composing but stays on disk.
 */
export function promptsOverrideDir(): string {
	return path.join(PATHS.data, "prompts");
}

/** The machine-global data root (LH_DATA_DIR or <repo>/data) — the fallback
 *  root and the home of the account registry + session key. */
export const BASE_DATA = BASE_DATA_ROOT;

/**
 * THE ACCOUNT REGISTRY (mobile-web, 2026-10-29): one hand-editable JSON
 * document at the base data root — accounts and pending invites. NOT
 * account-scoped: it is what tells the server WHICH account a session
 * belongs to. Mode 0600 (it holds password hashes and invite codes).
 */
export const USERS_FILE = path.join(BASE_DATA_ROOT, "users.json");

/** HMAC secret for session cookies (0600, generated on first use). */
export const SESSION_KEY_FILE = path.join(BASE_DATA_ROOT, "session.key");

/** `<base>/users/<id>/` — the account's mutable-record root. */
export function userDataRoot(userId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error(`Invalid user id: ${userId}`);
	return path.join(BASE_DATA_ROOT, "users", userId);
}

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — the SAME file the Electron app has always
 * hand-edited (owner decision: option A, zero migration). Desktop main.cjs
 * passes LH_AUTH_FILE pointing at userData/auth.json (mode 0600); in dev
 * (no Electron) the default is the repo-root auth.json (gitignored, same
 * pattern as .env.local — a worktree may symlink it to the master copy).
 * The SERVER reads/writes this file directly at call time (no restart to
 * change a key); it reflects the values into process.env at boot with
 * FILL-GAP precedence — real environment variables (incl. .env.local in
 * dev) always win (src/server/keys.ts). Hand-edits still work: the file is
 * re-read from disk on every API access. Secrets NEVER go in settings.json
 * — this file keeps that role, alongside .env.local.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
