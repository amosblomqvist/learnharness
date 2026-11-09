/**
 * The document-sourced session's prompt segment (issue #175): when a
 * ChatRecord carries sourceDocuments, the prober and the teacher get this
 * segment APPENDED to their composed instructions — the same trailing
 * position and `---` join the narration rule uses (teacher-agent.ts
 * baseAgentOptions), keeping the static doctrine prefix byte-stable for
 * provider caching. It is per-session state, so it cannot be a static
 * prompts/ fragment (those compose identically for every session; the
 * override machinery does not apply to it).
 *
 * The segment states the contract the issue asks for: the documents — not
 * the goal text — define the curriculum. The agent reads the staged
 * material itself (the read tool; the path is agent-readable by design),
 * probes what the learner already understands OF THE DOCUMENT'S topics,
 * and plans/teaches through the document's content.
 */
import type { SourceDocumentRef } from "../core/contracts.ts";

/** The segment text for one session's documents; null when there are none
 * (the ordinary goal-described session — nothing is appended). */
export function sourceDocumentsSegment(documents: readonly SourceDocumentRef[] | undefined): string | null {
	if (!documents || documents.length === 0) return null;
	const lines = documents.map((doc) => `- ${doc.name} — read it at \`${doc.path}\``);
	return [
		"## Session source documents",
		"",
		"This session was created from documents he chose. They are the curriculum:",
		"",
		...lines,
		"",
		"- **Read the material before anything else.** Use the `read` tool on each path above (continue with `offset` until you have the whole document) BEFORE probing or planning. The document's content — its topics, its structure, its depth — defines what this lesson covers.",
		"- His goal text is a lens, not the syllabus: use it to judge emphasis and depth, never to import outside material he did not attach.",
		"- **Probe his understanding of the document's topics**, exactly as the probe doctrine demands: strands come from the document, and the map locates his edge within them.",
		"- **Plan and teach through the document's content** in the document's own order when it has one, adapting pace and depth to what probing revealed.",
		"- Stay honest to the text: teach what the document says, and say so plainly when his questions reach beyond it.",
	].join("\n");
}
