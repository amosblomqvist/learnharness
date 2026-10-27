/**
 * The Local Claude route's contract (owner-approved design, 2026-10-27;
 * docs/architecture.md §8.1): lesson turns run through the user's OWN
 * installed Claude Code binary via the Claude Agent SDK. The app never
 * collects, stores or forwards a Claude credential — Claude Code keeps its
 * own login — so there is no sign-in control anywhere, no credential file,
 * and nothing here that could hold a token. Pure types + constants;
 * browser-safe (the settings card and the picker read this).
 *
 * This is deliberately NOT a NATIVE_SUBSCRIPTIONS entry: that list drives
 * the OAuth login UI and the credential store, neither of which exists on
 * this route.
 */

export const CLAUDE_LOCAL = Object.freeze({
	/** The persisted provider id (model specs, usage stamps: `claude-local:<id>`). */
	providerId: "claude-local",
	/** The compact label shown where API routes show a price. */
	label: "Local Claude",
	/** The Providers card title. Never a product/feature name on its own. */
	title: "Claude (via your Claude Code install)",
	/** The oldest Claude Code the probe admits. One constant, compared by the
	 *  probe. Re-verified against the pinned SDK (0.3.311, which targets Claude
	 *  Code 2.1.311 per its package.json `claudeCodeVersion`): its sdk.d.ts gives
	 *  a "requires Claude Code" version for NONE of the options this route sends
	 *  (`--thinking`, `--thinking-display`, `--effort`, `--tools`,
	 *  `--setting-sources`, `--strict-mcp-config`, `--no-session-persistence`,
	 *  `--allowedTools`, `--permission-mode`, `--include-partial-messages`), and
	 *  the SDK runs no version check of its own. Its only version notes are
	 *  `verbatimPrompts` (2.1.248; older CLIs ignore it), `plugins` delivered
	 *  via initialize, the one path that sends `--await-initialize` (2.1.261;
	 *  older CLIs exit), and initialize-response fields (2.1.268) — none used
	 *  here. So 2.1.248 is a conservative floor, not a proven requirement;
	 *  re-check it whenever the SDK is bumped. */
	minVersion: "2.1.248",
	/** The in-process MCP server the app's tools are served through; the
	 *  model sees `mcp__learnharness__<tool>`, the record keeps bare names. */
	mcpServerName: "learnharness",
} as const);

export type ClaudeLocalProviderId = typeof CLAUDE_LOCAL.providerId;

/** How the system prompt reaches Claude Code: the app's composed prompt
 *  as a custom string (default), or Claude Code's own preset with the app's
 *  prompt appended (costs Claude Code's coding-agent preamble every turn). */
export type ClaudeLocalSystemPromptMode = "custom" | "preset";

/** The probe's verdict. Every non-ready state is recoverable by fixing the
 *  install/login and pressing Re-check — nothing is ever "fatal". */
export type ClaudeLocalState =
	| "disabled"
	| "not-found"
	| "unsupported-version"
	| "not-signed-in"
	| "api-key"
	| "third-party"
	| "unavailable"
	| "ready";

/** The latest plan-usage report Claude Code emitted during a turn
 *  (SDK rate_limit_event) — memory only, never persisted. */
export interface ClaudeLocalUsageReport {
	status: "allowed" | "allowed_warning" | "rejected";
	/** 0..1 of the named window, when reported. */
	utilization?: number;
	/** Unix seconds when the window resets, when reported. */
	resetsAt?: number;
	rateLimitType?: string;
	/** Claude Code reported the turn drew on extra usage rather than the plan. */
	isUsingOverage?: boolean;
	/** Unix ms when the app observed it. */
	observedAt: number;
}

export interface ClaudeLocalStatus {
	providerId: ClaudeLocalProviderId;
	enabled: boolean;
	allowBackgroundUse: boolean;
	systemPromptMode: ClaudeLocalSystemPromptMode;
	state: ClaudeLocalState;
	/** The detected install (also reported while not ready, for the card). */
	binary: { path: string; version: string | null; source: "override" | "path" | "known-location" } | null;
	/** What Claude Code reported about its login — never a token or email. */
	account: { subscriptionType?: string; apiProvider?: string } | null;
	/** How many models supportedModels() offered (0 unless ready). */
	models: number;
	/** Human-readable detail for the non-ready states. */
	error?: string;
	/** Ids Claude Code offered that pi-ai's catalog does not know (no
	 *  context window known, so never offered) — reported in any state. */
	skippedModels?: string[];
	/** ISO time of the last probe, null before the first. */
	probedAt: string | null;
	/** Bumped on every state/catalog change (scope invalidation). */
	revision: number;
	usage?: ClaudeLocalUsageReport;
}

/** The admission scope a turn captures: the probe revision pins the
 *  binary + catalog the turn was admitted against. */
export interface ClaudeLocalScope {
	providerId: ClaudeLocalProviderId;
	revision: number;
	selectedModelId: string;
}

/** The renderer-facing control surface (same shape in desktop and web —
 *  the Next server owns the route everywhere). Settings are written through
 *  PUT /api/settings/claudeLocal; this bridge only reads and re-probes. */
export interface ClaudeLocalControlBridge {
	status(): Promise<ClaudeLocalStatus>;
	probe(): Promise<ClaudeLocalStatus>;
	onChange(listener: () => void): () => void;
}

export function isClaudeLocalProvider(provider: string | undefined): provider is ClaudeLocalProviderId {
	return provider === CLAUDE_LOCAL.providerId;
}
