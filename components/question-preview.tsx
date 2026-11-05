"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
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

function remarkQuestionPreview({ cutBeforeMath }: { cutBeforeMath: number | null }) {
	return (tree: { children: PreviewNode[] }) => {
		let stopped = false;
		let mathIndex = 0;
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
						out.push(node);
						break;
					case "inlineMath":
						if (cutBeforeMath !== null && mathIndex++ >= cutBeforeMath) stopped = true;
						else out.push(node);
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
							const content = prefix(node.children);
							if (content.length) out.push(...content, { type: "text", value: " " });
						}
				}
			}
			return out;
		};
		tree.children = [{ type: "paragraph", children: prefix(tree.children) }];
	};
}

const previewComponents = {
	p: ({ children }: ComponentProps<"p"> & ExtraProps) => <span>{children}</span>,
	span: ({ children, title, node: _node, ...props }: ComponentProps<"span"> & ExtraProps) => title === linkLabelMarker
		? <span className="text-primary underline underline-offset-4">{children}</span>
		: <span title={title} {...props}>{children}</span>,
	code: ({ children }: ComponentProps<"code"> & ExtraProps) => (
		<code data-streamdown="inline-code" className="inline-block align-middle whitespace-pre rounded px-1.5 py-0.5 font-mono leading-none">{children}</code>
	),
	strong: MarkdownStrong,
};

/** A single inert line inside the dock's expand button. No block renderers,
 * media, links, copy buttons or streaming block splitting belong in a teaser. */
export function QuestionPreview({ children }: { children: string }) {
	// A new question must be measured in full, independently of the old cutoff.
	return <MeasuredQuestionPreview key={children} source={children} />;
}

function MeasuredQuestionPreview({ source }: { source: string }) {
	const slotRef = useRef<HTMLSpanElement>(null);
	const [fit, setFit] = useState({ cutBeforeMath: Infinity, ready: false });
	const previewPlugins = useMemo(() => ({
		cjk: {
			...streamdownPlugins.cjk!,
			// Streamdown caches processors by plugin name + serialized options,
			// not closure identity. Keep the cutoff in explicit plugin options.
			remarkPluginsAfter: [...streamdownPlugins.cjk!.remarkPluginsAfter, [remarkQuestionPreview, {
				cutBeforeMath: Number.isFinite(fit.cutBeforeMath) ? fit.cutBeforeMath : null,
			}]],
		},
		math: streamdownPlugins.math,
	} satisfies PluginConfig), [fit.cutBeforeMath]);

	useLayoutEffect(() => {
		if (fit.ready || !slotRef.current) return;
		const slot = slotRef.current;
		const height = slot.getBoundingClientRect().height;
		if (height <= 0) return; // Hidden/unlaid-out dock: measure when it gains size.
		// Include KaTeX error fallbacks so their indexes still match inlineMath AST
		// nodes. Measure actual typesetting, not a list of guessed TeX commands.
		const math = [...slot.querySelectorAll<HTMLElement>(".katex, .katex-error")];
		const tall = math.findIndex((node) => node.getBoundingClientRect().height > height);
		setFit({ cutBeforeMath: tall < 0 ? Infinity : tall, ready: true });
	}, [fit]);

	useEffect(() => {
		const slot = slotRef.current;
		if (!slot) return;
		const reset = () => setFit({ cutBeforeMath: Infinity, ready: false });
		let previous = slot.getBoundingClientRect();
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
			const next = slot.getBoundingClientRect();
			if (next.width !== previous.width || next.height !== previous.height) {
				previous = next;
				reset();
			}
		});
		observer?.observe(slot);
		const fonts = slot.ownerDocument.fonts;
		fonts?.addEventListener("loadingdone", reset);
		return () => {
			observer?.disconnect();
			fonts?.removeEventListener("loadingdone", reset);
		};
	}, []);

	// One compact, math-friendly line, reserved even for an empty teaser. The
	// absolute content cannot grow the slot. Zero KaTeX leading removes only
	// extra line-box space: its own struts retain the full, unscaled glyph height.
	return (
		<span
			ref={slotRef}
			data-question-preview
			data-ready={fit.ready}
			className="relative block h-[1.6em] min-w-0 overflow-hidden"
			style={{ visibility: fit.ready ? "visible" : "hidden" }}
		>
			<Streamdown
				mode="static"
				plugins={previewPlugins}
				components={previewComponents}
				controls={false}
				skipHtml
				className="lh-prose absolute top-1/2 block w-full min-w-0 -translate-y-1/2 overflow-hidden text-ellipsis whitespace-nowrap text-[length:inherit]! leading-[inherit]! [&_.katex]:inline-block [&_.katex]:max-w-full [&_.katex]:overflow-hidden [&_.katex]:align-middle [&_.katex]:leading-[0]!"
			>
				{transformMathDelimiters(repairMathForDisplay(source))}
			</Streamdown>
		</span>
	);
}
