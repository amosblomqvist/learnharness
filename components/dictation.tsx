"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { LOCAL_DICTATION_MAX_MS } from "@/src/core";
import { createDeepgramEngine, createLocalEngine, warmDeepgram, DICTATION_KEYLESS, type DictationEngine } from "./dictation-engines";
export { createWarmMinter, WARM_TOKEN_TTL_MS, DICTATION_KEYLESS } from "./dictation-engines";
export type { WarmMinter } from "./dictation-engines";
import { useDictationLanguage } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
export { isDictationActive } from "@/components/dictation-state";

/**
 * Voice dictation — shared capture for cloud streaming and local uploads.
 * Local mode buffers PCM in memory, then uploads WAV on stop. Transport
 * adapters live in dictation-engines.ts; the cloud tuning history follows.
 *
 * Architecture (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket DIRECTLY (audio never loops
 * through our server) with a short-lived token minted by /api/stt/token
 * (the real key stays server-side), and streams frames while it listens.
 * Finals append into the PRIMARY INPUT (see below).
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
let composerTarget: ((text: string) => void) | null = null;

/** File references use the very same default destination as dictation,
 * including claims whose dock is currently collapsed. A focused editor can
 * insert at its caret instead; callers use this only as the fallback. */
export function appendToPrimaryInput(text: string): boolean {
	const target = questionTarget ?? composerTarget;
	if (!target) return false;
	target(text);
	return true;
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
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
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — the engine's final transcript has landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters — cancel (Esc) resolves them too, by its
	 *  discard semantics. */
	finish: () => Promise<void>;
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
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const { getSettings } = useDictationLanguage();
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const phaseRef = useRef<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const levelRef = useRef(0);
	const appendRef = useRef(append);
	appendRef.current = append;
	const engineRef = useRef<DictationEngine | null>(null);
	const cloudRef = useRef(false);
	const streamRef = useRef<MediaStream | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const flushCaptureRef = useRef<(() => void) | null>(null);
	const genRef = useRef(0);
	const bufferRef = useRef<string[]>([]);
	const waitersRef = useRef<Array<() => void>>([]);
	const limitRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const finishStartedRef = useRef(false);
	const captureReadyRef = useRef(false);
	const stopRef = useRef<() => void>(() => {});

	const changePhase = useCallback((next: DictationPhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);
	useEffect(() => {
		const target = (text: string) => appendRef.current(text);
		composerTarget = target;
		return () => { if (composerTarget === target) composerTarget = null; };
	}, []);

	/** Both engines finish through one teardown, flush, and waiter release. */
	const cleanup = useCallback((warmNext = true) => {
		genRef.current++;
		clearTimeout(limitRef.current);
		setDictationActive(false);
		if (bufferRef.current.length) {
			const text = bufferRef.current.join(" ");
			bufferRef.current = [];
			(questionTarget ?? appendRef.current)(text);
		}
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect(); sourceRef.current = null;
		workletRef.current?.disconnect(); workletRef.current = null;
		flushCaptureRef.current?.(); flushCaptureRef.current = null;
		engineRef.current?.cancel(); engineRef.current = null;
		captureReadyRef.current = false;
		changePhase("idle");
		for (const waiter of waitersRef.current.splice(0)) waiter();
		if (warmNext && cloudRef.current) warmDeepgram();
	}, [changePhase]);

	/** Stop input first, then drain the partial worklet frame before inference. */
	const endCapture = useCallback(async () => {
		if (finishStartedRef.current || !captureReadyRef.current) return;
		finishStartedRef.current = true;
		const gen = genRef.current;
		clearTimeout(limitRef.current);
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect(); sourceRef.current = null;
		const worklet = workletRef.current;
		if (worklet?.port.postMessage) {
			const drained = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 1000);
				flushCaptureRef.current = () => { clearTimeout(timer); resolve(true); };
				try { worklet.port.postMessage({ type: "flush" }); }
				catch { clearTimeout(timer); resolve(false); }
			});
			if (gen !== genRef.current) return;
			if (!drained) { setError("Could not finish microphone capture. Try recording again."); cleanup(); return; }
		}
		if (gen !== genRef.current) return;
		flushCaptureRef.current = null;
		worklet?.disconnect(); workletRef.current = null;
		engineRef.current?.finish();
	}, [cleanup]);

	const start = useCallback(async () => {
		if (phaseRef.current !== "idle") return;
		setDictationActive(true);
		setError(null);
		changePhase("connecting");
		bufferRef.current = [];
		finishStartedRef.current = false;
		captureReadyRef.current = false;
		cloudRef.current = false;
		const gen = ++genRef.current;
		try {
			const settings = await getSettings();
			if (gen !== genRef.current) return;
			const events = {
				ready() { if (gen === genRef.current && phaseRef.current !== "stopping") changePhase("recording"); },
				text(text: string) { if (gen === genRef.current) bufferRef.current.push(text); },
				end() { if (gen === genRef.current) cleanup(); },
				error(message: string) { if (gen === genRef.current) { setError(message); cleanup(); } },
				limit() { if (gen === genRef.current) { setError("Recording stopped at the 10-minute limit"); stopRef.current(); } },
			};
			cloudRef.current = settings.provider !== "local";
			if (settings.provider === "local" && !settings.local) throw new Error("Configure a local dictation endpoint in Settings");
			const engine = settings.provider === "local" && settings.local
				? createLocalEngine(settings.local, events)
				: createDeepgramEngine(settings.language ?? "en", events);
			engineRef.current = engine;
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== genRef.current) { for (const track of stream.getTracks()) track.stop(); return; }
			streamRef.current = stream;
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (gen !== genRef.current) return;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;
			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (event) => {
				if (gen !== genRef.current) return;
				const message = event.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (message.type === "level") levelRef.current = message.rms ?? 0;
				else if (message.type === "audio" && message.buffer) engine.write(message.buffer);
				else if (message.type === "flushed") flushCaptureRef.current?.();
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet); worklet.connect(ctx.destination);
			captureReadyRef.current = true;
			engine.connect();
			if ((phaseRef.current as DictationPhase) === "stopping") void endCapture();
			else if (settings.provider === "local") {
				limitRef.current = setTimeout(() => {
					if (gen !== genRef.current) return;
					setError("Recording stopped at the 10-minute limit");
					stopRef.current();
				}, LOCAL_DICTATION_MAX_MS);
			}
		} catch (error) {
			if (gen !== genRef.current) return;
			setError(error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
				? "Microphone permission denied" : error instanceof Error ? error.message : "Microphone unavailable");
			cleanup();
		}
	}, [getSettings, cleanup, changePhase, endCapture]);

	const stop = useCallback(() => {
		if (phaseRef.current !== "connecting" && phaseRef.current !== "recording") return;
		if (!captureReadyRef.current) { cleanup(); return; }
		changePhase("stopping");
		void endCapture();
	}, [changePhase, endCapture, cleanup]);
	stopRef.current = stop;
	const cancel = useCallback(() => {
		if (phaseRef.current === "idle") return;
		bufferRef.current = [];
		cleanup();
	}, [cleanup]);
	const finish = useCallback((): Promise<void> => {
		if (phaseRef.current === "idle") return Promise.resolve();
		const done = new Promise<void>((resolve) => { waitersRef.current.push(resolve); });
		stop();
		return done;
	}, [stop]);
	useEffect(() => {
		dictationFinisher = finish;
		return () => { if (dictationFinisher === finish) dictationFinisher = null; };
	}, [finish]);
	const toggle = useCallback(() => {
		if (phaseRef.current === "idle") void start(); else stop();
	}, [start, stop]);
	useEffect(() => {
		let mounted = true;
		void getSettings().then((settings) => { if (mounted && settings.provider !== "local") warmDeepgram(); }).catch(() => {});
		return () => { mounted = false; bufferRef.current = []; cleanup(false); };
	}, [cleanup, getSettings]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);
	return { phase, error, levelRef, active: phase !== "idle", toggle, stop, finish, cancel, clearError: () => setError(null) };
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
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the Deepgram row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
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
							openSettings("keys", DEEPGRAM_KEY_ID);
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
