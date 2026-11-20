import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOrdinary, inspectDataLocation, verifyStore } from "./electron/data-location.cjs";
import { assertDataWritesAdmitted, configureDataWriteAccess } from "./src/store/data-write-gate.ts";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Mutable learning records live under PATHS.data. The machine-local location
 * pointer (LH_DATA_CONFIG_FILE or <ROOT>/data-location.json) can select a
 * custom folder. Packaged Electron resolves the location before the server
 * starts and supplies its userData/data default via LH_DEFAULT_DATA_DIR.
 *
 * LH_DATA_DIR alone pins the folder for the session when LH_DATA_CONFIG_FILE
 * is unset. Otherwise the fallback resolves in this order: LH_DEFAULT_DATA_DIR,
 * LH_DATA_DIR, then <ROOT>/data.
 *
 * Bundled prompts stay under ROOT. Provider keys and subscription credentials
 * stay in their local credential stores.
 */
export const DEFAULT_DATA_ROOT = process.env.LH_DEFAULT_DATA_DIR
	? path.resolve(/* turbopackIgnore: true */ process.env.LH_DEFAULT_DATA_DIR)
	: process.env.LH_DATA_DIR
		? path.resolve(/* turbopackIgnore: true */ process.env.LH_DATA_DIR)
		: path.join(/* turbopackIgnore: true */ ROOT, "data");

export const DATA_CONFIG_FILE = process.env.LH_DATA_CONFIG_FILE
	? path.resolve(/* turbopackIgnore: true */ process.env.LH_DATA_CONFIG_FILE)
	: path.join(/* turbopackIgnore: true */ ROOT, "data-location.json");

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — stays on the local machine (`userData/auth.json`
 * or `<ROOT>/auth.json`), never relocated with the learning data directory.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(/* turbopackIgnore: true */ process.env.LH_AUTH_FILE)
	: path.join(/* turbopackIgnore: true */ ROOT, "auth.json");

export const DATA_DIR_FIXED = Boolean(process.env.LH_DATA_DIR && !process.env.LH_DATA_CONFIG_FILE);

/** The packaged shell and server protect the same installation resources. */
export const DATA_APP_ROOT = process.env.LH_DESKTOP_SERVER === "1" && process.env.LH_DATA_APP_ROOT
	? path.resolve(/* turbopackIgnore: true */ process.env.LH_DATA_APP_ROOT)
	: ROOT;

function resolveInitialDataLocation() {
	const desktopLocation = process.env.LH_DESKTOP_SERVER === "1" && process.env.LH_STARTUP_DATA_LOCATION;
	if (desktopLocation) return JSON.parse(desktopLocation) as Omit<DataLocationGlobalState, "listeners">;
	return inspectDataLocation({
		configFile: DATA_DIR_FIXED ? null : DATA_CONFIG_FILE,
		defaultDir: DATA_DIR_FIXED ? process.env.LH_DATA_DIR! : DEFAULT_DATA_ROOT, appRoot: DATA_APP_ROOT, authFile: AUTH_FILE,
	});
}

interface DataLocationGlobalState {
	currentDir: string;
	defaultDir: string;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
	storeId: string | null;
	recoveryReason: string | null;
	listeners: Set<(root: string) => void>;
}

function locationState(): DataLocationGlobalState {
	const g = globalThis as typeof globalThis & { __lhDataLocation?: DataLocationGlobalState };
	if (!g.__lhDataLocation) {
		const initial = resolveInitialDataLocation();
		g.__lhDataLocation = {
			...initial,
			listeners: new Set(),
		};
	}
	return g.__lhDataLocation;
}

const TEACHER_PROMPT = path.join(ROOT, "src", "agent", "system-prompt.md");

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: TEACHER_PROMPT,
	get data(): string {
		return locationState().currentDir;
	},
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	get chats(): string {
		return path.join(/* turbopackIgnore: true */ locationState().currentDir, "chats");
	},
	get graph(): string {
		return path.join(/* turbopackIgnore: true */ locationState().currentDir, "graph");
	},
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	get debug(): string {
		return path.join(/* turbopackIgnore: true */ locationState().currentDir, "debug");
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
	| "auditor"
	| "sideQuestion";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	get nodes(): string {
		return path.join(/* turbopackIgnore: true */ PATHS.graph, "nodes.jsonl");
	},
	get chains(): string {
		return path.join(/* turbopackIgnore: true */ PATHS.graph, "chains.jsonl");
	},
	get sessions(): string {
		return path.join(/* turbopackIgnore: true */ PATHS.graph, "sessions.jsonl");
	},
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	get coverage(): string {
		return path.join(/* turbopackIgnore: true */ PATHS.graph, "coverage.jsonl");
	},
};

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export let SOURCES_FILE = path.join(/* turbopackIgnore: true */ PATHS.graph, "sources.json");
/** Presentation-only source names/folder placement; never extraction identity. */
export let SOURCE_ORGANIZATION_FILE = path.join(/* turbopackIgnore: true */ PATHS.graph, "source-organization.json");
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export let POSITIONS_FILE = path.join(/* turbopackIgnore: true */ PATHS.graph, "positions.json");

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export let RENDER_SETTINGS_FILE = path.join(/* turbopackIgnore: true */ PATHS.graph, "render-settings.json");

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export let GRAPH_FORMAT_FILE = path.join(/* turbopackIgnore: true */ PATHS.graph, "format.json");

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent, appearance, graph.
 */
export let SETTINGS_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "settings.json");

/**
 * User prompt-override files (settings-storage wave, 2026-09-19).
 */
export let PROMPTS_OVERRIDE_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "prompts");

/**
 * Imported custom themes (theme wave, 2026-11-04).
 */
export let THEMES_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "themes");

function syncBindings(root: string): void {
	const graphDir = path.join(/* turbopackIgnore: true */ root, "graph");
	SOURCES_FILE = path.join(/* turbopackIgnore: true */ graphDir, "sources.json");
	SOURCE_ORGANIZATION_FILE = path.join(/* turbopackIgnore: true */ graphDir, "source-organization.json");
	POSITIONS_FILE = path.join(/* turbopackIgnore: true */ graphDir, "positions.json");
	RENDER_SETTINGS_FILE = path.join(/* turbopackIgnore: true */ graphDir, "render-settings.json");
	GRAPH_FORMAT_FILE = path.join(/* turbopackIgnore: true */ graphDir, "format.json");
	SETTINGS_FILE = path.join(/* turbopackIgnore: true */ root, "settings.json");
	PROMPTS_OVERRIDE_DIR = path.join(/* turbopackIgnore: true */ root, "prompts");
	THEMES_DIR = path.join(/* turbopackIgnore: true */ root, "themes");
}

locationState().listeners.add(syncBindings);
syncBindings(locationState().currentDir);

export function getDataLocationState(): {
	currentDir: string;
	defaultDir: string;
	isCustom: boolean;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
	recoveryReason: string | null;
	fixed: boolean;
} {
	const s = locationState();
	const storeError = checkActiveStore(s);
	return {
		currentDir: s.currentDir,
		defaultDir: s.defaultDir,
		isCustom: s.currentDir !== s.defaultDir,
		configuredDir: s.configuredDir,
		unavailableConfiguredDir: storeError ? s.configuredDir : s.unavailableConfiguredDir,
		recoveryReason: storeError?.message ?? s.recoveryReason,
		fixed: DATA_DIR_FIXED,
	};
}

export function setActiveDataDir(
	nextDir: string,
	options?: {
		defaultDir?: string;
		configuredDir?: string | null;
		unavailableConfiguredDir?: string | null;
		storeId?: string | null;
	},
): void {
	const s = locationState();
	const resolved = path.resolve(/* turbopackIgnore: true */ nextDir);
	if (options?.defaultDir !== undefined) {
		s.defaultDir = path.resolve(/* turbopackIgnore: true */ options.defaultDir);
	}
	s.currentDir = resolved;
	if (options && "configuredDir" in options) {
		s.configuredDir = options.configuredDir ? path.resolve(/* turbopackIgnore: true */ options.configuredDir) : null;
	} else {
		s.configuredDir = resolved === s.defaultDir ? null : resolved;
	}
	if (options && "unavailableConfiguredDir" in options) {
		s.unavailableConfiguredDir = options.unavailableConfiguredDir
			? path.resolve(/* turbopackIgnore: true */ options.unavailableConfiguredDir)
			: null;
	} else {
		s.unavailableConfiguredDir = null;
	}
	s.storeId = options?.storeId ?? null;
	s.recoveryReason = null;
	for (const listener of [...s.listeners]) listener(resolved);
}

export function activeStoreId(): string | null {
	return locationState().storeId;
}

/** Runtime identity errors belong to the current check. Startup validation
 * failures still require the full recovery flow. */
function checkActiveStore(s: DataLocationGlobalState): Error | null {
	if (!s.configuredDir || s.unavailableConfiguredDir) return null;
	let failure: Error | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			verifyStore(s.currentDir, s.storeId);
			return null;
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}
	}
	return failure;
}

/** Guard every mutable-store write, including writes to captured plugin paths. */
export function assertDataStoreWritable(file?: string): void {
	const s = locationState();
	const relative = file === undefined ? "" : path.relative(s.currentDir, file);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
	assertDataWritesAdmitted();
	const storeError = checkActiveStore(s);
	if (storeError) throw storeError;
	if (s.unavailableConfiguredDir) {
		throw new Error(s.recoveryReason ?? `The configured data folder "${s.unavailableConfiguredDir}" is unavailable.`);
	}
	let current = s.currentDir;
	for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
		current = path.join(/* turbopackIgnore: true */ current, segment);
		const stat = fs.lstatSync(/* turbopackIgnore: true */ current, { throwIfNoEntry: false });
		if (stat) assertOrdinary(stat, current);
	}
}

/** Configured roots are never candidates for mkdir, even if a drive goes away
 * between the identity check and the filesystem operation. */
export function mkdirDataDirectory(directory: string, mode?: number): void {
	assertDataStoreWritable(directory);
	const s = locationState();
	const relative = path.relative(s.currentDir, directory);
	if (!s.configuredDir || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode });
		return;
	}
	let current = s.currentDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(/* turbopackIgnore: true */ current, segment);
		try {
			fs.mkdirSync(/* turbopackIgnore: true */ current, { mode });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = fs.lstatSync(/* turbopackIgnore: true */ current);
			assertOrdinary(stat, current);
			if (!stat.isDirectory()) throw error;
		}
	}
}

/** Subscribe to active data-directory changes across the server process. */
export function onDataDirChange(listener: (root: string) => void): () => void {
	const s = locationState();
	s.listeners.add(listener);
	return () => s.listeners.delete(listener);
}

configureDataWriteAccess({ verify: assertDataStoreWritable, mkdir: mkdirDataDirectory });
