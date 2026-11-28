"use client";

import { useState } from "react";
import { SettingsRow } from "@/components/settings/controls";
import { formatMegabytes, removeLocalModel, startLocalModelDownload, useLocalSttStatus } from "@/components/local-dictation";
import { useDictationActive } from "@/components/dictation-state";

/** Settings → Keys → Dictation: the on-device model, used whenever no Deepgram key is set. */
export function LocalDictationRow() {
	const status = useLocalSttStatus();
	const dictating = useDictationActive();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!status) return null;
	const { model } = status;

	const run = async (action: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	};

	const hint = error ?? (model.state === "ready"
		? `Ready · ${formatMegabytes(model.totalBytes)}${status.deepgramKey ? " · used when no Deepgram key is set" : ""}`
		: model.state === "downloading"
			? `Downloading · ${Math.floor((model.receivedBytes / Math.max(1, model.totalBytes)) * 100)}% of ${formatMegabytes(model.totalBytes)}`
			: model.error
				? `Download failed: ${model.error}`
				: `Not downloaded · ${formatMegabytes(model.totalBytes)} · audio stays on this computer`);

	const button = model.state === "ready"
		? { label: "Remove", testid: "local-dictation-remove", action: removeLocalModel, disabled: dictating }
		: model.state === "downloading"
			? { label: "Cancel", testid: "local-dictation-cancel", action: removeLocalModel, disabled: false }
			: { label: "Download", testid: "local-dictation-download", action: startLocalModelDownload, disabled: false };

	return (
		<SettingsRow label={`On-device dictation · ${model.label}`} hint={hint} testid="row-local-dictation">
			<button
				type="button"
				data-testid={button.testid}
				disabled={busy || button.disabled}
				onClick={() => void run(button.action)}
				className="shrink-0 rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
			>
				{button.label}
			</button>
		</SettingsRow>
	);
}
