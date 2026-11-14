export const EXTERNAL_CLI_PROVIDERS = {
	claudeCode: "claude-code",
	codex: "codex",
	geminiCli: "gemini-cli",
} as const;

export type ExternalCliProvider = (typeof EXTERNAL_CLI_PROVIDERS)[keyof typeof EXTERNAL_CLI_PROVIDERS];

const EXTERNAL_CLI_PROVIDER_IDS = new Set<string>(Object.values(EXTERNAL_CLI_PROVIDERS));

/** Membership check for external CLI provider identifiers. */
export function isExternalCliProvider(id: unknown): id is ExternalCliProvider {
	return typeof id === "string" && EXTERNAL_CLI_PROVIDER_IDS.has(id);
}

export const EXTERNAL_CLI_STATUS_STATES = {
	notFound: "not-found",
	meetsMinimum: "meets-minimum",
	updateRequired: "update-required",
	versionUnchecked: "version-unchecked",
	/** Gemini CLI's bundle is installed but `node`, which starts it, is not on PATH. */
	nodeMissing: "node-missing",
} as const;

/** Shown for the `node-missing` state and as the turn's error when Gemini CLI cannot be started. */
export const GEMINI_NODE_MISSING_MESSAGE = "Gemini CLI was found but Node.js was not found on PATH.";

export type ExternalCliStatusState =
	(typeof EXTERNAL_CLI_STATUS_STATES)[keyof typeof EXTERNAL_CLI_STATUS_STATES];

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface ExternalCliStatus {
	state: ExternalCliStatusState;
	version: string | null;
	minimumVersion: string;
}

export const EXTERNAL_CLI_LABELS: Record<ExternalCliProvider, string> = {
	[EXTERNAL_CLI_PROVIDERS.claudeCode]: "Claude Code",
	[EXTERNAL_CLI_PROVIDERS.codex]: "Codex",
	[EXTERNAL_CLI_PROVIDERS.geminiCli]: "Gemini CLI",
};
