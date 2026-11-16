import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { getCliBinary } from "../claude-code/binary.ts";
import { externalCliEnv } from "../../core/auth-env.ts";
import { EXTERNAL_CLI_PROVIDERS } from "../../core/contracts/external-cli.ts";
import { parseRpcLine, RpcClient, RpcMethod } from "./app-server.ts";
import { codexBinarySpec } from "./stream.ts";

const CODEX_API = "codex" as Api;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CACHE_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 30_000;
type CodexModel = { id: string; displayName: string; hidden: boolean; inputModalities?: string[]; supportedReasoningEfforts: { reasoningEffort: string }[] };
type ModelPage = { data: CodexModel[]; nextCursor: string | null };

export function toCodexModel(entry: CodexModel): Model<Api> {
	const efforts = new Set(entry.supportedReasoningEfforts.map((option) => option.reasoningEffort));
	const thinkingLevelMap = Object.fromEntries(LEVELS.map((level) => [level, efforts.has(level) ? level : null]));
	return {
		id: entry.id, name: entry.displayName, api: CODEX_API, provider: EXTERNAL_CLI_PROVIDERS.codex,
		baseUrl: "", input: entry.inputModalities?.includes("image") === false ? ["text"] : ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: efforts.size > 0,
		thinkingLevelMap, contextWindow: 1_000_000, maxTokens: 128_000,
	};
}

export function createCodexProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>, models: readonly Model<Api>[]): Provider {
	return createProvider({
		id: EXTERNAL_CLI_PROVIDERS.codex, name: "Codex",
		auth: { apiKey: { name: "Codex CLI", resolve: async () => ({ auth: {}, source: "codex CLI" }) } },
		models, api: { stream: streamSimple, streamSimple },
	});
}

export async function listCodexModels(binary = getCliBinary(codexBinarySpec), args = ["app-server"]): Promise<Model<Api>[]> {
	if (!binary) throw new Error("Codex CLI was not found");
	const child = spawn(binary, args, { env: externalCliEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout });
	try {
		return await new Promise<Model<Api>[]>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Codex model list timed out")), LIST_TIMEOUT_MS);
			const finish = (error?: Error, models?: Model<Api>[]) => { clearTimeout(timer); error ? reject(error) : resolve(models!); };
			child.once("error", (error) => finish(error));
			child.stdin.on("error", (error) => finish(error));
			child.once("exit", () => finish(new Error("Codex app-server exited")));
			const rpc = new RpcClient((line) => child.stdin.write(`${line}\n`));
			const entries: Model<Api>[] = [];
			const cursors = new Set<string>();
			const page = (cursor: string | null) => rpc.request("model/list", { cursor, includeHidden: false }, (response) => {
				if (response.error) return finish(new Error(response.error.message));
				try {
					const result = response.result as ModelPage;
					entries.push(...result.data.filter((entry) => !entry.hidden).map(toCodexModel));
					if (result.nextCursor) {
						if (cursors.has(result.nextCursor)) throw new Error("Repeated model list cursor");
						cursors.add(result.nextCursor); page(result.nextCursor);
					} else finish(undefined, entries);
				} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			});
			lines.on("line", (line) => {
				try { const message = parseRpcLine(line); if (message.kind === "response") rpc.handleResponse(message); }
				catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			});
			rpc.request(RpcMethod.INITIALIZE, { clientInfo: { name: "learnharness", version: "1" }, capabilities: { experimentalApi: true } }, (response) => {
				if (response.error) return finish(new Error(response.error.message));
				rpc.notify(RpcMethod.INITIALIZED); page(null);
			});
		});
	} finally { lines.close(); child.kill(); await closed; }
}

let cached: readonly Model<Api>[] = [];
let fetchedAt = 0;
let pending: Promise<void> | undefined;
let lister = listCodexModels;
export function codexModels(): readonly Model<Api>[] { return cached; }
export function configureCodexModelLister(fn: typeof listCodexModels): void { lister = fn; cached = []; fetchedAt = 0; }
export function refreshCodexModels(): Promise<void> {
	if (pending) return pending;
	if (cached.length > 0 && fetchedAt && Date.now() - fetchedAt < CACHE_MS) return Promise.resolve();
	pending = (async () => {
		try { cached = await lister(); fetchedAt = Date.now(); } catch { /* Preserve the last successful catalog. */ }
	})().finally(() => { pending = undefined; });
	return pending;
}
