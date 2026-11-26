"use client";

import type { Components } from "streamdown";
import { MessageResponse, streamdownPlugins } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext, mdComponents } from "@/components/md-blocks";

const plainMarkdown = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"];
let markdownComponents: Components;
function getMarkdownComponents() {
	// Resolve lazily, like HostMarkdown, because the shared renderer imports host UI.
	return markdownComponents ??= {
		...mdComponents,
		a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a> : <>{children}</>,
		pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
		code: ({ children }) => <code>{children}</code>,
	};
}

export function StartupMessageBody({ markdown }: { markdown: string }) {
	// Use the session renderer's prose typography and Markdown styles, while
	// keeping remote announcements passive (no HTML, embeds, or rich fences).
	return <MarkdownDisplayOnlyContext.Provider value={true}>
		<MessageResponse mode="static" skipHtml rehypePlugins={[]} allowedElements={plainMarkdown}
			plugins={{ cjk: streamdownPlugins.cjk }} components={getMarkdownComponents()} controls={false}
			urlTransform={(value, key) => {
				if (key !== "href" || !value.startsWith("https://")) return;
				try {
					const url = new URL(value);
					if (url.protocol === "https:" && !url.username && !url.password) return url.href;
				} catch { /* Non-HTTPS or invalid links render as text. */ }
			}}>{markdown}</MessageResponse>
	</MarkdownDisplayOnlyContext.Provider>;
}
