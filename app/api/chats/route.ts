import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
import {
	compactionInFlight,
	createChat,
	FormBodyLimitError,
	isTurnRunning,
	listChats,
	readBoundedForm,
	readSettingsRecord,
	stageSessionDocuments,
	startDocumentExtraction,
	stores,
	titleFromPrompt,
	type StagedDocument,
} from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	/* Two request shapes share this route: the original JSON body, and —
	 * for document-sourced sessions (issue #175) — multipart form data
	 * with a "request" JSON field plus the chosen source "files" (PDF/MD/
	 * TXT, the notes-import caps). Files convert and stage SYNCHRONOUSLY
	 * here: a big PDF makes creation slower, but the created session's
	 * material is on disk and agent-readable before the response. */
	let body: { title?: unknown; kind?: unknown; graphContext?: unknown };
	let files: File[] = [];
	if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
		let form: FormData;
		try {
			form = await readBoundedForm(req, MAX_IMPORT_BODY_BYTES);
		} catch (err) {
			const oversized = err instanceof FormBodyLimitError;
			return Response.json({ error: oversized ? "Session documents are too large. Attach fewer or smaller files." : "Could not read the request. Try sending again." }, { status: oversized ? 413 : 400 });
		}
		const raw = form.get("request");
		try {
			body = typeof raw === "string" ? (JSON.parse(raw) as typeof body) : {};
		} catch {
			return Response.json({ error: "Invalid session request." }, { status: 400 });
		}
		files = form.getAll("files").filter((f): f is File => f instanceof File);
		if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });
		if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
			return Response.json({ error: "Session documents are too large. Max 25 MB in total." }, { status: 413 });
		}
	} else {
		body = (await req.json().catch(() => ({}))) as typeof body;
	}
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	// Source documents define a TEACHING session's curriculum (issue #175);
	// practice keeps drawing from the graph instead.
	if (files.length > 0 && kind === "practice") {
		return Response.json({ error: "Documents can only be attached to teaching sessions." }, { status: 400 });
	}
	// Stage BEFORE the record exists: a refused conversion (image-only PDF,
	// unreadable file) must not mint an orphan session — the learner's draft
	// stays put and the error names the file.
	let documents: StagedDocument[] = [];
	if (files.length > 0) {
		const staged = await stageSessionDocuments(files);
		if (!staged.ok) return Response.json({ error: staged.error }, { status: 400 });
		documents = staged.documents;
	}
	const chat = createChat(
		titleFromPrompt(title || "Untitled session"),
		kind,
		// The RECORD carries the durable refs only — the converted text lives
		// in the staged material file, not inside chats/*.json.
		documents.map(({ text: _text, notice: _notice, ...ref }) => ref),
	);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	// The documents' graph accumulation (issue #175): the ordinary import
	// pipeline, started in the background — creation never waits on the
	// model calls, and a refused/unavailable run leaves the session intact
	// (the agent reads the staged material directly).
	if (documents.length > 0) startDocumentExtraction(documents);
	return Response.json({ id: chat.id, title: chat.title });
}
