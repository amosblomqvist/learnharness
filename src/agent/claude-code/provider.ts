import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { CLAUDE_CODE_API, CLAUDE_CODE_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: CLAUDE_CODE_API,
	provider: CLAUDE_CODE_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	// The CLI has no thinking-off switch; effort low is the floor.
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const CLAUDE_CODE_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "opus", name: "Claude Opus" },
	{ ...SHARED_MODEL_FIELDS, id: "sonnet", name: "Claude Sonnet" },
	{ ...SHARED_MODEL_FIELDS, id: "haiku", name: "Claude Haiku" },
];

/** A model name the CLI may accept beyond the three listed aliases: another
 *  alias it reports (e.g. `fable`) or a full ID (e.g. `claude-mythos-5-2`).
 *  Starting with a letter keeps it from ever reading as a CLI flag. */
const CLI_MODEL_NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/** The model record for a Claude Code selection. Listed aliases come from the
 *  fixed catalog; any other well-formed name is synthesized with the same
 *  fields, so a saved choice the CLI reported keeps working before the CLI is
 *  asked again (for example right after a restart). Whether the account can
 *  use it is the CLI's call at request time. */
export function claudeCodeModel(id: string, name?: string): Model<Api> | undefined {
	const listed = CLAUDE_CODE_MODELS.find((model) => model.id === id);
	if (listed) return listed;
	return CLI_MODEL_NAME.test(id) ? { ...SHARED_MODEL_FIELDS, id, name: name ?? id } : undefined;
}

export function createClaudeCodeProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: CLAUDE_CODE_PROVIDER,
		name: "Claude Code",
		auth: { apiKey: { name: "Claude Code CLI", resolve: async () => ({ auth: {}, source: "claude CLI" }) } },
		models: CLAUDE_CODE_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
