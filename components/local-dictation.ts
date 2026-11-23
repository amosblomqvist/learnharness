"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { LocalSttStatus } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

/**
 * Browser side of on-device dictation: the cached engine/model status, the
 * one-at-a-time download consent, and the clip upload. The engine rule is
 * simple: a Deepgram key means Deepgram, no key means the local model.
 */

const listeners = new Set<() => void>();
let status: LocalSttStatus | null = null;
let inflight: Promise<LocalSttStatus> | null = null;

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

async function errorText(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error) return body.error;
	} catch {}
	return fallback;
}

function checkedStatus(body: unknown): LocalSttStatus {
	const candidate = body as Partial<LocalSttStatus> | null;
	if (typeof candidate?.deepgramKey !== "boolean" || typeof candidate.model?.state !== "string") {
		throw new Error("Dictation status unavailable");
	}
	return candidate as LocalSttStatus;
}

function publish(next: LocalSttStatus): LocalSttStatus {
	status = next;
	emit();
	return next;
}

/** Fresh from the server; concurrent callers share one request. */
export function fetchLocalSttStatus(): Promise<LocalSttStatus> {
	inflight ??= fetch("/api/stt/local", { cache: "no-store" })
		.then(async (res) => {
			if (!res.ok) throw new Error(await errorText(res, `Dictation status unavailable (${res.status})`));
			return publish(checkedStatus(await res.json()));
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/** The last known status without waiting, else a fresh one. */
export function localSttStatus(): Promise<LocalSttStatus> {
	return status ? Promise.resolve(status) : fetchLocalSttStatus();
}

/** Silent refresh (page mount, after a run, after a key change). */
export function refreshLocalSttStatus(): void {
	fetchLocalSttStatus().catch(() => {});
}

// Saving or deleting the Deepgram key switches the engine.
let watchingKeys = false;
export function watchKeyChanges(): void {
	if (watchingKeys || typeof window === "undefined") return;
	watchingKeys = true;
	onSettingsSaved((section) => {
		if (section === "keys") refreshLocalSttStatus();
	});
}

export async function startLocalModelDownload(): Promise<LocalSttStatus> {
	const res = await fetch("/api/stt/local/model", { method: "POST" });
	if (!res.ok) throw new Error(await errorText(res, `Download could not start (${res.status})`));
	return publish(checkedStatus(await res.json()));
}

/** Cancels a download in progress, or removes the installed model. */
export async function removeLocalModel(): Promise<LocalSttStatus> {
	const res = await fetch("/api/stt/local/model", { method: "DELETE" });
	if (!res.ok) throw new Error(await errorText(res, `Model could not be removed (${res.status})`));
	return publish(checkedStatus(await res.json()));
}

const POLL_MS = 500;

/** Polls while a download runs; stops when nothing is downloading or no one listens. */
let pollTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePoll() {
	if (pollTimer || status?.model.state !== "downloading" || listeners.size === 0) return;
	pollTimer = setTimeout(() => {
		pollTimer = null;
		fetchLocalSttStatus().then(schedulePoll, () => {});
	}, POLL_MS);
}

/** Live status for UI (Settings row, dictation bar). Null until first fetched. */
export function useLocalSttStatus(): LocalSttStatus | null {
	const current = useSyncExternalStore(subscribe, () => status, () => null);
	useEffect(() => {
		watchKeyChanges();
		if (!status) refreshLocalSttStatus();
	}, []);
	useEffect(() => {
		schedulePoll();
	}, [current]);
	return current;
}

/** Resolves once the model is installed; rejects with the download's error.
 *  An abort only stops waiting: the download itself keeps going. */
export function waitForLocalModel(signal: AbortSignal, onProgress?: (receivedBytes: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const check = () => {
			if (signal.aborted) return;
			const model = status?.model;
			if (model?.state === "downloading") onProgress?.(model.receivedBytes);
			if (model?.state === "ready") {
				done();
				resolve();
			} else if (model?.state === "missing") {
				done();
				reject(new Error(model.error ?? "The speech model download stopped"));
			} else schedulePoll();
		};
		const done = () => {
			listeners.delete(check);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			done();
			reject(new DOMException("Stopped waiting for the speech model", "AbortError"));
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort);
		listeners.add(check);
		check();
	});
}

export type LocalModelConsentChoice = "download" | "key" | "cancel";
interface ConsentRequest { totalBytes: number; answer: (choice: LocalModelConsentChoice) => void }
let consent: ConsentRequest | null = null;
const consentListeners = new Set<() => void>();

function setConsent(next: ConsentRequest | null) {
	consent = next;
	for (const listener of consentListeners) listener();
}

/** Asks once; an abort (Esc, navigation) answers "cancel" and closes the dialog. */
export function requestLocalModelConsent(totalBytes: number, signal: AbortSignal): Promise<LocalModelConsentChoice> {
	return new Promise((resolve) => {
		const request: ConsentRequest = {
			totalBytes,
			answer: (choice) => {
				if (consent === request) setConsent(null);
				signal.removeEventListener("abort", onAbort);
				resolve(choice);
			},
		};
		const onAbort = () => request.answer("cancel");
		signal.addEventListener("abort", onAbort);
		consent?.answer("cancel");
		setConsent(request);
	});
}

export function useLocalModelConsent(): ConsentRequest | null {
	return useSyncExternalStore(
		(listener) => {
			consentListeners.add(listener);
			return () => {
				consentListeners.delete(listener);
			};
		},
		() => consent,
		() => null,
	);
}

/** The capture worklet posts Int16Array frames: copy their bytes, not their values. */
export function joinPcm(frames: readonly ArrayBufferView[]): Uint8Array<ArrayBuffer> {
	let total = 0;
	for (const frame of frames) total += frame.byteLength;
	const out = new Uint8Array(total);
	let at = 0;
	for (const frame of frames) {
		out.set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), at);
		at += frame.byteLength;
	}
	return out;
}

/** Mono 16 kHz s16le PCM to the local server; resolves with the transcript. */
export async function transcribeLocally(pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
	const res = await fetch("/api/stt/local/transcribe", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: pcm,
		signal,
	});
	if (!res.ok) throw new Error(await errorText(res, `On-device transcription failed (${res.status})`));
	const body = (await res.json()) as { text?: unknown };
	return typeof body.text === "string" ? body.text : "";
}

export function formatMegabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}
