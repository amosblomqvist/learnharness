/**
 * The child environment for the user's Claude Code (Local Claude route,
 * docs/architecture.md §8.1). The Agent SDK's `env` option REPLACES the
 * child's environment wholesale (verified in sdk.mjs: `{...options.env}`),
 * so this is an ALLOWLIST, never a copy of process.env with deletions:
 *
 *   - the server process holds every saved provider key reflected into
 *     process.env (keys.ts initAuthEnv — ANTHROPIC_API_KEY included), the
 *     desktop capability secret (LH_DESKTOP_API_SECRET) and whatever the
 *     user's shell exported. None of it may reach the child: an
 *     ANTHROPIC_API_KEY there would silently bill the API instead of the
 *     user's plan, and a forwarded CLAUDE_CODE_OAUTH_TOKEN would make the
 *     app an intermediary of a Claude credential. Claude Code reads its own
 *     login from its own config dir (HOME / CLAUDE_CONFIG_DIR), which is
 *     exactly what passes.
 *   - the fixed additions keep the child a plain inference engine for ONE
 *     turn: no auto-compaction (the app owns context), no claude.ai MCP
 *     servers, no auto memory, no non-essential traffic.
 */

/** Exact names that pass through. */
const PASS_NAMES = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "TERM", "TZ",
	"CLAUDE_CONFIG_DIR",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	// Windows process plumbing (spawn and TLS need these; none carry secrets).
	"SystemRoot", "SYSTEMROOT", "SystemDrive", "ComSpec", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
	"HOMEDRIVE", "HOMEPATH", "ProgramData", "PROGRAMDATA", "ProgramFiles", "PROGRAMFILES", "WINDIR", "windir", "USERNAME",
]);
/** Windows env names are case-insensitive and Node reports them as the
 *  system spells them (commonly `Path`, not `PATH`): on win32 the
 *  allowlist matches ignoring case and keeps the name as given. */
const PASS_NAMES_UPPER = new Set([...PASS_NAMES].map((name) => name.toUpperCase()));
/** Prefixes that pass through (locale and XDG base dirs). */
const PASS_PREFIXES = ["LC_", "XDG_"];
/** Names that NEVER pass, whatever the allowlist says (belt and braces). */
const DENY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^LH_|^ANTHROPIC_|^CLAUDE_CODE_OAUTH/i;

/** The fixed controls every child gets. */
export const CLAUDE_CHILD_CONTROLS: Readonly<Record<string, string>> = Object.freeze({
	DISABLE_AUTO_COMPACT: "1",
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

export function claudeChildEnvAllows(name: string, platform: NodeJS.Platform = process.platform): boolean {
	if (DENY.test(name)) return false;
	if (platform === "win32") return PASS_NAMES_UPPER.has(name.toUpperCase()) || PASS_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix));
	return PASS_NAMES.has(name) || PASS_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Build the child's environment from the allowlist plus the controls.
 *  `extra` (e.g. ELECTRON_RUN_AS_NODE for a cli.js launch through the
 *  packaged app's own binary) is applied last and also filtered. */
export function claudeChildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (typeof value !== "string" || !claudeChildEnvAllows(name, platform)) continue;
		out[name] = value;
	}
	Object.assign(out, CLAUDE_CHILD_CONTROLS);
	for (const [name, value] of Object.entries(extra)) {
		if (DENY.test(name)) continue;
		out[name] = value;
	}
	return out;
}
