/**
 * Apple on-device dictation — renderer side (the bridge is
 * window.lh.appleSpeech, electron/preload.cjs → electron/apple-speech.cjs).
 *
 * Engine choice: a Deepgram key wins; with no key, a
 * Mac on macOS 26+ uses Apple's on-device model; everywhere else the
 * keyless Deepgram error stays. The model download always needs the
 * user's consent first (the dictation dialog or Settings → Dictation).
 */

export type AppleModelState = "unsupported" | "supported" | "downloading" | "installed";

export type AppleSpeechStatus =
	| { available: false }
	| {
			available: true;
			/** BCP 47, e.g. "en-US" — the system locale, else en-US. */
			locale: string;
			/** English display name, e.g. "English (United States)". */
			language: string;
			model: AppleModelState;
			/** This app holds a reservation for the locale (Remove drops it). */
			reserved: boolean;
			/** 0..1 while this app's download runs. */
			progress?: number;
	  };

export type AppleSpeechEvent =
	| { session: number; type: "ready" | "end" }
	| { session: number; type: "final"; text: string }
	| { session: number; type: "error"; message: string };

export type AppleInstallEvent =
	| { type: "progress"; fraction: number }
	| { type: "done" }
	| { type: "error"; message: string };

export type AppleSpeechBridge = {
	status: () => Promise<AppleSpeechStatus>;
	install: () => Promise<unknown>;
	start: () => Promise<{ session: number }>;
	stop: (session: number) => Promise<unknown>;
	cancel: (session: number) => Promise<unknown>;
	audio: (session: number, buffer: ArrayBuffer) => void;
	onEvent: (cb: (event: AppleSpeechEvent) => void) => () => void;
	onInstall: (cb: (event: AppleInstallEvent) => void) => () => void;
};

/** Developer reports put one locale's model at ~130–400 MB (en-US ≈ 390 MB
 *  on disk); Apple publishes no size. */
export const APPLE_MODEL_SIZE = "about 150–400 MB";

export function appleSpeechBridge(): AppleSpeechBridge | undefined {
	if (typeof window === "undefined") return undefined;
	return window.lh?.appleSpeech;
}

/** Apple can serve dictation on this host for the resolved locale. */
export function appleUsable(status: AppleSpeechStatus | null): status is Extract<AppleSpeechStatus, { available: true }> {
	return !!status && status.available && status.model !== "unsupported";
}

/** Ready to transcribe without asking: the model is on the Mac. The helper
 *  reserves the locale itself when it transcribes. */
export function appleModelReady(status: AppleSpeechStatus | null): boolean {
	return appleUsable(status) && status.model === "installed";
}

export type DictationEngine = "deepgram" | "apple" | "keyless";

/** A Deepgram key wins; keyless falls back to Apple when usable. */
export function chooseEngine(hasDeepgramKey: boolean, apple: AppleSpeechStatus | null): DictationEngine {
	if (hasDeepgramKey) return "deepgram";
	return appleUsable(apple) ? "apple" : "keyless";
}

/** The Settings row's status text. */
export function appleRowStatus(status: Extract<AppleSpeechStatus, { available: true }>): string {
	if (status.model === "downloading") {
		return status.progress === undefined ? "downloading…" : `downloading ${Math.round(status.progress * 100)}%`;
	}
	return appleModelReady(status) ? "installed" : "not installed";
}

/* Module-level status cache: dictation's click path and the Settings row
 * share it. refresh() re-queries the helper; failures read as unavailable. */
let cached: AppleSpeechStatus | null = null;
let inflight: Promise<AppleSpeechStatus> | null = null;
const listeners = new Set<(status: AppleSpeechStatus) => void>();

export function cachedAppleStatus(): AppleSpeechStatus | null {
	return cached;
}

function publish(status: AppleSpeechStatus) {
	cached = status;
	for (const listener of listeners) listener(status);
}

export function refreshAppleStatus(): Promise<AppleSpeechStatus> {
	const bridge = appleSpeechBridge();
	if (!bridge) {
		publish({ available: false });
		return Promise.resolve(cached!);
	}
	if (inflight) return inflight;
	inflight = bridge
		.status()
		.catch((): AppleSpeechStatus => ({ available: false }))
		.then((status) => {
			inflight = null;
			publish(status);
			return status;
		});
	return inflight;
}

/** The cached status if present, else a fresh query. */
export function appleStatus(): Promise<AppleSpeechStatus> {
	return cached ? Promise.resolve(cached) : refreshAppleStatus();
}

export function subscribeAppleStatus(listener: (status: AppleSpeechStatus) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Install progress lands in the cache, so every surface shows one download. */
let installWired = false;
export function wireAppleInstallEvents() {
	const bridge = appleSpeechBridge();
	if (installWired || !bridge) return;
	installWired = true;
	bridge.onInstall((event) => {
		if (event.type === "progress" && appleUsable(cached)) publish({ ...cached, model: "downloading", progress: event.fraction });
		else void refreshAppleStatus();
	});
}
