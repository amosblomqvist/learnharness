"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dictation, DictationPhase } from "./dictation";

const MAX_BYTES = 24_000 * 2 * 120;

/** The same composer/question targets and keyboard controls, with Codex transcription. */
export function useCodexDictation({ append, onActive, getLanguage, enabled = true }: { enabled?: boolean; append: (text: string) => void; onActive: (active: boolean) => void; getLanguage?: () => Promise<string> }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const phaseRef = useRef<DictationPhase>("idle");
	const callbacks = useRef({ append, onActive, getLanguage });
	callbacks.current = { append, onActive, getLanguage };
	const levelRef = useRef(0);
	const generation = useRef(0);
	const media = useRef<MediaStream | null>(null);
	const context = useRef<AudioContext | null>(null);
	const source = useRef<MediaStreamAudioSourceNode | null>(null);
	const capture = useRef<AudioWorkletNode | null>(null);
	const frames = useRef<ArrayBuffer[]>([]);
	const bytes = useRef(0);
	const request = useRef<AbortController | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flushDone = useRef<(() => void) | null>(null);
	const waiters = useRef<Array<() => void>>([]);
	const stopRef = useRef<() => void>(() => {});
	const transition = useCallback((value: DictationPhase) => { phaseRef.current = value; setPhase(value); }, []);
	const releaseMedia = useCallback(() => {
		for (const track of media.current?.getTracks() ?? []) track.stop();
		media.current = null;
		source.current?.disconnect(); source.current = null;
		capture.current?.disconnect(); capture.current = null;
		void context.current?.close().catch(() => {}); context.current = null;
		if (timer.current) clearTimeout(timer.current); timer.current = null;
	}, []);
	const cleanup = useCallback(() => {
		generation.current++;
		request.current?.abort(); request.current = null;
		if (flushTimer.current) clearTimeout(flushTimer.current); flushTimer.current = null;
		flushDone.current?.(); flushDone.current = null;
		releaseMedia(); frames.current = []; bytes.current = 0; levelRef.current = 0;
		callbacks.current.onActive(false); transition("idle");
		for (const resolve of waiters.current.splice(0)) resolve();
	}, [releaseMedia, transition]);
	const stop = useCallback(() => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "connecting") return;
		const gen = generation.current;
		transition("stopping");
		// Stop the microphone before transcription; flush the worklet's partial frame.
		for (const track of media.current?.getTracks() ?? []) track.stop();
		media.current = null;
		source.current?.disconnect(); source.current = null;
		void (async () => {
			try {
				if (capture.current) await new Promise<void>((resolve) => {
					flushDone.current = resolve;
					flushTimer.current = setTimeout(resolve, 500);
					capture.current!.port.postMessage({ type: "flush" });
				});
				if (gen !== generation.current) return;
				if (flushTimer.current) clearTimeout(flushTimer.current); flushTimer.current = null;
				flushDone.current = null;
				releaseMedia();
				if (bytes.current < 4_800) { cleanup(); return; }
				const audio = new Blob(frames.current, { type: "audio/pcm;rate=24000" });
				frames.current = [];
				const controller = new AbortController(); request.current = controller;
				const deadline = setTimeout(() => controller.abort(), 75_000);
				try {
					const language = await callbacks.current.getLanguage?.();
					if (gen !== generation.current) return;
					const headers: Record<string, string> = { "Content-Type": "audio/pcm;rate=24000", "x-lh-dictation": "1" };
					if (language && language !== "multi") headers["x-lh-dictation-language"] = language;
					const response = await fetch("/api/stt/transcribe", { method: "POST", body: audio, headers, signal: controller.signal });
					const result = await response.json() as { text?: string; message?: string };
					if (gen !== generation.current) return;
					if (!response.ok) throw new Error(result.message || "Codex dictation failed. Try again.");
					if (typeof result.text !== "string") throw new Error("Codex returned an invalid transcript.");
					if (result.text.trim()) callbacks.current.append(result.text.trim());
				} finally { clearTimeout(deadline); }
				if (gen === generation.current) cleanup();
			} catch (failure) {
				if (gen !== generation.current) return;
				setError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "Codex dictation took too long. Try again.");
				cleanup();
			}
		})();
	}, [cleanup, releaseMedia, transition]);
	stopRef.current = stop;
	const start = useCallback(async () => {
		if (phaseRef.current !== "idle") return;
		const gen = ++generation.current;
		setError(null); transition("connecting"); callbacks.current.onActive(true);
		frames.current = []; bytes.current = 0;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
			if (gen !== generation.current) { for (const track of stream.getTracks()) track.stop(); return; }
			media.current = stream;
			const ctx = new AudioContext({ sampleRate: 24_000 }); context.current = ctx;
			if (ctx.sampleRate !== 24_000) throw new Error("This device cannot record at the required sample rate.");
			await ctx.audioWorklet.addModule("/worklets/codex-pcm-capture.js");
			if (gen !== generation.current) return;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== generation.current) return;
			const node = new AudioWorkletNode(ctx, "codex-pcm-capture"); capture.current = node;
			node.port.onmessage = (event: MessageEvent<{ type: string; rms?: number; buffer?: ArrayBuffer }>) => {
				if (gen !== generation.current) return;
				const message = event.data;
				if (message.type === "level") levelRef.current = message.rms ?? 0;
				if (message.type === "flushed") { flushDone.current?.(); return; }
				if (message.type === "audio" && message.buffer) {
					const frame = message.buffer.slice(0, MAX_BYTES - bytes.current);
					if (frame.byteLength) { frames.current.push(frame); bytes.current += frame.byteLength; }
					if (bytes.current >= MAX_BYTES) stopRef.current();
				}
			};
			const input = ctx.createMediaStreamSource(stream); source.current = input;
			input.connect(node); node.connect(ctx.destination);
			transition("recording");
			timer.current = setTimeout(() => stopRef.current(), 120_000);
		} catch (failure) {
			if (gen !== generation.current) return;
			setError(failure instanceof DOMException && failure.name === "NotAllowedError" ? "Microphone permission denied" : failure instanceof Error && failure.message.includes("sample rate") ? failure.message : "The microphone could not be started. Check your input device and try again.");
			cleanup();
		}
	}, [cleanup, transition]);
	const cancel = useCallback(() => { if (phaseRef.current !== "idle") cleanup(); }, [cleanup]);
	const finish = useCallback(() => {
		if (phaseRef.current === "idle") return Promise.resolve();
		const done = new Promise<void>((resolve) => waiters.current.push(resolve));
		stop(); return done;
	}, [stop]);
	const toggle = useCallback(() => { if (phaseRef.current === "idle") void start(); else stop(); }, [start, stop]);
	useEffect(() => {
		if (!enabled) return;
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => { window.removeEventListener("lh:kbd-toggle-dictation", toggle); window.removeEventListener("lh:kbd-cancel-dictation", cancel); };
	}, [toggle, cancel, enabled]);
	useEffect(() => () => { cleanup(); }, [cleanup]);
	return { phase, error, levelRef, active: phase !== "idle", toggle, stop, finish, cancel, clearError: () => setError(null) };
}
