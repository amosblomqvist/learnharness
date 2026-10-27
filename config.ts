import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/**
 * MULTI-USER PROFILES (2026-10-27): the data dir is the INSTALL root. It
 * holds the profile registry and host settings; each profile's learner
 * records live under users/<id>/. Keys (AUTH_FILE) stay household-wide.
 * Until users.json exists the install is unclaimed and learner paths
 * resolve to the root itself — the pre-profiles layout, which the first
 * profile's claim moves into its folder.
 */
export const INSTALL = {
	root: DATA_ROOT,
	users: path.join(DATA_ROOT, "users.json"),
	host: path.join(DATA_ROOT, "host.json"),
	sessions: path.join(DATA_ROOT, "sessions.json"),
	userDirs: path.join(DATA_ROOT, "users"),
} as const;

/** The learner entries a profile owns — what the claim moves out of an
 *  unclaimed root into the first profile's folder. */
export const LEARNER_ENTRIES = ["chats", "graph", "jobs", "settings.json", "prompts", "debug"] as const;

const USER_ID = /^usr_[a-z0-9]+$/;

export function isUserId(value: unknown): value is string {
	return typeof value === "string" && USER_ID.test(value);
}

/** One profile's learner folder. */
export function userDataDir(userId: string): string {
	if (!isUserId(userId)) throw new Error(`Invalid user id: ${userId}`);
	return path.join(INSTALL.userDirs, userId);
}

/** The active profile rides the async context of the request (and of
 *  every turn, job, and extraction it spawns — continuations inherit it).
 *  globalThis for the turn-liveness reason: Next dev compiles each route
 *  as its own module instance, and they must share one storage. */
function activeUser(): AsyncLocalStorage<string> {
	const g = globalThis as typeof globalThis & { __lhActiveUser?: AsyncLocalStorage<string> };
	return (g.__lhActiveUser ??= new AsyncLocalStorage<string>());
}

export function runAsUser<T>(userId: string, fn: () => T): T {
	if (!isUserId(userId)) throw new Error(`Invalid user id: ${userId}`);
	return activeUser().run(userId, fn);
}

export function activeUserId(): string | undefined {
	return activeUser().getStore();
}

export class NoActiveUserError extends Error {
	constructor() {
		super("No active user: learner data needs a signed-in profile.");
		this.name = "NoActiveUserError";
	}
}

/** Where the active profile's learner records live. A claimed install
 *  with no active profile refuses — reading another profile's data (or
 *  the stale root) is never a fallback. */
export function learnerRoot(): string {
	const id = activeUserId();
	if (id) return userDataDir(id);
	if (fs.existsSync(INSTALL.users)) throw new NoActiveUserError();
	return DATA_ROOT;
}

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	/** The active profile's learner folder (learnerRoot above). */
	get data(): string {
		return learnerRoot();
	},
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	get chats(): string {
		return path.join(learnerRoot(), "chats");
	},
	get graph(): string {
		return path.join(learnerRoot(), "graph");
	},
	/** Debug artifacts (env-gated): debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	get debug(): string {
		return path.join(learnerRoot(), "debug");
	},
};

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
export const LEDGER_FILES = {
	get nodes(): string {
		return path.join(PATHS.graph, "nodes.jsonl");
	},
	get chains(): string {
		return path.join(PATHS.graph, "chains.jsonl");
	},
	get sessions(): string {
		return path.join(PATHS.graph, "sessions.jsonl");
	},
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	get coverage(): string {
		return path.join(PATHS.graph, "coverage.jsonl");
	},
};

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
	return path.join(learnerRoot(), "settings.json");
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
	return path.join(learnerRoot(), "prompts");
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
