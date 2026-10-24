/** Public connection metadata. Credentials and login answers never belong here. */
export const SUBSCRIPTION_PROVIDERS = [
	{ id: "subscription-openai-codex", provider: "openai-codex", name: "Codex subscription" },
] as const;

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDERS)[number]["id"];
export function subscriptionProvider(id: string) {
	return SUBSCRIPTION_PROVIDERS.find((p) => p.id === id);
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
