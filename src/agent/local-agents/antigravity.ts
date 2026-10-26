import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientApp, ndJsonStream, type ClientConnection, type InitializeResponse, type NewSessionResponse, type PromptResponse, type RequestPermissionResponse, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import packageMetadata from "../../../package.json" with { type: "json" };
import { appHeldEnvVars, resolveBinary } from "./binaries.ts";
import { BRIDGE_SERVER_NAME } from "./mcp-server.ts";
import type { AdapterProbe, LocalAgentAdapter, OpenRequest } from "./adapter.ts";
import type { LocalRun, RunSession } from "./run.ts";
import type { PromptBlock } from "./transcript.ts";

/**
 * Antigravity via Google's official Antigravity ACP server, installed by the
 * learner (docs/architecture.md §8.2). Google's binary makes every model
 * request and owns the Google sign-in and its tokens; LearnHarness only
 * speaks the Agent Client Protocol to it over stdio and never reads a token.
 *
 * Isolation: no filesystem or terminal client capabilities, the app's
 * loopback MCP bridge as the only extra tool server, an empty private
 * working directory, and every native-tool permission request rejected
 * (fail-closed) — the agent's own file and shell tools never run.
 */

const API: Api = "antigravity-acp";
const PROVIDER = "antigravity";
const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function knownDirs(): string[] {
	const home = os.homedir();
	return [path.join(home, ".local", "opt", "agy-acp", "current"), path.join(home, ".local", "bin")];
}

export function resolveAntigravityBinary(): Promise<string | undefined> {
	return resolveBinary({ envVar: "AGY_ACP_BIN", names: process.platform === "win32" ? ["agy_acp_server.exe"] : ["agy_acp_server.par", "agy_acp_server"], knownDirs: knownDirs() });
}

/** Presence only — the token's contents are never read. */
export function antigravityTokenPresent(): Promise<boolean> {
	const home = process.env.GEMINI_HOME ? path.resolve(process.env.GEMINI_HOME) : path.join(os.homedir(), ".gemini");
	if (fs.existsSync(path.join(home, "antigravity-acp", "acp_token.json"))) return Promise.resolve(true);
	if (process.platform !== "darwin") return Promise.resolve(false);
	// The macOS login keychain item's attributes, not its secret (no -w / -g).
	return new Promise((resolve) => execFile("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"], { timeout: 5_000 }, (error) => resolve(!error)));
}

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of appHeldEnvVars()) delete env[name];
	return env;
}

function serverArgs(): string[] { return process.platform === "linux" ? ["--uid="] : []; }

function withTimeout<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Antigravity ${what} timed out.`)), ms);
		const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); }, (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); });
	});
}

interface AcpProcess {
	child: ChildProcess;
	connection: ClientConnection;
	initialize: InitializeResponse;
	cwd: string;
	dir: string;
	close(): void;
}

interface AcpHandlers {
	onUpdate?: (update: Record<string, any>) => void;
	onExit?: (message: string) => void;
}

async function startAcp(binary: string, handlers: AcpHandlers = {}, signal?: AbortSignal): Promise<AcpProcess> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-antigravity-"));
	const cwd = path.join(dir, "workspace");
	fs.mkdirSync(cwd, { mode: 0o700 });
	const child = spawn(binary, serverArgs(), { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let stderr = "", closed = false;
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
	child.stdin!.on("error", () => { /* surfaced through exit */ });
	const app = new ClientApp({ name: "learnharness" })
		// Fail closed: the agent's native tools (files, shell) never get permission.
		.onRequest("session/request_permission", ({ params }): RequestPermissionResponse => {
			const reject = params.options.find((option) => option.kind === "reject_once") ?? params.options.find((option) => option.kind === "reject_always");
			return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
		})
		.onNotification("session/update", ({ params }) => { handlers.onUpdate?.(params.update as Record<string, any>); });
	const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
	const connection = app.connect(stream);
	const close = () => {
		if (closed) return;
		closed = true;
		try { connection.close(); } catch { /* already closed */ }
		child.kill("SIGTERM");
		const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
		force.unref();
		fs.rm(dir, { recursive: true, force: true }, () => {});
	};
	const exited = new Promise<never>((_, reject) => {
		child.on("error", (error) => { if (!closed) handlers.onExit?.(error.message); reject(new Error(`Antigravity could not start: ${error.message}`)); });
		child.on("exit", (code) => { const message = stderr.trim().split("\n").pop() || `Antigravity exited (${code ?? "signal"}).`; if (!closed) handlers.onExit?.(message); reject(new Error(message)); });
	});
	exited.catch(() => {});
	try {
		const initialize = await withTimeout(Promise.race([connection.agent.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: packageMetadata.name, title: "LearnHarness", version: packageMetadata.version },
		}), exited]), REQUEST_TIMEOUT_MS, "start", signal);
		if (initialize.protocolVersion !== PROTOCOL_VERSION) throw new Error("This Antigravity version speaks an unsupported protocol. Update it and refresh.");
		return { child, connection, initialize, cwd, dir, close };
	} catch (error) { close(); throw error; }
}

function selectOptions(option: SessionConfigOption | undefined): Array<{ value: string; name: string }> {
	if (!option || option.type !== "select") return [];
	const entries = option.options as Array<{ value?: string; name: string; options?: Array<{ value: string; name: string }> }>;
	return entries.flatMap((entry) => entry.options ?? (entry.value !== undefined ? [{ value: entry.value, name: entry.name }] : []));
}
function configOption(options: SessionConfigOption[] | null | undefined, category: string): SessionConfigOption | undefined {
	return options?.find((option) => option.category === category || option.id === category);
}

function levelMap(values: string[]): Model<Api>["thinkingLevelMap"] {
	const map: Record<string, string | null> = {};
	for (const level of LEVELS) map[level] = values.includes(level) ? level : null;
	return map as Model<Api>["thinkingLevelMap"];
}

function catalogModel(id: string, name: string, initialize: InitializeResponse, thoughtLevels: string[]): Model<Api> {
	return {
		id, name, api: API, provider: PROVIDER, baseUrl: "",
		reasoning: thoughtLevels.length > 0,
		...(thoughtLevels.length > 0 ? { thinkingLevelMap: levelMap(thoughtLevels) } : {}),
		input: initialize.agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: /^gemini/i.test(id) ? 1_048_576 : 200_000,
		maxTokens: 65_536,
	} as Model<Api>;
}

/** The catalog a fresh session advertises: model selector values (with their thought levels), else the draft model list. */
async function discoverModels(acp: AcpProcess, session: NewSessionResponse, signal?: AbortSignal): Promise<Model<Api>[]> {
	const modelOption = configOption(session.configOptions, "model");
	const models = selectOptions(modelOption);
	if (models.length > 0) {
		const out: Model<Api>[] = [];
		for (const model of models) {
			let options = session.configOptions;
			if (modelOption?.type === "select" && modelOption.currentValue !== model.value) {
				const response = await withTimeout(acp.connection.agent.request("session/set_config_option", { sessionId: session.sessionId, configId: modelOption.id, value: model.value }), REQUEST_TIMEOUT_MS, "model listing", signal);
				options = response.configOptions;
			}
			out.push(catalogModel(model.value, model.name, acp.initialize, selectOptions(configOption(options, "thought_level")).map((o) => o.value)));
		}
		return out;
	}
	const draft = (session as { models?: { availableModels?: Array<{ modelId: string; name?: string }> } }).models?.availableModels ?? [];
	return draft.map((model) => catalogModel(model.modelId, model.name ?? model.modelId, acp.initialize, []));
}

async function withFreshSession<T>(binary: string, signal: AbortSignal | undefined, use: (acp: AcpProcess, session: NewSessionResponse) => Promise<T>, authenticate = false): Promise<T> {
	const acp = await startAcp(binary, {}, signal);
	try {
		if (authenticate) {
			const method = acp.initialize.authMethods?.find((candidate) => /oauth-personal|google/i.test(`${candidate.id} ${candidate.name}`));
			if (!method) throw new Error("This Antigravity version does not offer Google sign-in.");
			await withTimeout(acp.connection.agent.request("authenticate", { methodId: method.id }), SIGN_IN_TIMEOUT_MS, "sign-in", signal);
		}
		const session = await withTimeout(acp.connection.agent.request("session/new", { cwd: acp.cwd, mcpServers: [] }), REQUEST_TIMEOUT_MS, "session", signal);
		return await use(acp, session);
	} finally { acp.close(); }
}

export async function probeAntigravity(options: { discoverModels: boolean; previous: Model<Api>[] }): Promise<AdapterProbe> {
	const binary = await resolveAntigravityBinary();
	if (!binary) return { installed: false, signedIn: false, models: [] };
	const signedIn = await antigravityTokenPresent();
	if (!signedIn) return { installed: true, binary, signedIn: false, models: [] };
	// Spawning the server is heavy: discover once per connection, then reuse.
	if (!options.discoverModels || options.previous.length > 0) return { installed: true, binary, signedIn: true, usesSubscription: true, models: options.previous };
	try {
		const models = await withFreshSession(binary, undefined, (acp, session) => discoverModels(acp, session));
		return { installed: true, binary, signedIn: true, usesSubscription: true, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const auth = /auth|credential|sign|login/i.test(message);
		return { installed: true, binary, signedIn: !auth, models: [], error: auth ? "Antigravity's Google sign-in is missing or expired. Sign in again." : `Antigravity did not respond: ${message}` };
	}
}

function toAcpContent(blocks: PromptBlock[], images: boolean) {
	return blocks.map((block) => block.type === "image"
		? (images ? { type: "image" as const, data: block.data, mimeType: block.mimeType } : { type: "text" as const, text: `[image omitted: ${block.mimeType}]` })
		: { type: "text" as const, text: block.text });
}

async function openAntigravity(run: LocalRun, request: OpenRequest): Promise<RunSession> {
	let sessionId: string | undefined;
	const acp = await startAcp(request.binary, {
		onUpdate: (update) => {
			if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") run.text(update.content.text ?? "");
			else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") run.thinking(update.content.text ?? "");
		},
		onExit: (message) => run.fail(message),
	});
	try {
		const mcp = acp.initialize.agentCapabilities?.mcpCapabilities;
		if (request.tools.length > 0 && !mcp?.http) throw new Error("This Antigravity version cannot use LearnHarness's tools (no HTTP MCP support). Update it and refresh.");
		const session = await withTimeout(acp.connection.agent.request("session/new", {
			cwd: acp.cwd,
			mcpServers: request.tools.length > 0 ? [{ type: "http", name: BRIDGE_SERVER_NAME, url: request.bridge.url, headers: [{ name: "Authorization", value: `Bearer ${request.bridge.token}` }] }] : [],
		}), REQUEST_TIMEOUT_MS, "session");
		sessionId = session.sessionId;
		// Prompting permission mode: native tools must ask, and asking is always rejected.
		if (session.modes && session.modes.currentModeId !== "default" && session.modes.availableModes.some((mode) => mode.id === "default")) {
			await withTimeout(acp.connection.agent.request("session/set_mode", { sessionId, modeId: "default" }), REQUEST_TIMEOUT_MS, "mode");
		}
		let options = session.configOptions;
		const modelOption = configOption(options, "model");
		if (modelOption?.type === "select") {
			if (modelOption.currentValue !== request.model.id) options = (await withTimeout(acp.connection.agent.request("session/set_config_option", { sessionId, configId: modelOption.id, value: request.model.id }), REQUEST_TIMEOUT_MS, "model")).configOptions;
			const thought = configOption(options, "thought_level");
			const wanted = request.level && request.model.thinkingLevelMap?.[request.level];
			if (thought?.type === "select" && wanted && thought.currentValue !== wanted) await withTimeout(acp.connection.agent.request("session/set_config_option", { sessionId, configId: thought.id, value: wanted }), REQUEST_TIMEOUT_MS, "thinking level");
		} else {
			await withTimeout(acp.connection.agent.request("session/set_model", { sessionId, modelId: request.model.id }), REQUEST_TIMEOUT_MS, "model");
		}
	} catch (error) { acp.close(); throw error; }
	const images = acp.initialize.agentCapabilities?.promptCapabilities?.image === true;
	let disposed = false;
	return {
		start(prompt) {
			acp.connection.agent.request<PromptResponse>("session/prompt", { sessionId: sessionId!, prompt: toAcpContent(prompt, images) }).then(
				(response) => run.endTurn(response.stopReason === "max_tokens" ? "length" : "stop"),
				(error) => { if (!disposed) run.fail(error instanceof Error ? error.message : String(error)); },
			);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (sessionId) void acp.connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
			acp.close();
		},
	};
}

export const antigravityAdapter: LocalAgentAdapter = {
	providerId: PROVIDER,
	surfaceOnArrival: true,
	images: true,
	probe: probeAntigravity,
	open: openAntigravity,
	async signIn(signal) {
		const binary = await resolveAntigravityBinary();
		if (!binary) throw new Error("Install the Antigravity ACP server first.");
		return withFreshSession(binary, signal, (acp, session) => discoverModels(acp, session, signal), true);
	},
};
