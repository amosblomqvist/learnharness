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

/** The SDK's own debug log is switched on by DEBUG_CLAUDE_AGENT_SDK in THIS
 *  process's environment (the server's — env.ts only shapes the child's),
 *  and no option turns it off: it would write Claude Code's non-JSON
 *  stdout, the spawn command line and the start of every prompt to
 *  <Claude config dir>/debug/sdk-*.txt and print that path to the server
 *  log. Owner decision (2026-10-28): the seam removes the variable before
 *  the SDK loads and before every query, with one fixed log line.
 *  LH_CLAUDE_LOCAL_DEBUG stays the route's own debug switch. */
export function disarmSdkDebugLog(env: NodeJS.ProcessEnv = process.env): void {
	if (env.DEBUG_CLAUDE_AGENT_SDK === undefined) return;
	delete env.DEBUG_CLAUDE_AGENT_SDK;
	console.info("[claude-local] ignoring DEBUG_CLAUDE_AGENT_SDK: the Agent SDK's debug log would write Claude Code's own output to disk");
}

/** The query function the route runs on: the injected fake when a test
 *  set one, else the real SDK (imported once per process), each call
 *  preceded by disarmSdkDebugLog. A failed import (the chunk missing
 *  mid-update, a transient load error) is not cached: one failure must not
 *  leave the route unavailable until a restart. `load` is the import itself
 *  (a test seam). */
export function loadClaudeQuery(load: () => Promise<{ query: ClaudeQuery }> = () => import("@anthropic-ai/claude-agent-sdk")): Promise<ClaudeQuery> {
	const state = seam();
	if (state.query) return Promise.resolve(state.query);
	if (!state.loaded) {
		disarmSdkDebugLog();
		const loading: Promise<ClaudeQuery> = load().then((sdk) => ((params) => { disarmSdkDebugLog(); return sdk.query(params); }) as ClaudeQuery, (error: unknown) => {
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
