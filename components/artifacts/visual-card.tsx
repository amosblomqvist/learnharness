"use client";

import { useContext, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { SvgImage } from "@/components/artifacts/svg-image";
import type { ArtifactPartProps, VisualResult } from "@/src/core";

/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the chat view's jobs feed). The SVG itself renders from the steer message
 * (sub-agent result delivery) via VisualOutputCard.
 *
 * Both display modes use an SVG image document: generated markup and its
 * styles never join the app's DOM. Downloads still contain the original SVG.
 */

/** The svg root's DECLARED width in px, when there is one — the natural
 *  size the card displays at instead of stretching to full width (owner,
 *  2026-10-07). %, em, "auto", or a missing attribute → null (the caller
 *  falls back to full-width). Pure. */
export function svgNaturalWidth(svg: string): number | null {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(svg);
	if (!m) return null;
	const value = m[1]!.trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]!);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="visual" />;
}

/** The figure itself — exported: the steer card renders the delivered artifact. */
export function VisualOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as VisualResult | undefined;
	const overlay = useSessionMermaid();
	const actions = useContext(ChatActionsContext);
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) — seeded here, written through
	// the silent artifact-ui route on toggle; without a chat page (tests,
	// previews) it stays local-only. The toggled state also feeds the
	// fullscreen overlay (openFigure).
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const natural = result && typeof result.svg === "string" ? svgNaturalWidth(result.svg) : null;
	if (!result || typeof result.svg !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Figure completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.svg.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="visual-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Figure
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The figure could not be drawn."}</p>
			</div>
		);
	}
	return (
		/* NO CARD CHROME (owner round, 2026-10-07): the figure is document
		   material — no border, no padding box. Image first, then the CAPTION
		   ROW below: "Figure" left, the controls right, both edges following
		   the IMAGE's own width (the wrapper carries the natural-sizing law,
		   so the row hugs a centered narrow figure, not the column). */
		<div
			className={
				natural !== null
					? "my-4 mx-auto w-fit max-w-full"
					: "my-4 w-full"
			}
			data-testid="visual-card"
		>
			{/* Natural sizing (owner, 2026-10-07): a declared-width svg sits at
			   ITS size; max-w-full still shrinks oversized ones to fit. No
			   declared size (viewBox-only, %-width) keeps the full-width law.
			   The invert filter rides the bg-white holder, so the backing flips
			   white→black together with the strokes; transparent areas ARE the
			   backing. */}
			<div
				className={
					natural !== null
						? "w-fit max-w-full overflow-hidden rounded-lg bg-white"
						: "w-full overflow-hidden rounded-lg bg-white"
				}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				data-testid="visual-svg"
			>
				<SvgImage
					svg={result.svg}
					width={natural ?? undefined}
					className={natural !== null ? "block h-auto max-w-full" : "block h-auto w-full"}
				/>
			</div>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
				<div className="flex items-center gap-1.5">
					{/* The invert affordance (owner round, 2026-10-07): the disc IS
					    the half-filled contrast circle; the tooltip names it. */}
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert figure brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download figure as SVG"
						title="Download as SVG"
						onClick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")}
						data-testid="visual-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open figure fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(result.svg, inverted)}
							data-testid="visual-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
