/** `write_note` — the teacher's one write surface (2026-11-12).
 *
 *  Why it exists: every learner-facing artefact so far was read-only (the file
 *  tools are read-only by construction), so a session's notes had to be copied
 *  out by hand. This tool writes ONE markdown note into a single configured
 *  folder — nothing else on the filesystem is writable, no directory creation
 *  outside it, no overwrite unless explicitly asked.
 *
 *  Target: LH_NOTES_DIR (absolute) or `<data>/notes` by default. On a
 *  self-hosted install this can point at an Obsidian subfolder; the folder is
 *  the entire authority the model has. */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../../config.ts";
import { serverExecute } from "../tool-execute.ts";

const MAX_NOTE_CHARS = 200_000;
const MAX_NAME = 80;

export function notesDir(): string {
	const configured = process.env.LH_NOTES_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(PATHS.data, "notes");
}

/** One file name, no folders: the last path segment, hostile characters and a
 *  trailing `.md` normalized away. Unicode letters survive (Turkish titles). */
export function sanitizeNoteName(input: string): string {
	const last = (input ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
	const cleaned = last
		.replace(/\.md$/i, "")
		.replace(/[\u0000-\u001f<>:"|?*]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME)
		.replace(/^\.+/, "");
	return cleaned || "note";
}

export interface WrittenNote {
	path: string;
	name: string;
	/** True when an existing note with this name was kept and a suffixed copy written. */
	suffixed: boolean;
}

/** Write under `dir` without ever replacing an existing note unless asked. */
export function writeNote(dir: string, title: string, body: string, overwrite = false): WrittenNote {
	const base = path.resolve(dir);
	fs.mkdirSync(base, { recursive: true });
	const stem = sanitizeNoteName(title);
	let name = `${stem}.md`;
	let target = path.join(base, name);
	if (!target.startsWith(base + path.sep)) throw new Error("unsafe note path");
	let suffixed = false;
	if (!overwrite && fs.existsSync(target)) {
		for (let i = 2; i < 100; i++) {
			name = `${stem}-${i}.md`;
			target = path.join(base, name);
			if (!fs.existsSync(target)) break;
		}
		suffixed = true;
	}
	fs.writeFileSync(target, body, "utf-8");
	return { path: target, name, suffixed };
}

export const writeNoteTool: AgentTool<any> = {
	name: "write_note",
	label: "write_note",
	description:
		"Save ONE markdown note into your notes folder (the only writable location). " +
		"Use it when the learner asks for notes, a summary, a flashcard block or a study sheet they will keep. " +
		"`title` becomes the file name (a .md is added); an existing note with the same name is never replaced " +
		"unless `overwrite` is true — otherwise a -2 copy is written. Body is markdown, max 200k characters.",
	parameters: Type.Object({
		title: Type.String({ description: "File name without a path, e.g. 'SecAI Domain 1 - weak areas'" }),
		body: Type.String({ description: "Full markdown content of the note" }),
		overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing note with the same name" })),
	}),
	execute: serverExecute(
		"write_note",
		Type.Object({
			title: Type.String(),
			body: Type.String(),
			overwrite: Type.Optional(Type.Boolean()),
		}),
		async ({ title, body, overwrite }): Promise<string> => {
			if (!body.trim()) return "write_note failed: the body is empty.";
			if (body.length > MAX_NOTE_CHARS) return `write_note failed: the body is ${body.length} chars, the limit is ${MAX_NOTE_CHARS}.`;
			try {
				const written = writeNote(notesDir(), title, body, overwrite === true);
				return (
					`Note saved: ${written.path}` +
					(written.suffixed ? " (an existing note kept its name; this is a suffixed copy — say so to the learner)" : "")
				);
			} catch (error) {
				return `write_note failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	),
};
