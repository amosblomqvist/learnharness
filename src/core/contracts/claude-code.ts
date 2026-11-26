export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface ClaudeCodeStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

// --permission-prompts none was added in 2.1.259. This is not an official
// minimum-version/stability contract for claudecode/toolUseId; admission fails closed.
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.259";

export interface ClaudeCodeSettings {
	enabled?: boolean;
	configDir?: string;
}

export type ClaudeCodeProfileSource = "default" | "env" | "discovered" | "configured";

/** Non-secret metadata only; never carries credentials, tokens, or file contents. */
export interface ClaudeCodeProfile {
	path: string;
	displayPath: string;
	label: string;
	source: ClaudeCodeProfileSource;
	exists: boolean;
	hasSettings: boolean;
	hasCredentials: boolean;
}

export interface ClaudeCodeProfilesResponse {
	profiles: ClaudeCodeProfile[];
	configuredDir: string | null;
	inheritedEnvDir: string | null;
	effectiveDir: string | null;
	defaultDir: string;
}

/** Browser-safe portable syntax check for CLAUDE_CONFIG_DIR.
 *  Accepts `~`, `~/...`, POSIX `/...`, Windows `X:\...` / `X:/...`, and UNC `\\server\share...`.
 *  Rejects empty/whitespace/untrimmed strings, NUL bytes, relative paths, `~user`, and `.`/`..` segments. */
export function isValidClaudeConfigDir(value: string): boolean {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
		return false;
	}
	const isHome = value === "~" || value.startsWith("~/");
	const isPosixAbsolute = value.startsWith("/");
	const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(value);
	const isWindowsUnc = /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
	if (!isHome && !isPosixAbsolute && !isWindowsDrive && !isWindowsUnc) {
		return false;
	}
	const segments = value.split(/[\\/]+/);
	return !segments.some((segment) => segment === "." || segment === "..");
}
