import type { Api, Model } from "@earendil-works/pi-ai";

import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { CLAUDE_CODE_MODELS, claudeCodeModel } from "../agent/claude-code/provider.ts";
import { readClaudeModels, type ClaudeModelInfo } from "../agent/claude-code/model-info.ts";
import { claudeCodeAvailable } from "./claude-code-config.ts";

const FRESH_MS = 10 * 60_000;

type Cache = { binary: string; at: number; models: ReadonlyMap<string, ClaudeModelInfo> };
let cache: Cache | null = null;
let inflight: Promise<void> | null = null;

/** Refresh the alias → concrete model map for the picker. Metadata only,
 * cached for ten minutes per binary; a failed read keeps labels as aliases. */
export async function refreshClaudeCodeModels(
	read: (binary: string) => Promise<ClaudeModelInfo[]> = readClaudeModels,
	available: () => boolean = claudeCodeAvailable,
	findBinary: () => string | null = getClaudeBinary,
	now: () => number = Date.now,
): Promise<void> {
	if (!available()) return;
	const binary = findBinary();
	if (!binary) return;
	if (cache && cache.binary === binary && now() - cache.at < FRESH_MS) return;
	inflight ??= read(binary).then((rows) => {
		cache = { binary, at: now(), models: new Map(rows.map((row) => [row.alias, row])) };
	}).finally(() => { inflight = null; });
	await inflight;
}

/** The last known concrete model for an alias, if the CLI reported one. */
export function claudeCodeModelInfo(alias: string): ClaudeModelInfo | undefined {
	return cache?.models.get(alias);
}

/** Models the CLI reported beyond the three listed aliases, in a stable
 *  order: other aliases (e.g. `fable`) first, then full IDs (e.g.
 *  `claude-mythos-5-2`) in the CLI's own order. `default` is skipped: it is
 *  the CLI's own setting, not a model. Nothing is listed until the CLI has
 *  answered, and nothing here is hardcoded. */
export function claudeCodeExtraModels(): Model<Api>[] {
	if (!cache) return [];
	const rows = [...cache.models.values()].filter((row) => row.alias !== "default" && !CLAUDE_CODE_MODELS.some((model) => model.id === row.alias));
	const aliasesFirst = [...rows.filter((row) => !row.alias.startsWith("claude-")), ...rows.filter((row) => row.alias.startsWith("claude-"))];
	return aliasesFirst.flatMap((row) => {
		const model = claudeCodeModel(row.alias, row.displayName ? `Claude ${row.displayName}` : undefined);
		return model ? [model] : [];
	});
}

/** Tests only. */
export function resetClaudeCodeModels(): void {
	cache = null;
	inflight = null;
}
