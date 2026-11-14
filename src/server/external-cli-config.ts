import { getClaudeBinary, getCliBinary } from "../agent/claude-code/binary.ts";
import { codexBinarySpec } from "../agent/codex/stream.ts";
import { findGeminiBinary } from "../agent/gemini-cli/binary.ts";
import { EXTERNAL_CLI_PROVIDERS, type ExternalCliProvider } from "../core/contracts/external-cli.ts";
import type { UserSettings } from "../core/settings.ts";
import { settingsStore } from "../store/settings.ts";

type ExternalCliEntry = {
	settingsKey: keyof UserSettings;
	findBinary: () => string | null;
};

const EXTERNAL_CLI_CONFIGS: Partial<Record<ExternalCliProvider, ExternalCliEntry>> = {
	[EXTERNAL_CLI_PROVIDERS.claudeCode]: {
		settingsKey: "claudeCode",
		findBinary: getClaudeBinary,
	},
	[EXTERNAL_CLI_PROVIDERS.codex]: {
		settingsKey: "codex",
		findBinary: () => getCliBinary(codexBinarySpec),
	},
	[EXTERNAL_CLI_PROVIDERS.geminiCli]: {
		settingsKey: "geminiCli",
		findBinary: findGeminiBinary,
	},
};

function readEnabledFlag(settings: UserSettings | null, key: keyof UserSettings): boolean {
	const section = settings?.[key];
	return section !== null && typeof section === "object" && !Array.isArray(section)
		&& (section as { enabled?: unknown }).enabled === true;
}

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new admissions consult it. */
export function externalCliEnabled(provider: ExternalCliProvider): boolean {
	const entry = EXTERNAL_CLI_CONFIGS[provider];
	if (!entry) return false;
	return readEnabledFlag(settingsStore.readSettings(), entry.settingsKey);
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function externalCliAvailable(provider: ExternalCliProvider): boolean {
	const entry = EXTERNAL_CLI_CONFIGS[provider];
	if (!entry) return false;
	return readEnabledFlag(settingsStore.readSettings(), entry.settingsKey) && entry.findBinary() !== null;
}
