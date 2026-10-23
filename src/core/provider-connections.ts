/** Public connection metadata. Credentials and login answers never belong here. */
export const SUBSCRIPTION_PROVIDERS = [
	{ id: "subscription-openai-codex", provider: "openai-codex", name: "Codex subscription" },
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
export interface SubscriptionStatus {
	id: SubscriptionProviderId;
	name: string;
	connected: boolean;
	expires?: number;
}
export interface LoginPromptView {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
}
export interface LoginEventView {
	type: "info" | "auth_url" | "device_code" | "progress";
	message?: string;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
}
export interface LoginAttemptView {
	id: string;
	providerId: SubscriptionProviderId;
	state: "pending" | "connected" | "cancelled" | "failed";
	events: LoginEventView[];
	prompt?: LoginPromptView;
	/** Sanitized application error only, never the supplier error or callback. */
	error?: string;
}
