/** Which dictation provider runs, given the saved choice and which keys exist.
 *  One source of truth for the token route and the settings UI. Pure. */
export type DictationProviderId = "deepgram" | "elevenlabs";

export const DICTATION_PROVIDERS: readonly { id: DictationProviderId; label: string; keyId: string }[] = [
	{ id: "deepgram", label: "Deepgram", keyId: "DEEPGRAM_API_KEY" },
	{ id: "elevenlabs", label: "ElevenLabs", keyId: "ELEVENLABS_API_KEY" },
];

export function isDictationProvider(value: unknown): value is DictationProviderId {
	return value === "deepgram" || value === "elevenlabs";
}

export type DictationProviderResolution = { provider: DictationProviderId } | { keyless: string };

const keyIdOf = (id: DictationProviderId) => DICTATION_PROVIDERS.find((p) => p.id === id)!.keyId;

/** An explicit choice wins (keyless if its key is missing). With no choice, use
 *  whichever key exists, Deepgram if both; with none, Deepgram's keyless state. */
export function resolveDictationProvider(
	saved: DictationProviderId | undefined,
	keys: { deepgram: boolean; elevenlabs: boolean },
): DictationProviderResolution {
	const provider = saved ?? (!keys.deepgram && keys.elevenlabs ? "elevenlabs" : "deepgram");
	return keys[provider] ? { provider } : { keyless: keyIdOf(provider) };
}
