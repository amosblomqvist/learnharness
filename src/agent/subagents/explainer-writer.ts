import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExplainerResult } from "../../core/contracts.ts";
import { renderExplainer } from "../explainer/render.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { healToolRecord } from "../tools/heal.ts";
import { runSubagent } from "./pi-run.ts";

export interface ExplainerWriterOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	chatId?: string;
	maxSteps?: number;
}

const INSTRUCTIONS = `You are an explainer writer in a learning application. Create one diagram-led page for the learner. The brief is all you know about the lesson.
Use write_explainer to save the complete page source and render_explainer to render it; fix errors and render again. Ignore the bundled instructions for file locations, render.mjs, prepare, Glimpse and look.mjs.
Slides, video, PPTX, <ve-ask> and <ve-flow> models are unavailable. Do not use external resources, including CDNs. The page has no comments or reply feature: do not write <ve-ask> or text or components that expect a reader to send a reply or selected words. Ignore the bundled reply instructions.
Finish with 1–3 sentences of notes for the teacher, without HTML.`;

const PROMPT_FILES = ["SKILL.md", "references/diagrams.md", "references/kit.md", "references/style-guide.md", "references/themes.md", "references/motion.md"];
let promptPromise: Promise<string> | undefined;
function systemPrompt(): Promise<string> {
	return promptPromise ??= Promise.all(PROMPT_FILES.map(async (file) =>
		`\n\n--- ${file} ---\n${await readFile(path.join(process.cwd(), "src/agent/explainer-kit", file), "utf8")}`,
	)).then((parts) => INSTRUCTIONS + parts.join(""));
}

interface WriterState { source: string | null; renderedSource: string | null; html: string | null }
const writeInput = Type.Object({ source: Type.String({ description: "Complete page source." }) });
const renderInput = Type.Object({});

function createTools(state: WriterState, onActivity?: (line: string) => void): Record<string, AgentTool<any>> {
	return healToolRecord({
		write_explainer: {
			name: "write_explainer", label: "write_explainer",
			description: "Save the complete page source, replacing the previous source.", parameters: writeInput,
			execute: serverExecute("write_explainer", writeInput, async ({ source }) => {
				if (!source.trim()) return "ERROR: empty source.";
				state.source = source;
				onActivity?.("write_explainer");
				return "Saved. Call render_explainer to verify the page.";
			}),
		},
		render_explainer: {
			name: "render_explainer", label: "render_explainer",
			description: "Render the saved source and report errors or warnings.", parameters: renderInput,
			execute: serverExecute("render_explainer", renderInput, async () => {
				if (!state.source) return "ERROR: write the source first.";
				const source = state.source;
				const result = await renderExplainer(source);
				if (!result.ok) return `ERROR:\n${result.errors.join("\n")}`;
				state.renderedSource = source;
				state.html = result.html;
				onActivity?.("render_explainer: rendered");
				return `Rendered successfully.${result.warnings.length ? `\nWarnings:\n${result.warnings.join("\n")}` : ""}`;
			}),
		},
	});
}

export async function runExplainerWriter(input: { title: string; brief: string }, opts: ExplainerWriterOptions = {}): Promise<ExplainerResult> {
	const title = input.title.trim() || "Explainer";
	const state: WriterState = { source: null, renderedSource: null, html: null };
	try {
		const result = await runSubagent(Object.values(createTools(state, opts.onActivity)), {
			role: "demoBuilder", engine: opts.engine, systemPrompt: await systemPrompt(),
			prompt: `Explainer title: ${title}\nBrief (all you know about the lesson):\n${input.brief.trim() || "(no brief)"}\nWrite and render the page, then finish with notes.`,
			maxTurns: opts.maxSteps ?? 24, abortSignal: opts.abortSignal, onUsage: opts.onUsage,
			onToolStart: (name) => opts.onActivity?.(name), chatId: opts.chatId,
		});
		if (!state.source) return { title, html: "", notes: "FAILED: the writer never wrote a source." };
		if (state.renderedSource !== state.source || !state.html) {
			opts.onActivity?.("final verification");
			const rendered = await renderExplainer(state.source);
			if (!rendered.ok) return { title, html: "", notes: `FAILED: ${rendered.errors.join("; ")}` };
			state.html = rendered.html;
		}
		return { title, html: state.html!, notes: result.text.trim() || undefined };
	} catch (err) {
		return { title, html: "", notes: `FAILED: ${err instanceof Error ? err.message : String(err)}` };
	}
}
