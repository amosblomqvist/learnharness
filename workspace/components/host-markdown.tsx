"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ExtraProps } from "streamdown";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext, mdComponents } from "@/components/md-blocks";
import { cn } from "@/lib/utils";

/** Streamdown's default image adds a download button independently of its
 * controls setting. Keep its image styling and passive error fallback here,
 * without changing the image component used by ordinary transcripts. */
function StaticMarkdownImage({ className, src, alt, node, onLoad, onError, ...props }: ComponentProps<"img"> & ExtraProps) {
	const image = useRef<HTMLImageElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (image.current?.complete) setFailed(image.current.naturalWidth === 0);
	}, []);
	const fallback = failed && props.width == null && props.height == null;
	if (!src) return null;
	return (
		<div className="group relative my-4 inline-block" data-streamdown="image-wrapper">
			{/* The Markdown pipeline owns URL sanitization, just as in chat. */}
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				alt={alt}
				className={cn("max-w-full rounded-lg", fallback && "hidden", className)}
				data-streamdown="image"
				onError={event => { setFailed(true); onError?.(event); }}
				onLoad={event => { setFailed(false); onLoad?.(event); }}
				ref={image}
				src={src}
				{...props}
			/>
			{fallback && <span className="text-muted-foreground text-xs italic" data-streamdown="image-fallback">Image not available</span>}
			<div className="pointer-events-none absolute inset-0 hidden rounded-lg bg-black/10 group-hover:block" />
		</div>
	);
}

// Resolve lazily: the existing message/plugin-host module graph is cyclic.
// Once initialized, the module-scoped identity stays stable across snapshots.
let components: typeof mdComponents & { img: typeof StaticMarkdownImage };
function getComponents() {
	return components ??= { ...mdComponents, img: StaticMarkdownImage };
}
const linkSafety = { enabled: false };

/** Complete, display-only Markdown snapshots through the actual host message
 * pipeline, including its presentation-only tool-math recovery. The local
 * profile never changes transcript controls or plugin renderers. A new snapshot
 * retires the old async code/diagram subtree. */
export function HostMarkdown({ text }: { text: string }) {
	return (
		<MarkdownDisplayOnlyContext.Provider value={true}>
			<ToolContentResponse key={text} mode="static" isAnimating={false} controls={false} components={getComponents()} linkSafety={linkSafety}>
				{text}
			</ToolContentResponse>
		</MarkdownDisplayOnlyContext.Provider>
	);
}
