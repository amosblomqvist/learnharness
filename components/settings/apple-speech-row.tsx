"use client";

import { useEffect, useState } from "react";
import { Hint } from "@/components/ui/hint";
import {
	APPLE_MODEL_SIZE,
	APPLE_REMOVE_NOTE,
	appleModelReady,
	appleRowStatus,
	appleSpeechBridge,
	appleUsable,
	cachedAppleStatus,
	refreshAppleStatus,
	subscribeAppleStatus,
	wireAppleInstallEvents,
	type AppleSpeechStatus,
} from "@/components/apple-speech";

/**
 * Settings → Dictation → "Apple on-device": the model's status with
 * download, or remove once installed. Laid out like the key rows below it
 * (10px action link + lowercase mono status). macOS owns the shared
 * storage, so remove only drops this app's reservation; its tooltip says
 * so. Rendered only where Apple dictation can run.
 */
export function AppleSpeechRow() {
	const [status, setStatus] = useState<AppleSpeechStatus | null>(() => cachedAppleStatus());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		wireAppleInstallEvents();
		const off = subscribeAppleStatus(setStatus);
		void refreshAppleStatus();
		return off;
	}, []);

	if (!appleUsable(status)) return null;
	const ready = appleModelReady(status);
	const downloading = status.model === "downloading";

	async function act(action: "install" | "release") {
		const bridge = appleSpeechBridge();
		if (!bridge || busy) return;
		setBusy(true);
		setError(null);
		try {
			await bridge[action]();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
		}
		await refreshAppleStatus();
		setBusy(false);
	}

	return (
		<div data-testid="apple-speech-row">
			<div className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5">
				<span className="font-ui text-xs text-foreground">
					Apple on-device <span className="text-muted-foreground">· {status.language}</span>
				</span>
				<span className="flex items-center gap-2">
					{!downloading && (
						<Hint label={ready ? APPLE_REMOVE_NOTE : `On-device model, ${APPLE_MODEL_SIZE}`} side="top">
							<button
								type="button"
								onClick={() => void act(ready ? "release" : "install")}
								disabled={busy}
								data-testid={ready ? "apple-speech-remove" : "apple-speech-download"}
								className="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
							>
								{ready ? "remove" : "download"}
							</button>
						</Hint>
					)}
					<span data-testid="apple-speech-status" className="font-mono text-[11px] text-muted-foreground">
						{appleRowStatus(status)}
					</span>
				</span>
			</div>
			{error && (
				<p role="alert" data-testid="apple-speech-error" className="pl-6 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}
