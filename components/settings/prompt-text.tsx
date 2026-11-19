"use client";

import { useRef, type RefObject } from "react";
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
	const lineCount = text.split(/\r\n|\r|\n/).length;
	return <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
		<div className={cn("h-full font-mono text-xs leading-5", preview ? "hidden" : "flex")}>
			<div aria-hidden="true" className="shrink-0 select-none overflow-hidden border-r border-border bg-muted/40 px-3 text-right text-muted-foreground tabular-nums">
				<div ref={gutter} className="py-3">{Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
			</div>
			<textarea
				ref={fieldRef}
				aria-label={onChange ? "Override Markdown" : "Default Markdown"}
				value={text}
				readOnly={!onChange || busy}
				spellCheck={false}
				wrap="off"
				onChange={onChange && (event => onChange(event.target.value))}
				onScroll={event => {
					if (gutter.current) gutter.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`;
				}}
				className="h-full min-w-0 flex-1 resize-none bg-transparent px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
			/>
		</div>
		{preview && <div className="h-full overflow-auto p-4" tabIndex={0} aria-label="Rendered Markdown">
			<HostMarkdown text={text} />
		</div>}
	</div>;
}
