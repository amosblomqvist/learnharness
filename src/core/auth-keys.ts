/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19).
 * PURE, browser-safe — no fs, no env. The catalog drives the auth page's
 * key list (label, description, where-to-get docs link) and the write-side
 * shape validation (owner decision: SHAPE-ONLY validation, no live pings —
 * a revoked key looks fine until a real call fails; that trade was chosen
 * over phoning providers).
 *
 * The store itself is the long-standing flat {VAR: value} auth.json map
 * (see config.AUTH_FILE): keys are identified BY their environment-variable
 * name — the same name consumers read today (OPENROUTER_API_KEY, …), so the
 * catalog id IS the file key and the env var, one name everywhere.
 *
 * Unknown vars found in the file (outside the catalog) are PRESERVED
 * verbatim and surfaced as generic entries — forward-compat for future
 * entries (e.g. a plans-login token) without a schema change — but they
 * are not hand-writable through the curated API (only the catalog's keys
 * have shapes worth checking and docs worth showing).
 */

/** One curated key entry. `id` is the env-var/file key name. */
export interface AuthKeyInfo {
	id: string;
	/** Human label for the settings page. */
	label: string;
	/** One-sentence what-is-this-for. */
	description: string;
	/** Where the user gets a key (opens in the real browser via the shell). */
	docsUrl: string;
}

export const AUTH_KEYS: readonly AuthKeyInfo[] = [
	{
		id: "DEEPGRAM_API_KEY",
		label: "Deepgram",
		description: "Speech-to-text key for dictation — needs ≥ Member permission in the Deepgram console to mint tokens.",
		docsUrl: "https://console.deepgram.com/",
	},
	{
		id: "TAVILY_API_KEY",
		label: "Tavily",
		description: "Web-search engine for the researcher sub-agent (AI-native search API). Setting the key activates it — no engine toggle needed.",
		docsUrl: "https://app.tavily.com/",
	},
	{
		id: "BRAVE_API_KEY",
		label: "Brave Search",
		description: "Web-search engine for the researcher sub-agent — the alternative to Tavily. Setting the key activates it.",
		docsUrl: "https://brave.com/search/api/",
	},
] as const;

const AUTH_KEY_IDS: ReadonlySet<string> = new Set(AUTH_KEYS.map((k) => k.id));

export function isKnownAuthKey(id: string): boolean {
	return AUTH_KEY_IDS.has(id);
}

/** One model-provider key row for the settings page's dropdown: which
 *  pi-ai provider, the env var its key rides in, and the human label
 *  (pi's own Provider.name). */
export interface AuthProviderInfo {
	id: string;
	envVar: string;
	label: string;
}

/**
 * THE MODEL-PROVIDER KEY TABLE (provider-keys interlude, 2026-09-19):
 * every pi-ai provider that takes a PLAIN api-key env var — derived from
 * pi-ai's own provider→env-var table at generation time, so it can never
 * drift from what pi actually reads: tests/auth-provider-keys.test.ts
 * re-derives the truth from pi-ai (builtinProviders + findEnvKeys via a
 * truthy-for-every-var proxy env) and asserts EXACT equality with this
 * table — a pi-ai upgrade that adds/renames a provider key fails the gate
 * loudly instead of drifting silently.
 *
 * EXCLUDED by owner spec — providers whose auth is not a plain key this
 * wave: github-copilot (OAuth), amazon-bedrock (AWS creds), google-vertex
 * (ADC), azure (needs a base URL), the cloudflare
 * account-scoped pair. Anthropic keeps ANTHROPIC_API_KEY only — its
 * AUTH_TOKEN/OAUTH_TOKEN alternates stay env-only. openai-codex exposes
 * no env-key (naturally absent). Providers sharing one env var (moonshotai
 * / moonshotai-cn, opencode / opencode-go, the qwen-token-plan pair,
 * xiaomi variants) each keep their own row — the UI groups as it wishes.
 */
export const AUTH_PROVIDER_KEYS: readonly AuthProviderInfo[] = [
	{ id: "ant-ling", envVar: "ANT_LING_API_KEY", label: "Ant Ling" },
	{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
	{ id: "baseten", envVar: "BASETEN_API_KEY", label: "Baseten" },
	{ id: "cerebras", envVar: "CEREBRAS_API_KEY", label: "Cerebras" },
	{ id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
	{ id: "fireworks", envVar: "FIREWORKS_API_KEY", label: "Fireworks" },
	{ id: "google", envVar: "GEMINI_API_KEY", label: "Google" },
	{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
	{ id: "huggingface", envVar: "HF_TOKEN", label: "Hugging Face" },
	{ id: "kimi-coding", envVar: "KIMI_API_KEY", label: "Kimi For Coding" },
	{ id: "meta", envVar: "META_API_KEY", label: "Meta" },
	{ id: "minimax", envVar: "MINIMAX_API_KEY", label: "MiniMax" },
	{ id: "minimax-cn", envVar: "MINIMAX_CN_API_KEY", label: "MiniMax CN" },
	{ id: "mistral", envVar: "MISTRAL_API_KEY", label: "Mistral" },
	{ id: "moonshotai", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI" },
	{ id: "moonshotai-cn", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI CN" },
	{ id: "nvidia", envVar: "NVIDIA_API_KEY", label: "NVIDIA" },
	{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
	{ id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode Zen" },
	{ id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" },
	{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	{ id: "qwen-token-plan", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan" },
	{ id: "qwen-token-plan-cn", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY", label: "Qwen Token Plan CN" },
	{ id: "qwen-token-plan-individual", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan Individual" },
	{ id: "radius", envVar: "RADIUS_API_KEY", label: "Radius" },
	{ id: "together", envVar: "TOGETHER_API_KEY", label: "Together" },
	{ id: "typesafe", envVar: "TYPESAFE_API_KEY", label: "TypeSafe" },
	{ id: "vercel-ai-gateway", envVar: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway" },
	{ id: "xai", envVar: "XAI_API_KEY", label: "xAI" },
	{ id: "xiaomi", envVar: "XIAOMI_API_KEY", label: "Xiaomi" },
	{ id: "xiaomi-token-plan-ams", envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", label: "Xiaomi Token Plan AMS" },
	{ id: "xiaomi-token-plan-cn", envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY", label: "Xiaomi Token Plan CN" },
	{ id: "xiaomi-token-plan-sgp", envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", label: "Xiaomi Token Plan SGP" },
	{ id: "zai", envVar: "ZAI_API_KEY", label: "Z.AI" },
	{ id: "zai-coding-cn", envVar: "ZAI_CODING_CN_API_KEY", label: "Z.AI Coding CN" },
] as const;

/**
 * THE single custom endpoint's identity: a user-configured OpenAI-compatible
 * server registered into pi-ai at runtime (server/custom-provider.ts). NOT part
 * of AUTH_PROVIDER_KEYS (that table is test-pinned to pi-ai's built-ins and is
 * env-var-keyed); this one is keyed by a user-supplied base URL, and its key
 * rides this reserved env var (optional — keyless local servers allowed).
 */
export const CUSTOM_PROVIDER = {
	id: "custom",
	envVar: "CUSTOM_OPENAI_API_KEY",
	label: "Custom endpoint",
} as const;

/** Every distinct env var a model-provider key rides in (the write side's
 *  writability check — see isProviderEnvVar below; also drives which
 *  PRESENT provider vars surface as status rows). */
export const AUTH_PROVIDER_ENV_VARS: ReadonlySet<string> = new Set(AUTH_PROVIDER_KEYS.map((p) => p.envVar));

/** Is this env-var name the key of SOME pi-ai model provider? */
export function isProviderEnvVar(envVar: string): boolean {
	return AUTH_PROVIDER_ENV_VARS.has(envVar);
}

/** Shape-check result: ok, or a 400-ready message naming the expectation. */
export type KeyShapeResult = { ok: true } | { ok: false; error: string };

/**
 * The write-side shape gate (owner decision: reject bad pastes with 400 —
 * a truncated or wrong-family key can never land in the store). Values are
 * TRIMMED first (paste hygiene); empty-after-trim always fails.
 *
 * CURATED keys carry family rules (Tavily's tvly-… prefix; Brave and
 * Deepgram publish no format — length floors + paste hygiene only).
 * MODEL-PROVIDER keys use genericProviderKeyGuard below instead (families
 * vary by provider — only paste hygiene applies; owner spec: min length
 * ~12, no whitespace). OPENROUTER_API_KEY moved to the generic guard with
 * the provider-keys interlude — no sk-or family check anymore.
 */
export function validateKeyShape(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	const nonEmpty = (min: number) =>
		value.length >= min && !/\s/.test(value)
			? { ok: true as const }
			: { ok: false as const, error: `${id} must be at least ${min} characters with no whitespace` };
	switch (id) {
		case "TAVILY_API_KEY":
			return value.startsWith("tvly-")
				? nonEmpty(20)
				: { ok: false, error: `${id} must start with "tvly-" (Tavily's key format)` };
		case "BRAVE_API_KEY":
			// No public format — a length floor + paste hygiene only.
			return nonEmpty(20);
		case "DEEPGRAM_API_KEY":
			// No public format — the length floor only catches truncated pastes.
			return nonEmpty(20);
		default:
			return { ok: false, error: `unknown key "${id}" (supported: ${[...AUTH_KEY_IDS].join(", ")})` };
	}
}

/** The generic truncation guard for MODEL-PROVIDER keys (families vary —
 *  only paste hygiene applies; owner spec: trim, no whitespace, min 12). */
export function genericProviderKeyGuard(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	if (value.length >= 12 && !/\s/.test(value)) return { ok: true };
	return { ok: false, error: `${id} must be at least 12 characters with no whitespace` };
}

/** A masked key never leaves the server as plaintext (owner decision:
 *  last 4 chars + length — enough to identify which key is stored after
 *  rotating between several, and to spot a mis-pasted family). */
export function maskKey(value: string): string {
	const v = value.trim();
	if (v.length <= 4) return `…${v}`; // degenerate paste — still never the whole value
	return `…${v.slice(-4)}`;
}

/** One key's status row for the GET view (never carries plaintext). */
export interface AuthKeyStatus {
	id: string;
	/** Catalog metadata when the key is curated; null for unknown-file-var
	 *  entries (preserved + surfaced, but no curated form to edit through). */
	info: AuthKeyInfo | null;
	/** A key is present when EITHER the environment or the file has it. */
	present: boolean;
	/** Ordinary masked tail + count, e.g. "…ab12 (64 chars)"; custom keys
	 * use full redaction, with no credential characters at any length. */
	masked: string | null;
	/** Where the live value comes from, given env-wins precedence. */
	source: "env" | "file" | "none";
	/** True when the file holds a value that the environment shadows — the
	 *  settings page explains why a saved key is not the live one. */
	shadowedByEnv: boolean;
}
