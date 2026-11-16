import { EXTERNAL_CLI_PROVIDERS, type ExternalCliStatus } from "./external-cli.ts";

export const CLAUDE_CODE_PROVIDER: string = EXTERNAL_CLI_PROVIDERS.claudeCode;

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export type ClaudeCodeStatus = ExternalCliStatus;

// --permission-prompts none was added in 2.1.259. This is not an official
// minimum-version/stability contract for claudecode/toolUseId; admission fails closed.
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.259";
