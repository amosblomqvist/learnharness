import type { GraphNode } from "./contracts/graph.ts";
import type { LhViewMessage } from "./view.ts";

/** Message-granular graph links (owner, 2026-10-13). Persisted provenance and
 * native IDs already carry everything needed; only the render seam is new. */
export function messageAnchorId(messageId: string): string {
	return `message-${messageId}`;
}

export function messageIdFromHash(hash: string): string | null {
	try {
		const anchor = decodeURIComponent(hash.replace(/^#/, ""));
		return anchor.startsWith("message-") && anchor.length > "message-".length
			? anchor.slice("message-".length)
			: null;
	} catch {
		return null;
	}
}

/** Old empty anchors do not mask a later real one. Ledger order, not date or
 * lexical order, selects the FIRST recorded message in this source. */
export function propositionSessionHref(node: Pick<GraphNode, "provenance">, chatId: string): string {
	const messageId = node.provenance.find((p) => p.chatId === chatId && p.messageId !== "")?.messageId;
	return `/chat/${encodeURIComponent(chatId)}${messageId ? `#${encodeURIComponent(messageAnchorId(messageId))}` : ""}`;
}

/** projectView's text-part identity is <native message ID>-t<text index>.
 * Assistant GROUP IDs cannot identify an individual extraction source. */
export function textPartMessageId(partId: string | undefined): string | null {
	return partId?.match(/^(.*)-t\d+$/)?.[1] || null;
}

/** One DOM anchor per native teacher message, at its first non-empty prose
 * block. Empty text blocks and intervening tools/thinking do not steal it. */
export function firstSourceTextParts(messages: readonly LhViewMessage[]): Map<string, string> {
	const first = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim() || !part.id) continue;
			const messageId = textPartMessageId(part.id);
			if (messageId && !first.has(messageId)) first.set(messageId, part.id);
		}
	}
	return first;
}
