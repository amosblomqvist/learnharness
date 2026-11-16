import { getClaudeBinary, getCliBinary } from "../agent/claude-code/binary.ts";
import { refreshCodexModels } from "../agent/codex/provider.ts";
import { codexBinarySpec } from "../agent/codex/stream.ts";
import { syncExternalCliProvider } from "../agent/models.ts";
import { findGeminiBinary } from "../agent/gemini-cli/binary.ts";
import { EXTERNAL_CLI_PROVIDERS, type ExternalCliProvider } from "../core/contracts/external-cli.ts";
import type { UserSettings } from "../core/settings.ts";
import { settingsStore } from "../store/settings.ts";

type ExternalCliEntry = {
	settingsKey: keyof UserSettings;
	findBinary: () => string | null;
	/** For a CLI that lists its models at run time: fetches the list. A failed fetch keeps the last list. */
	refreshModels?: () => Promise<void>;
};

const EXTERNAL_CLI_CONFIGS: Partial<Record<ExternalCliProvider, ExternalCliEntry>> = {
	[EXTERNAL_CLI_PROVIDERS.claudeCode]: {
		settingsKey: "claudeCode",
		findBinary: getClaudeBinary,
	},
	[EXTERNAL_CLI_PROVIDERS.codex]: {
		settingsKey: "codex",
		findBinary: () => getCliBinary(codexBinarySpec),
		refreshModels: refreshCodexModels,
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

/**
 * Refreshes the model lists of the enabled, installed CLIs that list models at run time, then rebuilds their providers.
 * `providers` limits it to those ids; ids that are not such CLIs are ignored.
 */
export async function refreshExternalCliCatalogs(providers?: Iterable<string | undefined>): Promise<void> {
	const wanted = providers === undefined ? undefined : new Set(providers);
	const entries = Object.entries(EXTERNAL_CLI_CONFIGS) as [ExternalCliProvider, ExternalCliEntry][];
	await Promise.all(entries
		.filter(([provider, entry]) => entry.refreshModels && (!wanted || wanted.has(provider)) && externalCliAvailable(provider))
		.map(([provider, entry]) => entry.refreshModels!().then(() => syncExternalCliProvider(provider))));
}
