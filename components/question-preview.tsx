"use client";

import type { ComponentProps } from "react";
import { Streamdown, type ExtraProps, type PluginConfig } from "streamdown";
import { streamdownPlugins } from "@/components/ai-elements/message";
import { MarkdownStrong } from "@/components/md-blocks";
import { repairMathForDisplay, transformMathDelimiters } from "@/src/core";

// Transform the renderer's parsed Markdown, not a whitespace-flattened source:
// flattening first destroys code fences and significant spaces in inline code.
// These are parser-owned nodes; the question/answer source is never modified.
type PreviewNode = {
	type: string;
	value?: string;
	children?: PreviewNode[];
	alt?: string | null;
	url?: string;
	data?: { hName: string; hProperties: { title: string; href?: undefined } };
};
// Carry link labels through the shared sanitizer without relaxing its schema.
// The local span renderer consumes this marker; it never becomes a tooltip.
const linkLabelMarker = "lh-question-preview-link";

function remarkQuestionPreview() {
	return (tree: { children: PreviewNode[] }) => {
		let stopped = false;
		const prefix = (nodes: PreviewNode[]): PreviewNode[] => {
			const out: PreviewNode[] = [];
			for (const node of nodes) {
				if (stopped) break;
				switch (node.type) {
					case "code":
					case "math":
						stopped = true;
						break;
					case "text":
						out.push({ ...node, value: node.value?.replace(/\s+/g, " ") });
						break;
					case "inlineCode":
					case "inlineMath":
						out.push(node);
						break;
					case "emphasis":
					case "strong":
					case "delete":
						out.push({ ...node, children: prefix(node.children ?? []) });
						break;
					case "link":
					case "linkReference":
						// Retain link styling/labels, not navigation or safety dialogs.
						out.push({
							type: "link", url: "", children: prefix(node.children ?? []),
							data: { hName: "span", hProperties: { title: linkLabelMarker, href: undefined } },
						});
						break;
					case "image":
					case "imageReference":
						out.push({ type: "text", value: node.alt ?? "" });
						break;
					case "break":
						out.push({ type: "text", value: " " });
						break;
					case "html":
					case "definition":
						break;
					default:
						if (node.children) {
							out.push(...prefix(node.children), { type: "text", value: " " });
						}
				}
			}
			return out;
		};
		tree.children = [{ type: "paragraph", children: prefix(tree.children) }];
	};
}

const previewPlugins = {
	cjk: {
		...streamdownPlugins.cjk!,
		remarkPluginsAfter: [...streamdownPlugins.cjk!.remarkPluginsAfter, remarkQuestionPreview],
	},
	math: streamdownPlugins.math,
} satisfies PluginConfig;

const previewComponents = {
	p: ({ children }: ComponentProps<"p"> & ExtraProps) => <span>{children}</span>,
	span: ({ children, title, node: _node, ...props }: ComponentProps<"span"> & ExtraProps) => title === linkLabelMarker
		? <span className="text-primary underline underline-offset-4">{children}</span>
		: <span title={title} {...props}>{children}</span>,
	code: ({ children }: ComponentProps<"code"> & ExtraProps) => (
		<code data-streamdown="inline-code" className="whitespace-pre rounded px-1.5 py-0.5 font-mono">{children}</code>
	),
	strong: MarkdownStrong,
};

/** A single inert line inside the dock's expand button. No block renderers,
 * media, links, copy buttons or streaming block splitting belong in a teaser. */
export function QuestionPreview({ children }: { children: string }) {
	return (
		<Streamdown
			mode="static"
			plugins={previewPlugins}
			components={previewComponents}
			controls={false}
			skipHtml
			className="lh-prose relative block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[length:inherit]! leading-[inherit]! [&_.katex]:inline-block [&_.katex]:max-w-full [&_.katex]:overflow-hidden"
		>
			{transformMathDelimiters(repairMathForDisplay(children))}
		</Streamdown>
	);
}
