"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { deepgramListenUrl, type DictationLanguage } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
import { dispatchFocusedPluginShortcut } from "@/components/plugin-input-focus";
export { isDictationActive } from "@/components/dictation-state";
import { AppleModelDialog } from "@/components/apple-model-dialog";
import {
	appleModelReady,
	appleSpeechBridge,
	appleStatus,
	chooseEngine,
	refreshAppleStatus,
	subscribeAppleStatus,
	wireAppleInstallEvents,
	type AppleSpeechEvent,
} from "@/components/apple-speech";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
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
 *
 * Apple on-device engine (components/apple-speech.ts):
 * with NO Deepgram key on macOS 26+, the same capture graph streams its
 * frames over IPC to the SpeechAnalyzer helper instead of the Deepgram
 * socket; finals, the deferred flush, stop/cancel/finish and the meter are
 * shared. On a host with the bridge, the engine is decided BEFORE the mic
 * (warm token + cached status — near-instant), so the model-download
 * prompt never lights the mic indicator. The download always asks first
 * (AppleModelDialog); "downloading" shows its progress in the bar.
 */

/*
 * Deepgram streaming params (the owner's live-tuned dictate config): nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
// URL construction lives in the browser-safe core; only language varies.

/** Apple's stop path finalizes the last phrase on-device; allow longer
 *  than Deepgram's 3s before the safety net ends the run anyway. */
const APPLE_STOP_SAFETY_MS = 10_000;

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
export const DICTATION_ACTIVE_ELSEWHERE = "Dictation is active elsewhere";

// Mounted controllers do not claim capture. Only start() acquires the single
// window-wide owner, synchronously, before settings/mic/token awaits.
let recordingOwner: symbol | null = null;
let recordingTarget: ((text: string) => unknown) | null = null;
const controllers = new Map<symbol, { primary: boolean; toggle: () => void; cancel: () => void }>();
function toggleGlobalDictation() {
	if (dispatchFocusedPluginShortcut("toggle-dictation")) return;
	for (const controller of controllers.values()) {
		if (controller.primary) {
			controller.toggle();
			return;
		}
	}
}
function cancelGlobalDictation() {
	if (recordingOwner) controllers.get(recordingOwner)?.cancel();
}
function registerController(id: symbol, controller: { primary: boolean; toggle: () => void; cancel: () => void }) {
	if (controllers.size === 0) {
		window.addEventListener("lh:kbd-toggle-dictation", toggleGlobalDictation);
		window.addEventListener("lh:kbd-cancel-dictation", cancelGlobalDictation);
	}
	controllers.set(id, controller);
	return () => {
		controllers.delete(id);
		if (controllers.size === 0) {
			window.removeEventListener("lh:kbd-toggle-dictation", toggleGlobalDictation);
			window.removeEventListener("lh:kbd-cancel-dictation", cancelGlobalDictation);
		}
	};
}

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
let questionTarget: ((text: string) => void | Promise<void>) | null = null;
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

/* The CORE finisher registry: the pending question's dock needs finish()
 * without a prop bridge. Explicit plugin controllers never register here;
 * their submit paths await their own controller.finish(). */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish the core page's dictation before continuing (see Dictation.finish). */
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
export function usePluginQuestionDictationTarget(append: (text: string) => void | Promise<void>, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) {
				// Cancel/discard an obsolete capture before releasing its destination.
				if (recordingTarget === append) cancelGlobalDictation();
				questionTarget = null;
			}
		};
	}, [append, claimed]);
}

export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type DictationPhase = "idle" | "downloading" | "connecting" | "recording" | "stopping";

export interface DictationDestination { id: string; append: (text: string) => void | Promise<void> }

export type Dictation = {
	phase: DictationPhase;
	/** One shared recorder; an explicit side destination never claims the main input. */
	destinationId: string;
	blocked?: boolean;
	toggleFor: (destination: DictationDestination) => void;
	finishFor: (destinationId: string) => Promise<void>;
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
	 *  ended — Deepgram's last finals have landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  settles the waiters. Cancel (Esc) normally resolves after discarding
	 *  buffered speech; cancel/dispose during asynchronous transcript delivery
	 *  rejects instead, so a waiting submit cannot send stale text. */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
	/** The Apple model-download prompt: the locale's display name while it
	 *  is open, else null. */
	modelPrompt: string | null;
	/** 0..1 during the "downloading" phase, else null. */
	downloadProgress: number | null;
	/** Download (the prompt's primary action), then start dictating. */
	confirmModel: () => void;
	dismissModel: () => void;
};

/**
 * Shared capture engine with one synchronous window-wide recording owner.
 * Each primary run captures its main/question or explicit side destination.
 * Explicit plugin controllers never claim the primary target or finisher;
 * their asynchronous transcript delivery is part of finishing.
 */
export function useDictation({ append, destination = "primary", disabled = false }: {
	append: (text: string) => void;
	/** Explicit destinations never register or consult the core primary target. */
	destination?: "primary" | "explicit";
	disabled?: boolean;
}): Dictation {
	const primary = destination === "primary";
	const owner = useRef(Symbol("dictation")).current;
	const { getLanguage } = useDictationLanguage();
	const [phase, setPhaseState] = useState<DictationPhase>("idle");
	const phaseRef = useRef<DictationPhase>("idle");
	const setPhase = useCallback((next: DictationPhase) => {
		phaseRef.current = next;
		setPhaseState(next);
	}, []);
	const [destinationId, setDestinationId] = useState("main");
	const destinationRef = useRef<DictationDestination | null>(null);
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const [error, setError] = useState<string | null>(null);
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	const levelRef = useRef(0);
	/** Fresh fallback for the next start; a live run retains its own target. */
	const appendRef = useRef(append);
	appendRef.current = append;
	useEffect(() => {
		if (!primary) return;
		const target = (text: string) => appendRef.current(text);
		composerTarget = target;
		return () => {
			if (composerTarget === target) composerTarget = null;
		};
	}, [primary]);

	// Live machinery (non-render values). The MediaStream tracks stop and
	// the per-run nodes disconnect on teardown; the socket is recreated per
	// run; the AudioContext is app-lifetime (mitigation C).
	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes — the CONTEXT outlives runs (mitigation C). */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before the socket is OPEN (mitigation A): flushed in
	 *  order on open; capped at 256 frames (≈32s) with the oldest dropped;
	 *  cleared at teardown so a dead run's audio can't leak into the next. */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	/** The deferred transcript (owner round 2): finals land here during the
	 *  run and flush into the primary input once, at teardown. */
	const bufferRef = useRef<string[]>([]);
	/** Resolvers waiting for the run to fully end (finish(), owner
	 *  2026-10-01): released by cleanup() — every terminal path runs it. */
	const waitersRef = useRef<Array<{ resolve: () => void; reject: (error: unknown) => void }>>([]);
	const appendFailureRef = useRef<{ error: unknown } | null>(null);
	const appendPendingRef = useRef(false);
	/** Which transport the live run uses. */
	const engineRef = useRef<"deepgram" | "apple">("deepgram");
	/** The Apple helper session (null when idle), its readiness, and the
	 *  event subscription's disposer. */
	const appleSessionRef = useRef<number | null>(null);
	const appleReadyRef = useRef(false);
	const appleOffRef = useRef<(() => void) | null>(null);
	const [modelPrompt, setModelPrompt] = useState<string | null>(null);
	const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
	/** Where a run waiting on the model prompt or download will start. */
	const promptDestinationRef = useRef<DictationDestination | undefined>(undefined);

	/** Flush into this run's fixed destination. Called exactly once at cleanup; the
	 *  buffer clears itself so double-cleanup is a no-op. */
	const flush = useCallback((): unknown => {
		if (bufferRef.current.length === 0) return;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		return (destinationRef.current?.append ?? appendRef.current)(text);
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
	const cleanup = useCallback((warmNext = true) => {
		const endGen = ++genRef.current;
		let appended: unknown;
		// A second cleanup (cancel/dispose) cannot turn an unfinished async
		// append into a successful finish: that would send the old draft.
		let failure: { error: unknown } | null = appendPendingRef.current
			? { error: new DOMException("Dictation transcript delivery canceled", "AbortError") }
			: null;
		appendPendingRef.current = false;
		try {
			appended = flush(); // exactly one append, after the final transcript
		} catch (error) {
			failure = { error };
		}
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		// The AudioContext is app-lifetime (mitigation C) — nodes die, it stays.
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		appleOffRef.current?.();
		appleOffRef.current = null;
		const appleSession = appleSessionRef.current;
		appleSessionRef.current = null;
		appleReadyRef.current = false;
		// No-op when the helper already exited; kills it on cancel paths.
		if (appleSession !== null) void appleSpeechBridge()?.cancel(appleSession);
		setDownloadProgress(null);
		const complete = (failed: { error: unknown } | null) => {
			if (endGen !== genRef.current) return;
			appendPendingRef.current = false;
			appendFailureRef.current = failed;
			if (failed) setError(failed.error instanceof Error ? failed.error.message : "Dictation transcript could not be applied");
			if (recordingOwner === owner) {
				recordingOwner = null;
				recordingTarget = null;
				setDictationActive(false);
			}
			setPhase("idle");
			// A plugin's async onTranscript is part of finishing, not a
			// fire-and-forget notification: send must see its controlled text.
			for (const waiter of waitersRef.current.splice(0)) {
				if (failed) waiter.reject(failed.error);
				else waiter.resolve();
			}
			if (warmNext) warmTokens.refresh();
		};
		if (appended && typeof (appended as PromiseLike<unknown>).then === "function") {
			appendPendingRef.current = true;
			setPhase("stopping");
			// Both branches consume the promise, including stop-without-finish.
			void Promise.resolve(appended).then(() => complete(null), (error: unknown) => complete({ error }));
		} else complete(failure);
	}, [flush, owner, setPhase]);

	/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
	const openSocket = useCallback(
		(gen: number, token: string, language: DictationLanguage) => {
			// Minted JWTs authenticate via the "bearer" subprotocol — ["token",
			// jwt] is rejected at the handshake (verified live; "token" is for
			// raw API keys only, as in the owner's pi dictate extension).
			const ws = new WebSocket(deepgramListenUrl(language), ["bearer", token]);
			wsRef.current = ws;

			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				// Mitigation A: everything captured during the handshake (or a
				// reconnect gap) goes out now, in order — Deepgram accepts
				// faster-than-realtime sends.
				for (const frame of pendingRef.current) ws.send(frame);
				pendingRef.current = [];
				setPhase("recording");
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: any;
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "Results") {
					const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
					// Only finals stream (interim_results=false). DEFERRED (owner
					// round 2): they buffer here and reach the input once, at
					// teardown — the meter is the only live feedback.
					if (msg.is_final && text) bufferRef.current.push(text);
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now — the stop path's
					// safety net stays as the no-close backstop only.
					cleanup();
					return;
				}
				// Abnormal close mid-run: ONE reconnect with a fresh token (the
				// research pass: resume is our job, no SDK to lean on).
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintFreshToken() // always FRESH — a stale warm token is the likely culprit
						.then((t) => {
							if (gen === genRef.current) openSocket(gen, t, language);
						})
						.catch(() => {
							if (gen === genRef.current) {
								setError("Deepgram reconnect failed");
								cleanup();
							}
						});
				} else {
					setError(`Deepgram connection lost (${ev.code})`);
					cleanup();
				}
			});
		},
		[cleanup, setPhase],
	);

	/** Start the Apple helper session and wire its events. `gen` guards staleness. */
	const openApple = useCallback(
		async (gen: number) => {
			const bridge = appleSpeechBridge();
			if (!bridge) {
				setError("Apple dictation unavailable");
				cleanup();
				return;
			}
			const handle = (ev: AppleSpeechEvent) => {
				if (ev.type === "ready") {
					appleReadyRef.current = true;
					for (const frame of pendingRef.current) bridge.audio(ev.session, frame);
					pendingRef.current = [];
					setPhase("recording");
				} else if (ev.type === "final") {
					bufferRef.current.push(ev.text); // deferred, as with Deepgram
				} else if (ev.type === "error" && ev.message === "model-missing") {
					// macOS dropped the model since the status check: ask again.
					bufferRef.current = [];
					promptDestinationRef.current = destinationRef.current ?? undefined;
					cleanup();
					void refreshAppleStatus().then((status) => {
						if (status.available) setModelPrompt(status.language);
					});
				} else if (ev.type === "error") {
					setError(`Apple dictation failed: ${ev.message}`);
					cleanup();
				} else {
					cleanup(); // "end": the helper finalized and exited
				}
			};
			appleOffRef.current?.();
			// main replies to start() before the helper can emit anything, and
			// IPC to one window stays ordered: every event finds its session set.
			appleOffRef.current = bridge.onEvent((ev) => {
				if (gen === genRef.current && ev.session === appleSessionRef.current) handle(ev);
			});
			try {
				const { session } = await bridge.start();
				if (gen !== genRef.current) {
					void bridge.cancel(session);
					return;
				}
				appleSessionRef.current = session;
			} catch (e) {
				if (gen !== genRef.current) return;
				setError(e instanceof Error ? e.message : "Apple dictation unavailable");
				cleanup();
			}
		},
		[cleanup, setPhase],
	);

	const start = useCallback(async (destination?: DictationDestination) => {
		if (disabledRef.current || phaseRef.current !== "idle") return;
		if (recordingOwner !== null && recordingOwner !== owner) {
			setError(DICTATION_ACTIVE_ELSEWHERE);
			return;
		}
		const target = destination ?? { id: "main", append: primary ? questionTarget ?? appendRef.current : (text: string) => appendRef.current(text) };
		destinationRef.current = target;
		setDestinationId(target.id);
		recordingOwner = owner;
		recordingTarget = target.append;
		setDictationActive(true);
		setError(null);
		appendFailureRef.current = null;
		setPhase("connecting");
		reconnectsRef.current = 0;
		bufferRef.current = []; // fresh run, fresh buffer (round 2)
		pendingRef.current = []; // fresh run, fresh queue (mitigation A)
		const gen = ++genRef.current;
		let language: DictationLanguage;
		try {
			language = await getLanguage();
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "Dictation language unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;

		// Mitigation D: the warm token (pre-minted at mount / after the last
		// run) resolves ~instantly; a cold/keyless mint surfaces below. The
		// mic is the long pole (macOS HAL + APM init) and gates everything —
		// the token runs concurrently with it. 127.0.0.1 is a secure
		// context, so getUserMedia works without TLS; macOS TCC prompts on
		// first use.
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {}); // surfaced below; no unhandled rejection
		engineRef.current = "deepgram";
		if (appleSpeechBridge()) {
			// Engine BEFORE mic: both inputs are warm, and the download
			// prompt must not light the mic.
			const apple = await appleStatus();
			const hasKey = await tokenPromise.then(
				() => true,
				// Only the keyless 503 means "no key"; other failures stay
				// Deepgram's to surface.
				(e: unknown) => !(e instanceof Error && e.message === DICTATION_KEYLESS),
			);
			if (gen !== genRef.current) return;
			if (chooseEngine(hasKey, apple) === "apple") {
				if (!appleModelReady(apple) && apple.available) {
					promptDestinationRef.current = destination;
					cleanup(false); // releases the owner; the prompt is not a run
					setModelPrompt(apple.language);
					return;
				}
				engineRef.current = "apple";
			}
		}
		const micPromise = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		let stream: MediaStream;
		try {
			stream = await micPromise;
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			// Mitigation C: app-lifetime context + memoized worklet module —
			// per-run costs (context creation, module fetch) are gone.
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				if (gen !== genRef.current) return;
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio" && engineRef.current === "apple") {
					const session = appleSessionRef.current;
					if (session !== null && appleReadyRef.current) appleSpeechBridge()?.audio(session, msg.buffer!);
					// Queue until the helper is ready (mitigation A, same cap).
					else {
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > 256) pendingRef.current.shift();
					}
				} else if (msg.type === "audio") {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer!);
					// Mitigation A: not OPEN yet (handshake or reconnect gap) —
					// queue, capped; the open handler flushes in order.
					else {
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > 256) pendingRef.current.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) —
			// an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		if (engineRef.current === "apple") {
			void openApple(gen);
			return;
		}
		let token: string;
		try {
			token = await tokenPromise;
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "token unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		// Mitigation B: the handshake fires the moment the graph is live,
		// overlapping any remaining token wait — mic-gated, never before it.
		openSocket(gen, token, language);
	}, [openSocket, openApple, cleanup, getLanguage, owner, primary, setPhase]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phaseRef.current !== "recording" && phaseRef.current !== "connecting") return;
		setPhase("stopping");

		// Mic dies FIRST — no more audio enqueues (dictate pattern). The
		// per-run nodes die with it; the AudioContext stays (mitigation C).
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;

		if (engineRef.current === "apple") {
			const session = appleSessionRef.current;
			if (session === null) {
				cleanup();
				return;
			}
			// Closing stdin finalizes: the helper sends its last finals, then
			// "end" runs cleanup(); the safety net covers a helper that hangs.
			void appleSpeechBridge()?.stop(session);
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, APPLE_STOP_SAFETY_MS);
			return;
		}

		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				cleanup();
				return;
			}
			// Deepgram flushes remaining finals then closes; if it never
			// does, the safety net ends the run anyway (dictate pattern).
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 3000);
		} else {
			cleanup();
		}
	}, [cleanup, setPhase]);

	const cancel = useCallback(() => {
		if (phaseRef.current === "idle") return;
		// Discard first, teardown second — cleanup() flushes, and the now-empty
		// buffer makes that flush a no-op. Also kills a "stopping" run: the
		// flush already underway is abandoned (its timer is cleared inside).
		bufferRef.current = [];
		cleanup();
	}, [cleanup]);

	const finishCurrent = useCallback((): Promise<void> => {
		return new Promise((resolve, reject) => {
			// A model download is not a run: nothing to flush, never block a submit.
			if (phaseRef.current === "idle" || phaseRef.current === "downloading") {
				if (appendFailureRef.current) reject(appendFailureRef.current.error);
				else resolve();
				return;
			}
			waitersRef.current.push({ resolve, reject });
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phaseRef.current === "recording" || phaseRef.current === "connecting") stop();
		});
	}, [stop]);
	const finishFor = useCallback((id: string) => destinationRef.current?.id === id ? finishCurrent() : Promise.resolve(), [finishCurrent]);
	// A main submission must not stop or wait for side-input recording.
	const finish = useCallback(() => finishFor("main"), [finishFor]);

	// Publish finish() for the sibling subtrees (the pending question's
	// dock) — registered for as long as this page owns the hook.
	useEffect(() => {
		if (!primary) return;
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish, primary]);

	const confirmModel = useCallback(() => {
		const bridge = appleSpeechBridge();
		setModelPrompt(null);
		if (!bridge) return;
		if (recordingOwner !== null && recordingOwner !== owner) {
			setError(DICTATION_ACTIVE_ELSEWHERE);
			return;
		}
		const destination = promptDestinationRef.current;
		const gen = ++genRef.current;
		// Hold the recording owner so Esc cancels the wait (the download continues in macOS).
		recordingOwner = owner;
		recordingTarget = destination?.append ?? null;
		setDictationActive(true);
		setError(null);
		setDownloadProgress(0);
		setPhase("downloading");
		bridge
			.install()
			.then(() => refreshAppleStatus())
			.then(() => {
				if (gen !== genRef.current) return;
				setDownloadProgress(null);
				setPhase("idle");
				void start(destination);
			})
			.catch((e: unknown) => {
				if (gen !== genRef.current) return;
				setError(e instanceof Error ? `Model download failed: ${e.message}` : "Model download failed");
				cleanup();
			});
	}, [start, cleanup, owner, setPhase]);

	const dismissModel = useCallback(() => setModelPrompt(null), []);

	// Shared download progress (the Settings row may have started it).
	useEffect(() => {
		wireAppleInstallEvents();
		return subscribeAppleStatus((status) => {
			if (status.available && status.model === "downloading" && status.progress !== undefined) {
				setDownloadProgress((current) => (current === null ? current : status.progress!));
			}
		});
	}, []);

	const toggleFor = useCallback((destination?: DictationDestination) => {
		if (phaseRef.current === "idle") void start(destination);
		else if (phaseRef.current === "recording" || phaseRef.current === "connecting") stop();
		// Focus chooses where to START. An active run always stops into its
		// original destination, even after focus moves to a different field.
	}, [start, stop]);
	const toggle = useCallback(() => toggleFor(), [toggleFor]);

	// One shared pair of shortcut listeners, regardless of widget count:
	// focused plugin control first, otherwise core fallback; Esc always
	// cancels the actual recording owner rather than the focused widget.
	useEffect(() => {
		warmTokens.refresh(); // pre-mint at mount (mitigation D) — silent if keyless
		void refreshAppleStatus(); // warm the engine choice (no bridge → unavailable)
		return () => {
			// Navigation cancels capture: invalidate every pending await before
			// releasing resources, and never append into a different page's input.
			bufferRef.current = [];
			cleanup(false);
		};
	}, [cleanup]);
	useEffect(() => registerController(owner, { primary, toggle, cancel }), [owner, primary, toggle, cancel]);

	return {
		phase,
		destinationId,
		toggleFor,
		finishFor,
		error,
		levelRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
		modelPrompt,
		downloadProgress,
		confirmModel,
		dismissModel,
	};
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
export function DictationBar({ dictation, disabled = false }: { dictation: Dictation; disabled?: boolean }) {
	const { phase, error, levelRef, toggle, active, clearError, blocked, modelPrompt, downloadProgress, confirmModel, dismissModel, cancel } = dictation;
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

	const dialog = modelPrompt !== null && (
		<AppleModelDialog
			language={modelPrompt}
			onDownload={confirmModel}
			onCancel={dismissModel}
			onUseDeepgram={() => {
				dismissModel();
				openSettings("keys", DEEPGRAM_KEY_ID);
			}}
		/>
	);

	if (phase === "downloading") {
		const percent = Math.round((downloadProgress ?? 0) * 100);
		return (
			<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-download">
				<Hint label="Stop waiting (Esc) — the download continues" side="top">
					<button
						type="button"
						onClick={cancel}
						aria-label="Stop waiting for the speech model"
						data-testid="dictation-download-cancel"
						className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-card/50 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						<Loader2Icon className="size-3.5 animate-spin" />
						Cancel
					</button>
				</Hint>
				<span className="shrink-0 text-xs text-muted-foreground">Downloading speech model {percent}%</span>
				<div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
					<div className="h-full rounded-full bg-foreground/40 transition-[width]" style={{ width: `${percent}%` }} />
				</div>
			</div>
		);
	}

	if (!active) {
		return (
			<>
			{dialog}
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
					disabled={disabled || blocked}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
					className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
				>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
			</>
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
