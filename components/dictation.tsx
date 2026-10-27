"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog, waitForPendingSettingsWrites } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { DICTATION_STOP_PCM_BYTES, MAX_DICTATION_WAV_BYTES, WAV_HEADER_BYTES, deepgramListenUrl, pcm16Wav, type DictationLanguage, type DictationProvider } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
export { isDictationActive } from "@/components/dictation-state";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
 *
 * The renderer captures 16 kHz mono PCM in an AudioWorklet. Deepgram streams
 * directly using a short-lived token from /api/stt/token. OpenAI buffers a
 * bounded recording and sends it through the local server after stop, using
 * the explicitly selected Platform API key. Neither real key reaches the
 * renderer. Finals append into the PRIMARY INPUT (see below).
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying session's socket can never
 *     tear down the current one.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: mic dies FIRST (no more audio enqueues), then CloseStream,
 *     then a 3s safety net in case Deepgram never closes the socket.
 *   - interim_results=false, endpointing=300: his live-tuned params — no
 *     partial hypotheses, finals commit ~300ms after a pause (owner
 *     round 1: live words are distracting and shift the meter; the
 *     meter's width is FIXED while recording).
 *
 * Owner round 2 (2026-09-17, second live test):
 *   - DEFERRED transcript: finals accumulate in a buffer during the run
 *     and flush into the primary input ONCE, when the dictation ends
 *     (click-again/Esc → Deepgram flushes its last finals → socket close
 *     → one joined append). Nothing textual renders while recording —
 *     only the meter. Live output may return as a toggleable setting at
 *     the settings milestone; deferred is the only behavior for now.
 *   - ADAPTIVE meter: the strip's cell count derives from its measured
 *     width (4px pitch, 8–48 cells, ResizeObserver) so narrow rows (the
 *     draft view's tighter column) show fewer bars instead of
 *     overflowing under their neighbors.
 *
 * Owner round 1 (2026-09-17, first live mic test):
 *   - ONE primary transcription input at all times: the pending
 *     quiz/ask question's field while one waits (text mode → the answer
 *     field, select modes → "Your thinking"), else the page's composer.
 *     Implemented as a module-level registry the question form claims on
 *     mount — see useDictationTarget below.
 *   - Click → meter IMMEDIATELY (optimistic): the meter strip renders
 *     from the click, connection + TCC happen behind it. The token mint
 *     and the mic acquisition run CONCURRENTLY (Promise.all) to shrink
 *     the real gap.
 *
 * Meter rendering lives in <DictationBar> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * tiny bar strip repaints.
 *
 * Start-latency mitigation wave (owner, 2026-09-27 — A+B+C+D, the
 * optimistic meter stays): the old start path serialized [token ∥ mic] →
 * NEW AudioContext → addModule fetch → WSS handshake, and DROPPED every
 * frame that arrived before the socket was OPEN — the first seconds of
 * speech never reached Deepgram. Now:
 *   - QUEUE-DON'T-DROP (A): frames arriving before OPEN buffer (capped,
 *     oldest dropped) and flush in order on open — captured speech is
 *     never lost, wherever in setup it lands.
 *   - PARALLEL HANDSHAKE (B, mic-gated): the handshake starts the moment
 *     the capture graph is live, not after it. Mic-gated, NOT token-gated:
 *     an OS TCC prompt can outlive Deepgram's 10s idle timeout.
 *   - PERSISTENT GRAPH (C): one app-lifetime AudioContext + a memoized
 *     worklet module — per-run contexts paid context creation AND a
 *     worklet-module fetch on every start (through the dev server in dev).
 *   - WARM TOKEN (D): pre-minted at page mount and refreshed after every
 *     run (TTL 3min); the click no longer waits on the remote mint. A
 *     stale-token handshake failure self-heals via the reconnect-once
 *     path, which always mints FRESH.
 *   - The honest floor stays: getUserMedia can't be pre-warmed (the mic
 *     indicator would stay lit) — hence the owner's optimistic meter.
 */

/*
 * Deepgram streaming params (the owner's live-tuned dictate config): nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
// URL construction lives in the browser-safe core; only language varies.

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak ("add it to auth.json
 * (desktop) or .env.local (dev)") — the surface says the short truth
 * instead. Exported for pins; the errored idle button's click recognizes
 * it and deep-links Settings → Keys → the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
export const OPENAI_DICTATION_KEYLESS = "Dictation needs an OpenAI API key";

/** Mint a fresh short-lived token (the route holds the real key
 *  server-side). Module-level: the start path's warm cache and the
 *  reconnect path both bottom out here. The keyless 503 (no
 *  DEEPGRAM_API_KEY) is the route's ONLY 503 — the raw message is
 *  dev-speak, so the error becomes the short client-authored line
 *  (zero-keys wave, owner 2026-09-25). */
async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void) | null = null;

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<boolean>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<boolean> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve(true);
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** A recording, upload, or failed audio awaiting retry/discard. */
	active: boolean;
	/** Failed OpenAI audio remains in memory until retried or discarded. */
	retryable: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended and the last final has landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters with false on failure or cancellation, so submit
	 *  paths can leave the user's draft untouched. */
	finish: () => Promise<boolean>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
};

/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
/** One capture target, with provider-specific finalization and no cross-provider fallback. */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const { getLanguage, getProvider } = useDictationLanguage();
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [retryable, setRetryable] = useState(false);
	const phaseRef = useRef<DictationPhase>("idle");
	const retryableRef = useRef(false);
	const providerRef = useRef<DictationProvider | null>(null);
	const levelRef = useRef(0);
	const appendRef = useRef(append);
	appendRef.current = append;
	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const pendingRef = useRef<Array<ArrayBuffer | ArrayBufferView>>([]);
	const pcmRef = useRef<Uint8Array[]>([]);
	const pcmBytesRef = useRef(0);
	const limitReachedRef = useRef(false);
	const uploadRef = useRef<AbortController | null>(null);
	const flushCaptureRef = useRef<(() => void) | null>(null);
	const stopRef = useRef<() => void>(() => {});
	const genRef = useRef(0);
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	const bufferRef = useRef<string[]>([]);
	const waitersRef = useRef<Array<(success: boolean) => void>>([]);

	const setRunPhase = useCallback((next: DictationPhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);

	const flush = useCallback(() => {
		if (bufferRef.current.length === 0) return;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		(questionTarget ?? appendRef.current)(text);
	}, []);

	/** Retaining failed OpenAI audio lets the user retry without re-recording. */
	const cleanup = useCallback((success = true, retainAudio = false) => {
		genRef.current++;
		const keep = retainAudio && pcmBytesRef.current > 0;
		retryableRef.current = keep;
		setRetryable(keep);
		setDictationActive(keep);
		if (success) flush(); else bufferRef.current = [];
		if (safetyRef.current) clearTimeout(safetyRef.current);
		safetyRef.current = null;
		flushCaptureRef.current = null;
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect(); sourceRef.current = null;
		workletRef.current?.disconnect(); workletRef.current = null;
		const ws = wsRef.current; wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try { ws.close(); } catch {}
		}
		uploadRef.current?.abort(); uploadRef.current = null;
		if (!keep) { pcmRef.current = []; pcmBytesRef.current = 0; }
		setRunPhase("idle");
		for (const waiter of waitersRef.current.splice(0)) waiter(success);
		if (providerRef.current === "deepgram") warmTokens.refresh();
	}, [flush, setRunPhase]);

	const uploadOpenAI = useCallback(async (gen: number) => {
		if (!pcmBytesRef.current) {
			setError("No audio was captured"); cleanup(false); return;
		}
		const controller = new AbortController();
		uploadRef.current = controller;
		try {
			const wav = pcm16Wav(pcmRef.current);
			const res = await fetch("/api/stt/openai", {
				method: "POST", headers: { "content-type": "audio/wav" }, body: wav, signal: controller.signal,
			});
			const body = await res.json().catch(() => ({})) as { text?: unknown; message?: unknown };
			if (!res.ok || typeof body.text !== "string") {
				throw new Error(typeof body.message === "string" ? body.message : "OpenAI transcription failed");
			}
			if (gen !== genRef.current) return;
			if (body.text.trim()) bufferRef.current.push(body.text.trim());
			setError(limitReachedRef.current ? "Recording reached its limit and was transcribed" : null);
			cleanup();
		} catch (e) {
			if (gen !== genRef.current || controller.signal.aborted) return;
			setError(e instanceof Error ? e.message : "OpenAI transcription failed");
			cleanup(false, true);
		}
	}, [cleanup]);

	const openSocket = useCallback((gen: number, token: string, language: DictationLanguage) => {
		const ws = new WebSocket(deepgramListenUrl(language), ["bearer", token]);
		wsRef.current = ws;
		ws.addEventListener("open", () => {
			if (gen !== genRef.current) return;
			for (const frame of pendingRef.current) ws.send(frame);
			pendingRef.current = [];
			setRunPhase("recording");
		});
		ws.addEventListener("message", (ev) => {
			if (gen !== genRef.current) return;
			let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
			try { msg = JSON.parse(ev.data as string); } catch { return; }
			const text = msg.channel?.alternatives?.[0]?.transcript;
			if (msg.type === "Results" && msg.is_final && text) bufferRef.current.push(text);
		});
		ws.addEventListener("close", (ev) => {
			if (gen !== genRef.current) return;
			if (ev.code === 1000) { cleanup(); return; }
			if (reconnectsRef.current < 1) {
				reconnectsRef.current++;
				mintFreshToken().then((t) => { if (gen === genRef.current) openSocket(gen, t, language); }).catch(() => {
					if (gen === genRef.current) { setError("Deepgram reconnect failed"); cleanup(); }
				});
			} else { setError(`Deepgram connection lost (${ev.code})`); cleanup(); }
		});
	}, [cleanup, setRunPhase]);

	const start = useCallback(async () => {
		if (phaseRef.current !== "idle" || retryableRef.current) return;
		setDictationActive(true);
		setError(null); setRunPhase("connecting");
		providerRef.current = null;
		reconnectsRef.current = 0; bufferRef.current = []; pendingRef.current = [];
		pcmRef.current = []; pcmBytesRef.current = 0; limitReachedRef.current = false;
		const gen = ++genRef.current;
		try {
			await waitForPendingSettingsWrites("general");
			if (gen !== genRef.current) return;
			const provider = await getProvider();
			if (gen !== genRef.current) return;
			providerRef.current = provider;
			if (provider === "openai") {
				const keys = await fetch("/api/keys", { cache: "no-store" });
				if (!keys.ok) throw new Error("Could not check the OpenAI API key");
				const body = await keys.json() as { keys?: { id: string; present: boolean }[] };
				if (!body.keys?.some((key) => key.id === "OPENAI_API_KEY" && key.present)) throw new Error(OPENAI_DICTATION_KEYLESS);
			}
			if (gen !== genRef.current) return;
			// Deepgram uses the confirmed language for the entire run, including reconnects.
			const language = provider === "deepgram" ? await getLanguage() : null;
			if (gen !== genRef.current) return;
			const tokenPromise = provider === "deepgram" ? warmTokens.mint() : null;
			tokenPromise?.catch(() => {});
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== genRef.current) { for (const track of stream.getTracks()) track.stop(); return; }
			streamRef.current = stream;
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (provider === "openai" && ctx.sampleRate !== 16000) throw new Error("This microphone cannot capture 16 kHz audio");
			if (gen !== genRef.current) return;
			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (event) => {
				if (gen !== genRef.current) return;
				const msg = event.data as { type: string; rms?: number; buffer?: ArrayBuffer | ArrayBufferView };
				if (msg.type === "level") { levelRef.current = msg.rms ?? 0; return; }
				if (msg.type === "flushed") { flushCaptureRef.current?.(); return; }
				if (msg.type !== "audio" || !msg.buffer) return;
				if (provider === "openai") {
					const bytes = msg.buffer instanceof ArrayBuffer
						? new Uint8Array(msg.buffer) : new Uint8Array(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
					if (pcmBytesRef.current + bytes.byteLength + WAV_HEADER_BYTES > MAX_DICTATION_WAV_BYTES) {
						setError("Recording exceeded the audio limit; retry the captured portion or discard it");
						cleanup(false, true); return;
					}
					pcmRef.current.push(Uint8Array.from(bytes));
					pcmBytesRef.current += bytes.byteLength;
					if (pcmBytesRef.current >= DICTATION_STOP_PCM_BYTES && phaseRef.current === "recording") {
						limitReachedRef.current = true;
						stopRef.current();
					}
				} else {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer);
					else { pendingRef.current.push(msg.buffer); if (pendingRef.current.length > 256) pendingRef.current.shift(); }
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source; source.connect(worklet); worklet.connect(ctx.destination);
			if (provider === "openai") { setRunPhase("recording"); return; }
			const token = await tokenPromise!;
			if (gen === genRef.current && language) openSocket(gen, token, language);
		} catch (e) {
			if (gen !== genRef.current) return;
			const message = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
				? "Microphone permission denied" : e instanceof Error ? e.message : "Dictation unavailable";
			setError(message); cleanup(false);
		}
	}, [cleanup, getLanguage, getProvider, openSocket, setRunPhase]);

	const stop = useCallback(() => {
		const current = phaseRef.current;
		const gen = genRef.current;
		if (current !== "recording" && current !== "connecting") return;
		setRunPhase("stopping");
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect(); sourceRef.current = null;
		if (providerRef.current === "openai") {
			const worklet = workletRef.current;
			if (!worklet) { setError("No audio was captured"); cleanup(false); return; }
			flushCaptureRef.current = () => {
				if (gen !== genRef.current) return;
				flushCaptureRef.current = null;
				if (safetyRef.current) clearTimeout(safetyRef.current);
				safetyRef.current = null;
				worklet.disconnect(); workletRef.current = null;
				void uploadOpenAI(gen);
			};
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) { setError("Could not finish audio capture"); cleanup(false, true); }
			}, 3000);
			try { worklet.port.postMessage({ type: "flush" }); }
			catch { setError("Could not finish audio capture"); cleanup(false, true); }
			return;
		}
		workletRef.current?.disconnect(); workletRef.current = null;
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try { ws.send(JSON.stringify({ type: "CloseStream" })); }
			catch { cleanup(); return; }
			safetyRef.current = setTimeout(() => { if (gen === genRef.current) cleanup(); }, 3000);
		} else cleanup(providerRef.current !== null);
	}, [cleanup, setRunPhase, uploadOpenAI]);
	stopRef.current = stop;

	const cancel = useCallback(() => {
		if (phaseRef.current === "idle" && !retryableRef.current) return;
		bufferRef.current = [];
		setError(null);
		cleanup(false);
	}, [cleanup]);

	const finish = useCallback((): Promise<boolean> => new Promise((resolve) => {
		const current = phaseRef.current;
		if (current === "idle") { resolve(!retryableRef.current); return; }
		waitersRef.current.push(resolve);
		if (current === "recording" || current === "connecting") stop();
	}), [stop]);

	useEffect(() => {
		dictationFinisher = finish;
		return () => { if (dictationFinisher === finish) dictationFinisher = null; };
	}, [finish]);

	const toggle = useCallback(() => {
		const current = phaseRef.current;
		if (current === "idle" && retryableRef.current) {
			setError(null); setRunPhase("stopping"); setDictationActive(true);
			void uploadOpenAI(++genRef.current);
		} else if (current === "idle") void start();
		else if (current === "recording" || current === "connecting") stop();
	}, [start, stop, setRunPhase, uploadOpenAI]);

	useEffect(() => {
		let cancelled = false;
		void getProvider().then((provider) => {
			if (!cancelled && provider === "deepgram") warmTokens.refresh();
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [getProvider]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);
	useEffect(() => () => {
		genRef.current++;
		setDictationActive(false);
		uploadRef.current?.abort();
		if (safetyRef.current) clearTimeout(safetyRef.current);
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		sourceRef.current?.disconnect(); workletRef.current?.disconnect();
		try { wsRef.current?.close(); } catch {}
		for (const waiter of waitersRef.current.splice(0)) waiter(false);
	}, []);

	return { phase, error, levelRef, active: phase !== "idle" || retryable, retryable, toggle, stop, finish, cancel, clearError: () => setError(null) };
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             Deepgram flushes the last final.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, retryable, cancel, clearError } = dictation;
	const active = phase !== "idle";
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the Deepgram row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS || error === OPENAI_DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	/** Adaptive cell count (owner round 2): derived from the meter's
	 *  measured width — narrow rows show fewer bars instead of
	 *  overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (retryable && !active) {
		return (
			<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-retry">
				<Hint label={error ?? "OpenAI transcription failed"} side="top">
					<button type="button" onClick={toggle} data-testid="dictation-retry-button" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
						Retry transcription
					</button>
				</Hint>
				<button type="button" onClick={cancel} data-testid="dictation-discard-button" className="rounded-md px-2 py-1 text-xs text-muted-foreground">Discard audio</button>
			</div>
		);
	}

	if (!active) {
		return (
			<Hint
				// The error line truncates in the button; its tooltip reveals it.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", error === DICTATION_KEYLESS ? DEEPGRAM_KEY_ID : undefined);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
					className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
				>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint label="Stop dictation (Esc)" side="top">
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
					data-testid="dictation-toggle"
					className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
				>
					{phase === "stopping" ? <Loader2Icon className="size-3.5 animate-spin" /> : <MicIcon className="size-3.5" />}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
