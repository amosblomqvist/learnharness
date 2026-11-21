export const CLAUDE_CODE_PROVIDER = "claude-code";
/** Human label for the Claude Code provider in model menus and refusals. */
export const CLAUDE_CODE_LABEL = "Claude Code";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface ClaudeCodeStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

// --permission-prompts none was added in 2.1.259. This is not an official
// minimum-version/stability contract for claudecode/toolUseId; admission fails closed.
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.259";
