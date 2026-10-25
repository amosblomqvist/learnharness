import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import spawn from "cross-spawn";
import { ACP_AGENTS, type AcpAgentId, type AcpConnectionConfig } from "../../core/acp.ts";
import { AUTH_PROVIDER_ENV_VARS, AUTH_KEYS } from "../../core/auth-keys.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { PATHS } from "../../../config.ts";

export interface AcpInitialization {
	protocolVersion: number;
	agentInfo?: { name?: string; version?: string };
	agentCapabilities?: {
		promptCapabilities?: { image?: boolean };
		mcpCapabilities?: { http?: boolean };
		sessionCapabilities?: { systemPrompt?: { mode?: { override?: unknown } } };
	};
}
export interface AcpSession {
	sessionId: string;
	models?: { currentModelId: string; availableModels?: { modelId: string; name: string }[] };
	configOptions?: AcpConfigOption[];
}
export interface AcpConfigValue { value: string; name: string }
export interface AcpConfigOption {
	id: string;
	category?: string;
	type: string;
	currentValue: string | boolean;
	options?: (AcpConfigValue | { options: AcpConfigValue[] })[];
}
export type AcpNotification = (method: string, params: Record<string, unknown>) => void;
interface AcpClientOptions {
	onNotification?: AcpNotification;
	signal?: AbortSignal;
	applicationTools?: readonly string[];
	systemPrompt?: string;
}

/** Only the CLI's own saved subscription login is used. Never mutate parent env. */
export function subscriptionEnv(id: AcpAgentId, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const excluded = new Set<string>([...AUTH_PROVIDER_ENV_VARS, ...AUTH_KEYS.map((key) => key.id)]);
	const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
	for (const [key, value] of Object.entries(source)) {
		if (excluded.has(key) || /^(ANTHROPIC_|OPENAI_|AZURE_|AWS_|GOOGLE_|GEMINI_|BEDROCK_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|MODEL_PROVIDER$|DEFAULT_AUTH_REQUEST$|CODEX_CONFIG$|CODEX_API_KEY$)/i.test(key)) continue;
		env[key] = value;
	}
	// Electron's executable is also a Node runtime for child adapter scripts.
	env.ELECTRON_RUN_AS_NODE = "1";
	if (id === "codex") {
		env.INITIAL_AGENT_MODE = "read-only";
		env.MODEL_PROVIDER = "openai";
		env.CODEX_CONFIG = JSON.stringify({ forced_login_method: "chatgpt", features: { shell_tool: false } });
	}
	return env;
}

/** ACP v1 is newline-delimited JSON-RPC over stdio. One client per native session.
 * Pending RPCs, process trees, and temporary workspaces have one owner here. */
export class AcpClient {
	readonly cwd = mkdtempSync(path.join(tmpdir(), "learnharness-acp-"));
	private readonly child;
	private readonly childDone: Promise<void>;
	private childClosed = false;
	private readonly lines;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
	private nextId = 0;
	private failure?: Error;
	private closed = false;
	private closing?: Promise<void>;
	private sessionId?: string;
	private authKind?: string;
	private authReady?: () => void;
	private readonly authNotification = new Promise<void>((resolve) => { this.authReady = resolve; });
	private subscriptionVerified = false;
	private readonly applicationCallIds = new Set<string>();
	private readonly abort: () => void;
	private readonly signal?: AbortSignal;
	private readonly onNotification: AcpNotification;
	private readonly applicationTools: readonly string[];
	private readonly codex: boolean;
	private readonly ephemeralAck = path.join(this.cwd, "codex-ephemeral.json");

	constructor(id: AcpAgentId, config: AcpConnectionConfig, options: AcpClientOptions = {}) {
		const agent = ACP_AGENTS.find((agent) => agent.id === id)!;
		const { signal } = options;
		this.signal = signal;
		this.onNotification = options.onNotification ?? (() => {});
		this.applicationTools = options.applicationTools ?? [];
		this.codex = id === "codex";
		const env = subscriptionEnv(id);
		if (id === "codex" && options.systemPrompt) {
			// Published Codex adapters before sessionCapabilities.systemPrompt
			// accept the same instructions through their native config override.
			env.CODEX_CONFIG = JSON.stringify({ ...JSON.parse(env.CODEX_CONFIG!), developer_instructions: options.systemPrompt });
		}
		let command = config.command ?? agent.command;
		let args = config.args ?? [];
		if (this.codex) {
			// The adapter's native CLI override is the supported boundary for
			// enforcing ephemeral threads, even when ACP ignores metadata flags.
			env.LH_CODEX_NATIVE_PATH = env.CODEX_PATH;
			env.LH_CODEX_ADAPTER_LAUNCH = JSON.stringify({ command, args });
			env.LH_CODEX_PROXY_NODE = process.execPath;
			env.LH_CODEX_PROXY_SCRIPT = path.join(PATHS.root, "src", "agent", "acp", "codex-ephemeral.cjs");
			env.LH_CODEX_EPHEMERAL_ACK = this.ephemeralAck;
			const shim = path.join(this.cwd, process.platform === "win32" ? "codex-ephemeral.cmd" : "codex-ephemeral");
			writeFileSync(shim, process.platform === "win32"
				? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%LH_CODEX_PROXY_NODE%" "%LH_CODEX_PROXY_SCRIPT%" %*\r\n'
				: '#!/bin/sh\nexec "$LH_CODEX_PROXY_NODE" "$LH_CODEX_PROXY_SCRIPT" "$@"\n', { mode: 0o700 });
			env.CODEX_PATH = shim;
		}
		if (process.platform === "win32") {
			const assets = path.join(PATHS.root, "src", "agent", "acp");
			// Only static, repository-owned code is encoded. Executable/argv
			// data travels separately in the environment, never as shell text.
			const keeper = readFileSync(path.join(assets, "windows-job.ps1"), "utf8");
			env.LH_ACP_LAUNCH = JSON.stringify({ command, args });
			env.LH_ACP_NODE = process.execPath;
			env.LH_ACP_WORKER = path.join(assets, "process-supervisor.cjs");
			env.LH_ACP_READY = path.join(this.cwd, "job-ready");
			command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(keeper, "utf16le").toString("base64")];
		}
		this.child = spawn(command, args, {
			cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
		});
		this.childDone = new Promise((resolve) => this.child.once("close", () => { this.childClosed = true; resolve(); }));
		// Drain stderr without exposing credentials or native prompts to the browser.
		this.child.stderr?.resume();
		this.child.stdin?.on("error", (error) => this.fail(error));
		this.child.on("error", (error) => this.fail(new Error(`Could not start ${agent.label} ACP (${config.command ?? agent.command}). Install ${agent.package} and check the executable path. ${error.message}`)));
		this.child.on("exit", (code, signal) => this.fail(new Error(`${agent.label} ACP exited (${signal ?? code ?? "unknown"}). Check its installation and sign in with ${agent.login}.`)));
		this.lines = createInterface({ input: this.child.stdout! });
		this.lines.on("line", (line) => this.receive(line));
		this.abort = () => {
			if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
			this.fail(new DOMException("ACP request aborted", "AbortError"));
			void this.close();
		};
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private receive(line: string) {
		let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };
		try { message = JSON.parse(line); } catch { this.fail(new Error("ACP adapter sent invalid JSON on stdout")); return; }
		if (!message || typeof message !== "object") { this.fail(new Error("Invalid ACP response")); return; }
		if (message.method) {
			if (message.method === "_auth/status_update") {
				const status = message.params?.authStatus as { kind?: unknown } | undefined;
				if (typeof status?.kind === "string") {
					this.authKind = status.kind;
					this.authReady?.();
					if (this.subscriptionVerified && status.kind !== "account") {
						this.fail(new Error("ACP subscription sign-in changed. Reconnect with your subscription in Settings → Subscriptions."));
						void this.close();
					}
				}
				return;
			}
			if (message.method === "session/update") {
				const update = message.params?.update as { toolCallId?: string; rawInput?: { server?: string; tool?: string } } | undefined;
				if (update?.toolCallId && update.rawInput?.server === "learnharness" && this.applicationTools.includes(update.rawInput.tool ?? "")) this.applicationCallIds.add(update.toolCallId);
			}
			if (message.id !== undefined) {
				// MCP execution here only hands a request to the existing app loop.
				// Approve its registered tools once, never native coding operations.
				this.write(message.method === "session/request_permission"
					? { jsonrpc: "2.0", id: message.id, result: this.toolPermission(message.params ?? {}) }
					: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability not supported" } });
			} else {
				try { this.onNotification(message.method, message.params ?? {}); }
				catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
			}
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new Error(`ACP error ${message.error.code ?? ""}: ${message.error.message ?? "Request failed"}`));
		else pending.resolve(message.result);
	}
	private toolPermission(params: Record<string, unknown>) {
		const call = params.toolCall as { toolCallId?: string; _meta?: { claudeCode?: { toolName?: string; mcpServer?: { name?: string } } } } | undefined;
		const claude = call?._meta?.claudeCode;
		const knownClaude = (!claude?.mcpServer || claude.mcpServer.name === "learnharness") && this.applicationTools.some((name) => claude?.toolName === `mcp__learnharness__${name}`);
		const knownCodex = call?.toolCallId && this.applicationCallIds.has(call.toolCallId);
		const options = Array.isArray(params.options) ? params.options as { kind?: string; optionId?: string }[] : [];
		const allow = (knownClaude || knownCodex) ? options.find((option) => option.kind === "allow_once" && typeof option.optionId === "string") : undefined;
		return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
	}

	private write(message: unknown) {
		if (!this.closed && !this.child.stdin?.destroyed) this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}
	private fail(error: Error) {
		this.failure ??= error;
		this.authReady?.();
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
		this.pending.clear();
	}
	/** A retained prompt uses null only when its owner manages separate active
	 * and idle deadlines; ordinary RPCs keep their bounded default. */
	request<T>(method: string, params: unknown, timeoutMs: number | null = 60_000): Promise<T> {
		if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error("ACP connection closed"));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = timeoutMs === null ? undefined : setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ACP ${method} timed out. Check the adapter and its subscription sign-in.`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}
	notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
	async initialize(): Promise<AcpInitialization> {
		const result = await this.request<AcpInitialization>("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "learnharness", title: "LearnHarness", version: packageMetadata.version },
			clientCapabilities: {},
		});
		if (result?.protocolVersion !== 1) throw new Error("ACP adapter does not support protocol version 1");
		return result;
	}
	async newSession(params: Record<string, unknown>): Promise<AcpSession> {
		const session = await this.request<AcpSession>("session/new", { ...params, cwd: this.cwd });
		if (!session?.sessionId || typeof session.sessionId !== "string") throw new Error("ACP adapter returned no session ID");
		this.sessionId = session.sessionId;
		if (this.codex) {
			let verified: unknown;
			try { verified = JSON.parse(readFileSync(this.ephemeralAck, "utf8")); } catch { /* Refuse unsupported adapters before prompting. */ }
			if (!Array.isArray(verified) || !verified.includes(session.sessionId)) throw new Error("The Codex adapter did not confirm an ephemeral session. Use an adapter that honors CODEX_PATH; LearnHarness will not save its internal rounds as Codex chats.");
		}
		// The two maintained adapters report connection identity without
		// exposing credentials. Fail closed before inference, including when
		// an old adapter cannot distinguish subscription from saved API auth.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.authNotification, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
			if (this.failure) throw this.failure;
			if (this.authKind !== "account") throw new Error(this.authKind
				? `ACP reports ${this.authKind} authentication. A subscription account login is required; API billing is not used by this connection.`
				: "The ACP adapter did not report its authentication type. Update the adapter and sign in with your subscription.");
			this.subscriptionVerified = true;
		} finally { clearTimeout(timer); }
		return session;
	}

	close(): Promise<void> {
		return this.closing ??= this.dispose();
	}
	private async dispose(): Promise<void> {
		if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
		this.closed = true;
		this.signal?.removeEventListener("abort", this.abort);
		this.fail(new Error("ACP connection closed"));
		this.lines.close();
		this.child.stdout?.resume();
		this.child.stdin?.destroy();
		if (this.child.pid) {
			if (process.platform === "win32") {
				// EOF stops the worker; the keeper terminates its entire job.
				// Killing a stuck keeper also closes the kernel-owned job handle.
				await this.waitForChild(7000);
				if (!this.childClosed) { this.child.kill("SIGKILL"); await this.waitForChild(2000); }
			} else {
				try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill("SIGTERM"); }
				await this.waitForChild(1000);
				try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* The process group already exited. */ }
			}
		}
		this.child.stdout?.destroy();
		this.child.stderr?.destroy();
		if (path.dirname(this.cwd) === path.resolve(tmpdir()) && path.basename(this.cwd).startsWith("learnharness-acp-")) {
			try { rmSync(this.cwd, { recursive: true, force: true }); } catch { /* A CLI can briefly retain an open workspace handle. */ }
		}
	}
	private async waitForChild(timeout: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([this.childDone, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout); })]); }
		finally { clearTimeout(timer); }
	}
}
