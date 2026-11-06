"use client";
import { deepgramListenUrl, dictationWav, LOCAL_DICTATION_MAX_BYTES, LOCAL_DICTATION_TIMEOUT_MS, type DictationLanguage, type LocalDictationSettings } from "@/src/core";

export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
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

export type DictationEngine = {
	connect: () => void;
	write: (frame: ArrayBuffer) => void;
	finish: () => void;
	cancel: () => void;
};
export type DictationEvents = {
	ready: () => void;
	text: (text: string) => void;
	end: () => void;
	error: (message: string) => void;
	limit?: () => void;
};

export function warmDeepgram(): void { warmTokens.refresh(); }

/** The cloud protocol owns tokens, reconnect, frame buffering, and CloseStream. */
export function createDeepgramEngine(language: DictationLanguage, events: DictationEvents): DictationEngine {
	let cancelled = false;
	let finishing = false;
	let socket: WebSocket | undefined;
	let pending: ArrayBuffer[] = [];
	let retries = 0;
	let safety: ReturnType<typeof setTimeout> | undefined;
	const token = warmTokens.mint();
	void token.catch(() => {});
	const fail = (message: string) => { if (!cancelled) events.error(message); };
	const closeStream = () => {
		if (socket?.readyState !== WebSocket.OPEN) return;
		try { socket.send(JSON.stringify({ type: "CloseStream" })); }
		catch { fail("Deepgram connection lost"); return; }
		clearTimeout(safety);
		safety = setTimeout(() => { if (!cancelled) events.end(); }, 3000);
	};
	const open = (jwt: string) => {
		if (cancelled) return;
		const ws = new WebSocket(deepgramListenUrl(language), ["bearer", jwt]);
		socket = ws;
		ws.addEventListener("open", () => {
			if (cancelled || socket !== ws) return;
			for (const frame of pending) ws.send(frame);
			pending = [];
			if (finishing) closeStream(); else events.ready();
		});
		ws.addEventListener("message", (ev) => {
			if (cancelled || socket !== ws) return;
			try {
				const message = JSON.parse(ev.data as string);
				const text = message.channel?.alternatives?.[0]?.transcript;
				if (message.type === "Results" && message.is_final && typeof text === "string" && text) events.text(text);
			} catch { /* Ignore non-transcript messages. */ }
		});
		ws.addEventListener("close", (ev) => {
			if (cancelled || socket !== ws) return;
			if (ev.code === 1000) { events.end(); return; }
			if (!finishing && retries++ < 1) {
				mintFreshToken().then(open).catch(() => fail("Deepgram reconnect failed"));
			} else fail(`Deepgram connection lost (${ev.code})`);
		});
	};
	return {
		connect() { token.then(open).catch((error: unknown) => fail(error instanceof Error ? error.message : "Deepgram token unavailable")); },
		write(frame) {
			if (cancelled || finishing) return;
			if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
			else { pending.push(frame); if (pending.length > 256) pending.shift(); }
		},
		finish() {
			if (finishing || cancelled) return;
			finishing = true;
			closeStream();
			// A handshake that never opens must also release finish() callers.
			if (socket?.readyState !== WebSocket.OPEN) safety = setTimeout(() => fail("Deepgram connection timed out"), 10_000);
		},
		cancel() {
			cancelled = true; pending = [];
			clearTimeout(safety);
			try { socket?.close(); } catch { /* Already closed. */ }
		},
	};
}

/** Local inference starts only after the full recording has been captured. */
export function createLocalEngine(config: LocalDictationSettings, events: DictationEvents, request: typeof fetch = fetch): DictationEngine {
	let frames: ArrayBuffer[] = [];
	let size = 0;
	let finished = false;
	let cancelled = false;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		connect() { if (!cancelled) events.ready(); },
		write(frame) {
			if (cancelled || finished) return;
			const available = LOCAL_DICTATION_MAX_BYTES - 44 - size;
			if (frame.byteLength > available) {
				if (available > 0) { frames.push(frame.slice(0, available)); size += available; }
				events.limit?.();
				return;
			}
			size += frame.byteLength;
			frames.push(frame);
			if (size + 44 === LOCAL_DICTATION_MAX_BYTES) events.limit?.();
		},
		finish() {
			if (cancelled || finished) return;
			finished = true;
			void (async () => {
				try {
					const wav = dictationWav(frames);
					frames = [];
					timer = setTimeout(() => controller.abort(), LOCAL_DICTATION_TIMEOUT_MS);
					const response = await request("/api/stt/transcribe", {
						method: "POST", headers: { "Content-Type": "audio/wav", "x-dictation-config": encodeURIComponent(JSON.stringify(config)) },
						body: wav, signal: controller.signal,
					});
					const result = await response.json() as { text?: string; error?: string };
					if (cancelled) return;
					if (!response.ok || typeof result.text !== "string") throw new Error(result.error ?? "Local transcription failed");
					if (result.text.trim()) events.text(result.text.trim());
					events.end();
				} catch (error) {
					if (!cancelled) events.error(controller.signal.aborted ? "Local transcription timed out after 5 minutes" : error instanceof Error ? error.message : "Local transcription failed");
				} finally { clearTimeout(timer); frames = []; }
			})();
		},
		cancel() { cancelled = true; frames = []; clearTimeout(timer); controller.abort(); },
	};
}
