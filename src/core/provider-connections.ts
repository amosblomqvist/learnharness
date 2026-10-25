/** Public connection metadata. Credentials and login answers never belong here. */
export const SUBSCRIPTION_PROVIDERS = [
	{ id: "subscription-anthropic", provider: "anthropic", name: "Claude subscription" },
	{ id: "subscription-xai", provider: "xai", name: "Grok subscription" },
] as const;

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDERS)[number]["id"];
export function subscriptionProvider(id: string) {
	return SUBSCRIPTION_PROVIDERS.find((p) => p.id === id);
}
export type CustomProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface CustomModelDefinition {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	/** Optional configured API-equivalent prices per million tokens, not a subscription bill. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface CustomProviderDefinition {
	/** Namespaced, for example custom-local-proxy. Built-in providers cannot be replaced. */
	id: string;
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	/** Keyless endpoints require an explicit opt-in, not a missing secret. */
	keyless: boolean;
	models: CustomModelDefinition[];
}
export interface CustomProviderStatus extends CustomProviderDefinition {
	keyPresent: boolean;
}
