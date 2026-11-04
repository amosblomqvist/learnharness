import { createHash, randomUUID } from "node:crypto";

export type CliLaunch = { id: string; resume: boolean; resumeAfter: number };

type CliSessionRecord = { id: string; configKey: string; historyLength: number; historyKey: string };

function hasRole(entry: unknown, role: string): entry is { role: string } {
	return typeof entry === "object" && entry !== null && "role" in entry && entry.role === role;
}

export function freshLaunch(): CliLaunch {
	return { id: randomUUID(), resume: false, resumeAfter: 0 };
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The CLI streams thinking as empty text plus a signature, so those blocks must not decide reuse. */
function historyKey(conversation: unknown[]): string {
	return digest(conversation.map((entry) => {
		if (!hasRole(entry, "assistant") || !("content" in entry) || !Array.isArray(entry.content)) return entry;
		const content: unknown[] = entry.content;
		return { ...entry, content: content.filter((block) => !(typeof block === "object" && block !== null && "type" in block && block.type === "thinking")) };
	}));
}

/** Which CLI session each Pi sessionId can resume. In memory only: after a
 * server restart the next message starts a new CLI session with a segmented replay. */
export class CliSessions {
	private readonly records = new Map<string, CliSessionRecord>();

	/** Claims the record: any launch that does not end in `complete` leaves the chat without one. */
	begin(sessionId: string, configuration: unknown, conversation: unknown[]): CliLaunch {
		const record = this.records.get(sessionId);
		this.records.delete(sessionId);
		if (
			record
			&& record.configKey === digest(configuration)
			&& conversation.length > record.historyLength
			&& historyKey(conversation.slice(0, record.historyLength)) === record.historyKey
			&& conversation.slice(record.historyLength).every((entry) => hasRole(entry, "user"))
		) {
			return { id: record.id, resume: true, resumeAfter: record.historyLength };
		}
		return freshLaunch();
	}

	complete(sessionId: string, cliSessionId: string, configuration: unknown, conversation: unknown[]): void {
		this.records.set(sessionId, {
			id: cliSessionId,
			configKey: digest(configuration),
			historyLength: conversation.length,
			historyKey: historyKey(conversation),
		});
	}
}
