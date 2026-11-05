import { GROQ_DICTATION_HEADER, type DictationLanguage, type GroqWhisperModel } from "@/src/core";

/**
 * The renderer's side of Groq (Whisper) dictation: two calls to our own
 * /api/stt/transcribe route, which holds the real key (src/server/groq-stt.ts).
 * Kept apart from the hook so the transport is testable with a fake fetch.
 */

/** The client-authored keyless line, the Groq twin of DICTATION_KEYLESS. The
 * route's raw 503 is dev-speak; the surface says the short truth instead. */
export const GROQ_DICTATION_KEYLESS = "Dictation needs a Groq key";

/** The Settings → Providers row a Groq keyless click unfolds. Not the bare
 * GROQ_API_KEY: a present key is already a row in Model API keys, and the
 * dictation row has to open on its own. */
export const GROQ_DICTATION_ROW = "dictation:GROQ_API_KEY";

const ENDPOINT = "/api/stt/transcribe";
const headers = { [GROQ_DICTATION_HEADER]: "1" };

/** A failed chunk request. `message` is fit to show the user; `retryable` says
 * whether sending the same chunk again may work (a rate limit, an outage, a
 * dropped connection) and `retryAfterMs` is the wait the server asked for. */
export class GroqRequestError extends Error {
	constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
		super(message);
		this.name = "GroqRequestError";
	}
}

async function routeFailure(res: Response): Promise<GroqRequestError> {
	let message = `Groq dictation failed (${res.status})`;
	let retryable = res.status === 429 || res.status >= 500;
	try {
		const body = await res.json() as { message?: unknown; retryable?: unknown };
		if (typeof body.message === "string" && body.message) message = body.message;
		if (typeof body.retryable === "boolean") retryable = body.retryable;
	} catch {}
	const seconds = Number(res.headers.get("retry-after"));
	return new GroqRequestError(message, retryable, Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined);
}

async function routeMessage(res: Response): Promise<string> {
	return (await routeFailure(res)).message;
}

/** Is a Groq key configured? Resolves when it is; rejects with the keyless line
 * when it is not, so a run can refuse before the user has spoken. */
export async function checkGroqReady(request: typeof fetch = fetch): Promise<void> {
	let res: Response;
	try {
		res = await request(ENDPOINT, { headers, cache: "no-store" });
	} catch {
		throw new Error("Could not reach LearnHarness to check the Groq key.");
	}
	if (res.ok) return;
	if (res.status === 503) throw new Error(GROQ_DICTATION_KEYLESS);
	throw new Error(await routeMessage(res));
}

/** Send one chunk of audio (a WAV) and get its transcript, "" for silence.
 * `prompt` is the end of the previous chunk's transcript, so Whisper continues
 * it. Rejects with a GroqRequestError whose message is fit to show the user. An
 * aborted request rejects with the abort error, which the caller discards along
 * with the run. */
export async function transcribeGroq(request: typeof fetch, args: {
	wav: Uint8Array<ArrayBuffer>;
	model: GroqWhisperModel;
	language: DictationLanguage;
	prompt?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const form = new FormData();
	form.set("audio", new Blob([args.wav], { type: "audio/wav" }), "dictation.wav");
	form.set("model", args.model);
	form.set("language", args.language);
	if (args.prompt) form.set("prompt", args.prompt);
	let res: Response;
	try {
		res = await request(ENDPOINT, { method: "POST", headers, body: form, signal: args.signal });
	} catch (err) {
		if (args.signal?.aborted) throw err;
		throw new GroqRequestError("Could not send the recording for transcription. Check that LearnHarness is running.", true);
	}
	if (res.status === 503) throw new GroqRequestError(GROQ_DICTATION_KEYLESS, false);
	if (!res.ok) throw await routeFailure(res);
	const body = await res.json().catch(() => ({})) as { text?: unknown };
	if (typeof body.text !== "string") throw new GroqRequestError("Groq dictation returned no transcript.", false);
	return body.text.trim();
}
