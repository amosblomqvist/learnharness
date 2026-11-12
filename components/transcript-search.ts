import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import { findSessionTextMatches, readPluginQuestionAnswer, type LhViewPart } from "@/src/core";
import type { TranscriptRow } from "./transcript-rows";

interface TextNode { type: string; value?: string; alt?: string | null; children?: TextNode[] }

/** Text runs, rather than Markdown source: inline formatting and links do
 * not break phrases, block boundaries do, and fenced code keeps whitespace. */
export function markdownSearchRuns(source: string): string[] {
	const tree = fromMarkdown(source, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
	const runs: string[] = [];
	const inline = (node: TextNode): string => node.type === "html" ? "" : node.value ?? node.alt ?? node.children?.map(inline).join("") ?? "";
	const visit = (node: TextNode) => {
		if (node.type === "code" || node.type === "math") { if (node.value) runs.push(node.value); return; }
		if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
			const text = inline(node).replace(/[\t\n\r\f ]+/g, " ").trim();
			if (text) runs.push(text);
			return;
		}
		node.children?.forEach(visit);
	};
	visit(tree);
	return runs;
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	return [];
}

function fields(value: unknown, names: readonly string[]): string[] {
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	return names.flatMap(name => strings(record[name]));
}

/** Deliberately index presentation fields, never arbitrary JSON, internal
 * identifiers, image bytes, committed hidden solutions, or reasoning traces. */
export function partSearchSources(part: LhViewPart): string[] {
	if (part.type === "text") return [part.text ?? ""];
	if (part.type === "reasoning" || part.type === "step-start") return [];
	if (part.pluginQuestion) {
		if (part.pluginQuestion.status !== "posed") return [];
		const snapshot = part.pluginQuestion.snapshot;
		const answer = readPluginQuestionAnswer(part.result?.details ?? part.output, snapshot);
		return answer ? [...fields(snapshot.input, ["question", "details"]), ...strings(answer.answer)] : [];
	}
	if (part.pluginProblem) return fields(part.input, ["statement"]);
	if (/^tool-(quiz|probe|ask_user_question|explain|recall)$/.test(part.type)) {
		if (part.state !== "output-available") return [];
		const output = part.output as Record<string, unknown> | undefined;
		return [...fields(output, ["questionText", "text", "other", "readingThinking"]),
			...fields(part.input, ["details"]),
			...(Array.isArray(output?.options) ? output.options.flatMap(option => fields(option, ["label"])) : [])];
	}
	if (part.type === "tool-practice_problem") return fields(part.input, ["statement"]);
	if (part.type === "tool-practice_conclude") return [...fields(part.input, ["verdict"]), ...strings(part.reveal)];
	if (part.type === "data-practice-thinking") return fields(part.data, ["text"]);
	if (part.type === "data-graph-context") return fields(part.data, ["name", "title", "description"]);
	if (part.type === "data-plan-block") {
		const data = part.data as { nodes?: unknown[] } | undefined;
		return data?.nodes?.flatMap(node => fields(node, ["title"])) ?? [];
	}
	// Generic tool traces are collapsed: only their actual headline is visible.
	if (part.type.startsWith("tool-") && part.type !== "tool-plan_init") return [part.type.slice(5), ...fields(part.input, ["path", "pattern"])];
	return [];
}

export interface TranscriptSearchEntry { key: string; rowIndex: number; runs: readonly string[] }
export interface TranscriptSearchMatch { key: string; rowIndex: number; occurrence: number }
export type TranscriptSearchCache = Map<string, { sources: readonly string[]; runs: readonly string[] }>;

export function transcriptSearchIndex(rows: readonly TranscriptRow[], cache: TranscriptSearchCache = new Map()): TranscriptSearchEntry[] {
	const keys = new Set(rows.map(row => row.key));
	for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
	return rows.map((row, rowIndex) => {
		const plain = row.message.role === "user" && row.message.parts.some(part => part.type === "text");
		const sources = plain ? [row.message.parts.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")]
			: row.message.parts.slice(row.start, row.end).flatMap(partSearchSources);
		const previous = cache.get(row.key);
		const unchanged = previous && previous.sources.length === sources.length && previous.sources.every((source, index) => source === sources[index]);
		const runs = unchanged ? previous.runs : plain ? sources : sources.flatMap(markdownSearchRuns);
		if (!unchanged) cache.set(row.key, { sources, runs });
		return { key: row.key, rowIndex, runs };
	});
}

export function findTranscriptMatches(index: readonly TranscriptSearchEntry[], query: string): TranscriptSearchMatch[] {
	if (!query) return [];
	return index.flatMap(entry => {
		const count = entry.runs.reduce((total, run) => total + findSessionTextMatches(run, query).length, 0);
		return Array.from({ length: count }, (_, occurrence) => ({ key: `${entry.key}:${occurrence}`, rowIndex: entry.rowIndex, occurrence }));
	});
}
