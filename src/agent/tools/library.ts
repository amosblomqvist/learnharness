import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIBRARY_TAG_LABELS } from "../../core/contracts.ts";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { getHeadless, type HeadlessApi } from "../subagents/headless.ts";
import { readUnits, searchUnits, unitLabel, viewUnits, type LibraryReadable } from "../library/readable.ts";
import { dispatchJob, PDF_ACK, type JobToolContext } from "./jobs.ts";

/**
 * THE COURSE-LIBRARY TOOLS (course library wave, 2026-10-29): direct,
 * same-turn reading of the chat's ATTACHED library files — nothing else
 * in the library is reachable (the scope is the server-resolved file list,
 * re-read per call so a mid-session attach lands immediately).
 *
 * library_brief is the background path: it dispatches a pdf job naming a
 * library file (the runner reads it with the library reader), so it rides
 * the pdf job's toggle and the async protocol.
 *
 * Tool contract (the web.ts law): never throw into the agent loop — every
 * failure is an error STRING the model adapts to.
 */

export interface LibraryToolContext {
	/** The chat's in-scope files, resolved fresh per call. */
	files(): LibraryReadable[];
	/** The consuming model (image resize limits + vision support note). */
	model?: Pick<Model<Api>, "input" | "inputLimits">;
	headless?: HeadlessApi;
	/** Present = library_brief is available (background pdf jobs). */
	jobs?: JobToolContext;
}

const fileParam = Type.String({ description: "The file: its id (file_…) or library path from the materials list." });
const unitsParam = Type.String({ description: "Pages/slides/sections: 'all', '1-5', '1,3,7', or '3'." });

/** Resolve a model-supplied file reference: id, full path, or a unique
 *  file name. Returns the file or an error string listing what exists. */
function resolveFile(files: LibraryReadable[], ref: string): LibraryReadable | string {
	const wanted = ref.trim();
	const byId = files.find((f) => f.id === wanted);
	if (byId) return byId;
	const byPath = files.find((f) => f.path === wanted || f.path.toLowerCase() === wanted.toLowerCase());
	if (byPath) return byPath;
	const byName = files.filter((f) => f.name.toLowerCase() === wanted.toLowerCase());
	if (byName.length === 1) return byName[0]!;
	if (files.length === 0) return "No course materials are attached to this chat.";
	const why = byName.length > 1 ? `"${ref}" matches several files — use the id.` : `No attached file matches "${ref}".`;
	return `${why} Attached files:\n${files.map((f) => `- ${f.id}  ${f.path}`).join("\n")}`;
}

/** One manifest-style line per file (library_ls). */
export function describeLibraryFile(file: LibraryReadable): string {
	const label = unitLabel(file);
	const size = label === "image" ? "image" : file.pages !== undefined ? `${file.pages} ${label}${file.pages === 1 ? "" : "s"}` : `? ${label}s`;
	const state = file.status === "processing" ? ", importing" : file.status === "failed" ? `, import failed: ${file.error ?? "unknown"}` : "";
	return `${file.id} | ${file.path} | ${file.tag ? LIBRARY_TAG_LABELS[file.tag] : "Reference"} | ${file.format.toUpperCase()}, ${size}${state}`;
}

const lsInput = Type.Object({});
const readInput = Type.Object({ file: fileParam, units: unitsParam });
const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Text to find (case-insensitive, literal)." }),
	file: Type.Optional(Type.String({ description: "Limit to one file (id or path); omit to search every attached file." })),
});
const viewInput = Type.Object({
	file: fileParam,
	units: Type.Optional(unitsParam),
	dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300, description: "Render DPI for pages/slides: 100 text, 150 default, 200 dense." })),
});
const briefInput = Type.Object({
	file: fileParam,
	question: Type.String({ description: "What you need from the file. The reader sees nothing else of the lesson." }),
});

function errorText(name: string, err: unknown): string {
	return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
}

export function libraryTools(ctx: LibraryToolContext): Record<string, AgentTool<any>> {
	const tools: Record<string, AgentTool<any>> = {
		library_ls: {
			name: "library_ls",
			label: "library_ls",
			description: "List the course materials attached to this chat: id | library path | tag | format and size.",
			parameters: lsInput,
			execute: serverExecute("library_ls", lsInput, async () => {
				const files = ctx.files();
				return files.length ? files.map(describeLibraryFile).join("\n") : "No course materials are attached to this chat.";
			}),
		},
		library_read: {
			name: "library_read",
			label: "library_read",
			description:
				"Read the text of an attached course file by page / slide / section (speaker notes included). " +
				"Output caps at 24,000 characters — read in ranges for long files.",
			parameters: readInput,
			execute: serverExecute("library_read", readInput, async ({ file, units }) => {
				const resolved = resolveFile(ctx.files(), file);
				if (typeof resolved === "string") return resolved;
				try {
					return (await readUnits(resolved, units)).text;
				} catch (err) {
					return errorText("library_read", err);
				}
			}),
		},
		library_search: {
			name: "library_search",
			label: "library_search",
			description: "Find a term across the attached course files (or one file) — returns matching pages/slides/sections with snippets.",
			parameters: searchInput,
			execute: serverExecute("library_search", searchInput, async ({ query, file }) => {
				const files = ctx.files();
				let targets = files;
				if (file) {
					const resolved = resolveFile(files, file);
					if (typeof resolved === "string") return resolved;
					targets = [resolved];
				}
				if (targets.length === 0) return "No course materials are attached to this chat.";
				const out: string[] = [];
				for (const target of targets) {
					if (target.status !== "ready" || target.format === "image") continue;
					try {
						const r = await searchUnits(target, query, 10);
						if (r.units.length) out.push(`## ${target.path} (${target.id})\n${r.text}`);
					} catch (err) {
						out.push(`## ${target.path}\n${errorText("library_search", err)}`);
					}
				}
				return out.length ? out.join("\n\n") : `No matches for "${query}".`;
			}),
		},
		library_view: {
			name: "library_view",
			label: "library_view",
			description:
				"LOOK at an attached course file: pages/slides rendered as images (equations, diagrams, handwriting, layout), " +
				"an extracted file's embedded pictures, or an image file. Max 6 units per call.",
			parameters: viewInput,
			execute: serverExecute("library_view", viewInput, async ({ file, units, dpi }): Promise<string | ImageFileResult> => {
				const resolved = resolveFile(ctx.files(), file);
				if (typeof resolved === "string") return resolved;
				try {
					const r = await viewUnits(resolved, units ?? "1", {
						headless: ctx.headless ?? getHeadless(),
						dpi,
						resize: ctx.model?.inputLimits?.images?.resize,
					});
					const notes = [r.text || `${r.images.length} image(s)`];
					if (ctx.model && !ctx.model.input.includes("image")) {
						notes.push("[Current model does not support images. The images will be omitted from this request.]");
					}
					return { text: notes.join("\n"), ...(r.images.length ? { images: r.images } : {}) };
				} catch (err) {
					return errorText("library_view", err);
				}
			}),
		},
	};
	if (ctx.jobs) {
		const jobs = ctx.jobs;
		tools.library_brief = {
			name: "library_brief",
			label: "library_brief",
			description:
				"Dispatch a background reader for ONE attached course file (any format) that returns a cited brief answering your question — " +
				"for digesting a whole lecture or test without spending your own context. ASYNC and fire-and-forget: your turn continues; " +
				"the brief arrives later as a new message. For a quick look at a few pages or one question, use library_read / library_view.",
			parameters: briefInput,
			execute: serverExecute("library_brief", briefInput, ({ file, question }, { toolCallId }) => {
				const resolved = resolveFile(ctx.files(), file);
				if (typeof resolved === "string") return resolved;
				return dispatchJob(jobs, "pdf", toolCallId, PDF_ACK, { path: resolved.path, question, fileId: resolved.id });
			}),
		};
	}
	return tools;
}
