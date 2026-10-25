import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const ACP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** A non-secret snapshot of choices advertised by the installed adapter. */
export interface AcpModelInfo {
	id: string;
	name: string;
	/** Absent for the legacy agent-default entry. Native IDs are opaque. */
	modelId?: string;
	reasoning: Partial<Record<ThinkingLevel, string>>;
}

/** Subscription agents are local processes; their credentials stay with the CLI. */
export const ACP_AGENTS = [
	{ id: "codex", provider: "acp-codex", label: "Codex", command: "codex-acp", package: "@agentclientprotocol/codex-acp", cliPackage: "@openai/codex", login: "codex login" },
	{ id: "claude", provider: "acp-claude", label: "Claude Code", command: "claude-agent-acp", package: "@agentclientprotocol/claude-agent-acp", cliPackage: "@anthropic-ai/claude-code", login: "claude auth login" },
] as const;

export type AcpAgentId = (typeof ACP_AGENTS)[number]["id"];
export interface AcpConnectionConfig {
	enabled?: boolean;
	/** Trusted host launch settings. HTTP connection writes cannot set these;
	 * legacy copies in user settings are ignored by server composition. */
	command?: string;
	args?: string[];
	/** Refreshed on Connect; actual choices are checked again before inference. */
	models?: AcpModelInfo[];
}
export type AcpSettings = Partial<Record<AcpAgentId, AcpConnectionConfig>>;

export function acpAgentForProvider(provider: string) {
	return ACP_AGENTS.find((agent) => agent.provider === provider);
}

/** Validate trusted host configuration and sanitize legacy disk records. */
export function parseAcpConfig(value: unknown):
	| { ok: true; config: AcpConnectionConfig }
	| { ok: false; error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Connection must be an object" };
	const raw = value as Record<string, unknown>;
	const config: AcpConnectionConfig = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		config.enabled = raw.enabled;
	}
	if (raw.command !== undefined) {
		if (typeof raw.command !== "string" || !raw.command.trim() || /[\r\n\0]/.test(raw.command)) {
			return { ok: false, error: "command must be a nonempty executable path or name" };
		}
		config.command = raw.command.trim();
	}
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
			return { ok: false, error: "args must be an array of strings" };
		}
		config.args = [...raw.args];
	}
	if (Array.isArray(raw.models)) {
		config.models = raw.models.flatMap((item): AcpModelInfo[] => {
			if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string"
				|| !(item.id === "default" || (typeof item.modelId === "string" && item.id === `model/${item.modelId}`))) return [];
			const reasoning: AcpModelInfo["reasoning"] = {};
			for (const level of ACP_THINKING_LEVELS) {
				if (typeof item.reasoning?.[level] === "string") reasoning[level] = item.reasoning[level];
			}
			return [{ id: item.id, name: item.name, ...(item.id !== "default" ? { modelId: item.modelId } : {}), reasoning }];
		});
	}
	return { ok: true, config };
}

export interface AcpConnectionStatus {
	id: AcpAgentId;
	config: AcpConnectionConfig;
}
