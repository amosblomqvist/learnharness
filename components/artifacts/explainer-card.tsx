"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { useSessionMermaid } from "@/components/session-overlay";
import type { ArtifactPartProps, ExplainerResult } from "@/src/core";

/**
 * Explainer artifact card (PBI-21): the delivered HTML page, shrunk into the
 * lesson. The page is finished on the server and self-contained, so the
 * iframe gets sandbox="allow-scripts" only (no same-origin grant — the page
 * can run its kit scripts but never touch the app's storage, cookies, or
 * DOM) and no bridge script: no height reports, no error chip.
 *
 * Shrinking: the page is laid out at a virtual width (VIRTUAL_WIDTH) and a
 * CSS scale() fits it to the card. The width is tracked with a
 * ResizeObserver; the first paint (SSR included) uses DEFAULT_SCALE. The
 * visible height is capped (MAX_VISIBLE_HEIGHT) and the rest is cut — the
 * whole page is for the full-screen view.
 */

/** The width the page is laid out at, before it is shrunk to the card. */
export const VIRTUAL_WIDTH = 1200;
/** The tallest the card shows; anything lower in the page is cut. */
export const MAX_VISIBLE_HEIGHT = 480;
/** The scale of the first paint (SSR and before the width is measured). */
export const DEFAULT_SCALE = 0.5;

/** The explainer tool-call box: the part's output is the dispatch ack — the
 * box is the DispatchCard. The page renders from the steer message via
 * ExplainerOutputCard. */
export function ExplainerCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="explainer" />;
}

/** The explainer artifact — exported: the steer card renders the delivered result. */
export function ExplainerOutputCard({ output }: { output: unknown }) {
	const result = output as ExplainerResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Explainer completed, but the result could not be displayed.
			</div>
		);
	}
	if (result.html.length === 0) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="explainer-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Explainer
					<span className="rounded bg-error/15 px-1.5 py-0.5 text-error">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The explainer could not be built."}</p>
			</div>
		);
	}
	return <ExplainerFrame title={result.title} html={result.html} />;
}

function ExplainerFrame({ title, html }: { title: string; html: string }) {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState(DEFAULT_SCALE);
	const overlay = useSessionMermaid();

	useEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		const measure = () => {
			const width = box.clientWidth;
			if (width > 0) setScale(Math.min(width / VIRTUAL_WIDTH, 1));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="explainer-card">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">explainer</span>
					<span className="truncate text-xs font-medium tracking-wide text-foreground">{title}</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						aria-label="Download explainer as HTML"
						title="Download as HTML"
						onClick={() => downloadFile(`${slugFilename(title)}.html`, html, "text/html")}
						data-testid="explainer-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay?.openPage && (
						<button
							type="button"
							aria-label="Open explainer fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openPage?.(html, title)}
							data-testid="explainer-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
			<div
				ref={boxRef}
				className="relative mt-2 w-full overflow-hidden rounded-lg border bg-white"
				style={{ height: MAX_VISIBLE_HEIGHT }}
				data-testid="explainer-viewport"
			>
				<iframe
					title={title}
					// allow-scripts ONLY: the page runs its own scripts but never
					// reaches the app's storage, cookies, or DOM.
					sandbox="allow-scripts"
					srcDoc={html}
					// scrolling OFF (as the demo card): a scrollable iframe traps the
					// wheel and stalls the lesson's scrolling.
					scrolling="no"
					className="absolute left-0 top-0 border-0"
					style={{
						width: VIRTUAL_WIDTH,
						height: MAX_VISIBLE_HEIGHT / scale,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
					data-testid="explainer-iframe"
				/>
			</div>
		</div>
	);
}
