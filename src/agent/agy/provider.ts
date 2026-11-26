import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { getAgyBinary } from "./binary.ts";
import { AGY_API, AGY_PROVIDER } from "./constants.ts";
import { createAgyLauncher } from "./launch.ts";
import { createAgyStreamFunction } from "./stream.ts";

const SHARED_MODEL_FIELDS = {
	api: AGY_API,
	provider: AGY_PROVIDER,
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name">;

// Next.js route bundles can each instantiate their own piModels() collection;
// keep the live AGY list on globalThis so every route sees refreshed models.
const AGY_MODELS_KEY = Symbol.for("lh.agy-models");
const agyModelsGlobal = globalThis as typeof globalThis & { [AGY_MODELS_KEY]?: readonly Model<Api>[] };

export type ReadAgyModels = (binary: string, signal?: AbortSignal) => Promise<string>;

export const readAgyModels: ReadAgyModels = (binary, signal) => new Promise((resolve, reject) => {
	execFile(binary, ["models"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536, signal,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Parse `agy models` stdout (`<id>\t<name>` per line) into Pi model entries. */
export function parseAgyModelsOutput(output: string): Model<Api>[] {
	const models = new Map<string, Model<Api>>();
	for (const line of output.split(/\r?\n/)) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const id = line.slice(0, tab).trim();
		const name = line.slice(tab + 1).trim();
		if (!id || !name || models.has(id)) continue;
		models.set(id, { ...SHARED_MODEL_FIELDS, id, name });
	}
	return [...models.values()];
}

export function createAgyProvider(
	streamSimple: StreamFunction<Api, SimpleStreamOptions>,
	options: {
		findBinary?: () => string | null;
		readModels?: ReadAgyModels;
	} = {},
): Provider {
	const findBinary = options.findBinary ?? getAgyBinary;
	const readModels = options.readModels ?? readAgyModels;
	const shared = options.readModels === undefined;

	const provider = createProvider({
		id: AGY_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: [],
		fetchModels: async ({ signal }) => {
			const binary = findBinary();
			const models = binary ? parseAgyModelsOutput(await readModels(binary, signal)) : [];
			if (shared) agyModelsGlobal[AGY_MODELS_KEY] = models;
			return models;
		},
		api: { stream: streamSimple, streamSimple },
	});

	if (!shared) return provider;
	return {
		...provider,
		getModels: () => agyModelsGlobal[AGY_MODELS_KEY] ?? [],
		getAllModels: () => agyModelsGlobal[AGY_MODELS_KEY] ?? [],
	};
}

export const streamAgy = createAgyStreamFunction(createAgyLauncher());
