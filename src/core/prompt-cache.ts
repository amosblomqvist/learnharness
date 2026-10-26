/**
 * DEEPSEEK-STYLE PREFIX CACHING, ported from DeepSeek Harness (DSH).
 *
 * DeepSeek bills a prompt prefix once: a later request that shares an exact
 * byte prefix with an earlier request pays the (much cheaper) cache-read rate
 * for the shared tokens and the full input rate only for the suffix. The
 * provider reports the split as `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`; pi-ai maps the hit half into
 * `Usage.cacheRead`.
 *
 * The hard requirement is BYTE-IDENTICAL PREFIX. DSH achieves 97%+ hit
 * rates with one rule: once a message (or a tool declaration, or the system
 * prompt) has been sent, never rewrite it — append after it. That is why DSH
 * keeps the rendered system prompt as a surface node, appends changed prompts
 * in-history instead of rewriting node 0, and treats any surface replacement
 * as a cache epoch. This module is the measurement half of that rule: it
 * projects a request to its model-visible prefix, fingerprints it, and reports
 * how much of the previous request's prefix survives.
 *
 * It is pure and browser-safe (types only from pi-ai) so the same rules can
 * price and audit on either side of the wire.
 *
 * Token counts are estimates (`estimateMessageTokens`, the same chars/4 law
 * compaction uses); provider usage remains authoritative for money.
 */

import type { AssistantMessage, Message, SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "./compaction.ts";

/** DeepSeek's server-side prefix cache works in 64-token blocks; a prefix
 * shorter than one block cannot hit. Reported hits are therefore always a
 * multiple of this in practice. Used only for diagnostics. */
export const DEEPSEEK_CACHE_BLOCK_TOKENS = 64;

/** One model-visible message, reduced to what the wire actually carries. */
export interface CacheBlock {
	/** Wire role, for human-readable divergence reports. */
	role: string;
	/** 64-bit FNV-1a fingerprint of the wire text (two 32-bit lanes). */
	hash: string;
	/** Estimated request tokens for this message. */
	tokens: number;
	/** First 80 characters of the wire text (diagnostics only). */
	preview: string;
}

/** One request's model-visible prefix. */
export interface CacheView {
	blocks: CacheBlock[];
	/** Fingerprint of the leading system prompt text (without tool declarations). */
	systemHash: string | null;
	/** Fingerprint of every tool declaration the request carries. */
	toolsHash: string | null;
	/** Sum of `blocks[].tokens` (estimated). */
	totalTokens: number;
}

/** How the current request relates to the previous one for the same chat. */
export type CacheChangeKind = "first" | "append" | "system" | "tools" | "rewrite";

export interface CacheAudit {
	kind: CacheChangeKind;
	/** Leading messages whose wire bytes are unchanged. */
	sharedBlocks: number;
	totalBlocks: number;
	/** Estimated tokens in the unchanged prefix. */
	sharedTokens: number;
	/** Estimated tokens in the whole current request. */
	totalTokens: number;
	/** `sharedTokens / totalTokens`, 0..1. 0 for a rewritten system/tool head. */
	prefixShare: number;
	/** Index of the first changed message (absent for "first"/"append"). */
	divergedAt?: number;
	/** Short wire previews at the divergence (diagnostics only). */
	previousPreview?: string;
	nextPreview?: string;
}

/** Provider-reported cache accounting for one model call. Counts are
 * disjoint in pi's `Usage`: `freshInputTokens` excludes cache reads/writes. */
export interface CacheUsageStats {
	freshInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** The full prompt: fresh input + cache reads + cache writes. */
	promptTokens: number;
	/** `cacheReadTokens / promptTokens`, or null when the provider reported
	 * no cache field at all (unknown, never a fake 0%). */
	hitRate: number | null;
}

// ─── stable wire projection ──────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted, `undefined` members omitted.
 * The provider hashes the serialized request, so a map-key-order wobble
 * would read as a prefix change even when the model sees the same bytes. */
export function stableJson(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** 64-bit FNV-1a over UTF-16 code units, rendered as 16 hex characters. */
export function fingerprint(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a ^= code;
		a = Math.imul(a, 0x01000193);
		b ^= code + 0x9e37;
		b = Math.imul(b, 0x85ebca6b);
	}
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: string; text?: string };
			return typed.type === "text" ? typed.text ?? "" : "";
		})
		.join("\n");
}

function blockWireText(block: unknown): string {
	if (!block || typeof block !== "object") return stableJson(block);
	const typed = block as {
		type?: string;
		text?: string;
		thinking?: string;
		thinkingSignature?: string;
		redacted?: boolean;
		id?: string;
		name?: string;
		arguments?: unknown;
		argumentsError?: string;
		thoughtSignature?: string;
		mimeType?: string;
		data?: string;
	};
	switch (typed.type) {
		case "text":
			return `text:${typed.text ?? ""}`;
		case "thinking":
			return stableJson({
				thinking: typed.thinking ?? "",
				signature: typed.thinkingSignature,
				redacted: typed.redacted === true,
			});
		case "toolCall":
			return stableJson({
				id: typed.id,
				name: typed.name,
				arguments: typed.arguments,
				argumentsError: typed.argumentsError,
				thoughtSignature: typed.thoughtSignature,
			});
		case "image":
			return stableJson({
				image: typed.mimeType,
				bytes: typed.data?.length ?? 0,
				hash: fingerprint(typed.data ?? ""),
			});
		default:
			return stableJson(block);
	}
}

function toolDeclarationText(tool: unknown): string {
	const typed = tool as { name?: string; description?: string; parameters?: unknown };
	return stableJson({ name: typed.name, description: typed.description, parameters: typed.parameters });
}

/** Reduce one provider-facing message to the bytes that matter for prefix
 * reuse. Deliberately drops `timestamp`, `usage`, ids, and provider
 * bookkeeping that no wire serializer reads. */
export function messageWireText(message: Message): string {
	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			return stableJson({
				role: "system",
				content: textOfContent(system.content),
				sections: system.sections ?? null,
				toolsAdded: system.toolsAdded?.map(toolDeclarationText) ?? null,
				toolsRemoved: system.toolsRemoved ?? null,
			});
		}
		case "user":
			return stableJson({
				role: "user",
				content: typeof message.content === "string" ? message.content : message.content.map(blockWireText),
			});
		case "assistant": {
			const assistant = message as AssistantMessage;
			return stableJson({
				role: "assistant",
				api: assistant.api,
				provider: assistant.provider,
				model: assistant.model,
				stopReason: assistant.stopReason,
				content: assistant.content.map(blockWireText),
			});
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			return stableJson({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError: result.isError === true,
				content: result.content.map(blockWireText),
			});
		}
		default:
			return stableJson(message);
	}
}

function systemTextOf(message: Message): string | null {
	if (message.role !== "system") return null;
	const system = message as SystemMessage;
	return stableJson({
		content: textOfContent(system.content),
		sections: system.sections ?? null,
	});
}

function toolsTextOf(message: Message): string | null {
	if (message.role !== "system") return null;
	const system = message as SystemMessage;
	const added = system.toolsAdded?.map(toolDeclarationText) ?? [];
	const removed = system.toolsRemoved ?? [];
	if (added.length === 0 && removed.length === 0) return null;
	return stableJson({ added, removed });
}

/** Project a converted request to its cache-relevant prefix. */
export function buildCacheView(messages: readonly Message[]): CacheView {
	const blocks: CacheBlock[] = [];
	let systemHash: string | null = null;
	let toolsHash: string | null = null;
	for (const message of messages) {
		const wire = messageWireText(message);
		blocks.push({
			role: message.role,
			hash: fingerprint(wire),
			tokens: estimateMessageTokens(message),
			preview: wire.slice(0, 80),
		});
		systemHash ??= systemTextOf(message);
		toolsHash ??= toolsTextOf(message);
	}
	return {
		blocks,
		systemHash,
		toolsHash,
		totalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
	};
}

// ─── prefix comparison ───────────────────────────────────────────────────────

/** Compare two requests for the same chat. A changed system prompt or tool
 * declaration is a miss from token 0, because the provider's cached prefix
 * starts with the declarations; an append keeps every earlier block. */
export function diffCacheViews(previous: CacheView | null, next: CacheView): CacheAudit {
	const totalTokens = next.totalTokens;
	if (!previous) {
		return {
			kind: "first",
			sharedBlocks: 0,
			totalBlocks: next.blocks.length,
			sharedTokens: 0,
			totalTokens,
			prefixShare: 0,
		};
	}
	if (previous.systemHash !== next.systemHash) {
		return {
			kind: "system",
			sharedBlocks: 0,
			totalBlocks: next.blocks.length,
			sharedTokens: 0,
			totalTokens,
			prefixShare: 0,
			divergedAt: 0,
			previousPreview: "system prompt",
			nextPreview: "system prompt",
		};
	}
	if (previous.toolsHash !== next.toolsHash) {
		return {
			kind: "tools",
			sharedBlocks: 0,
			totalBlocks: next.blocks.length,
			sharedTokens: 0,
			totalTokens,
			prefixShare: 0,
			divergedAt: 0,
			previousPreview: "tool declarations",
			nextPreview: "tool declarations",
		};
	}
	let shared = 0;
	while (
		shared < previous.blocks.length
		&& shared < next.blocks.length
		&& previous.blocks[shared]!.hash === next.blocks[shared]!.hash
	) {
		shared++;
	}
	if (shared === previous.blocks.length) {
		// The whole previous request is a prefix of this one: pure append
		// (including the equal case, where the only difference is metadata).
		return {
			kind: "append",
			sharedBlocks: shared,
			totalBlocks: next.blocks.length,
			sharedTokens: previous.totalTokens,
			totalTokens,
			prefixShare: totalTokens > 0 ? Math.min(1, previous.totalTokens / totalTokens) : 0,
		};
	}
	const sharedTokens = previous.blocks
		.slice(0, shared)
		.reduce((sum, block) => sum + block.tokens, 0);
	return {
		kind: "rewrite",
		sharedBlocks: shared,
		totalBlocks: next.blocks.length,
		sharedTokens,
		totalTokens,
		prefixShare: totalTokens > 0 ? Math.min(1, sharedTokens / totalTokens) : 0,
		divergedAt: shared,
		previousPreview: previous.blocks[shared]?.preview,
		nextPreview: next.blocks[shared]?.preview,
	};
}

// ─── provider-reported economics ────────────────────────────────────────────

/** Split one provider `Usage` into the cache-relevant buckets. */
export function cacheUsageStats(usage: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): CacheUsageStats {
	const freshInputTokens = usage.input ?? 0;
	const cacheReadTokens = usage.cacheRead ?? 0;
	const cacheWriteTokens = usage.cacheWrite ?? 0;
	const promptTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens;
	const known = usage.cacheRead !== undefined;
	return {
		freshInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		promptTokens,
		hitRate: known && promptTokens > 0 ? cacheReadTokens / promptTokens : null,
	};
}

/** Dollars avoided by reading `cacheReadTokens` at the cache rate instead of
 * the input rate, derived from the provider-computed cost blocks themselves
 * (so no rate table is duplicated here). Returns 0 when the provider did not
 * split the cost. */
export function cacheSavingsUsd(usage: {
	input?: number;
	cacheRead?: number;
	cost?: { input?: number; cacheRead?: number };
}): number {
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input <= 0 || cacheRead <= 0) return 0;
	const inputCost = usage.cost?.input;
	const cacheCost = usage.cost?.cacheRead;
	if (!Number.isFinite(inputCost) || !Number.isFinite(cacheCost)) return 0;
	const saved = (cacheRead / input) * (inputCost ?? 0) - (cacheCost ?? 0);
	return saved > 0 ? saved : 0;
}
