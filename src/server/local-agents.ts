/**
 * Local agent connections — the server composition (docs/architecture.md
 * §8.2). Plugs the preference store into the agent-layer state and serves
 * GET/POST /api/connections/local. Importing this module wires the store
 * (model-catalog.ts imports it, so every catalog/engine consumer is wired).
 */
import { LOCAL_AGENTS, type LocalAgentAction, type LocalAgentProviderId, type LocalAgentStatus } from "../core/contracts/local-agents.ts";
import { cancelLocalAgentSignIn, configureAppHeldEnvVars, configureLocalAgentPreferences, localAgentStatuses, refreshLocalAgents, setLocalAgentPreferences, signInLocalAgent } from "../agent/local-agents/index.ts";
import { authStore } from "../store/auth.ts";
import { localAgentPreferenceStore } from "../store/local-agents.ts";

configureLocalAgentPreferences(localAgentPreferenceStore);
// Saved keys are reflected into this process's env; vendor runtimes must not inherit them.
configureAppHeldEnvVars(() => Object.keys(authStore.authVars()));

export function isLocalAgentId(value: string): value is LocalAgentProviderId {
	return LOCAL_AGENTS.some((agent) => agent.providerId === value);
}

export async function localAgentConnections(force = false): Promise<LocalAgentStatus[]> {
	await refreshLocalAgents({ force });
	return localAgentStatuses();
}

/** Shape-gate a POST body; null = 400. */
export function parseLocalAgentAction(body: unknown): LocalAgentAction | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	switch (b.action) {
		case "refresh": case "signIn": case "cancelSignIn": return { action: b.action };
		case "enable":
			if (typeof b.enabled !== "boolean" || (b.allowBackgroundUse !== undefined && typeof b.allowBackgroundUse !== "boolean")) return null;
			return { action: "enable", enabled: b.enabled, ...(typeof b.allowBackgroundUse === "boolean" ? { allowBackgroundUse: b.allowBackgroundUse } : {}) };
		case "consent":
			return typeof b.allowBackgroundUse === "boolean" ? { action: "consent", allowBackgroundUse: b.allowBackgroundUse } : null;
		default: return null;
	}
}

export async function applyLocalAgentAction(providerId: LocalAgentProviderId, action: LocalAgentAction): Promise<LocalAgentStatus[]> {
	switch (action.action) {
		case "refresh":
			await refreshLocalAgents({ providerId, force: true });
			break;
		case "enable":
			setLocalAgentPreferences(providerId, { enabled: action.enabled, ...(action.allowBackgroundUse !== undefined ? { allowBackgroundUse: action.allowBackgroundUse } : {}) });
			await refreshLocalAgents({ providerId, force: true });
			break;
		case "consent":
			setLocalAgentPreferences(providerId, { allowBackgroundUse: action.allowBackgroundUse });
			break;
		case "signIn":
			// Runs in the vendor runtime for minutes; the client polls status.
			void signInLocalAgent(providerId).catch((error) => console.warn(`[local-agents] ${providerId} sign-in ended: ${error instanceof Error ? error.message : String(error)}`));
			break;
		case "cancelSignIn":
			cancelLocalAgentSignIn(providerId);
			break;
	}
	return localAgentStatuses();
}
