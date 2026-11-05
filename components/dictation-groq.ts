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

async function routeMessage(res: Response): Promise<string> {
	try {
		const body = await res.json() as { message?: unknown };
		if (typeof body.message === "string" && body.message) return body.message;
	} catch {}
	return `Groq dictation failed (${res.status})`;
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

/** Send one recording (a WAV) and get its transcript, "" for silence. Rejects
 * with a message fit to show the user. An aborted request rejects with the
 * abort error, which the caller discards along with the run. */
export async function transcribeGroq(request: typeof fetch, args: {
	wav: Uint8Array<ArrayBuffer>;
	model: GroqWhisperModel;
	language: DictationLanguage;
	signal?: AbortSignal;
}): Promise<string> {
	const form = new FormData();
	form.set("audio", new Blob([args.wav], { type: "audio/wav" }), "dictation.wav");
	form.set("model", args.model);
	form.set("language", args.language);
	let res: Response;
	try {
		res = await request(ENDPOINT, { method: "POST", headers, body: form, signal: args.signal });
	} catch (err) {
		if (args.signal?.aborted) throw err;
		throw new Error("Could not send the recording for transcription. Check that LearnHarness is running.");
	}
	if (res.status === 503) throw new Error(GROQ_DICTATION_KEYLESS);
	if (!res.ok) throw new Error(await routeMessage(res));
	const body = await res.json().catch(() => ({})) as { text?: unknown };
	if (typeof body.text !== "string") throw new Error("Groq dictation returned no transcript.");
	return body.text.trim();
}
