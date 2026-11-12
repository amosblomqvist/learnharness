/**
 * Session → Anki .apkg (issue #11): a DETERMINISTIC export of the
 * session's actual quiz history as a ready-to-open Anki deck.
 *
 * What becomes a card (the session-markdown engine's view of evidence,
 * reused — never a second opinion about what a session taught):
 *
 *   - every GRADED quiz-family answer (quiz/probe multiple choice, and
 *     explain/recall free recall that carries the model's committed
 *     answer): Front = the question, Back = the correct answer (+ the
 *     quiz explanation when present). Dismissed checks never engaged, so
 *     they export nothing — same law as the markdown export's blocks.
 *   - every CONCLUDED practice problem (not dismissed) with a committed
 *     model solution: Front = the statement, Back = the model solution,
 *     joined through the SAME pose-side fold the markdown export uses
 *     (problemInputForConclude — the reveal law holds: a dismissed
 *     problem never reveals).
 *
 * The .apkg is the legacy Anki2 package every Anki since 2.0 imports: a
 * ZIP with `collection.anki2` (SQLite) and `media` (a JSON map — here
 * "{}", the export is text-only). SQLite is built with node:sqlite and
 * the ZIP is written by hand over node:zlib — zero new dependencies.
 *
 * Node-bound core (like core/graph.ts): NOT re-exported through the
 * browser barrel — node:sqlite has no browser polyfill. The server
 * barrel re-exports this module for the export route.
 *
 * DETERMINISM: GUIDs derive from chat id + message id + occurrence, and
 * note/card ids from the record's own message timestamps, so re-exporting
 * a session mints the same identities — Anki's importer matches notes by
 * GUID and updates in place instead of duplicating.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, problemInputForConclude } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { markdownContext } from "./session-markdown.ts";

// ─── evidence extraction (pure — the session-markdown view) ───────────────────

/** One flashcard of evidence, in transcript order. */
export interface AnkiCard {
	front: string;
	back: string;
	/** The record message the card was minted from — the GUID's anchor. */
	messageId: string;
	toolCallId: string;
	source: "quiz" | "recall" | "practice";
}

/** Non-empty trimmed string of an unknown value, else undefined. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The session's flashcard evidence: graded quiz-family answers plus
 * concluded (non-dismissed) practice problems with a committed solution.
 * Rides the session-markdown traversal context for the practice join —
 * the same call map and the same problemInputForConclude fold the
 * markdown export renders with, so the two exports can never disagree
 * about what a session's evidence is.
 */
export function ankiCardsOf(messages: readonly LhMessage[]): AnkiCard[] {
	const ctx = markdownContext(messages);
	const cards: AnkiCard[] = [];
	for (const message of messages) {
		if ((message as { role?: string }).role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (result.isError) continue; // retry context, not learning evidence

		// The quiz family: quiz/probe (multiple choice, client-graded) and
		// explain/recall (free recall). The full graded QuestionAnswerData
		// rides the result's details (question-core's buildAnswer — our own
		// code, trusted by the parse-seam law); the call's arguments stay
		// the model's authoring copy and are not re-read here.
		if (result.toolName === "quiz" || result.toolName === "probe") {
			const out = result.details as Partial<QuestionAnswerData> | null | undefined;
			if (out?.dismissed === true) continue; // skipped, never engaged
			const question = text(out?.questionText);
			if (question === undefined) continue;
			const options = Array.isArray(out?.options) ? out!.options! : [];
			const indices = Array.isArray(out?.correctIndices) ? out!.correctIndices! : [];
			const labels = indices
				.map((i) => options.find((o) => o.index === i))
				.map((o) => text(o?.label))
				.filter((l): l is string => l !== undefined);
			if (labels.length === 0) continue; // no resolvable correct answer
			const explanation = text(out?.explanation);
			cards.push({
				front: question,
				back: explanation !== undefined ? `${labels.join("; ")}\n\n${explanation}` : labels.join("; "),
				messageId: (message as { id?: string }).id ?? "",
				toolCallId: result.toolCallId,
				source: "quiz",
			});
			continue;
		}
		if (result.toolName === "explain" || result.toolName === "recall") {
			const out = result.details as Partial<QuestionAnswerData> | null | undefined;
			if (out?.dismissed === true) continue;
			const question = text(out?.questionText);
			// Free recall's back side is the model's COMMITTED answer (the
			// immutable correct answer posed before the learner replied) —
			// present on every current record; without it there is no back.
			const committed = text(out?.committed);
			if (question === undefined || committed === undefined) continue;
			cards.push({
				front: question,
				back: committed,
				messageId: (message as { id?: string }).id ?? "",
				toolCallId: result.toolCallId,
				source: "recall",
			});
			continue;
		}

		// Practice: one card per CONCLUDED problem. The outcome lives in the
		// conclude call's arguments (the results are bare acks — the practice
		// join), and the reveal is the modelSolution committed at POSE time,
		// folded by the same helper the markdown export renders with. A
		// dismissed problem never reveals — no card.
		if (result.toolName === PRACTICE_CONCLUDE_TOOL) {
			const args = ctx.calls.get(result.toolCallId)?.args;
			if (args?.outcome === "dismissed") continue; // the reveal law
			const input = problemInputForConclude(messages, result.toolCallId);
			const statement = text(input?.statement);
			const solution = text(input?.modelSolution);
			if (statement === undefined || solution === undefined) continue;
			cards.push({
				front: statement,
				back: solution,
				messageId: (message as { id?: string }).id ?? "",
				toolCallId: result.toolCallId,
				source: "practice",
			});
		}
	}
	return cards;
}

// ─── the Anki2 package builder (node:sqlite + node:zlib) ─────────────────────

/** node:sqlite needs Node ≥ 22.5 (unflagged from 23.4) — the clear guard
 *  the route surfaces as a 500 when the host runtime lacks it. */
export class AnkiExportUnavailableError extends Error {
	constructor() {
		super("Anki export requires Node 22.5+ (node:sqlite is unavailable on this runtime)");
		this.name = "AnkiExportUnavailableError";
	}
}

/** Lazily resolved so merely importing this module never throws on an
 *  older runtime; memoized null means the builtin is genuinely absent
 *  (old Node, or an Electron build where it still sits behind a flag). */
let sqliteModule: typeof import("node:sqlite") | null | undefined;
async function loadSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (sqliteModule !== undefined) return sqliteModule;
	try {
		sqliteModule = await import("node:sqlite");
	} catch {
		sqliteModule = null;
	}
	return sqliteModule;
}

/** One fixed note type for every export ("LearnHarness Basic"): a stable
 *  model id means each imported session REUSES the note type instead of
 *  littering the collection with per-session "Basic" clones. */
const MODEL_ID = 1748000000000;
const MODEL_NAME = "LearnHarness Basic";
const DECK_PREFIX = "LearnHarness::";

/** sha1 hex of a stable string — the GUID/source. */
function sha1(value: string): string {
	return createHash("sha1").update(value, "utf8").digest("hex");
}

/** Anki's duplicate-detection checksum: sha1 of the HTML-stripped first
 *  field, first 8 hex digits as an integer (anki.utils.fieldChecksum's
 *  shape; our fields are plain text, so the strip is a no-op guard). */
function fieldChecksum(front: string): number {
	const stripped = front.replace(/<[^>]+>/g, "");
	return parseInt(sha1(stripped).slice(0, 8), 16);
}

/** The exact Anki2 schema (schema ver 11 — the maximally compatible
 *  legacy .apkg layout every Anki since 2.0 imports). */
const ANKI2_SCHEMA = `
PRAGMA page_size=4096;
PRAGMA legacy_file_format=0;
CREATE TABLE col (
	id INTEGER PRIMARY KEY,
	crt INTEGER NOT NULL,
	mod INTEGER NOT NULL,
	scm INTEGER NOT NULL,
	ver INTEGER NOT NULL,
	dty INTEGER NOT NULL,
	usn INTEGER NOT NULL,
	ls INTEGER NOT NULL,
	conf TEXT NOT NULL,
	models TEXT NOT NULL,
	decks TEXT NOT NULL,
	dconf TEXT NOT NULL,
	tags TEXT NOT NULL
);
CREATE TABLE notes (
	id INTEGER PRIMARY KEY,
	guid TEXT NOT NULL,
	mid INTEGER NOT NULL,
	mod INTEGER NOT NULL,
	usn INTEGER NOT NULL,
	tags TEXT NOT NULL,
	flds TEXT NOT NULL,
	sfld TEXT NOT NULL,
	csum INTEGER NOT NULL,
	flags INTEGER NOT NULL,
	data TEXT NOT NULL
);
CREATE TABLE cards (
	id INTEGER PRIMARY KEY,
	nid INTEGER NOT NULL,
	did INTEGER NOT NULL,
	ord INTEGER NOT NULL,
	mod INTEGER NOT NULL,
	usn INTEGER NOT NULL,
	type INTEGER NOT NULL,
	queue INTEGER NOT NULL,
	due INTEGER NOT NULL,
	ivl INTEGER NOT NULL,
	factor INTEGER NOT NULL,
	reps INTEGER NOT NULL,
	lapses INTEGER NOT NULL,
	left INTEGER NOT NULL,
	odue INTEGER NOT NULL,
	odid INTEGER NOT NULL,
	flags INTEGER NOT NULL,
	data TEXT NOT NULL
);
CREATE TABLE revlog (
	id INTEGER PRIMARY KEY,
	cid INTEGER NOT NULL,
	usn INTEGER NOT NULL,
	ease INTEGER NOT NULL,
	ivl INTEGER NOT NULL,
	lastIvl INTEGER NOT NULL,
	factor INTEGER NOT NULL,
	time INTEGER NOT NULL,
	type INTEGER NOT NULL
);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

/** The minimal valid model (Basic: Front/Back, one Card 1 template) —
 *  the standard library shapes Anki itself writes for a fresh Basic type. */
function basicModel(modSeconds: number): Record<string, unknown> {
	return {
		id: MODEL_ID,
		name: MODEL_NAME,
		type: 0,
		mod: modSeconds,
		usn: 0,
		sortf: 0,
		did: 1,
		tmpls: [
			{
				name: "Card 1",
				ord: 0,
				qfmt: "{{Front}}",
				afmt: '{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}',
				bqfmt: "",
				bafmt: "",
				did: null,
			},
		],
		flds: [
			{ name: "Front", ord: 0, sticky: false, rtlo: false, font: "Arial", size: 20, media: [] },
			{ name: "Back", ord: 1, sticky: false, rtlo: false, font: "Arial", size: 20, media: [] },
		],
		css: ".card {\n\tfont-family: arial;\n\tfont-size: 20px;\n\ttext-align: center;\n\tcolor: black;\n\tbackground-color: white;\n}\n",
		latexPre:
			"\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
		latexPost: "\\end{document}",
		latexsvg: false,
		req: [[0, "any", [0]]],
		tags: [],
		vers: [],
	};
}

/** The col row's four JSON blobs (conf/models/decks/dconf) + scalar
 *  fields, as the values tuple the schema's column order demands. */
function colRow(
	title: string,
	deckId: number,
	crtSeconds: number,
	modSeconds: number,
	scmMs: number,
	noteCount: number,
): [number, number, number, number, number, number, number, number, string, string, string, string, string] {
	const day = Math.floor(crtSeconds / 86400);
	const conf = {
		activeDecks: [1],
		curDeck: 1,
		newSpread: 0,
		collapseTime: 1200,
		timeLim: 0,
		estTimes: true,
		dueCounts: true,
		curModel: String(MODEL_ID),
		nextPos: noteCount + 1,
		sortType: "noteFld",
		sortBackwards: false,
	};
	const decks = {
		"1": {
			id: 1,
			name: "Default",
			mod: 0,
			usn: 0,
			lrnToday: [0, 0],
			revToday: [0, 0],
			newToday: [0, 0],
			timeToday: [0, 0],
			collapsed: false,
			browserCollapsed: false,
			desc: "",
			dyn: 0,
			conf: 1,
			extendNew: 0,
			extendRev: 0,
		},
		[String(deckId)]: {
			id: deckId,
			name: `${DECK_PREFIX}${title}`,
			mod: modSeconds,
			usn: 0,
			lrnToday: [day, 0],
			revToday: [day, 0],
			newToday: [day, 0],
			timeToday: [day, 0],
			collapsed: false,
			browserCollapsed: false,
			desc: `Exported from LearnHarness session "${title}".`,
			dyn: 0,
			conf: 1,
			extendNew: 0,
			extendRev: 0,
		},
	};
	const dconf = {
		"1": {
			id: 1,
			name: "Default",
			mod: 0,
			usn: 0,
			maxTaken: 60,
			autoplay: true,
			timer: 0,
			replayq: true,
			new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20 },
			rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
			lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
			timerMin: 0,
		},
	};
	return [
		1,
		crtSeconds,
		modSeconds,
		scmMs,
		11, // schema ver — the legacy anki2 layout
		0,
		0,
		0,
		JSON.stringify(conf),
		JSON.stringify({ [String(MODEL_ID)]: basicModel(modSeconds) }),
		JSON.stringify(decks),
		JSON.stringify(dconf),
		"{}",
	];
}

export interface AnkiApkgInput {
	chatId: string;
	title: string;
	/** The record's createdAt (ISO) — the collection's creation stamp. */
	createdAt?: string;
	messages: readonly LhMessage[];
}

/** A strictly-increasing epoch-ms allocator seeded from each card's own
 *  message timestamp (stable in the record), so ids are deterministic
 *  across exports while still sorting in transcript order. */
class IdAllocator {
	private last = 0;
	constructor(private readonly fallbackBase: number) {}
	next(candidate: number): number {
		const id = Math.max(this.last + 1, Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : 0);
		this.last = id;
		return id;
	}
}

/**
 * Build the whole .apkg as bytes. Deterministic for the same record:
 * GUIDs from chat id + message id + occurrence, ids from message
 * timestamps, col stamps from the record's createdAt. Throws
 * AnkiExportUnavailableError when node:sqlite is missing.
 */
export async function buildAnkiApkg(input: AnkiApkgInput): Promise<Uint8Array<ArrayBuffer>> {
	const sqlite = await loadSqlite();
	if (sqlite === null) throw new AnkiExportUnavailableError();
	const cards = ankiCardsOf(input.messages);

	// Ids/stamps: seed from the record's own times, never Date.now().
	const parsedCreate = input.createdAt !== undefined ? Date.parse(input.createdAt) : NaN;
	const ids = cards.map((c) => messageTimestampOf(input.messages, c.messageId));
	const baseMs = Number.isFinite(parsedCreate)
		? parsedCreate
		: ids.find((t) => Number.isFinite(t) && t > 0) ?? 1_700_000_000_000;
	const crtSeconds = Math.floor(baseMs / 86_400_000) * 86_400; // day-start, Anki's crt convention
	const allocator = new IdAllocator(baseMs);
	const deckId = deckIdFor(input.chatId);

	const rows = cards.map((card, i) => {
		const noteId = allocator.next(ids[i] ?? 0);
		const cardId = allocator.next(ids[i] ?? 0);
		const occurrence = cards.slice(0, i).filter((c) => c.messageId === card.messageId).length;
		const guid = sha1(`lh-anki\x1f${input.chatId}\x1f${card.messageId}\x1f${occurrence}`);
		return { noteId, cardId, guid, card };
	});
	const lastId = rows.length > 0 ? rows[rows.length - 1]!.cardId : baseMs;
	const modSeconds = Math.floor(lastId / 1000);

	const db = new sqlite.DatabaseSync(":memory:") as DatabaseSync;
	try {
		db.exec(ANKI2_SCHEMA);
		db.prepare("INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
			...colRow(input.title, deckId, crtSeconds, modSeconds, Math.max(lastId, baseMs), rows.length),
		);
		const insertNote = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)");
		const insertCard = db.prepare("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
		rows.forEach(({ noteId, cardId, guid, card }, i) => {
			insertNote.run(
				noteId, // id (epoch ms)
				guid,
				MODEL_ID,
				Math.floor(noteId / 1000), // mod (epoch seconds)
				-1, // usn: local, unsynced
				"", // tags
				`${card.front}\x1f${card.back}`,
				card.front, // sfld: the sort field (text in Anki's own rows)
				fieldChecksum(card.front),
				0,
				"",
			);
			insertCard.run(
				cardId, // id (epoch ms)
				noteId,
				deckId,
				0, // ord: Card 1
				Math.floor(noteId / 1000), // mod
				-1,
				0, // type: new
				0, // queue: new
				i + 1, // due: the new-card position
				0, // ivl
				0, // factor
				0, // reps
				0, // lapses
				0, // left
				0, // odue
				0, // odid
				0,
				"",
			);
		});
		// node:sqlite cannot serialize an in-memory db to bytes; VACUUM INTO
		// writes a clean, deterministic copy to a scratch file we read back
		// and delete — the bytes ARE the export, nothing durable remains.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-"));
		try {
			const dbPath = path.join(dir, "collection.anki2");
			db.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
			return zipApkg(fs.readFileSync(dbPath), new Date(crtSeconds * 1000));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		db.close();
	}
}

/** The message a card was minted from → its timestamp (ms), 0 if unknown. */
function messageTimestampOf(messages: readonly LhMessage[], messageId: string): number {
	for (const message of messages) {
		if ((message as { id?: string }).id === messageId) {
			const t = (message as { timestamp?: unknown }).timestamp;
			return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
		}
	}
	return 0;
}

/** A stable deck id from the chat id (48-bit positive, never the Default 1)
 *  — re-exports land in the SAME deck instead of stacking duplicates. */
function deckIdFor(chatId: string): number {
	const id = parseInt(sha1(`lh-anki-deck\x1f${chatId}`).slice(0, 12), 16);
	return id > 1 ? id : 2;
}

// ─── the ZIP writer (~100 lines, no archiver dependency) ─────────────────────

function dosTime(date: Date): { time: number; date: number } {
	// UTC fields so the stamp is identical on every machine.
	const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
	const year = Math.max(date.getUTCFullYear(), 1980);
	const day = (year - 1980) << 9 | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
	return { time, date: day };
}

/** A minimal ZIP: local entries (deflate) + central directory + EOCD. */
function zipApkg(collection: Buffer, stamp: Date): Uint8Array<ArrayBuffer> {
	const { time, date } = dosTime(stamp);
	const entries = [
		{ name: "collection.anki2", data: collection },
		{ name: "media", data: Buffer.from("{}", "utf8") },
	];
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const compressed = deflateRawSync(entry.data, { level: 9 });
		const crc = crc32(entry.data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // local file header
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(8, 8); // method: deflate
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra length
		locals.push(local, name, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); // central directory header
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8); // flags
		central.writeUInt16LE(8, 10); // method: deflate
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30); // extra length
		central.writeUInt16LE(0, 32); // comment length
		central.writeUInt16LE(0, 34); // disk number
		central.writeUInt16LE(0, 36); // internal attributes
		central.writeUInt32LE(0, 38); // external attributes
		central.writeUInt32LE(offset, 42); // local header offset
		centrals.push(central, name);
		offset += 30 + name.length + compressed.length;
	}
	let centralSize = 0;
	for (const chunk of centrals) centralSize += chunk.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16); // central directory start
	eocd.writeUInt16LE(0, 20); // comment length
	return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}
