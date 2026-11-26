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

export type ClaudeCodeProfileFs = Pick<typeof nodeFs, "readdirSync" | "statSync" | "realpathSync"> &
	Partial<Pick<typeof nodeFs, "readFileSync">>;

const MAX_METADATA_FILE_BYTES = 1024 * 1024;
const MAX_METADATA_VALUE_LENGTH = 256;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMetadataString(value: unknown, maxLength = MAX_METADATA_VALUE_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!cleaned) return undefined;
	const bounded = cleaned.slice(0, maxLength).trim();
	return bounded || undefined;
}

function readSafeJsonObject(filePath: string, fsOps: ClaudeCodeProfileFs): Record<string, unknown> | null {
	if (typeof fsOps.readFileSync !== "function") return null;
	try {
		const stat = fsOps.statSync(/* turbopackIgnore: true */ filePath);
		if (!stat.isFile()) return null;
		if (typeof stat.size === "number" && (stat.size <= 0 || stat.size > MAX_METADATA_FILE_BYTES)) {
			return null;
		}
		const raw = fsOps.readFileSync(/* turbopackIgnore: true */ filePath, "utf8");
		if (typeof raw !== "string") return null;
		if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_FILE_BYTES) return null;
		const parsed: unknown = JSON.parse(raw);
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function extractClaudeJsonAccountMeta(
	candidatePaths: readonly string[],
	fsOps: ClaudeCodeProfileFs,
): { email?: string; subscriptionPlan?: string } {
	let email: string | undefined;
	let subscriptionPlan: string | undefined;

	for (const candidatePath of candidatePaths) {
		const parsed = readSafeJsonObject(candidatePath, fsOps);
		if (!parsed) continue;
		const oauthAccount = isPlainObject(parsed.oauthAccount) ? parsed.oauthAccount : null;
		if (oauthAccount) {
			if (!email) {
				email = sanitizeMetadataString(oauthAccount.emailAddress);
			}
			if (!subscriptionPlan && oauthAccount.billingType === "stripe_subscription") {
				subscriptionPlan = "Subscription";
			}
		}
		if (email && subscriptionPlan) break;
	}

	return {
		...(email ? { email } : {}),
		...(subscriptionPlan ? { subscriptionPlan } : {}),
	};
}

/** Non-secret discovery of Claude Code config directories; inspects filesystem
 *  stat metadata and allowlisted non-secret account display metadata from
 *  `.claude.json` only. Never reads `.credentials.json` or exposes tokens/secrets. */
export function discoverClaudeCodeProfiles(
	options: DiscoverClaudeCodeProfilesOptions = {},
): ClaudeCodeProfilesResponse {
	const fsOps: ClaudeCodeProfileFs = options.fs ?? nodeFs;
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
		const claudeJsonPaths = resolved === resolvedDefault
			? [
					path.join(/* turbopackIgnore: true */ resolved, ".claude.json"),
					path.join(/* turbopackIgnore: true */ resolvedHome, ".claude.json"),
				]
			: [path.join(/* turbopackIgnore: true */ resolved, ".claude.json")];
		const accountMeta = extractClaudeJsonAccountMeta(claudeJsonPaths, fsOps);
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
			...accountMeta,
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
