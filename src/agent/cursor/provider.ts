/** Cursor catalog. Registered on LearnHarness's Models collection, not in
 * pi-ai's builtinProviders(), so the auth-key drift test stays pinned. */
import { execFileSync } from "node:child_process";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { CURSOR_PROVIDER_ID } from "../../core/cursor.ts";
import { cursorAgentBin } from "./login.ts";
import { cursorProxyBaseUrl } from "./proxy.ts";

/** Loopback dummy. pi-ai refuses to stream without a resolved key. The proxy
 * ignores Authorization; the CLI uses its own login. */
export const CURSOR_LOCAL_API_KEY = "learnharness-local";

/** The CLI does not publish a context window. The meter uses this estimate. */
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 16_384;

export interface CursorModelInfo {
	id: string;
	name: string;
}

/** Used when the CLI cannot be asked, including every test run. */
export function cursorFixtureModels(): CursorModelInfo[] {
	return [
		{ id: "auto", name: "Auto" },
		{ id: "composer-2.5", name: "Composer 2.5" },
	];
}

/** `agent --list-models` lines look like `composer-2.5 - Composer 2.5 (current)`.
 * A parenthetical that is not default/current stays part of the display name. */
export function parseCursorModelList(text: string): CursorModelInfo[] {
	const models: CursorModelInfo[] = [];
	for (const line of text.split("\n")) {
		const match = /^(\S+)\s+-\s+(.+)$/.exec(line.trim());
		if (!match?.[1] || !match[2]) continue;
		const name = match[2].trim().replace(/\s+\((?:default|current)\)\s*$/i, "");
		if (!name || match[1].startsWith("-")) continue;
		models.push({ id: match[1], name });
	}
	return models;
}

let listed: CursorModelInfo[] | null = null;

export function cursorModelList(): CursorModelInfo[] {
	if (process.env.NODE_ENV === "test") return cursorFixtureModels();
	if (listed) return listed;
	try {
		const out = execFileSync(cursorAgentBin(), ["--list-models"], {
			timeout: 12_000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 4 * 1024 * 1024,
		});
		const parsed = parseCursorModelList(out);
		listed = parsed.length > 0 ? parsed : cursorFixtureModels();
	} catch {
		listed = cursorFixtureModels();
	}
	return listed;
}

function toModel(entry: CursorModelInfo): Model<"openai-completions"> {
	return {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: CURSOR_PROVIDER_ID,
		baseUrl: cursorProxyBaseUrl(),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
		compat: { supportsStrictMode: false, supportsUsageInStreaming: true },
		type: "chat",
	};
}

export function cursorProvider() {
	return createProvider({
		id: CURSOR_PROVIDER_ID,
		name: "Cursor",
		baseUrl: cursorProxyBaseUrl(),
		auth: {
			apiKey: {
				name: "Cursor",
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: { apiKey: CURSOR_LOCAL_API_KEY }, source: "cursor-agent" };
				},
			},
		},
		models: cursorModelList().map(toModel),
		api: openAICompletionsApi(),
	});
}
