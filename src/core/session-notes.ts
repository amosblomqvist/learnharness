import type { CallUsage } from "./contracts/chat.ts";
import type { JobUsage } from "./contracts/jobs.ts";

export const noteBlockKinds = ["paragraph", "key idea", "definition", "theorem", "method", "example"] as const;
export type NoteBlockKind = (typeof noteBlockKinds)[number];
export interface NoteBlock {
	kind: NoteBlockKind;
	/** Descriptive label for new notes; older saved blocks may omit it. */
	title?: string;
	/** Ordered procedure, followed by the supporting explanation in text. */
	steps?: string[];
	text: string;
}
export interface WrittenSection {
	heading: string;
	sourceIds: string[];
	blocks: NoteBlock[];
}
export interface NoteSection extends WrittenSection {
	id: string;
	nodeIds: string[];
	graphNodeIds?: string[];
}
export interface NoteDocument {
	title: string;
	overview: string;
	/** New handouts include a reference page; older handouts and live notes may omit it. */
	quickReference?: NoteQuickReference;
	sections: NoteSection[];
}
export interface NoteQuickReference {
	decisions: { situation: string; approach: string }[];
	essentials: { title: string; text: string }[];
}
export interface NoteEdition {
	fingerprint: string;
	writtenAt: string;
	document: NoteDocument;
}
export type NoteMode = "handout" | "liveNotes";
export type NotesAction =
	| { action: "generate-handout" | "retry-handout-pdf" | "update-live-notes" }
	| { action: "set-live-notes-enabled"; enabled: boolean };
export interface NotesRun {
	id: string;
	chatId: string;
	title: string;
	mode: NoteMode;
	startedAt: number;
	activity: string;
	usage?: JobUsage;
}
export interface SessionNotesRecord {
	liveNotesEnabled: boolean;
	liveNotes: NoteEdition | null;
	handout: NoteEdition | null;
	pendingHandout?: NoteEdition;
	handoutPdfLayoutVersion?: number;
	topics: Record<string, string>;
	error: Partial<Record<NoteMode, string>>;
	failedLiveNotes?: string;
	usage: { at: string; mode: NoteMode; model: string; step: CallUsage }[];
}
/** Increment when cached handouts need to be typeset again from their saved text. */
export const HANDOUT_PDF_LAYOUT_VERSION = 3;
export interface NotesView {
	liveNotesEnabled: boolean;
	liveNotes: NoteEdition | null;
	handout: NoteEdition | null;
	eligible: boolean;
	handoutOutdated: boolean;
	running: NoteMode[];
	error: Partial<Record<NoteMode, string>>;
	handoutPdfPending: boolean;
	usage: { mode: NoteMode; calls: number; tokens?: number }[];
}
export const emptyNotesView = (): NotesView => ({
	liveNotesEnabled: false,
	liveNotes: null,
	handout: null,
	eligible: false,
	handoutOutdated: false,
	running: [],
	error: {},
	handoutPdfPending: false,
	usage: [],
});
export interface NotePassage {
	messageId: string;
	topic: string;
	text: string;
	graphNodeIds?: string[];
}
/** Section numbers belong to the renderer, including for previously saved notes. */
export function noteSectionHeading(heading: string): string {
	return heading.trim().replace(/^(?:\d+(?:\.\d+)*[.)]\s+)+(?=\S)/, "");
}
export function noteSectionText(section: WrittenSection): string {
	return [noteSectionHeading(section.heading), ...section.blocks.flatMap(b => [b.title, ...(b.steps ?? []), b.text].filter(Boolean))].join("\n");
}
export function noteQuickReferenceText(reference: NoteQuickReference): string {
	return [
		...reference.decisions.flatMap(row => [row.situation, row.approach]),
		...reference.essentials.flatMap(item => [item.title, item.text]),
	].join("\n");
}
export function noteHref(chatId: string, mode: NoteMode, sectionId?: string): string {
	return `/chat/${encodeURIComponent(chatId)}?notes=${mode}${sectionId ? `&section=${encodeURIComponent(sectionId)}` : ""}`;
}
/** Accept older links at the navigation boundary; the rest of the app uses the tab names. */
export function noteModeFromQuery(value: unknown): NoteMode | undefined {
	if (value === "handout" || value === "final") return "handout";
	if (value === "liveNotes" || value === "live") return "liveNotes";
	return undefined;
}
export interface NoteIndexEntry {
	chatId: string;
	sessionTitle: string;
	mode: NoteMode;
	sectionId: string;
	heading: string;
	text: string;
}
