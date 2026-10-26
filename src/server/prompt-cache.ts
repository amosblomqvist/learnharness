/**
 * PROMPT-CACHE TELEMETRY (the DSH prefix-reuse law, server side).
 *
 * DeepSeek's automatic context cache is a prefix cache: a request pays the
 * cache-read rate only for the byte prefix it shares with an earlier request.
 * The provider reports the split per call (`prompt_cache_hit_tokens` →
 * pi's `Usage.cacheRead`), and that number is the only ground truth. This
 * module turns it into something a human can act on:
 *
 *   - every request is projected through the SAME seam the model sees
 *     (`toLlmMessages`) and fingerprinted (core/prompt-cache.ts);
 *   - the first model call of a turn compares against the last call of the
 *     previous turn, later calls compare against the previous step (tool
 *     results append, so they must extend the prefix);
 *   - one line per turn reports predicted prefix reuse vs provider-reported
 *     hits, plus dollars saved;
 *   - a stable prefix with zero hits is called out loudly, because that is
 *     almost always a routing problem (a gateway that does not forward
 *     DeepSeek's cache metrics, or a non-native OpenAI-compatible route).
 *
 * State is process-local (`globalThis`, the compaction/jobs idiom) and
 * keyed by chat id. A restart loses only diagnostics; the provider cache
 * itself lives upstream.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	buildCacheView,
	cacheSavingsUsd,
	cacheUsageStats,
	diffCacheViews,
	type CacheAudit,
	type CacheView,
} from "../core/prompt-cache.ts";
import { toLlmMessages } from "../core/native-messages.ts";

/** What the agent layer hands the observer before each model call. */
export interface PromptCacheProbeInput {
	model: string;
	/** The agent's live message list (the leading system message included). */
	messages: readonly AgentMessage[];
	/** The agent loop's step index within the turn (0-based). */
	step: number;
}

/** The agent layer's narrow seam (no server imports cross the lint zone). */
export interface PromptCacheProbe {
	observe(input: PromptCacheProbeInput): void;
}

interface ChatCacheState {
	view: CacheView;
	model: string;
	/** Prefix share predicted when this turn's first call was seen. */
	turnAudit: CacheAudit | null;
	/** Provider usage accumulated for this turn. */
	steps: number;
	promptTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	savedUsd: number;
	/** The last observed audit (diagnostics). */
	lastAudit: CacheAudit | null;
	/** Warn-once latch for "stable prefix, zero hits". */
	warnedNoHits: boolean;
	/** Last model-call usage, for the turn summary. */
	lastHitRate: number | null;
}

export interface PromptCacheTurn extends PromptCacheProbe {
	recordUsage(usage: Usage): void;
	finish(): void;
}

const g = globalThis as typeof globalThis & {
	__lhPromptCache?: Map<string, ChatCacheState>;
};

function state(): Map<string, ChatCacheState> {
	return (g.__lhPromptCache ??= new Map());
}

/** Reset the per-process diagnostics (tests, and a chat delete). */
export function resetPromptCacheTelemetry(chatId?: string): void {
	if (chatId === undefined) state().clear();
	else state().delete(chatId);
}

/** The latest audit for a chat (diagnostics surface; not persisted). */
export function promptCacheSnapshot(chatId: string): {
	predictedPrefixShare: number | null;
	lastProviderHitRate: number | null;
} | null {
	const entry = state().get(chatId);
	if (!entry) return null;
	return {
		predictedPrefixShare: entry.lastAudit?.prefixShare ?? null,
		lastProviderHitRate: entry.lastHitRate,
	};
}

function pct(value: number | null): string {
	return value === null ? "?" : `${Math.round(value * 100)}%`;
}

function tokens(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function describe(audit: CacheAudit): string {
	switch (audit.kind) {
		case "first":
			return "first request";
		case "append":
			return `append (+${audit.totalBlocks - audit.sharedBlocks} msg)`;
		case "system":
			return "SYSTEM PROMPT CHANGED — prefix reuse resets at token 0";
		case "tools":
			return "TOOL DECLARATIONS CHANGED — prefix reuse resets at token 0";
		case "rewrite":
			return `history rewrite at message ${audit.divergedAt ?? "?"} (compaction or edited record)`;
		default:
			return audit.kind;
	}
}

/**
 * Start one turn's prompt-cache observation. Call once per chat turn; the
 * returned object rides the agent build (`promptCache`) and the money
 * collector (`recordUsage`), and is closed in `onFinish`.
 */
export function beginPromptCacheTurn(chatId: string, model: string): PromptCacheTurn {
	const map = state();
	let entry = map.get(chatId);
	if (!entry || entry.model !== model) {
		entry = {
			view: { blocks: [], systemHash: null, toolsHash: null, totalTokens: 0 },
			model,
			turnAudit: null,
			steps: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			savedUsd: 0,
			lastAudit: null,
			warnedNoHits: false,
			lastHitRate: null,
		};
		map.set(chatId, entry);
	}
	const current = entry;
	// Reset the per-turn accumulators but keep the previous view: the first
	// call of this turn is compared against the last call of the last turn.
	current.turnAudit = null;
	current.steps = 0;
	current.promptTokens = 0;
	current.cacheReadTokens = 0;
	current.cacheWriteTokens = 0;
	current.savedUsd = 0;

	return {
		observe(input) {
			let view: CacheView;
			try {
				view = buildCacheView(toLlmMessages(input.messages as readonly AgentMessage[]));
			} catch (err) {
				// Telemetry must never break a turn.
				console.warn(`[chat ${chatId}] prompt-cache projection failed:`, err);
				return;
			}
			const audit = diffCacheViews(current.view.blocks.length > 0 ? current.view : null, view);
			current.lastAudit = audit;
			current.turnAudit ??= audit;
			current.view = view;
			if (audit.kind === "system" || audit.kind === "tools") {
				// A head rewrite is the one thing that can silently throw away
				// 100k+ cached tokens; name it at the moment it happens.
				console.warn(`[chat ${chatId}] prompt cache: ${describe(audit)}`);
			}
			if (process.env.LH_CACHE_DEBUG === "1") {
				console.info(
					`[chat ${chatId}] prompt cache step ${input.step}: ${describe(audit)} — predicted ${pct(audit.prefixShare)} of ${tokens(audit.totalTokens)} tokens reusable`,
				);
			}
		},

		recordUsage(usage) {
			const stats = cacheUsageStats(usage);
			current.steps += 1;
			current.promptTokens += stats.promptTokens;
			current.cacheReadTokens += stats.cacheReadTokens;
			current.cacheWriteTokens += stats.cacheWriteTokens;
			current.savedUsd += cacheSavingsUsd(usage);
			current.lastHitRate = stats.hitRate;
			// A provider that reports no cache field at all is unknown, not a
			// miss; only a reported near-zero hit rate against a large, stable
			// prefix earns the routing warning. Use the LATEST request's
			// prediction: a multi-step turn appends tool results, so the last
			// step is the one that should have hit.
			const predicted = current.lastAudit?.prefixShare ?? 0;
			if (
				stats.hitRate !== null
				&& stats.promptTokens >= 8_000
				&& stats.hitRate < 0.15
				&& predicted > 0.7
				&& !current.warnedNoHits
			) {
				current.warnedNoHits = true;
				console.warn(
					`[chat ${chatId}] prompt cache: provider reported ${pct(stats.hitRate)} hits on ${tokens(stats.promptTokens)} prompt tokens even though ${pct(predicted)} of the prefix was stable. `
					+ "Check that the session uses the native deepseek provider (not a gateway that drops prompt_cache_hit_tokens) and that settings did not change mid-session.",
				);
			}
		},

		finish() {
			if (current.steps === 0) return;
			const hitRate = current.promptTokens > 0 ? current.cacheReadTokens / current.promptTokens : null;
			const predicted = current.turnAudit?.prefixShare ?? 0;
			const saved = current.savedUsd >= 0.0001 ? ` · saved $${current.savedUsd.toFixed(4)}` : "";
			console.info(
				`[chat ${chatId}] prompt cache: ${current.steps} call${current.steps === 1 ? "" : "s"}, `
				+ `${tokens(current.cacheReadTokens)}/${tokens(current.promptTokens)} tokens reused (${pct(hitRate)}), `
				+ `predicted ${pct(predicted)}${saved}`,
			);
			// The next turn compares against this turn's last request.
			current.turnAudit = null;
		},
	};
}
