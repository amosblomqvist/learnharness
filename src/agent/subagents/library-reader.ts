import { randomUUID } from "node:crypto";
import type { Message, ToolResultMessage, Usage, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { LIBRARY_TAG_LABELS } from "../../core/contracts.ts";
import type { PiEngine } from "../models.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";
import { streamOnce } from "./pdf-reader.ts";
import { readUnits, searchUnits, unitLabel, viewUnits, type LibraryReadable, type ViewedImage } from "../library/readable.ts";

/**
 * THE LIBRARY READER (course library wave, 2026-10-29): reads ONE course-
 * library file on someone's behalf — any format (PDF, converted or
 * extracted Office files, images) through the shared reading surface
 * (library/readable.ts). Two callers, one loop:
 *
 * - "summary": the cached per-file summary every attaching chat's manifest
 *   carries (pdf-reader model slot — owner ruling 2026-10-29).
 * - "brief":   the teacher's background brief on an attached file (the pdf
 *   job, extended to take a library file).
 *
 * The pdf-reader's loop shape: tool calls run inline, viewed images join
 * the conversation as a user message after the tool results, the final
 * text is the deliverable, and a finish that consulted nothing is nudged
 * once (an unread summary is invention).
 */

export type LibraryReaderMode = "summary" | "brief";

export interface LibraryReaderOptions {
	engine: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	headless?: HeadlessApi;
	maxIterations?: number;
}

export interface LibraryReaderResult {
	text: string;
	/** Units whose text or images entered the loop (citation set). */
	unitsConsulted: number[];
	failed: boolean;
}

const SHARED = `You read one file from a learner's course library — lecture slides, quizzes, practice tests,
homework, answer keys, notes, or a syllabus. Tools read it by unit (page, slide, or section):
library_read for text, library_search to find terms, library_view to SEE units as images (equations,
diagrams, handwriting, slide layout — use it whenever extracted text looks garbled or thin, and for
image files). Start by reading: never describe content you have not consulted.

ANSWER KEYS AND SOLUTIONS: never reproduce answers, worked solutions, or final values from an answer
key, a solutions section, or answers printed in a quiz/test. Describe what they cover, never what
they say.`;

const SUMMARY_INSTRUCTIONS = `${SHARED}

Your deliverable is a SUMMARY a teacher scans before deciding what to read. Plain text, at most
~150 words, no preamble:
- One line: what the document is (kind, course/unit if stated, length).
- The topics it covers, in order, with unit ranges (e.g. "slides 4-9: one-sided limits").
- For quizzes, practice tests, and homework: number of questions, question formats (multiple choice,
  free response, proofs, computations), point values if shown, and the topics each part tests.
- Anything notable for teaching from it (definitions it uses, notation, a theorem it relies on).`;

const BRIEF_INSTRUCTIONS = `${SHARED}

Your deliverable is a BRIEF answering the teacher's question from this file: 2-8 sentences or short
sections, each claim cited by unit, e.g. (slide 7) or (p. 3). Quote question wording exactly when the
teacher asks what a quiz/test asks. If the file cannot answer the question, say so instead of
inventing. End with a line "Consulted: <units>".`;

const UNREAD_FINISH =
	"You finished without reading any part of the file — that would be invention. Read or view the relevant units first, then write your deliverable from what you saw.";

function declarations(file: LibraryReadable): Tool[] {
	const label = unitLabel(file);
	const spec = Type.String({ description: `Which ${label}s: 'all', '1-5', '1,3,7', or '3'` });
	return [
		{ name: "library_read", description: `Read the text of ${label}s (with speaker notes when present).`, parameters: Type.Object({ units: spec }) },
		{ name: "library_search", description: `Find a term (case-insensitive) — returns matching ${label}s with snippets.`, parameters: Type.Object({ query: Type.String() }) },
		{
			name: "library_view",
			description: `See ${label}s as images (max 6 per call). DPI applies to rendered pages: 100 text, 150 default, 200 dense.`,
			parameters: Type.Object({ units: spec, dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300 })) }),
		},
	];
}

function toolText(toolCallId: string, toolName: string, value: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: value }], isError, timestamp: Date.now() };
}

function describeFile(file: LibraryReadable): string {
	const label = unitLabel(file);
	return [
		`File: ${file.path}`,
		`Kind: ${file.tag ? LIBRARY_TAG_LABELS[file.tag] : "untagged reference"} (${file.format.toUpperCase()}${file.via === "extracted" ? ", read from extracted text and embedded pictures" : ""})`,
		label === "image" ? "A single image." : `${file.pages ?? "?"} ${label}s.`,
	].join("\n");
}

export async function runLibraryReader(
	file: LibraryReadable,
	mode: LibraryReaderMode,
	question: string,
	opts: LibraryReaderOptions,
): Promise<LibraryReaderResult> {
	const headless = opts.headless ?? getHeadless();
	const engine = opts.engine;
	const maxIterations = opts.maxIterations ?? (mode === "summary" ? 8 : 14);
	const tools = declarations(file);
	const sessionId = randomUUID();
	const consulted = new Set<number>();
	const instructions = mode === "summary" ? SUMMARY_INSTRUCTIONS : BRIEF_INSTRUCTIONS;
	let messages: Message[] = [{
		role: "user",
		content: `${describeFile(file)}\n\n${mode === "summary" ? "Summarize this file." : `The teacher's question: ${question || "(none — give a structural overview)"}`}`,
		timestamp: Date.now(),
	}];
	let nudged = false;
	let lastText = "";

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const result = await streamOnce(engine, instructions, messages, tools, sessionId, engine.level, opts.abortSignal);
			opts.onUsage?.(result.usage);
			messages = [...messages, result];
			const calls = result.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
			if (calls.length === 0) {
				lastText = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				if (consulted.size === 0 && !nudged) {
					nudged = true;
					messages = [...messages, { role: "user", content: UNREAD_FINISH, timestamp: Date.now() }];
					continue;
				}
				return { text: lastText || "(no text)", unitsConsulted: [...consulted].sort((a, b) => a - b), failed: !lastText };
			}

			const results: ToolResultMessage[] = [];
			const viewed: { caption: string; images: ViewedImage[] }[] = [];
			for (const call of calls) {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				try {
					if (call.name === "library_read") {
						const spec = String(args.units ?? "all");
						opts.onActivity?.(`reading ${spec}`);
						const r = await readUnits(file, spec);
						r.units.forEach((u) => consulted.add(u));
						results.push(toolText(call.id, call.name, r.text));
					} else if (call.name === "library_search") {
						const query = String(args.query ?? "");
						opts.onActivity?.(`searching "${query}"`);
						const r = await searchUnits(file, query);
						r.units.forEach((u) => consulted.add(u));
						results.push(toolText(call.id, call.name, r.text));
					} else if (call.name === "library_view") {
						const spec = String(args.units ?? "1");
						opts.onActivity?.(`viewing ${spec}`);
						const r = await viewUnits(file, spec, {
							headless,
							dpi: typeof args.dpi === "number" ? args.dpi : undefined,
							resize: engine.model.inputLimits?.images?.resize,
						});
						opts.abortSignal?.throwIfAborted();
						if (r.images.length) r.units.forEach((u) => consulted.add(u));
						viewed.push({ caption: r.text, images: r.images });
						results.push(toolText(call.id, call.name, r.images.length ? `${r.images.length} image(s) follow below.\n${r.text}` : r.text));
					} else {
						results.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}"`, true));
					}
				} catch (err) {
					if (opts.abortSignal?.aborted) throw err;
					results.push(toolText(call.id, call.name, `ERROR: ${err instanceof Error ? err.message : String(err)}`, true));
				}
			}
			messages = [...messages, ...results];
			const images = viewed.flatMap((v) => v.images);
			if (images.length) {
				messages = [...messages, {
					role: "user",
					content: [
						{ type: "text", text: viewed.map((v) => v.caption).filter(Boolean).join("\n") || "The requested images:" },
						...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
					],
					timestamp: Date.now(),
				}];
			}
		}
	} catch (err) {
		if (opts.abortSignal?.aborted) throw err;
		return { text: `Reading failed: ${err instanceof Error ? err.message : String(err)}`, unitsConsulted: [...consulted].sort((a, b) => a - b), failed: true };
	}
	return {
		text: lastText || `Reading failed: iteration limit (${maxIterations}) reached without a result.`,
		unitsConsulted: [...consulted].sort((a, b) => a - b),
		failed: !lastText,
	};
}
