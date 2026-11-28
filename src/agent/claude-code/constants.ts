import { tr } from "../../core/i18n.ts";
export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export const ClaudeCodeError = {
	CliNotFound: tr("未找到 claude CLI", "claude CLI not found"),
	NotSignedIn: tr("未登录 Claude Code", "not signed in"),
} as const;
