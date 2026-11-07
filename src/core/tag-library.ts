import { fuzzyScore } from "./fuzzy.ts";
import { readContentSpans } from "./content-reader.ts";
import { folderTagIds, placementOf, type SourceDirectory } from "./source-organization.ts";
import type { NoteIndexEntry } from "./session-notes.ts";

export type LibraryScope = { kind: "all" | "untagged" } | { kind: "folder" | "tag"; id: string };
export function libraryRows(
	library: SourceDirectory & { notes: NoteIndexEntry[] },
	scope: LibraryScope,
	query: string,
) {
	const { organization } = library;
	const tags = new Map(organization.tags?.map(t => [t.id, t]));
	const scopedTags = scope.kind === "folder" ? folderTagIds(organization, scope.id) : undefined;
	const bySource = new Map<string, NoteIndexEntry[]>();
	for (const note of library.notes) {
		if (!bySource.has(note.chatId)) bySource.set(note.chatId, []);
		bySource.get(note.chatId)!.push(note);
	}
	const q = query.trim();
	return library.sources
		.flatMap(source => {
			if (source.kind === "missing") return [];
			const label = source.label ?? source.id;
			const placement = placementOf(organization, source.id);
			const labels = (placement?.tagIds ?? []).flatMap(id => tags.get(id) ?? []);
			if (scope.kind === "tag" && !labels.some(t => t.id === scope.id)) return [];
			if (scope.kind === "untagged" && labels.length) return [];
			if (scopedTags && !labels.some(t => scopedTags.has(t.id))) return [];
			const notes = bySource.get(source.id) ?? [];
			const matches = q ? notes.filter(n => fuzzyScore(q, n.heading, n.text) !== null) : [];
			if (
				q &&
				!matches.length &&
				fuzzyScore(q, label, source.filePath ?? "", ...labels.map(t => t.name)) === null
			)
				return [];
			return [{ source, label, labels, notes, matches }];
		})
		.sort(
			(a, b) =>
				(b.source.createdAt ?? "").localeCompare(a.source.createdAt ?? "") ||
				(a.source.label ?? "").localeCompare(b.source.label ?? ""),
		);
}
export function matchingPassage(text: string, query: string): string {
	const plain = text.replace(/\s+/g, " ").trim();
	const tokens = query.toLowerCase().trim().split(/\s+/);
	const i = Math.min(...tokens.map(t => plain.toLowerCase().indexOf(t)).filter(n => n >= 0));
	let start = Number.isFinite(i) ? Math.max(0, i - 36) : 0;
	let end = start + 145;
	let position = 0;
	for (const span of readContentSpans(plain)) {
		const next = position + span.raw.length;
		if (span.kind === "math") {
			if (position < start && start < next) start = position;
			if (position < end && end < next) end = next;
		}
		position = next;
		if (position >= end) break;
	}
	return (start ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
}
