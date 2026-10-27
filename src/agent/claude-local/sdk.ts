/**
 * The Claude Agent SDK seam (Local Claude route, docs/architecture.md
 * §8.1): the ONE place that imports `@anthropic-ai/claude-agent-sdk`.
 * Lazy, so the proprietary SDK never loads unless the route is used, and
 * injectable, so every unit test runs against a fake `query` and no test
 * ever spawns a `claude` process (the suite stays offline — testing law).
 *
 * The SDK's `query()` spawns the CLI as a child and talks stream-json over
 * stdio; everything the app passes it is decided in agent.ts / stream.ts
 * and the server's probe — this file only hands the function over.
 */
import type {
	AccountInfo,
	HookCallback,
	McpSdkServerConfigWithInstance,
	ModelInfo,
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
	query as QueryFunction,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeQuery = typeof QueryFunction;
export type { AccountInfo, HookCallback, McpSdkServerConfigWithInstance, ModelInfo, Options as ClaudeQueryOptions, Query as ClaudeQueryHandle, SDKMessage, SDKUserMessage };

interface Seam {
	/** A test-injected query (never set in production). */
	query?: ClaudeQuery;
	/** The resolved real import, cached after the first load. */
	loaded?: Promise<ClaudeQuery>;
}
const KEY = Symbol.for("lh.claudeLocal.sdk");
function seam(): Seam {
	const global = globalThis as typeof globalThis & { [KEY]?: Seam };
	return global[KEY] ??= {};
}

/** The query function the route runs on: the injected fake when a test
 *  set one, else the real SDK (imported once per process). */
export function loadClaudeQuery(): Promise<ClaudeQuery> {
	const state = seam();
	if (state.query) return Promise.resolve(state.query);
	state.loaded ??= import("@anthropic-ai/claude-agent-sdk").then((sdk) => sdk.query);
	return state.loaded;
}

/** Test seam: install (or clear with undefined) a fake query. */
export function setClaudeQueryForTests(query: ClaudeQuery | undefined): void {
	seam().query = query;
}
