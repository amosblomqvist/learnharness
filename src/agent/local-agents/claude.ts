import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { appHeldEnvVars, resolveBinary } from "./binaries.ts";
import { BRIDGE_SERVER_NAME, CLAUDE_TOOL_PREFIX } from "./mcp-server.ts";
import type { AdapterProbe, LocalAgentAdapter, OpenRequest } from "./adapter.ts";
import type { LocalRun, RunSession } from "./run.ts";
import type { PromptBlock } from "./transcript.ts";

/**
 * Claude via the learner's own Claude Code CLI (docs/architecture.md §8.2).
 * LearnHarness never runs a claude.ai login and never touches the token:
 * Claude Code uses whatever sign-in the learner set up with
 * `claude auth login`. The app speaks the CLI's documented headless
 * protocol (`-p --input-format/--output-format stream-json`) directly — no
 * Anthropic SDK is bundled.
 *
 * Isolation: no built-in tools (`--tools ""`), no settings files, CLAUDE.md,
 * hooks, skills or slash commands (`--setting-sources ""`,
 * `--disable-slash-commands`), only the app's loopback MCP bridge
 * (`--strict-mcp-config`), the app's own system prompt, no session
 * persistence, and an empty private working directory.
 */

const API: Api = "claude-code-cli";
const PROVIDER = "claude-code";

/** Env vars that would silently move Claude Code off the learner's subscription. */
const SCRUBBED_ENV = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
];

/** The child's environment: the learner's own, minus app-held provider keys and anything that reroutes auth. */
export function claudeChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of SCRUBBED_ENV) delete env[key];
	for (const name of appHeldEnvVars()) delete env[name];
	// The app owns compaction and the tool surface; a parked tool call may wait on the learner.
	env.DISABLE_AUTO_COMPACT = "1";
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
	env.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1000);
	// Tool results reach the model whole, as they do on API connections.
	env.MAX_MCP_OUTPUT_TOKENS = "200000";
	return env;
}

function knownDirs(): string[] {
	const home = os.homedir();
	if (process.platform === "win32") return [path.join(home, ".local", "bin"), path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")];
	return [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".volta", "bin")];
}

export function resolveClaudeBinary(): Promise<string | undefined> {
	return resolveBinary({ envVar: "LH_CLAUDE_BIN", names: process.platform === "win32" ? ["claude.exe"] : ["claude"], knownDirs: knownDirs() });
}

function run(binary: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
	return new Promise((resolve) => {
		execFile(binary, args, { timeout, env: claudeChildEnv(), windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
	});
}

function titleCase(value: string): string { return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

let catalog: Model<Api>[] | undefined;
/** pi-ai's Anthropic catalog (no dated snapshots), relabelled as the local connection. */
export function claudeModels(): Model<Api>[] {
	if (catalog) return catalog;
	const anthropic = builtinProviders().find((provider) => provider.id === "anthropic");
	catalog = (anthropic?.getModels() ?? [])
		.filter((model) => !/-\d{8}$/.test(model.id))
		.map((model) => ({
			...model,
			api: API,
			provider: PROVIDER,
			baseUrl: "",
			headers: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Claude Code serves the 4.6 generation at 200K unless a [1m] variant is chosen.
			contextWindow: /-4-6$/.test(model.id) ? Math.min(model.contextWindow, 200_000) : model.contextWindow,
		}) as Model<Api>);
	return catalog;
}

export async function probeClaude(): Promise<AdapterProbe> {
	const binary = await resolveClaudeBinary();
	if (!binary) return { installed: false, signedIn: false, models: [] };
	const [version, status] = await Promise.all([run(binary, ["--version"], 15_000), run(binary, ["auth", "status", "--json"], 20_000)]);
	let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string | null; email?: string | null } = {};
	try { auth = JSON.parse(status.stdout); } catch { /* signed-out or failed runs may print no JSON */ }
	// A slow or failed check must not read as "signed out" and tear down live work.
	if (typeof auth.loggedIn !== "boolean") return { installed: true, binary, signedIn: false, models: [], uncertain: true, ...(version.ok ? { version: version.stdout.trim().split(/\s+/)[0] } : {}) };
	const signedIn = auth.loggedIn;
	return {
		installed: true,
		binary,
		version: version.ok ? version.stdout.trim().split(/\s+/)[0] : undefined,
		signedIn,
		...(auth.email ? { account: auth.email } : {}),
		...(auth.subscriptionType ? { plan: titleCase(auth.subscriptionType) } : {}),
		...(signedIn ? { usesSubscription: /claude\.ai|oauth|subscription/i.test(auth.authMethod ?? "") } : {}),
		models: signedIn ? claudeModels() : [],
		...(version.ok ? {} : { error: "Claude Code did not start. Reinstall it or update it, then refresh." }),
	};
}

/** pi thinking level → Claude Code `--effort`; "off" is expressed through MAX_THINKING_TOKENS. */
export function claudeEffort(level: ThinkingLevel | undefined): { args: string[]; env: Record<string, string> } {
	if (!level || level === "off") return { args: [], env: { MAX_THINKING_TOKENS: "0" } };
	return { args: ["--effort", level === "minimal" ? "low" : level], env: {} };
}

function toClaudeContent(blocks: PromptBlock[]) {
	return blocks.map((block) => block.type === "image"
		? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
		: { type: "text", text: block.text });
}

interface BlockState { kind: "text" | "thinking" | "tool_use" | "other"; id?: string; name?: string; json: string }

/** Feed one parsed stream-json line into the run. Exported for tests. */
export function claudeLineHandler(run: LocalRun, expectBridge: boolean) {
	const blocks = new Map<number, BlockState>();
	let stopReason: string | undefined;
	return (message: Record<string, any>) => {
		if (message.type === "system" && message.subtype === "init") {
			if (!expectBridge) return;
			const bridge = (message.mcp_servers as Array<{ name: string; status: string }> | undefined)?.find((server) => server.name === BRIDGE_SERVER_NAME);
			if (bridge?.status !== "connected") run.fail("Claude Code could not connect to LearnHarness's tools.");
			return;
		}
		if (message.type === "result") {
			if (message.is_error || message.subtype !== "success") run.fail(String(message.result || message.subtype || "Claude Code request failed."));
			else run.endTurn("stop");
			return;
		}
		if (message.type !== "stream_event") return;
		const event = message.event as Record<string, any>;
		switch (event.type) {
			case "message_start": {
				run.messageStarted();
				blocks.clear(); stopReason = undefined;
				const usage = event.message?.usage ?? {};
				run.usage({ input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, output: usage.output_tokens ?? 0 });
				break;
			}
			case "content_block_start": {
				const block = event.content_block ?? {};
				const kind = block.type === "text" || block.type === "thinking" || block.type === "tool_use" ? block.type : "other";
				blocks.set(event.index, { kind, id: block.id, name: block.name, json: "" });
				if (kind === "text" && block.text) run.text(block.text);
				break;
			}
			case "content_block_delta": {
				const state = blocks.get(event.index);
				const delta = event.delta ?? {};
				if (delta.type === "text_delta") run.text(delta.text ?? "");
				else if (delta.type === "thinking_delta") run.thinking(delta.thinking ?? "");
				else if (delta.type === "input_json_delta" && state) state.json += delta.partial_json ?? "";
				break;
			}
			case "content_block_stop": {
				const state = blocks.get(event.index);
				if (state?.kind !== "tool_use" || !state.id || !state.name) break;
				let args: Record<string, unknown> = {};
				try { const parsed = state.json.trim() ? JSON.parse(state.json) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; } catch { /* malformed → empty; pi validation reports it */ }
				run.declareToolCall({ id: state.id, name: state.name.startsWith(CLAUDE_TOOL_PREFIX) ? state.name.slice(CLAUDE_TOOL_PREFIX.length) : state.name, arguments: args });
				break;
			}
			case "message_delta": {
				stopReason = event.delta?.stop_reason ?? stopReason;
				if (typeof event.usage?.output_tokens === "number") run.usage({ output: event.usage.output_tokens });
				break;
			}
			case "message_stop":
				run.endMessage(stopReason === "max_tokens" ? "length" : "stop");
				break;
		}
	};
}

function openClaude(run: LocalRun, request: OpenRequest): RunSession {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-"));
	const cwd = path.join(dir, "workspace");
	fs.mkdirSync(cwd, { mode: 0o700 });
	const systemFile = path.join(dir, "system-prompt.txt");
	fs.writeFileSync(systemFile, request.systemPrompt, { mode: 0o600 });
	const effort = claudeEffort(request.level);
	const args = [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--model", request.model.id, ...effort.args,
		"--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config",
		"--permission-mode", "dontAsk", "--no-session-persistence", "--system-prompt-file", systemFile,
	];
	const expectBridge = request.tools.length > 0;
	if (expectBridge) {
		const configFile = path.join(dir, "mcp.json");
		fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: { type: "http", url: request.bridge.url, headers: { Authorization: `Bearer ${request.bridge.token}` } } } }), { mode: 0o600 });
		args.push("--mcp-config", configFile, "--allowedTools", request.tools.map((tool) => `${CLAUDE_TOOL_PREFIX}${tool.name}`).join(","));
	}
	const child = spawn(request.binary, args, { cwd, env: { ...claudeChildEnv(), ...effort.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	let disposed = false;
	const handle = claudeLineHandler(run, expectBridge);
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let parsed: Record<string, unknown>;
			try { parsed = JSON.parse(line); } catch { continue; }
			handle(parsed);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
	child.on("error", (error) => run.fail(`Claude Code could not start: ${error.message}`));
	child.on("exit", (code) => { if (!disposed) run.fail(stderr.trim().split("\n").pop() || `Claude Code exited (${code ?? "signal"}).`); });
	child.stdin.on("error", () => { /* surfaced through exit */ });
	return {
		start(prompt) {
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: toClaudeContent(prompt) } })}\n`);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			child.stdin.end();
			child.kill("SIGTERM");
			const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
			force.unref();
			fs.rm(dir, { recursive: true, force: true }, () => {});
		},
	};
}

export const claudeAdapter: LocalAgentAdapter = {
	providerId: PROVIDER,
	surfaceOnArrival: false,
	images: true,
	probe: probeClaude,
	open: async (run, request) => openClaude(run, request),
};
