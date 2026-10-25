"use client";

/**
 * RETRY (#122): the always-visible `↻ Retry` under the agent's LAST
 * message. It discards the agent span since the learner's last input and
 * reruns from that input (session-core regenerate). Placement is a pure
 * fold over the view (retryPlacement) so the render pins need no session.
 */

import { RotateCcwIcon } from "lucide-react";
import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import type { LhViewMessage } from "@/src/core";

/** Where Retry renders: under the last assistant group ("group"), under
 *  the error banner when the transcript ends on a learner-side message
 *  (an errored turn that saved no reply — "error"), or nowhere. Hidden
 *  while a turn runs or a compaction holds the model gate; a pending
 *  question does NOT hide it (the unanswered question goes with the span). */
export function retryPlacement(input: {
	messages: readonly LhViewMessage[];
	busy: boolean;
	compacting: boolean;
	hasError: boolean;
	/** The last native message carries a server-stamped id. A client-minted
	 *  `c_` id (an optimistic send that never landed, or a reply whose settle
	 *  sync is pending) is not in the record: Retry would only 400 as stale. */
	lastServerStamped: boolean;
}): "group" | "error" | null {
	if (input.busy || input.compacting || !input.lastServerStamped) return null;
	const last = input.messages.at(-1);
	if (!last) return null;
	if (last.role === "assistant") return "group";
	return input.hasError ? "error" : null;
}

export function RetryAction({ onRetry }: { onRetry: () => void }) {
	return (
		<MessageActions data-testid="retry-actions" className="mt-1">
			<MessageAction
				data-testid="retry-message"
				size="xs"
				className="text-muted-foreground"
				onClick={(e) => {
					blurAfterPointerClick(e);
					onRetry();
				}}
			>
				<RotateCcwIcon />
				Retry
			</MessageAction>
		</MessageActions>
	);
}
