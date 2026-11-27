// Fast availability on the direct OpenAI Responses API. ChatGPT subscriptions
// instead use the tiers returned by the currently connected account.
const fastModels = new Set([
	"gpt-5.5",
	"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	"gpt-6-astra", "gpt-6-luna", "gpt-6-sol",
	"gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol",
]);

export function supportsOpenAIFastMode(modelId: string): boolean {
	return fastModels.has(modelId);
}

/** Only server-reported processing tiers belong in this live result. */
export type FastModeServedTier = "default" | "priority" | "fast" | "flex" | "scale" | "ultrafast";
export interface FastModeResult {
	outcome: "applied" | "not-applied" | "unconfirmed";
	servedTier?: FastModeServedTier;
}

/** A requested tier or response.created is not proof of completed processing. */
export function fastModeCompletionResult(raw: unknown): FastModeResult | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const event = raw as { type?: unknown; response?: unknown };
	if (event.type !== "response.completed" || !event.response || typeof event.response !== "object" || Array.isArray(event.response)) return undefined;
	const response = event.response as { status?: unknown; error?: unknown; service_tier?: unknown };
	if (response.status !== "completed" || response.error) return undefined;
	const tier = response.service_tier;
	if (tier === "priority" || tier === "fast") return { outcome: "applied", servedTier: tier };
	if (tier === "default" || tier === "flex" || tier === "scale" || tier === "ultrafast") return { outcome: "not-applied", servedTier: tier };
	return { outcome: "unconfirmed" };
}

/** One later successful call must not hide an earlier downgrade or missing proof. */
export function mergeFastModeResults(previous: FastModeResult | undefined, next: FastModeResult): FastModeResult {
	const severity = { applied: 0, unconfirmed: 1, "not-applied": 2 };
	return previous && severity[previous.outcome] >= severity[next.outcome] ? previous : next;
}
