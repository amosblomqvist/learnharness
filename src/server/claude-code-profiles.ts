import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { externalCliEnv } from "../core/auth-env.ts";
import type {
	ClaudeCodeProfile,
	ClaudeCodeProfilesResponse,
	ClaudeCodeProfileSource,
} from "../core/contracts/claude-code.ts";
import { expandClaudeConfigDir } from "./claude-code-config.ts";

export type ClaudeCodeProfileFs = Pick<typeof nodeFs, "readdirSync" | "statSync" | "realpathSync">;

export interface DiscoverClaudeCodeProfilesOptions {
	homeDir?: string;
	env?: Record<string, string | undefined>;
	configuredDir?: string | null;
	fs?: ClaudeCodeProfileFs;
}

function isDirectoryTarget(target: string, fsOps: Pick<ClaudeCodeProfileFs, "statSync">): boolean {
	try {
		return fsOps.statSync(/* turbopackIgnore: true */ target).isDirectory();
	} catch {
		return false;
	}
}

function isRegularFile(target: string, fsOps: Pick<ClaudeCodeProfileFs, "statSync">): boolean {
	try {
		return fsOps.statSync(/* turbopackIgnore: true */ target).isFile();
	} catch {
		return false;
	}
}

function canonicalKey(target: string, fsOps: Pick<ClaudeCodeProfileFs, "realpathSync">): string {
	try {
		return fsOps.realpathSync(/* turbopackIgnore: true */ target);
	} catch {
		return path.resolve(target);
	}
}

function formatDisplayPath(resolved: string, resolvedHome: string): string {
	if (resolved === resolvedHome) return "~";
	const rel = path.relative(resolvedHome, resolved);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		return `~/${rel.split(path.sep).join("/")}`;
	}
	return resolved;
}

function resolveInheritedEnvDir(env: Record<string, string | undefined>, resolvedHome: string): string | null {
	const raw = externalCliEnv(env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.includes("\0")) return null;
	if (trimmed === "~") return resolvedHome;
	if (trimmed.startsWith("~/")) return path.resolve(resolvedHome, trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
	return null;
}

/** Non-secret discovery of Claude Code config directories; inspects filesystem
 *  stat metadata only and never reads `.credentials.json` or `.claude.json`. */
export function discoverClaudeCodeProfiles(
	options: DiscoverClaudeCodeProfilesOptions = {},
): ClaudeCodeProfilesResponse {
	const fsOps = options.fs ?? nodeFs;
	const resolvedHome = path.resolve(/* turbopackIgnore: true */ options.homeDir ?? os.homedir());
	const defaultDir = path.join(/* turbopackIgnore: true */ resolvedHome, ".claude");
	const resolvedDefault = path.resolve(/* turbopackIgnore: true */ defaultDir);

	let expandedConfigured: string | null = null;
	if (typeof options.configuredDir === "string" && options.configuredDir.trim().length > 0) {
		try {
			expandedConfigured = expandClaudeConfigDir(options.configuredDir, resolvedHome);
		} catch {
			expandedConfigured = null;
		}
	}

	const inheritedEnvDir = resolveInheritedEnvDir(options.env ?? process.env, resolvedHome);
	const effectiveDir = expandedConfigured ?? inheritedEnvDir ?? null;

	const seenCanonical = new Set<string>();
	const profiles: ClaudeCodeProfile[] = [];

	const addCandidate = (candidatePath: string, source: ClaudeCodeProfileSource) => {
		const resolved = path.resolve(/* turbopackIgnore: true */ candidatePath);
		const key = canonicalKey(resolved, fsOps);
		if (seenCanonical.has(key)) return;
		seenCanonical.add(key);

		const exists = isDirectoryTarget(resolved, fsOps);
		const hasSettings = exists && isRegularFile(path.join(/* turbopackIgnore: true */ resolved, "settings.json"), fsOps);
		const hasCredentials = exists && isRegularFile(path.join(/* turbopackIgnore: true */ resolved, ".credentials.json"), fsOps);
		const label = source === "default" || resolved === resolvedDefault
			? "Default (.claude)"
			: path.basename(resolved) || resolved;

		profiles.push({
			path: resolved,
			displayPath: formatDisplayPath(resolved, resolvedHome),
			label,
			source,
			exists,
			hasSettings,
			hasCredentials,
		});
	};

	addCandidate(defaultDir, "default");
	if (expandedConfigured) addCandidate(expandedConfigured, "configured");
	if (inheritedEnvDir) addCandidate(inheritedEnvDir, "env");

	let entries: nodeFs.Dirent[] = [];
	try {
		entries = fsOps.readdirSync(/* turbopackIgnore: true */ resolvedHome, { withFileTypes: true });
	} catch {
		entries = [];
	}

	const discovered = entries
		.filter((entry) => entry.name.startsWith(".claude") && entry.name !== ".claude")
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of discovered) {
		const candidate = path.join(/* turbopackIgnore: true */ resolvedHome, entry.name);
		const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryTarget(candidate, fsOps));
		if (!isDir) continue;
		addCandidate(candidate, "discovered");
	}

	return {
		profiles,
		configuredDir: expandedConfigured,
		inheritedEnvDir,
		effectiveDir,
		defaultDir,
	};
}
