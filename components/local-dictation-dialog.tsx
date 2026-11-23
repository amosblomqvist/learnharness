"use client";

import type { ReactElement, ReactNode } from "react";
import { HostDialog } from "@/components/host-dialog";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { formatMegabytes, useLocalModelConsent, type LocalModelConsentChoice } from "@/components/local-dictation";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

const TITLE = "Download the on-device speech model?";

/** The dialog's pure body, exported for render tests. */
export function LocalModelConsentBody({
	totalBytes,
	onAnswer,
	renderFrame,
}: {
	totalBytes: number;
	onAnswer: (choice: LocalModelConsentChoice) => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const backdropDismiss = useBackdropDismiss(() => onAnswer("cancel"));
	const frame = (
		<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
			<h2 className="text-sm font-semibold text-card-foreground">{TITLE}</h2>
			<p className="mt-1.5 text-xs text-muted-foreground" data-testid="local-model-consent-line">
				Dictation without a Deepgram key runs on this computer. The model is about {formatMegabytes(totalBytes)}, and audio
				stays on this computer.
			</p>
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="local-model-consent-cancel"
					onClick={() => onAnswer("cancel")}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="local-model-consent-key"
					onClick={() => onAnswer("key")}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Add a Deepgram key
				</button>
				<button
					type="button"
					data-testid="local-model-consent-download"
					onClick={() => onAnswer("download")}
					className="rounded-sm border border-border bg-secondary px-3 py-1.5 text-xs text-secondary-foreground transition-colors hover:bg-secondary/80"
				>
					Download
				</button>
			</div>
		</div>
	);
	if (renderFrame) return renderFrame(frame);
	return (
		<div role="dialog" aria-modal="true" aria-label={TITLE} data-testid="local-model-consent"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" {...backdropDismiss}>
			{frame}
		</div>
	);
}

/** Mounted once in the app shell: answers the one pending consent request. */
export function LocalModelConsentDialog() {
	const request = useLocalModelConsent();
	const { open: openSettings } = useSettingsDialog();
	if (!request) return null;
	const answer = (choice: LocalModelConsentChoice) => {
		request.answer(choice);
		if (choice === "key") openSettings("keys", "DEEPGRAM_API_KEY");
	};
	return (
		<LocalModelConsentBody
			totalBytes={request.totalBytes}
			onAnswer={answer}
			renderFrame={(frame) => (
				<HostDialog open frame={frame} aria-label={TITLE}
					onClose={() => {
						answer("cancel");
						return "closed";
					}}
					backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "local-model-consent" }}>
					{frame.props.children}
				</HostDialog>
			)}
		/>
	);
}
