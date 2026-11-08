import { createProvider, type Api, type Model, type SimpleStreamOptions, type StreamFunction, type ThinkingLevel } from "@earendil-works/pi-ai";
import { CODEX_PROVIDER } from "../../core/contracts/codex.ts";

export interface CodexModel {
	model: string; displayName: string; hidden?: boolean;
	inputModalities?: string[];
	supportedReasoningEfforts: { reasoningEffort: string }[];
}
export function codexModel(entry: CodexModel): Model<Api> {
	const thinkingLevelMap: Partial<Record<ThinkingLevel | "off", string | null>> = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
	for (const { reasoningEffort } of entry.supportedReasoningEfforts) {
		if (reasoningEffort === "none") thinkingLevelMap.off = "none";
		if (reasoningEffort in thinkingLevelMap) thinkingLevelMap[reasoningEffort as ThinkingLevel] = reasoningEffort;
	}
	return { id: entry.model, name: entry.displayName, provider: CODEX_PROVIDER, api: "codex-app-server", baseUrl: "",
		input: entry.inputModalities?.includes("image") ? ["text", "image"] : ["text"],
		reasoning: entry.supportedReasoningEfforts.length > 0, thinkingLevelMap,
		// Required Pi placeholders only. Public limits/prices are null for this route.
		contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
type Source = { models: Model<Api>[]; stream: StreamFunction<Api, SimpleStreamOptions> };
const key = Symbol.for("lh.codex.source");
const state = () => globalThis as typeof globalThis & { [key]?: Source };
export function setCodexSource(source?: Source) { state()[key] = source; }
export function createCodexProvider() {
	const stream: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
		const source = state()[key];
		if (!source) throw new Error("Codex is disconnected. Reconnect in Settings → Providers.");
		return source.stream(model, context, options);
	};
	return createProvider({ id: CODEX_PROVIDER, name: "Codex", models: state()[key]?.models ?? [],
		auth: { apiKey: { name: "Codex sign-in", resolve: async () => ({ auth: {}, source: "Codex" }) } },
		api: { stream, streamSimple: stream } });
}
