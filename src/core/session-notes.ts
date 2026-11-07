import type { CallUsage } from "./contracts/chat.ts";
import type { JobUsage } from "./contracts/jobs.ts";

export const noteBlockKinds = ["paragraph", "key idea", "definition", "theorem", "method", "example"] as const;
export type NoteBlockKind = (typeof noteBlockKinds)[number];
export interface NoteBlock {
	kind: NoteBlockKind;
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
	sections: NoteSection[];
}
export interface NoteEdition {
	fingerprint: string;
	writtenAt: string;
	document: NoteDocument;
}
export type NoteMode = "live" | "final";
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
	liveEnabled: boolean;
	live: NoteEdition | null;
	final: NoteEdition | null;
	pending?: NoteEdition;
	topics: Record<string, string>;
	error: Partial<Record<NoteMode, string>>;
	failedLive?: string;
	usage: { at: string; mode: NoteMode; model: string; step: CallUsage }[];
}
export interface NotesView {
	liveEnabled: boolean;
	live: NoteEdition | null;
	final: NoteEdition | null;
	eligible: boolean;
	outdated: boolean;
	running: NoteMode[];
	error: Partial<Record<NoteMode, string>>;
	pdfPending: boolean;
	usage: { mode: NoteMode; calls: number; tokens?: number }[];
}
export const emptyNotesView = (): NotesView => ({
	liveEnabled: false,
	live: null,
	final: null,
	eligible: false,
	outdated: false,
	running: [],
	error: {},
	pdfPending: false,
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
	return [noteSectionHeading(section.heading), ...section.blocks.map(b => b.text)].join("\n");
}
export function noteHref(chatId: string, mode: NoteMode, sectionId?: string): string {
	return `/chat/${encodeURIComponent(chatId)}?notes=${mode}${sectionId ? `&section=${encodeURIComponent(sectionId)}` : ""}`;
}
export interface NoteIndexEntry {
	chatId: string;
	sessionTitle: string;
	mode: NoteMode;
	sectionId: string;
	heading: string;
	text: string;
}
