/** Browser-safe, sanitized instance subscription authorization contract. */
export const SUBSCRIPTION_PROVIDER = "openai-codex";
export type SubscriptionMethod = "browser" | "device_code";
export type SubscriptionErrorCode =
	| "subscription_needs_login" | "subscription_limit" | "subscription_model_unavailable"
	| "subscription_network" | "subscription_unknown" | "subscription_storage_error"
	| "subscription_recovery_required" | "subscription_cancelled" | "subscription_expired"
	| "subscription_conflict" | "subscription_wrong_owner" | "subscription_invalid_input"
	| "subscription_device_unsupported";
export interface SubscriptionFailure {
	code: SubscriptionErrorCode;
	message: string;
}
export interface SubscriptionStatus {
	state: "disconnected" | "authorizing" | "connected" | "reconnect_required" | "error";
	/** Saved authorization, not a live entitlement check. */
	account?: string;
	attempt?: {
		id: string;
		method: SubscriptionMethod;
		expiresAt: number;
		authorizationUrl?: string;
		verificationUri?: string;
		userCode?: string;
		promptId?: string;
		manualAvailable?: boolean;
		callbackListening?: boolean;
		ownedHere: boolean;
	};
	error?: SubscriptionFailure;
}
export class SubscriptionError extends Error {
	constructor(public readonly code: SubscriptionErrorCode) {
		super(subscriptionFailure(code).message);
		this.name = "SubscriptionError";
	}
}
const MESSAGES: Record<SubscriptionErrorCode, string> = {
	subscription_needs_login: "Sign in to this instance's Codex subscription before using this model.",
	subscription_limit: "The provider reported a subscription usage limit. This task was stopped.",
	subscription_model_unavailable: "The selected subscription model is unavailable. No alternate model was used.",
	subscription_network: "The subscription request could not reach the provider. This task was stopped.",
	subscription_unknown: "The subscription operation failed. Its cause could not be confirmed.",
	subscription_storage_error: "Authorization storage is unavailable. New subscription requests are blocked.",
	subscription_recovery_required: "A token refresh has an uncertain outcome. Disconnect and authorize again before continuing.",
	subscription_cancelled: "Authorization was cancelled.",
	subscription_expired: "Authorization expired. Start a new attempt.",
	subscription_conflict: "An account or authorization attempt already exists. Disconnect or cancel it first.",
	subscription_wrong_owner: "This authorization belongs to another service process. Use the service that started it.",
	subscription_invalid_input: "The authorization input is invalid or no longer belongs to the current prompt.",
	subscription_device_unsupported: "Device authorization is not enabled by the provider. Start a browser attempt instead.",
};
export function subscriptionFailure(code: SubscriptionErrorCode): SubscriptionFailure {
	return { code, message: MESSAGES[code] };
}
/** Only validated machine codes establish a provider diagnosis. HTTP status alone does not. */
export function subscriptionResponseCode(value: unknown): SubscriptionErrorCode {
	if (!value || typeof value !== "object") return "subscription_unknown";
	const error = (value as { error?: unknown }).error;
	if (!error || typeof error !== "object") return "subscription_unknown";
	const code = (error as { code?: unknown }).code;
	if (code === "usage_limit_reached" || code === "insufficient_quota") return "subscription_limit";
	if (code === "model_not_found" || code === "model_not_available") return "subscription_model_unavailable";
	if (code === "token_expired" || code === "token_revoked" || code === "invalid_access_token") return "subscription_needs_login";
	return "subscription_unknown";
}
