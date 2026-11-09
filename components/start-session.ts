import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";

interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
	/** Source documents attached at creation (issue #175, teach only):
	 * the files ride a multipart body; the server converts and stages them
	 * before creating the session. */
	sourceDocuments?: readonly File[];
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		// Files cannot ride JSON, and a File stringifies to {} — the retry
		// identity carries name+size so a changed document set is a new start.
		const { sourceDocuments, ...json } = body;
		const identity = JSON.stringify([json, sourceDocuments?.map((f) => [f.name, f.size]) ?? [], settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const res = await (sourceDocuments && sourceDocuments.length > 0
				? this.createWithDocuments(json, sourceDocuments, fetchLike)
				: fetchLike("/api/chats", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}));
			if (!res.ok) {
				// Surface the server's reason when it names one (a refused
				// document conversion is actionable; a bare failure is not).
				const detail = await res.json().catch(() => null) as { error?: unknown } | null;
				throw new Error(
					typeof detail?.error === "string" && detail.error
						? `${OPENING_PROMPT_FAILURE} ${detail.error}`
						: OPENING_PROMPT_FAILURE,
				);
			}
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		if (!stashOpeningPrompt(this.created.id, body.title)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}

	/** The document-sourced create (issue #175): "request" carries the JSON
	 * body, "files" the chosen documents (the notes-import multipart shape). */
	private createWithDocuments(json: Omit<SessionCreation, "sourceDocuments">, files: readonly File[], fetchLike: typeof fetch): Promise<Response> {
		const form = new FormData();
		form.append("request", JSON.stringify(json));
		for (const file of files) form.append("files", file);
		return fetchLike("/api/chats", { method: "POST", body: form });
	}
}
