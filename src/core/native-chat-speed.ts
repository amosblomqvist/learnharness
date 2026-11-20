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
