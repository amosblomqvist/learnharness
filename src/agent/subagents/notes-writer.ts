import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { PATHS } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import {
	noteBlockKinds,
	noteSectionText,
	type NoteDocument,
	type NoteMode,
	type NotePassage,
	type WrittenSection,
} from "../../core/session-notes.ts";
import { noteTextHtml } from "../../core/note-render.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import type { Usage } from "@earendil-works/pi-ai";

interface Submission {
	overview: string;
	sections: WrittenSection[];
}
const text = Type.String({ minLength: 1 });
const schema = Type.Object({
	overview: text,
	sections: Type.Array(
		Type.Object({
			heading: text,
			sourceIds: Type.Array(text, { minItems: 1 }),
			blocks: Type.Array(Type.Object({ kind: Type.Union(noteBlockKinds.map(k => Type.Literal(k))), text }), {
				minItems: 1,
			}),
		}),
		{ minItems: 1 },
	),
});
interface EvidenceLine {
	ids: string[];
	text: string;
	topic?: string;
}
function batches(lines: EvidenceLine[], limit: number) {
	const result: EvidenceLine[][] = [];
	let batch: EvidenceLine[] = [],
		size = 0;
	for (const line of lines) {
		const width = Math.max(500, limit - JSON.stringify({ ...line, text: "" }).length - 200);
		for (let offset = 0; offset < line.text.length; offset += width) {
			const part = { ...line, text: line.text.slice(offset, offset + width) };
			const cost = JSON.stringify(part).length;
			if (batch.length && size + cost > limit) {
				result.push(batch);
				batch = [];
				size = 0;
			}
			batch.push(part);
			size += cost;
		}
	}
	if (batch.length) result.push(batch);
	return result;
}
export async function writeSessionNotes(opts: {
	chatId: string;
	title: string;
	mode: NoteMode;
	practice: boolean;
	passages: NotePassage[];
	engine: PiEngine;
	signal: AbortSignal;
	onUsage: (usage: Usage, model: string) => void;
}): Promise<NoteDocument> {
	const { chatId, mode, engine, signal } = opts;
	const skill = fs.readFileSync(path.join(PATHS.root, "skills", "learnharness-notes", "SKILL.md"), "utf8");
	const topics = new Map(opts.passages.map(p => [p.messageId, p.topic]));
	const practiceTargets = new Map(
		opts.passages.filter(p => p.graphNodeIds?.length).map(p => [p.topic, p.graphNodeIds!]),
	);
	const limit = Math.max(1200, Math.min(96_000, Math.floor((engine.model.contextWindow - 2000) * 1.4)));
	const live = mode === "live";
	const submit = (lines: EvidenceLine[], instruction: string) => {
		const allowed = new Set(lines.flatMap(line => line.ids));
		return withBgLlmSlot(signal, () =>
			runSubmitAgent<Submission>({
				role: "notesWriter",
				chatId,
				engine,
				signal,
				systemPrompt: skill,
				prompt: `${instruction}\nSession title: ${JSON.stringify(opts.title)}\nSource passages:\n${lines.map(l => JSON.stringify(l)).join("\n")}`,
				toolName: "submit_notes",
				toolDescription: "Submit the overview and supported lecture-note sections.",
				parameters: schema,
				fill: input => input,
				neverSubmitted: "The notes writer did not submit a handout.",
				onStep: (usage, model) => opts.onUsage(usage, model),
				validate: draft => {
					for (const s of draft.sections) {
						if (s.sourceIds.some(id => !allowed.has(id))) return "Use only supplied source IDs.";
						if (live && new Set(s.sourceIds.map(id => topics.get(id))).size !== 1)
							return "Keep each live section within one source topic.";
					}
					if (live) {
						const covered = new Set(draft.sections.flatMap(s => s.sourceIds.map(id => topics.get(id))));
						if ([...allowed].some(id => !covered.has(topics.get(id)))) return "Include each supplied topic.";
					}
					try {
						for (const part of [
							draft.overview,
							...draft.sections.flatMap(s => [s.heading, ...s.blocks.map(b => b.text)]),
						])
							noteTextHtml(part, true);
					} catch {
						return "Repair the invalid TeX and submit again.";
					}
					return null;
				},
			}),
		);
	};
	let sources: EvidenceLine[] = opts.passages.map(p => ({ ids: [p.messageId], topic: p.topic, text: p.text }));
	let groups = batches(sources, limit);
	// Map long original transcripts, then reduce across them. No provider compaction cut or live draft enters a final handout.
	for (let level = 0; groups.length > 1; level++) {
		if (level >= 8) throw new Error("The lesson could not be condensed within this model’s context window.");
		sources = [];
		for (const group of groups) {
			signal.throwIfAborted();
			const digest = await submit(
				group,
				"Condense these passages into brief evidence for a later handout. Preserve distinct ideas, conditions, examples and source IDs. Aim for under one quarter of the input length.",
			);
			for (const section of digest.sections)
				sources.push({
					ids: section.sourceIds,
					topic: live ? topics.get(section.sourceIds[0]!) : undefined,
					text: noteSectionText(section),
				});
		}
		groups = batches(sources, limit);
	}
	signal.throwIfAborted();
	const written = await submit(
		sources,
		live
			? "Write concise live sections, one per supplied topic."
			: "Compose one finished handout. Choose its logical order, combine revisited concepts, and write an overview of the whole lesson.",
	);
	const used = new Set<string>();
	const sections = written.sections.map(section => {
		const base = createHash("sha256")
			.update(JSON.stringify([section.heading, section.sourceIds[0]]))
			.digest("hex")
			.slice(0, 14);
		let id = base;
		for (let i = 2; used.has(id); i++) id = base + "-" + i;
		used.add(id);
		const coveredTopics = [...new Set(section.sourceIds.map(source => topics.get(source)!).filter(Boolean))];
		const graphNodeIds = coveredTopics.flatMap(topic => practiceTargets.get(topic) ?? []);
		return {
			...section,
			id,
			nodeIds: opts.practice ? [] : coveredTopics,
			...(graphNodeIds.length ? { graphNodeIds: [...new Set(graphNodeIds)] } : {}),
		};
	});
	return { title: opts.title, overview: written.overview, sections };
}
