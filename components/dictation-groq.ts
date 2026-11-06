import { GROQ_DICTATION_HEADER, GROQ_KEY_ID, joinTranscripts, type AuthKeyStatus, type DictationLanguage, type GroqWhisperModel } from "@/src/core";
import { TranscribeRequestError, type ChunkTransport } from "@/components/dictation-chunk-session";

/**
 * The renderer's side of Groq (Whisper) dictation: a key check against
 * /api/keys, and chunk uploads to our own /api/stt/transcribe route, which holds
 * the real key (src/server/groq-stt.ts). Kept apart from the hook so the
 * transport is testable with a fake fetch.
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

/** A failed Groq chunk request (see TranscribeRequestError). */
export class GroqRequestError extends TranscribeRequestError {
	constructor(message: string, retryable: boolean, retryAfterMs?: number) {
		super(message, retryable, retryAfterMs);
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

/** Is a Groq key configured? Resolves when it is; rejects with the keyless line
 * when it is not, so a run can refuse before the user has spoken. Asks the same
 * masked key list Settings reads (GET /api/keys); no Groq request is made. */
export async function checkGroqReady(request: typeof fetch = fetch): Promise<void> {
	let res: Response;
	try {
		res = await request("/api/keys", { cache: "no-store" });
	} catch {
		throw new Error("Could not reach LearnHarness to check the Groq key.");
	}
	if (!res.ok) throw new Error((await routeFailure(res)).message);
	const { keys } = await res.json() as { keys: Pick<AuthKeyStatus, "id" | "present">[] };
	if (!keys.some((key) => key.id === GROQ_KEY_ID && key.present)) throw new Error(GROQ_DICTATION_KEYLESS);
}

/** Send one chunk (a WAV) and get its transcript, "" for silence. `prompt` is the
 * end of the previous chunk's transcript. Rejects with a GroqRequestError whose
 * message is fit to show the user; a request aborted through `signal` rejects the
 * same way, so the caller checks `signal.aborted` first. */
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
	} catch {
		throw new GroqRequestError("Could not send the recording for transcription. Check that LearnHarness is running.", true);
	}
	if (res.status === 503) throw new GroqRequestError(GROQ_DICTATION_KEYLESS, false);
	if (!res.ok) throw await routeFailure(res);
	const body = await res.json().catch(() => ({})) as { text?: unknown };
	if (typeof body.text !== "string") throw new GroqRequestError("Groq dictation returned no transcript.", false);
	return body.text.trim();
}

export const PROMPT_TAIL_CHARS = 100;
/** Chunks shorter than this get no prompt: Whisper tends to echo a prompt back
 * when there is almost no audio to transcribe. */
const PROMPT_MIN_SECONDS = 2;

/** The last PROMPT_TAIL_CHARS characters of `text`, starting at a word. */
export function promptTail(text: string): string {
	const chars = [...text.trim()];
	if (chars.length <= PROMPT_TAIL_CHARS) return chars.join("");
	const tail = chars.slice(-PROMPT_TAIL_CHARS).join("");
	// The cut usually lands inside a word: drop its fragment.
	return /\s/.test(chars[chars.length - PROMPT_TAIL_CHARS - 1]!) ? tail : tail.replace(/^\S*\s+/, "");
}

/** Groq as a chunk session's transport: each chunk goes to /api/stt/transcribe
 * with the end of the previous transcript as Whisper's prompt. */
export function groqTransport(request: typeof fetch, args: { model: GroqWhisperModel; language: DictationLanguage }): ChunkTransport {
	return {
		failure: "Groq transcription failed",
		join: joinTranscripts,
		async transcribe({ wav, seconds, previousText, signal }) {
			const prompt = seconds >= PROMPT_MIN_SECONDS && previousText ? promptTail(previousText) : undefined;
			return { text: await transcribeGroq(request, { wav, model: args.model, language: args.language, prompt, signal }) };
		},
	};
}
