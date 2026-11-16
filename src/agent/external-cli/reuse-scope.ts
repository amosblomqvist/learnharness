import { isDeepStrictEqual } from "node:util";

import type { Message } from "@earendil-works/pi-ai";

import { conversationForReuse } from "./reuse-context.ts";

/** The owner, session, request and conversation a live process serves; compared before reusing it. */
export class ReuseScope {
	constructor(
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	/** Same owner, session and request, and `messages` extend the served conversation by exactly `added` messages. */
	matches(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], added: number): boolean {
		const conversation = conversationForReuse(messages);
		return owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + added;
	}

	reset(messages: Message[]): void { this.conversation = structuredClone(conversationForReuse(messages)); }

	append(message: Message): void { this.conversation.push(...structuredClone(conversationForReuse([message]))); }
}
