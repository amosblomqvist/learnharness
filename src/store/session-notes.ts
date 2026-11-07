import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { NoteEdition, SessionNotesRecord } from "../core/session-notes.ts";
import type { SessionNotesStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

interface StoredNotes extends SessionNotesRecord {
	pdfFile?: string;
}
// Keep the v1 disk format readable by earlier builds. Legacy names stop at this adapter.
interface StoredNotesV1 {
	version: 1;
	liveEnabled: boolean;
	live: NoteEdition | null;
	final: NoteEdition | null;
	pending?: NoteEdition;
	failedLive?: string;
	topics: SessionNotesRecord["topics"];
	error: Partial<Record<"live" | "final", string>>;
	usage: (Omit<SessionNotesRecord["usage"][number], "mode"> & { mode: "live" | "final" })[];
	pdfFile?: string;
}
function fromStoredNotes(record: StoredNotesV1): StoredNotes {
	return {
		liveNotesEnabled: record.liveEnabled,
		liveNotes: record.live,
		handout: record.final,
		pendingHandout: record.pending,
		failedLiveNotes: record.failedLive,
		topics: record.topics,
		error: {
			...(record.error.live !== undefined ? { liveNotes: record.error.live } : {}),
			...(record.error.final !== undefined ? { handout: record.error.final } : {}),
		},
		usage: record.usage.map(entry => ({ ...entry, mode: entry.mode === "live" ? "liveNotes" : "handout" })),
		pdfFile: record.pdfFile,
	};
}
function toStoredNotes(record: StoredNotes): StoredNotesV1 {
	return {
		version: 1,
		liveEnabled: record.liveNotesEnabled,
		live: record.liveNotes,
		final: record.handout,
		pending: record.pendingHandout,
		failedLive: record.failedLiveNotes,
		topics: record.topics,
		error: {
			...(record.error.liveNotes !== undefined ? { live: record.error.liveNotes } : {}),
			...(record.error.handout !== undefined ? { final: record.error.handout } : {}),
		},
		usage: record.usage.map(entry => ({ ...entry, mode: entry.mode === "liveNotes" ? "live" : "final" })),
		pdfFile: record.pdfFile,
	};
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
		return { liveNotesEnabled: false, liveNotes: null, handout: null, topics: {}, error: {}, usage: [] };
	}
	const record: StoredNotesV1 = JSON.parse(json);
	if (record.version !== 1) throw new Error("Unsupported session notes format.");
	return fromStoredNotes(record);
}
function change(id: string, edit: (state: StoredNotes) => void) {
	const state = read(id);
	edit(state);
	fs.mkdirSync(folder(id), { recursive: true });
	writeFileAtomicSync(path.join(folder(id), "record.json"), JSON.stringify(toStoredNotes(state)));
}
function pdfPath(id: string, file: string) {
	if (!/^[a-f0-9-]{36}\.pdf$/.test(file)) throw new Error("Invalid handout file.");
	return path.join(folder(id), file);
}
export const notesStore: SessionNotesStore = {
	read,
	change,
	saveHandoutPdf(id, edition, bytes) {
		const file = randomUUID() + ".pdf";
		fs.mkdirSync(folder(id), { recursive: true });
		fs.writeFileSync(pdfPath(id, file), bytes, { flag: "wx" });
		try {
			change(id, s => {
				s.handout = edition;
				s.pdfFile = file;
				delete s.pendingHandout;
				delete s.error.handout;
			});
		} catch (error) {
			fs.unlinkSync(pdfPath(id, file));
			throw error;
		}
		for (const old of fs.readdirSync(folder(id))) {
			if (old !== file && /^[a-f0-9-]{36}\.pdf$/.test(old)) fs.unlinkSync(pdfPath(id, old));
		}
	},
	handoutPdf(id: string): Buffer | null {
		const file = read(id).pdfFile;
		return file ? fs.readFileSync(pdfPath(id, file)) : null;
	},
	delete(id: string) {
		fs.rmSync(folder(id), { recursive: true, force: true });
	},
};
