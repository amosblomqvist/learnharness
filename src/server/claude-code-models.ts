import { getClaudeBinary } from "../agent/claude-code/binary.ts";
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

/** Tests only. */
export function resetClaudeCodeModels(): void {
	cache = null;
	inflight = null;
}
