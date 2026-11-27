"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { HostMarkdown } from "@/components/host-markdown";
import { cn } from "@/lib/utils";

export function PromptText({ text, preview, fieldRef, onChange, busy }: {
	text: string;
	preview: boolean;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	onChange?: (text: string) => void;
	busy?: boolean;
}) {
	const gutter = useRef<HTMLDivElement>(null);
	const lines = text.split(/\r\n|\r|\n/);
	const wrapping = "whitespace-pre-wrap [overflow-wrap:anywhere]";
	function syncGutter(field: HTMLTextAreaElement) {
		if (!gutter.current) return;
		gutter.current.style.width = `${field.clientWidth}px`;
		gutter.current.style.transform = `translateY(-${field.scrollTop}px)`;
	}
	useLayoutEffect(() => {
		const field = fieldRef.current;
		if (!field || preview) return;
		const sync = () => syncGutter(field);
		sync();
		if (typeof ResizeObserver === "undefined") return;
		// Observe the content box so the mirror follows scrollbar width too.
		const observer = new ResizeObserver(sync);
		observer.observe(field);
		return () => observer.disconnect();
	}, [fieldRef, preview]);
	return <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
		<div className={cn("h-full font-mono text-xs leading-5", preview ? "hidden" : "flex")}>
			<div aria-hidden="true" className="shrink-0 border-r border-border bg-muted/40 px-3">
				<span className="invisible">{lines.length}</span>
			</div>
			<div className="relative min-w-0 flex-1">
				{/* Invisible text measures the same wrapped visual rows as the field;
				    only the logical line numbers are visible in the gutter. */}
				<div ref={gutter} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 w-full select-none px-3 py-3">
					{lines.map((line, i) => <div key={i} className="relative min-h-5">
						<span className="absolute top-0 right-full mr-6 text-muted-foreground tabular-nums">{i + 1}</span>
						<div className={cn("invisible", wrapping)}>{line}</div>
					</div>)}
				</div>
				<textarea
					ref={fieldRef}
					aria-label={onChange ? "Override Markdown" : "Default Markdown"}
					value={text}
					readOnly={!onChange || busy}
					spellCheck={false}
					wrap="soft"
					onChange={onChange && (event => onChange(event.target.value))}
					onScroll={event => syncGutter(event.currentTarget)}
					className={cn("block size-full resize-none overflow-x-hidden bg-transparent px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", wrapping)}
				/>
			</div>
		</div>
		{preview && <div className="h-full overflow-auto p-4" tabIndex={0} aria-label="Rendered Markdown">
			<HostMarkdown text={text} />
		</div>}
	</div>;
}
