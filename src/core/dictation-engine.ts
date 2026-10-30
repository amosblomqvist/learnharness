import { deepgramListenUrl, elevenLabsLanguageCode, type DictationLanguage } from "./dictation.ts";
import type { DictationProviderId } from "./dictation-provider.ts";

/** What one incoming socket message means to the dictation hook. */
export type DictationParsed = {
	/** Final transcript strings carried by the message (usually zero or one). */
	finals: string[];
	/** A provider error to surface; the hook ends the run with it. */
	error?: string;
	/** After Stop, this message is the kind that can end the run: the hook
	 *  (re)starts a short quiet timer and finalizes (flush + close) when no
	 *  further message arrives before it fires. Providers that finish on a
	 *  close code leave it unset. */
	settles?: boolean;
};

/** The provider-specific half of dictation: everything about one streaming
 *  STT socket. The hook keeps the lifecycle (frame queue, deferred buffer,
 *  reconnect, safety net); an engine only speaks the wire protocol. Pure and
 *  browser-safe — no WebSocket here, only what to open, send and read. */
export interface DictationEngine {
	/** URL + subprotocols (auth) for `new WebSocket(url, protocols)`. */
	socket(token: string, language: DictationLanguage): { url: string; protocols: string[] };
	/** One worklet PCM frame → the payload to `send`. */
	encodeFrame(frame: ArrayBuffer): string | ArrayBuffer;
	/** One incoming text message → finals, an error, or a finished signal. */
	parseMessage(raw: string): DictationParsed;
	/** Messages to send, in order, to end the stream after the last frame. */
	endOfStream(): string[];
	/** Does this close code mean our end-of-stream landed (finalize now)? */
	isFinishedClose(code: number): boolean;
}

/** Deepgram: binary linear16 frames, JSON `Results`, `CloseStream`, and the
 *  server closes with 1000 once it has flushed. */
export const deepgramEngine: DictationEngine = {
	// Minted JWTs authenticate via the "bearer" subprotocol — ["token", jwt]
	// is rejected at the handshake (verified live; "token" is for raw API keys
	// only, as in the owner's pi dictate extension).
	socket: (token, language) => ({ url: deepgramListenUrl(language), protocols: ["bearer", token] }),
	encodeFrame: (frame) => frame,
	parseMessage(raw) {
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return { finals: [] };
		}
		if (msg?.type !== "Results") return { finals: [] };
		const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
		// Only finals stream (interim_results=false).
		return { finals: msg.is_final && text ? [text] : [] };
	},
	endOfStream: () => [JSON.stringify({ type: "CloseStream" })],
	isFinishedClose: (code) => code === 1000,
};

/** One engine per dictation run, chosen by the provider the token route minted
 *  for (an ElevenLabs engine carries run state, so never share one). */
export function createDictationEngine(provider: DictationProviderId): DictationEngine {
	return provider === "elevenlabs" ? createElevenLabsEngine() : deepgramEngine;
}

/** Browser-safe base64 of raw bytes (no Node Buffer in core). Chunked so a
 *  large frame never overflows the argument limit of fromCharCode. */
function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

const ELEVENLABS_ERRORS: Record<string, string> = {
	auth_error: "ElevenLabs rejected the key",
	quota_exceeded: "ElevenLabs quota exceeded",
	rate_limited: "ElevenLabs rate limit reached",
	commit_throttled: "ElevenLabs is throttling commits",
	session_time_limit_exceeded: "ElevenLabs session time limit reached",
	insufficient_audio_activity: "ElevenLabs heard no speech",
	invalid_request: "ElevenLabs rejected the request",
	input_error: "ElevenLabs could not read the audio",
	chunk_size_exceeded: "ElevenLabs audio chunk too large",
	transcriber_error: "ElevenLabs transcription failed",
	error: "ElevenLabs transcription failed",
	unaccepted_terms: "ElevenLabs terms are not accepted on this account",
	queue_overflow: "ElevenLabs is overloaded",
	resource_exhausted: "ElevenLabs is out of capacity",
};

/** The final commit's audio: 100 ms of 16 kHz linear16 silence. An empty
 *  commit chunk is undocumented, so a real (silent) frame is the safer
 *  carrier for `commit: true`. */
const SILENCE_100MS = new Uint8Array(3200);

/** ElevenLabs Scribe realtime: base64 JSON audio chunks, the token in the URL
 *  query, VAD-committed phrases, and a client-side close — the server never
 *  closes after the last commit. After Stop, every commit (and the "no new
 *  audio" notice) settles; the hook ends the run once the stream goes quiet,
 *  since a late VAD commit can precede the Stop commit. An engine is PER RUN
 *  (one fresh instance each time the hook starts a dictation). */
export function createElevenLabsEngine(): DictationEngine {
	let commitRequested = false;
	const chunk = (audio: Uint8Array, commit: boolean) =>
		JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64(audio), commit, sample_rate: 16000 });
	return {
		socket(token, language) {
			const params = new URLSearchParams({
				token,
				model_id: "scribe_v2_realtime",
				audio_format: "pcm_16000",
				commit_strategy: "vad",
				vad_silence_threshold_secs: "0.3",
			});
			// Omitted = Scribe auto-detects ("multi", unsupported languages).
			const languageCode = elevenLabsLanguageCode(language);
			if (languageCode) params.set("language_code", languageCode);
			return { url: `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, protocols: [] };
		},
		encodeFrame: (frame) => chunk(new Uint8Array(frame), false),
		parseMessage(raw) {
			let msg: any;
			try {
				msg = JSON.parse(raw);
			} catch {
				return { finals: [] };
			}
			const type: unknown = msg?.message_type;
			if (type === "committed_transcript" || type === "committed_transcript_with_timestamps") {
				const text: unknown = msg.text;
				const finals = typeof text === "string" && text ? [text] : [];
				// After Stop a commit may be an EARLIER phrase's late VAD commit,
				// not the Stop commit — so it only settles, never finishes.
				return commitRequested ? { finals, settles: true } : { finals };
			}
			if (typeof type === "string" && type in ELEVENLABS_ERRORS) {
				// The Stop commit carries silence when VAD already committed the
				// last phrase: "nothing new to commit" means the run is complete.
				if (commitRequested && type === "insufficient_audio_activity") return { finals: [], settles: true };
				return { finals: [], error: ELEVENLABS_ERRORS[type] };
			}
			return { finals: [] };
		},
		endOfStream() {
			commitRequested = true;
			return [chunk(SILENCE_100MS, true)];
		},
		isFinishedClose: () => false,
	};
}
