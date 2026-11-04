import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";

interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	/** `attach` uploads the draft's context files once the chat exists —
	 *  BEFORE navigation (File objects can't cross it); only their ids ride
	 *  the opening-prompt handover. An upload failure throws with the
	 *  session kept, so the retry reuses it and uploads only what's left. */
	async start(
		body: SessionCreation,
		fetchLike: typeof fetch,
		settingsIdentity?: string,
		attach?: { identity: string; upload: (chatId: string) => Promise<string[]> },
	): Promise<string> {
		const identity = JSON.stringify([body, settingsIdentity, attach?.identity ?? ""]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(OPENING_PROMPT_FAILURE);
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		const attachmentIds = attach ? await attach.upload(this.created.id) : undefined;
		if (!stashOpeningPrompt(this.created.id, body.title, false, attachmentIds)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}
