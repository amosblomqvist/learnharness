/** Codex subscription speed, separate from reasoning effort and API billing. */
export type ModelServiceTier = "default" | "priority";

// OpenAI Codex speed documentation, checked 2026-10-24. This is model
// capability, not a promise of account entitlement or delivered latency.
const CODEX_FAST_MODELS = new Set([
 "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
 "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol",
]);
export function supportsCodexFastMode(provider: string, id: string): boolean {
 // Native upstream ChatGPT only; the retired duplicate Codex id is accepted solely via the canonical alias.
 return canonicalSubscriptionProvider(provider) === "chatgpt" && CODEX_FAST_MODELS.has(id);
}
export function isModelServiceTier(value: unknown): value is ModelServiceTier {
 return value === "default" || value === "priority";
}
/** Unsupported providers never inherit or dispatch a Codex speed override. */
export function modelServiceTier(provider: string, id: string, value: unknown): ModelServiceTier | undefined {
 return supportsCodexFastMode(provider, id) && isModelServiceTier(value) ? value : undefined;
}

/** Older local builds used a duplicate Codex sign-in; use upstream ChatGPT instead. */
export function canonicalSubscriptionProvider(provider: string): string {
 return provider === "subscription-openai-codex" ? "chatgpt" : provider === "subscription-xai" ? "xai-subscription" : provider;
}
