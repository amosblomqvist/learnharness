/**
 * Regenerate src/agent/commandcode-models.generated.ts from Command Code's
 * live Provider API model catalog.
 *
 * Usage: npx tsx scripts/sync-commandcode.ts
 *
 * The upstream catalog carries id/name/context_length + supported_endpoints,
 * but no reasoning, vision, effort or price metadata. Those fields come from
 * the capability tables in the unofficial pi-commandcode-provider package
 * (MIT) and are carried forward from the existing generated file; models
 * upstream adds later get conservative runtime defaults until this sync is
 * extended with their metadata.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	COMMANDCODE_METADATA,
	type CommandCodeModelMetadata,
} from "../src/agent/commandcode-models.generated.ts";

const MODELS_URL =
	process.env.COMMAND_CODE_MODELS_URL ?? "https://api.commandcode.ai/provider/v1/models";
const OUT = path.join(import.meta.dirname, "..", "src", "agent", "commandcode-models.generated.ts");

type CommandCodeApi = "anthropic-messages" | "openai-completions" | "openai-responses";

interface LiveModel {
	id: string;
	name: string;
	context_length: number;
	supported_endpoints?: readonly string[];
}

interface SnapshotEntry {
	id: string;
	name: string;
	api: CommandCodeApi;
	contextWindow: number;
}

function apiFor(id: string, endpoints: readonly string[] | undefined): CommandCodeApi {
	if (id.startsWith("claude-")) return "anthropic-messages";
	return endpoints?.includes("/responses") ? "openai-responses" : "openai-completions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseCatalog(body: unknown): LiveModel[] {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new Error("Command Code model list response has no data array");
	}
	return body.data.map((entry) => {
		if (!isRecord(entry)) throw new Error("Command Code model entry is not an object");
		const { id, name, context_length, supported_endpoints } = entry;
		if (typeof id !== "string" || typeof name !== "string" || typeof context_length !== "number") {
			throw new Error("Command Code model entry is missing id/name/context_length");
		}
		return {
			id,
			name,
			context_length,
			...(Array.isArray(supported_endpoints)
				? { supported_endpoints: supported_endpoints.filter((v): v is string => typeof v === "string") }
				: {}),
		};
	});
}

function renderCost(meta: CommandCodeModelMetadata): string {
	return JSON.stringify(meta.cost);
}

function render(snapshot: readonly SnapshotEntry[]): string {
	const lines: string[] = [];
	lines.push(`/**`);
	lines.push(` * Command Code (commandcode.ai) Provider API model catalog — GENERATED.`);
	lines.push(` *`);
	lines.push(` * Source: GET https://api.commandcode.ai/provider/v1/models, merged with the`);
	lines.push(` * capability/pricing tables in the unofficial pi-commandcode-provider package`);
	lines.push(` * (MIT, https://github.com/patlux/pi-commandcode-provider). Models the upstream`);
	lines.push(` * catalog adds later are merged at runtime by fetchModels() in`);
	lines.push(` * src/agent/commandcode.ts, with conservative defaults until a sync adds`);
	lines.push(` * capability metadata.`);
	lines.push(` *`);
	lines.push(` * Regenerate: npx tsx scripts/sync-commandcode.ts`);
	lines.push(` * Do not edit manually.`);
	lines.push(` */`);
	lines.push(``);
	lines.push(`export type CommandCodeApi = "anthropic-messages" | "openai-completions" | "openai-responses";`);
	lines.push(``);
	lines.push(`export interface CommandCodeSnapshotEntry {`);
	lines.push(`\tid: string;`);
	lines.push(`\tname: string;`);
	lines.push(`\tapi: CommandCodeApi;`);
	lines.push(`\tcontextWindow: number;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export interface CommandCodeModelMetadata {`);
	lines.push(`\treasoning: boolean;`);
	lines.push(`\tinput: readonly ("text" | "image")[];`);
	lines.push(`\tcost: {`);
	lines.push(`\t\tinput: number;`);
	lines.push(`\t\toutput: number;`);
	lines.push(`\t\tcacheRead: number;`);
	lines.push(`\t\tcacheWrite: number;`);
	lines.push(`\t\ttiers?: { input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }[];`);
	lines.push(`\t};`);
	lines.push(`\tmaxTokens?: number;`);
	lines.push(`\tefforts?: readonly ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export const COMMANDCODE_SNAPSHOT: readonly CommandCodeSnapshotEntry[] = [`);
	for (const m of snapshot) {
		lines.push(
			`\t{ id: ${JSON.stringify(m.id)}, name: ${JSON.stringify(m.name)}, api: ${JSON.stringify(m.api)}, contextWindow: ${m.contextWindow} },`,
		);
	}
	lines.push(`];`);
	lines.push(``);
	lines.push(`export const COMMANDCODE_METADATA: Readonly<Record<string, CommandCodeModelMetadata>> = {`);
	for (const id of Object.keys(COMMANDCODE_METADATA).sort()) {
		const meta = COMMANDCODE_METADATA[id]!;
		const efforts = meta.efforts ? `, efforts: ${JSON.stringify(meta.efforts)}` : "";
		lines.push(
			`\t${JSON.stringify(id)}: { reasoning: ${meta.reasoning}, input: ${JSON.stringify(meta.input)}, cost: ${renderCost(meta)}, maxTokens: ${meta.maxTokens ?? 65_536}${efforts} },`,
		);
	}
	lines.push(`};`);
	lines.push(``);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const response = await fetch(MODELS_URL, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`Command Code model list request failed: ${response.status}`);
	}
	const live = parseCatalog(await response.json());
	const snapshot = live
		.map<SnapshotEntry>((model) => ({
			id: model.id,
			name: model.name,
			api: apiFor(model.id, model.supported_endpoints),
			contextWindow: model.context_length,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));

	writeFileSync(OUT, render(snapshot), "utf-8");
	console.log(`commandcode-models.generated.ts regenerated: ${snapshot.length} models.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	await main();
}

export { apiFor, parseCatalog };
