/**
 * The dictation token mint behind GET /api/stt/token: the renderer never holds
 * a real key. The server resolves the provider (saved choice + which keys
 * exist, src/core/dictation-provider.ts), mints a short-lived token upstream,
 * and returns { provider, token }; audio then flows renderer → provider
 * directly. The key lives server-side only (auth.json → process.env in the
 * desktop app; .env.local in dev — same seam as OPENROUTER_API_KEY).
 *
 *  - Deepgram: access token, TTL 300s (a run can outlast the 30s default;
 *    the token is only checked at the handshake). The key needs ≥ Member
 *    permission in the Deepgram console to call /auth/grant.
 *  - ElevenLabs: single-use `realtime_scribe` token (15 min expiry, consumed
 *    on use — so every reconnect mints a fresh one).
 *
 * Keyless → 503 `{ message, keyless: <missing key id> }` (machine-readable;
 * the client words its own line). Upstream trouble → 502 with a short message
 * that never carries a key. fetch / key lookup / saved record are injected so
 * tests need no network.
 */
import { resolveDictationProvider, type DictationProviderId } from "../core/dictation-provider.ts";

export interface SttTokenDeps {
	keyValue: (id: string) => string | undefined;
	savedProvider: () => DictationProviderId | undefined;
	fetch: typeof fetch;
}

const NAMES: Record<DictationProviderId, string> = { deepgram: "Deepgram", elevenlabs: "ElevenLabs" };

export async function mintSttToken(deps: SttTokenDeps): Promise<Response> {
	const resolved = resolveDictationProvider(deps.savedProvider(), {
		deepgram: deps.keyValue("DEEPGRAM_API_KEY") !== undefined,
		elevenlabs: deps.keyValue("ELEVENLABS_API_KEY") !== undefined,
	});
	if ("keyless" in resolved) {
		return Response.json(
			{
				message: `No ${resolved.keyless} — add it to auth.json (desktop) or .env.local (dev).`,
				keyless: resolved.keyless,
			},
			{ status: 503 },
		);
	}
	const { provider } = resolved;
	const name = NAMES[provider];
	const key = deps.keyValue(provider === "deepgram" ? "DEEPGRAM_API_KEY" : "ELEVENLABS_API_KEY")!;
	const scrub = (text: string) => text.split(key).join("…");
	try {
		const res =
			provider === "deepgram"
				? await deps.fetch("https://api.deepgram.com/v1/auth/grant", {
						method: "POST",
						headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
						body: JSON.stringify({ ttl_seconds: 300 }),
					})
				: await deps.fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
						method: "POST",
						headers: { "xi-api-key": key },
					});
		if (!res.ok) {
			const detail = scrub(await res.text());
			return Response.json(
				{ message: `${name} token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string; token?: string };
		const token = provider === "deepgram" ? data.access_token : data.token;
		if (!token) return Response.json({ message: `${name} grant returned no token` }, { status: 502 });
		return Response.json({ provider, token });
	} catch {
		return Response.json({ message: `${name} unreachable` }, { status: 502 });
	}
}
