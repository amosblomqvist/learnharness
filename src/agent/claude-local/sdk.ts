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
	/** The real import, cached once it is under way or resolved (a rejected
	 *  import is dropped, so the next probe or turn retries it). */
	loaded?: Promise<ClaudeQuery>;
}
const KEY = Symbol.for("lh.claudeLocal.sdk");
function seam(): Seam {
	const global = globalThis as typeof globalThis & { [KEY]?: Seam };
	return global[KEY] ??= {};
}

/** The query function the route runs on: the injected fake when a test
 *  set one, else the real SDK (imported once per process). A failed import
 *  (the chunk missing mid-update, a transient load error) is not cached:
 *  one failure must not leave the route unavailable until a restart.
 *  `load` is the import itself (a test seam). */
export function loadClaudeQuery(load: () => Promise<{ query: ClaudeQuery }> = () => import("@anthropic-ai/claude-agent-sdk")): Promise<ClaudeQuery> {
	const state = seam();
	if (state.query) return Promise.resolve(state.query);
	if (!state.loaded) {
		const loading: Promise<ClaudeQuery> = load().then((sdk) => sdk.query, (error: unknown) => {
			if (state.loaded === loading) state.loaded = undefined;
			throw error;
		});
		state.loaded = loading;
	}
	return state.loaded;
}

/** Test seam: install (or clear with undefined) a fake query. */
export function setClaudeQueryForTests(query: ClaudeQuery | undefined): void {
	seam().query = query;
}
