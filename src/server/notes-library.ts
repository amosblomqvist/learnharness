import { getGraph } from "../core/graph.ts";
import { noteQuickReferenceText, noteSectionHeading, noteSectionText, type NoteIndexEntry, type NoteMode } from "../core/session-notes.ts";
import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";

export function noteIndex(nodeId?: string, sessionIds?: string[]): NoteIndexEntry[] {
	const bySource = new Map<string, Set<string>>();
	if (nodeId) {
		const node = getGraph(stores.graphStore).nodes.find(n => n.id === nodeId);
		if (!node) return [];
		for (const point of node.provenance) {
			if (!point.messageId) continue;
			if (!bySource.has(point.chatId)) bySource.set(point.chatId, new Set());
			bySource.get(point.chatId)!.add(point.messageId);
		}
		// Practice targets point directly at an existing graph node without creating new extraction provenance.
		for (const chat of stores.chatStore.listChats()) {
			if (chat.kind === "practice" && !bySource.has(chat.id)) bySource.set(chat.id, new Set());
		}
	}
	const entries: NoteIndexEntry[] = [];
	const ids = nodeId ? [...bySource.keys()] : (sessionIds ?? stores.chatStore.listChats().map(c => c.id));
	for (const chatId of ids) {
		const state = stores.notesStore.read(chatId);
		const seen = new Set<string>();
		for (const mode of ["handout", "liveNotes"] as NoteMode[]) {
			const edition = state[mode];
			if (!edition) continue;
			for (const [i, section] of edition.document.sections.entries()) {
				const candidates =
					nodeId && !section.graphNodeIds?.includes(nodeId)
						? section.sourceIds.filter(id => bySource.get(chatId)?.has(id))
						: section.sourceIds;
				if (!candidates.length || candidates.every(id => seen.has(id))) continue;
				entries.push({
					chatId,
					sessionTitle: edition.document.title,
					mode,
					sectionId: section.id,
					heading: noteSectionHeading(section.heading),
					text: nodeId
						? ""
						: [
							i === 0 ? edition.document.overview : "",
							i === 0 && edition.document.quickReference ? noteQuickReferenceText(edition.document.quickReference) : "",
							noteSectionText(section),
						].filter(Boolean).join("\n"),
				});
			}
			// Prefer the published edition for evidence already available there.
			for (const s of edition.document.sections) for (const id of s.sourceIds) seen.add(id);
		}
	}
	return entries;
}
export function readTagsLibrary() {
	const directory = sourceDirectory.read();
	return {
		...directory,
		notes: noteIndex(
			undefined,
			directory.sources.filter(s => s.kind === "chat").map(s => s.id),
		),
	};
}
