/**
 * The read-aloud proxy (ElevenLabs voice slice 6): text in, MP3 stream out.
 *
 * The renderer never holds the ElevenLabs key — it POSTs text to /api/tts and
 * this module calls the provider with the server-side key (auth.json /
 * .env.local via keyValue, the same seam as the dictation token route) and
 * pipes the audio body straight back, unbuffered, so the first bytes reach the
 * player while the rest is still being synthesized.
 *
 * The provider is a small seam (TtsProvider): ElevenLabs is the only one in
 * this change, but its request shape, key id and defaults live behind the
 * interface so another provider can be added without touching the handler.
 *
 * Errors keep the client's job easy: 400 bad request, 503 keyless
 * ({ message, keyless: <key id> }), 502 upstream ({ message, upstreamStatus }
 * — the provider's own status, e.g. quota or permission). The key never
 * appears in any body, even one an upstream echoes it into.
 *
 * The same module lists the account's voices and TTS models for Settings →
 * Read aloud (slice 9): listTtsVoices follows the provider's page token,
 * listTtsModels filters to text-to-speech models and caches the list in
 * memory for TTS_MODELS_CACHE_MS. speak() resolves its model against that
 * list (resolveTtsModel), so playback always uses a model that exists; when
 * the list is unavailable it trusts the requested model, else the default.
 * The voice resolves the same way (resolveTtsVoice) against a voice-id list
 * cached just like the models: a saved voice that left the account plays as
 * Alice. Cost bound: one full paginated listing per key per cache window
 * (ids only), each page under the catalog timeout, run in parallel with the
 * model lookup; a failure is not cached and never blocks playback.
 */

import {
	DEFAULT_TTS_MODEL_ID,
	DEFAULT_TTS_VOICE_ID,
	isPlainTtsId,
	resolveTtsModel,
	resolveTtsVoice,
	type TtsModel,
	type TtsVoice,
} from "../core/read-aloud.ts";
import { keyValue } from "./keys.ts";

/** The wire-callable shape the proxy closes over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Longest text one request may carry (owner, 2026-10-29): far below every
 *  model's own limit — the client sends short chunks anyway. */
export const TTS_MAX_TEXT_CHARS = 2500;

/** How long the model list is reused: it changes when ElevenLabs ships a model,
 *  so a few minutes keeps the picker and every speak() off the network. */
export const TTS_MODELS_CACHE_MS = 5 * 60 * 1000;
/** A voices/models lookup that takes longer than this is treated as unreachable. */
const CATALOG_TIMEOUT_MS = 8000;
/** Upper bound on voice pages followed (100 per page), against a looping token. */
const MAX_VOICE_PAGES = 50;

/** One text-to-speech provider behind the proxy. */
export interface TtsProvider {
	id: string;
	/** The key-store id of the provider's API key. */
	keyId: string;
	/** Human name for error messages. */
	label: string;
	defaultVoiceId: string;
	defaultModelId: string;
	/** The upstream streaming request for one chunk of text. */
	request(input: { key: string; text: string; voiceId: string; modelId: string }): { url: string; init: RequestInit };
	/** One page of the account's voices (`pageToken` from the previous page). */
	voicesRequest(input: { key: string; pageToken?: string }): { url: string; init: RequestInit };
	/** A voices page → its voices and the next page token (undefined at the end). */
	parseVoices(json: unknown): { voices: TtsVoice[]; next?: string };
	/** The account's models. */
	modelsRequest(input: { key: string }): { url: string; init: RequestInit };
	/** The TTS-capable models of a models response. */
	parseModels(json: unknown): TtsModel[];
	/** A short human line from an upstream error body ("" when none). */
	errorDetail(body: string): string;
}

export { DEFAULT_TTS_MODEL_ID, DEFAULT_TTS_VOICE_ID };

export const elevenLabsTts: TtsProvider = {
	id: "elevenlabs",
	keyId: "ELEVENLABS_API_KEY",
	label: "ElevenLabs",
	defaultVoiceId: DEFAULT_TTS_VOICE_ID,
	defaultModelId: DEFAULT_TTS_MODEL_ID,
	request({ key, text, voiceId, modelId }) {
		return {
			url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_64`,
			init: {
				method: "POST",
				headers: { "xi-api-key": key, "Content-Type": "application/json" },
				body: JSON.stringify({ text, model_id: modelId }),
			},
		};
	},
	voicesRequest({ key, pageToken }) {
		const query = new URLSearchParams({ page_size: "100" });
		if (pageToken) query.set("next_page_token", pageToken);
		return { url: `https://api.elevenlabs.io/v2/voices?${query}`, init: { headers: { "xi-api-key": key } } };
	},
	parseVoices(json) {
		const page = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
		const voices: TtsVoice[] = [];
		for (const raw of Array.isArray(page.voices) ? page.voices : []) {
			const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
			if (!isPlainTtsId(v.voice_id)) continue;
			voices.push({
				id: v.voice_id,
				name: typeof v.name === "string" && v.name ? v.name : v.voice_id,
				category: typeof v.category === "string" ? v.category : "",
			});
		}
		const token = page.next_page_token;
		const next = page.has_more === true && typeof token === "string" && token ? token : undefined;
		return { voices, next };
	},
	modelsRequest({ key }) {
		return { url: "https://api.elevenlabs.io/v1/models", init: { headers: { "xi-api-key": key } } };
	},
	parseModels(json) {
		if (!Array.isArray(json)) return [];
		const models: TtsModel[] = [];
		for (const raw of json) {
			const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
			if (m.can_do_text_to_speech !== true || !isPlainTtsId(m.model_id)) continue;
			models.push({
				id: m.model_id,
				name: typeof m.name === "string" && m.name ? m.name : m.model_id,
				maxChars: typeof m.maximum_text_length_per_request === "number" ? m.maximum_text_length_per_request : 0,
			});
		}
		return models;
	},
	errorDetail(body) {
		// ElevenLabs errors are { detail: { status, message } } (or a bare string detail).
		try {
			const detail = (JSON.parse(body) as { detail?: unknown }).detail;
			if (typeof detail === "string") return detail;
			const d = detail as { message?: unknown; status?: unknown } | undefined;
			if (typeof d?.message === "string") return d.message;
			if (typeof d?.status === "string") return d.status;
		} catch {
			// Not JSON — no detail; the status alone says enough.
		}
		return "";
	},
};

/** Today's only provider; the seam a second one would slot into. */
function resolveTtsProvider(): TtsProvider {
	return elevenLabsTts;
}

export interface SpeakDeps {
	fetchFn?: FetchLike;
	/** The provider key; defaults to the server key store. */
	getKey?: (keyId: string) => string | undefined;
}

export interface CatalogDeps extends SpeakDeps {
	/** Clock for the model cache (tests). */
	now?: () => number;
}

function badRequest(message: string): Response {
	return Response.json({ message }, { status: 400 });
}

/** Scrub the key out of any text bound for a response body. */
function scrub(text: string, key: string): string {
	return key ? text.split(key).join("") : text;
}

function keylessResponse(provider: TtsProvider): Response {
	return Response.json(
		{
			message: `No ${provider.keyId} — add it to auth.json (desktop) or .env.local (dev).`,
			keyless: provider.keyId,
		},
		{ status: 503 },
	);
}

/** An upstream answer that is not usable; becomes the 502 response. */
class UpstreamFailure extends Error {
	constructor(
		message: string,
		readonly upstreamStatus?: number,
	) {
		super(message);
	}
}

function upstreamResponse(error: unknown): Response {
	const message = error instanceof UpstreamFailure ? error.message : "Read aloud failed";
	const upstreamStatus = error instanceof UpstreamFailure ? error.upstreamStatus : undefined;
	return Response.json({ message, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) }, { status: 502 });
}

/** The 502 for a non-ok upstream response. */
async function failureOf(provider: TtsProvider, key: string, upstream: Response): Promise<UpstreamFailure> {
	const detail = scrub(provider.errorDetail(await upstream.text().catch(() => "")), key).slice(0, 160);
	return new UpstreamFailure(
		`${provider.label} error (${upstream.status})${detail ? `: ${detail}` : ""}`,
		upstream.status,
	);
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** One upstream JSON GET; unreachable / non-ok / unparsable → UpstreamFailure. */
async function getJson(
	provider: TtsProvider,
	key: string,
	fetchFn: FetchLike,
	{ url, init }: { url: string; init: RequestInit },
): Promise<unknown> {
	// A catalog lookup sits in front of playback (the model list), so a stalled
	// upstream must not stall speech: give up after CATALOG_TIMEOUT_MS.
	const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetchFn(url, { ...init, signal });
	} catch {
		throw new UpstreamFailure(`${provider.label} unreachable`);
	}
	if (!res.ok) throw await failureOf(provider, key, res);
	try {
		return await res.json();
	} catch {
		throw new UpstreamFailure(`${provider.label} sent an unreadable answer`);
	}
}

let modelsCache: { key: string; at: number; models: TtsModel[] } | undefined;

/** Forget the cached model and voice lists (tests). */
export function clearTtsModelsCache(): void {
	modelsCache = undefined;
	voicesCache = undefined;
}

/** The TTS-capable models, cached per key for TTS_MODELS_CACHE_MS. Throws UpstreamFailure. */
async function fetchTtsModels(provider: TtsProvider, key: string, deps: CatalogDeps): Promise<TtsModel[]> {
	const now = (deps.now ?? Date.now)();
	if (modelsCache && modelsCache.key === key && now - modelsCache.at < TTS_MODELS_CACHE_MS) return modelsCache.models;
	const models = provider.parseModels(await getJson(provider, key, deps.fetchFn ?? defaultFetch, provider.modelsRequest({ key })));
	modelsCache = { key, at: now, models };
	return models;
}

let voicesCache: { key: string; at: number; ids: string[] } | undefined;

/** Every voice on the account, following the page token. Throws UpstreamFailure. */
async function fetchAllVoices(provider: TtsProvider, key: string, fetchFn: FetchLike): Promise<TtsVoice[]> {
	const voices: TtsVoice[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_VOICE_PAGES; page++) {
		const parsed = provider.parseVoices(await getJson(provider, key, fetchFn, provider.voicesRequest({ key, pageToken })));
		voices.push(...parsed.voices);
		if (!parsed.next || parsed.next === pageToken) break;
		pageToken = parsed.next;
	}
	return voices;
}

/** The account's voice ids for speak(), cached per key for TTS_MODELS_CACHE_MS
 *  (only ids are kept; failures are never cached). Throws UpstreamFailure. */
async function fetchVoiceIds(provider: TtsProvider, key: string, deps: CatalogDeps): Promise<string[]> {
	const now = (deps.now ?? Date.now)();
	if (voicesCache && voicesCache.key === key && now - voicesCache.at < TTS_MODELS_CACHE_MS) return voicesCache.ids;
	const ids = (await fetchAllVoices(provider, key, deps.fetchFn ?? defaultFetch)).map((v) => v.id);
	voicesCache = { key, at: now, ids };
	return ids;
}

/** GET /api/tts/voices: every voice on the account, cloned ones included → `[{ id, name, category }]`.
 *  Always fresh (so a new clone shows at once); the answer also refreshes speak()'s cache. */
export async function listTtsVoices(deps: CatalogDeps = {}): Promise<Response> {
	const provider = resolveTtsProvider();
	const key = (deps.getKey ?? keyValue)(provider.keyId);
	if (!key) return keylessResponse(provider);
	try {
		const voices = await fetchAllVoices(provider, key, deps.fetchFn ?? defaultFetch);
		voicesCache = { key, at: (deps.now ?? Date.now)(), ids: voices.map((v) => v.id) };
		return Response.json(voices, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return upstreamResponse(error);
	}
}

/** GET /api/tts/models: the TTS-capable models → `[{ id, name, maxChars }]`. */
export async function listTtsModels(deps: CatalogDeps = {}): Promise<Response> {
	const provider = resolveTtsProvider();
	const key = (deps.getKey ?? keyValue)(provider.keyId);
	if (!key) return keylessResponse(provider);
	try {
		return Response.json(await fetchTtsModels(provider, key, deps), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return upstreamResponse(error);
	}
}

/** POST /api/tts's body: `{ text, voiceId?, modelId? }` → streamed audio or an error response. */
export async function speak(body: unknown, deps: CatalogDeps = {}): Promise<Response> {
	const provider = resolveTtsProvider();
	const { text, voiceId, modelId } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	if (typeof text !== "string" || text.trim() === "") return badRequest("text is required");
	if (text.length > TTS_MAX_TEXT_CHARS) return badRequest(`text is over the ${TTS_MAX_TEXT_CHARS}-character limit`);
	if (voiceId !== undefined && !isPlainTtsId(voiceId)) return badRequest("invalid voiceId");
	if (modelId !== undefined && !isPlainTtsId(modelId)) return badRequest("invalid modelId");

	const key = (deps.getKey ?? keyValue)(provider.keyId);
	if (!key) return keylessResponse(provider);

	// The model and voice actually used: the request's if the account lists it,
	// else the default/fallback. An unavailable list never blocks playback. The
	// two lookups run together (each cached), so a cold or stalled cache adds at
	// most one CATALOG_TIMEOUT_MS per cache window, not two in series.
	const [listedModels, listedVoiceIds] = await Promise.all([
		fetchTtsModels(provider, key, deps).then((models) => models.map((m) => m.id), () => [] as string[]),
		fetchVoiceIds(provider, key, deps).catch(() => [] as string[]),
	]);
	const resolvedModel = resolveTtsModel(modelId as string | undefined, listedModels);
	const resolvedVoice = resolveTtsVoice(voiceId as string | undefined, listedVoiceIds);

	const fetchFn = deps.fetchFn ?? defaultFetch;
	const { url, init } = provider.request({ key, text, voiceId: resolvedVoice, modelId: resolvedModel });
	let upstream: Response;
	try {
		upstream = await fetchFn(url, init);
	} catch {
		return Response.json({ message: `${provider.label} unreachable` }, { status: 502 });
	}
	if (!upstream.ok || !upstream.body) return upstreamResponse(await failureOf(provider, key, upstream));
	return new Response(upstream.body, {
		status: 200,
		headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
	});
}
