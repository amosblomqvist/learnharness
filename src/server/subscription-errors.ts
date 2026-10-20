import { SubscriptionError, type SubscriptionErrorCode } from "../core/subscription.ts";

/** Project SDK/store causes onto fixed public codes; never return supplier text. */
export function subscriptionErrorCode(error: unknown): SubscriptionErrorCode {
	for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
		if (error instanceof SubscriptionError) return error.code;
		if (error.name === "SubscriptionStorageError") return "subscription_storage_error";
		// Exact-version device capability failure contains no provider body.
		if (error.message === "OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.") return "subscription_device_unsupported";
	}
	return "subscription_unknown";
}
