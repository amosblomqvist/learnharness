"use client";

/**
 * Local dictation (whisper.cpp) — the renderer half, kept out of
 * dictation.tsx so the local-whisper branch touches upstream code as little
 * as possible. dictation.tsx asks currentEngine() per run; a Whisper run
 * collects frames instead of streaming them and hands them to
 * transcribeWhisper() once, at stop.
 */
import { useSyncExternalStore } from "react";

export type DictationEngine = "whisper" | "deepgram";
const DEFAULT_ENGINE: DictationEngine = "whisper";

/** The not-installed line (the route's 503 carries full paths — the
 *  tooltip-sized surface says the short truth instead). */
export const DICTATION_WHISPER_MISSING = "Whisper is not installed (data/whisper)";

/** Whisper runs buffer up to 10 minutes of 128ms frames — the route's own
 *  ceiling; older frames drop past it. */
export const WHISPER_MAX_FRAMES = Math.floor((10 * 60 * 1000) / 128);

/** Transcribe one finished run locally. Frames are concatenated in order. */
export async function transcribeWhisper(frames: ArrayBuffer[], language: string): Promise<string> {
	const res = await fetch(`/api/stt/whisper?language=${encodeURIComponent(language)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: new Blob(frames),
	});
	const data = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
	if (!res.ok) {
		if (res.status === 503) throw new Error(DICTATION_WHISPER_MISSING);
		throw new Error(data.message ?? `whisper route ${res.status}`);
	}
	return data.text ?? "";
}

/* One window-wide engine snapshot: loaded once, updated by save(). */
let engine: DictationEngine = DEFAULT_ENGINE;
let loaded: Promise<DictationEngine> | null = null;
const listeners = new Set<() => void>();
const publish = (next: DictationEngine) => {
	engine = next;
	for (const l of listeners) l();
};

/** Load (once) the stored engine; failures fall back to the default. */
export function loadEngine(): Promise<DictationEngine> {
	if (!loaded) {
		loaded = fetch("/api/stt/engine")
			.then((r) => r.json() as Promise<{ engine?: DictationEngine }>)
			.then((b) => {
				publish(b.engine === "deepgram" ? "deepgram" : "whisper");
				return engine;
			})
			.catch(() => {
				loaded = null; // retry next time
				return engine;
			});
	}
	return loaded;
}

/** The engine as last known — synchronous, for teardown paths. */
export function currentEngine(): DictationEngine {
	return engine;
}

export async function saveEngine(next: DictationEngine): Promise<boolean> {
	const res = await fetch("/api/stt/engine", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ engine: next }),
	}).catch(() => null);
	if (!res?.ok) return false;
	publish(next);
	return true;
}

export function useDictationEngine(): DictationEngine {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			void loadEngine();
			return () => listeners.delete(l);
		},
		() => engine,
		() => DEFAULT_ENGINE,
	);
}
