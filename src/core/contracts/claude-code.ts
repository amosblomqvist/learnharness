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

/** "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5".
 * Null when the ID does not follow the canonical Claude naming, so callers
 * fall back to the alias instead of inventing a version. */
export function claudeModelVersionLabel(resolvedModel: string): string | null {
	const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(resolvedModel);
	if (!match) return null;
	const [, family, major, minor] = match;
	return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}
