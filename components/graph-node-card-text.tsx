"use client";

import type { GraphNode } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";

/** The detail card's name and statement, as a pure seam for render pins
 *  (the GraphChromeRow pattern). Both are extractor tool arguments, so
 *  they render through ToolContentResponse like other tool content: math
 *  and Markdown, never streamed. `.lh-prose` sets the chat font and size
 *  in unlayered CSS that beats Tailwind's type utilities — the variable
 *  overrides are what keep the card's own type. */
const NODE_CARD_TYPE = "[--font-prose:var(--font-ui)] " +
	"[&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit]";

export function NodeCardText({ name, statement }: Pick<GraphNode, "name" | "statement">) {
	return (
		<>
			<ToolContentResponse
				mode="static"
				className={`${NODE_CARD_TYPE} font-medium [--lh-prose-size:var(--text-sm)] [--lh-prose-leading:1.375]`}
			>
				{name}
			</ToolContentResponse>
			<ToolContentResponse
				mode="static"
				className={`${NODE_CARD_TYPE} mt-1 text-muted-foreground [--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625]`}
			>
				{statement}
			</ToolContentResponse>
		</>
	);
}
