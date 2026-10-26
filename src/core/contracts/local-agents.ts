/**
 * Local agent connections (docs/architecture.md §8.2): LearnHarness drives a
 * vendor CLI the learner installed and signed into themselves. The CLI owns
 * every credential; the app never sees, stores, or refreshes a token. The
 * persisted provider ids are distinct routes — they never fall back to API
 * keys or to the app's own subscription connections.
 */
export type LocalAgentProviderId = "claude-code" | "antigravity";

export interface LocalAgentDescriptor {
	providerId: LocalAgentProviderId;
	/** Compact product label (also the usage/price label). */
	label: string;
	/** Who runs the model and whose plan limits apply. */
	vendor: string;
	/** The locally installed program LearnHarness drives. */
	runtime: string;
	/** Where to get the runtime. */
	installUrl: string;
	/** The terminal command that signs the runtime in, when sign-in is not app-driven. */
	signInCommand?: string;
}

export const LOCAL_AGENTS: readonly LocalAgentDescriptor[] = [
	{ providerId: "claude-code", label: "Claude", vendor: "Anthropic", runtime: "Claude Code", installUrl: "https://code.claude.com/docs/en/setup", signInCommand: "claude auth login" },
	{ providerId: "antigravity", label: "Antigravity", vendor: "Google", runtime: "Antigravity ACP server", installUrl: "https://antigravity.google/docs/ide/extensions" },
];

export function localAgentDescriptor(providerId: string | undefined): LocalAgentDescriptor | undefined {
	return LOCAL_AGENTS.find((agent) => agent.providerId === providerId);
}

/** The learner's per-connection choices — the only state LearnHarness persists. */
export interface LocalAgentPreferences {
	enabled: boolean;
	allowBackgroundUse: boolean;
}
export const DEFAULT_LOCAL_AGENT_PREFERENCES: LocalAgentPreferences = { enabled: false, allowBackgroundUse: true };

/** Projected, credential-free status (GET /api/connections/local). */
export interface LocalAgentStatus {
	providerId: LocalAgentProviderId;
	enabled: boolean;
	allowBackgroundUse: boolean;
	installed: boolean;
	version?: string;
	signedIn: boolean;
	/** Account e-mail when the runtime reports it. */
	account?: string;
	/** Plan label when the runtime reports it (e.g. "Max"). */
	plan?: string;
	/** False when the runtime is signed in some other way than a subscription. */
	usesSubscription?: boolean;
	/** An app-driven sign-in (Antigravity) is running. */
	pending: boolean;
	/** enabled && installed && signedIn && a model catalog is available. */
	connected: boolean;
	/** Bumps whenever the connection's identity changes; in-flight work bound to an older generation stops. */
	generation: number;
	error?: string;
	checkedAt: number;
}

export type LocalAgentAction =
	| { action: "refresh" }
	| { action: "enable"; enabled: boolean; allowBackgroundUse?: boolean }
	| { action: "consent"; allowBackgroundUse: boolean }
	| { action: "signIn" }
	| { action: "cancelSignIn" };
