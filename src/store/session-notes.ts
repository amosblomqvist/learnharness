import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { NoteEdition, NoteMode } from "../core/session-notes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import type { CallUsage } from "../core/contracts/chat.ts";

export interface StoredNotes {
	version: 1;
	liveEnabled: boolean;
	live: NoteEdition | null;
	final: NoteEdition | null;
	pdfFile?: string;
	pending?: NoteEdition;
	topics: Record<string, string>;
	error: Partial<Record<NoteMode, string>>;
	failedLive?: string;
	usage: { at: string; mode: NoteMode; model: string; step: CallUsage }[];
}
function folder(id: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid session ID.");
	return path.join(PATHS.data, "notes", id);
}
function read(id: string): StoredNotes {
	let json: string;
	try {
		json = fs.readFileSync(path.join(folder(id), "record.json"), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return { version: 1, liveEnabled: false, live: null, final: null, topics: {}, error: {}, usage: [] };
	}
	const record: StoredNotes = JSON.parse(json);
	if (record.version !== 1) throw new Error("Unsupported session notes format.");
	return record;
}
function change(id: string, edit: (state: StoredNotes) => void) {
	const state = read(id);
	edit(state);
	fs.mkdirSync(folder(id), { recursive: true });
	writeFileAtomicSync(path.join(folder(id), "record.json"), JSON.stringify(state));
}
function pdfPath(id: string, file: string) {
	if (!/^[a-f0-9-]{36}\.pdf$/.test(file)) throw new Error("Invalid handout file.");
	return path.join(folder(id), file);
}
export const notesStore = {
	read,
	change,
	savePdf(id: string, edition: NoteEdition, bytes: Uint8Array) {
		const file = randomUUID() + ".pdf";
		fs.mkdirSync(folder(id), { recursive: true });
		fs.writeFileSync(pdfPath(id, file), bytes, { flag: "wx" });
		try {
			change(id, s => {
				s.final = edition;
				s.pdfFile = file;
				delete s.pending;
				delete s.error.final;
			});
		} catch (error) {
			fs.unlinkSync(pdfPath(id, file));
			throw error;
		}
		for (const old of fs.readdirSync(folder(id))) {
			if (old !== file && /^[a-f0-9-]{36}\.pdf$/.test(old)) fs.unlinkSync(pdfPath(id, old));
		}
	},
	pdf(id: string): Buffer | null {
		const file = read(id).pdfFile;
		return file ? fs.readFileSync(pdfPath(id, file)) : null;
	},
	delete(id: string) {
		fs.rmSync(folder(id), { recursive: true, force: true });
	},
};
