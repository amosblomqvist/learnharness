import os from "node:os";
import path from "node:path";
import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { isValidClaudeConfigDir } from "../core/contracts/claude-code.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function claudeCodeEnabled(): boolean {
	return settingsStore.readSettings()?.claudeCode?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function claudeCodeAvailable(): boolean {
	return claudeCodeEnabled() && getClaudeBinary() !== null;
}

export function expandClaudeConfigDir(configDir: string, home: string = os.homedir()): string {
	const trimmed = configDir.trim();
	if (!isValidClaudeConfigDir(trimmed)) {
		throw new Error("Invalid Claude Code config directory");
	}
	if (trimmed === "~") return path.resolve(home);
	if (trimmed.startsWith("~/")) return path.resolve(home, trimmed.slice(2));
	if (!path.isAbsolute(trimmed)) {
		throw new Error("Invalid Claude Code config directory for this server filesystem");
	}
	return path.resolve(trimmed);
}

export function configuredClaudeConfigDir(home: string = os.homedir()): string | undefined {
	const raw = settingsStore.readSettings()?.claudeCode?.configDir;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	try {
		return expandClaudeConfigDir(trimmed, home);
	} catch {
		return undefined;
	}
}

/** Returns the configured CLAUDE_CONFIG_DIR for child process launch.
 *  Expands ~ / ~/ against `home` and preserves non-OS-absolute values so
 *  the launcher fails explicitly rather than falling back to ~/.claude. */
export function effectiveClaudeConfigDir(home: string = os.homedir()): string | undefined {
	const raw = settingsStore.readSettings()?.claudeCode?.configDir;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed === "~") return path.resolve(home);
	if (trimmed.startsWith("~/")) return path.resolve(home, trimmed.slice(2));
	return path.isAbsolute(trimmed) ? path.resolve(trimmed) : trimmed;
}
