"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { APPLE_MODEL_SIZE } from "@/components/apple-speech";

/**
 * The Apple model-download consent: the model is a large one-time
 * download, so dictation never fetches it without asking. Title, one
 * line, three actions — the Deepgram alternative on the left, Cancel +
 * Download on the right.
 */
export function AppleModelBody({
	language,
	onDownload,
	onCancel,
	onUseDeepgram,
}: {
	language: string;
	onDownload: () => void;
	onCancel: () => void;
	onUseDeepgram: () => void;
}) {
	const backdropDismiss = useBackdropDismiss(onCancel);
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Download speech model?"
			data-testid="apple-model-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			{...backdropDismiss}
		>
			<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
				<h2 className="text-sm font-semibold text-card-foreground">Download speech model?</h2>
				<p className="mt-1.5 text-xs text-muted-foreground" data-testid="apple-model-line">
					Apple&apos;s on-device model for {language}, {APPLE_MODEL_SIZE}. Audio stays on this Mac.
				</p>
				<div className="mt-4 flex items-center gap-2">
					<button
						type="button"
						data-testid="apple-model-deepgram"
						onClick={onUseDeepgram}
						className="mr-auto rounded-sm px-1 py-1.5 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
					>
						Use Deepgram key
					</button>
					<button
						type="button"
						data-testid="apple-model-cancel"
						onClick={onCancel}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="apple-model-download"
						onClick={onDownload}
						autoFocus
						className="rounded-sm border border-border bg-accent/50 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Download
					</button>
				</div>
			</div>
		</div>
	);
}

export function AppleModelDialog(props: {
	language: string;
	onDownload: () => void;
	onCancel: () => void;
	onUseDeepgram: () => void;
}) {
	const { onCancel } = props;
	// Esc cancels (claimed at the document level — THE ONE-ESC LAW).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onCancel();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);
	if (typeof document === "undefined") return null;
	return createPortal(<AppleModelBody {...props} />, document.body);
}
