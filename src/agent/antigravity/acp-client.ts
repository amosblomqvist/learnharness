import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import packageMetadata from "../../../package.json" with { type: "json" };
import {
	ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS,
	ANTIGRAVITY_LOGOUT_TIMEOUT_MS,
	ANTIGRAVITY_OAUTH_TIMEOUT_MS,
	ANTIGRAVITY_SESSION_NEW_TIMEOUT_MS,
	ANTIGRAVITY_SET_CONFIG_TIMEOUT_MS,
} from "./constants.ts";
import {
	antigravityRuntimeArgs,
	compareSemver,
	type AntigravityRuntimeKind,
	type ResolvedAntigravityRuntime,
} from "./installation.ts";
import { touchAntigravityKeyringUnavailable } from "./profile.ts";

/** Terminates an ACP child cleanly via `stdin` EOF first, escalating directly
 *  to `SIGKILL` on timeout so `agy_acp_server` never emits noisy absl `SIGTERM`
 *  signal dumps. */
export async function terminateAcpProcess(
	child: ChildProcess,
	options: { eofGraceMs?: number; termGraceMs?: number; forceTerm?: boolean } = {},
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;

	const graceMs = options.forceTerm ? 50 : (options.eofGraceMs ?? 400);

	try {
		child.stdin?.end();
	} catch {
		// ignore
	}

	await new Promise<void>((resolve) => {
		let done = false;
		let reapTimer: NodeJS.Timeout | undefined;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(killTimer);
			if (reapTimer) clearTimeout(reapTimer);
			child.removeListener("close", finish);
			resolve();
		};
		child.once("close", finish);

		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {
					// ignore
				}
				reapTimer = setTimeout(finish, 300);
				reapTimer.unref();
				return;
			}
			finish();
		}, graceMs);
		killTimer.unref();
	});
}

export interface AcpClientInfo {
	name: string;
	version: string;
}

export interface AcpMcpHeader {
	name: string;
	value: string;
}

export interface AcpMcpServer {
	type: "http";
	name: string;
	url: string;
	headers: AcpMcpHeader[];
}

export type AcpPromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface AcpConfigOptionChoice {
	value: string;
	name?: string;
	description?: string;
	[key: string]: unknown;
}

export interface AcpConfigOptionGroup {
	group?: string;
	name?: string;
	options?: AcpConfigOptionChoice[];
	[key: string]: unknown;
}

export interface AcpConfigOption {
	id?: string;
	configId?: string;
	category?: string;
	name?: string;
	type?: string;
	currentValue?: unknown;
	value?: unknown;
	options?: Array<AcpConfigOptionChoice | AcpConfigOptionGroup>;
	availableValues?: Array<string | AcpConfigOptionChoice>;
	[key: string]: unknown;
}

export interface AcpInitializeResult {
	protocolVersion?: number;
	agentInfo?: { name?: string; title?: string; version?: string };
	agentCapabilities?: Record<string, unknown>;
	authMethods?: Array<{ id?: string; name?: string }>;
	[key: string]: unknown;
}

export interface AcpSessionNewParams {
	cwd: string;
	mcpServers?: AcpMcpServer[];
	systemPromptAppend?: string;
	disabledTools?: string[];
}

export interface AcpSessionLoadParams extends AcpSessionNewParams {
	sessionId: string;
}

export interface AcpSessionResumeParams extends AcpSessionNewParams {
	sessionId: string;
}

export interface AcpSessionNewResult {
	sessionId: string;
	configOptions?: AcpConfigOption[];
	[key: string]: unknown;
}

export interface AcpSetConfigOptionResult {
	configOptions?: AcpConfigOption[];
	[key: string]: unknown;
}

export interface AcpPromptUsage {
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	thoughtTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	[key: string]: unknown;
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | (string & {});

export interface AcpPromptResponse {
	stopReason?: AcpStopReason;
	usage?: AcpPromptUsage;
	[key: string]: unknown;
}

export interface AcpSessionUpdateChunk {
	sessionUpdate: "agent_thought_chunk" | "agent_message_chunk";
	content?: { type?: string; text?: string };
	[key: string]: unknown;
}

export interface AcpSessionToolUpdate {
	sessionUpdate: "tool_call" | "tool_call_update";
	toolCallId?: string;
	title?: string;
	status?: string;
	kind?: string;
	rawInput?: unknown;
	[key: string]: unknown;
}

export interface AcpSessionUsageUpdate {
	sessionUpdate: "usage_update";
	used?: number;
	size?: number;
	cost?: unknown;
	[key: string]: unknown;
}

export interface AcpSessionConfigOptionUpdate {
	sessionUpdate: "config_option_update";
	configOptions?: AcpConfigOption[];
	[key: string]: unknown;
}

export interface AcpSessionErrorUpdate {
	sessionUpdate: "error" | "state_update";
	error?: unknown;
	message?: unknown;
	[key: string]: unknown;
}

export type AcpSessionUpdate =
	| AcpSessionUpdateChunk
	| AcpSessionToolUpdate
	| AcpSessionUsageUpdate
	| AcpSessionConfigOptionUpdate
	| AcpSessionErrorUpdate
	| { sessionUpdate: string; [key: string]: unknown };

export interface AcpPermissionRequestParams {
	sessionId?: string;
	toolCall?: {
		toolCallId?: string;
		title?: string;
		kind?: string;
		_meta?: {
			is_mcp_tool_call?: unknown;
			mcp?: { server?: unknown; tool?: unknown };
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	options?: Array<{ optionId?: string; name?: string; kind?: string }>;
	[key: string]: unknown;
}

export class AcpRpcError extends Error {
	code?: number;
	data?: unknown;
	constructor(message: string, code?: number, data?: unknown) {
		super(message);
		this.name = "AcpRpcError";
		this.code = code;
		this.data = data;
	}
}

export class AcpTimeoutError extends Error {
	method: string;
	timeoutMs: number;
	constructor(method: string, timeoutMs: number) {
		super(`Antigravity ACP "${method}" timed out after ${timeoutMs}ms.`);
		this.name = "AcpTimeoutError";
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

export const ANTIGRAVITY_IPV6_ERROR_RE = /\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/i;

export function formatAntigravityError(
	message: string,
	stderrTail = "",
	platform: NodeJS.Platform = process.platform,
): string {
	const combined = `${message}\n${stderrTail}`;
	if (ANTIGRAVITY_IPV6_ERROR_RE.test(combined)) {
		const hint =
			platform === "linux"
				? "Antigravity failed on Linux because kernel IPv6 support is disabled (AF_INET6 / enforce_kernel_ipv6_support). Enable kernel IPv6 support and retry."
				: "Antigravity failed because kernel IPv6 support is disabled (AF_INET6 / enforce_kernel_ipv6_support). Enable kernel IPv6 support and retry.";
		return message.trim() ? `${hint} (${message.trim()})` : hint;
	}
	return message;
}

export function clientInfoForRuntime(runtime: Pick<ResolvedAntigravityRuntime, "version">): AcpClientInfo {
	if (!runtime.version || compareSemver(runtime.version, "1.5.1") < 0) {
		return { name: "zed", version: "0.0.0" };
	}
	return { name: "learnharness", version: packageMetadata.version };
}

type PendingRpc = {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
};

export interface CreateAcpClientOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	runtime: Pick<ResolvedAntigravityRuntime, "executablePath" | "args" | "version"> & {
		kind?: AntigravityRuntimeKind;
	};
	profileDir?: string;
	platform?: NodeJS.Platform;
	spawnProcess?: typeof spawn;
	onSessionUpdate?: (sessionId: string | undefined, update: AcpSessionUpdate) => void;
	onPermissionRequest?: (params: AcpPermissionRequestParams) => void;
	approvePermission?: (params: AcpPermissionRequestParams) => boolean;
	onStderrLine?: (line: string) => void;
	onClose?: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string) => void;
	onError?: (error: Error) => void;
}

export interface AcpClient {
	readonly child: ChildProcess;
	readonly stderrTail: () => string;
	readonly isClosed: () => boolean;
	initialize(timeoutMs?: number): Promise<AcpInitializeResult>;
	authenticate(methodId?: string, timeoutMs?: number): Promise<Record<string, unknown>>;
	logout(timeoutMs?: number): Promise<Record<string, unknown>>;
	sessionNew(params: AcpSessionNewParams, timeoutMs?: number): Promise<AcpSessionNewResult>;
	sessionLoad(params: AcpSessionLoadParams, timeoutMs?: number): Promise<AcpSessionNewResult>;
	sessionResume(params: AcpSessionResumeParams, timeoutMs?: number): Promise<AcpSessionNewResult>;
	setConfigOption(
		sessionId: string,
		configId: string,
		value: string,
		timeoutMs?: number,
	): Promise<AcpSetConfigOptionResult>;
	prompt(sessionId: string, prompt: AcpPromptBlock[], timeoutMs?: number): Promise<AcpPromptResponse>;
	cancel(sessionId: string): void;
	close(options?: { eofGraceMs?: number; termGraceMs?: number; forceTerm?: boolean }): Promise<void>;
}

export function buildAntigravitySessionMeta(params: Pick<AcpSessionNewParams, "disabledTools" | "systemPromptAppend">): {
	antigravity: {
		disabledTools: string[];
		systemPrompt?: { append: string };
	};
} {
	return {
		antigravity: {
			disabledTools: [...new Set([...(params.disabledTools ?? []), "run_workflow"])],
			...(params.systemPromptAppend !== undefined
				? { systemPrompt: { append: params.systemPromptAppend } }
				: {}),
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function spawnAcpClient(options: CreateAcpClientOptions): AcpClient {
	const spawnProcess = options.spawnProcess ?? spawn;
	const platform = options.platform ?? process.platform;
	const profileDir = options.profileDir ?? options.env.GEMINI_HOME;
	const runtimeKind: AntigravityRuntimeKind = options.runtime.kind ?? "acp-server";
	if (runtimeKind === "cli" && profileDir) {
		try {
			if (fs.existsSync(profileDir)) {
				touchAntigravityKeyringUnavailable(profileDir, platform);
			}
		} catch {
			// Best-effort refresh; do not block synthetic tests.
		}
	}
	const args = antigravityRuntimeArgs({ kind: runtimeKind, args: options.runtime.args }, profileDir);
	const child = spawnProcess(options.runtime.executablePath, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let nextId = 1;
	let closed = false;
	let stderr = "";
	const pending = new Map<number, PendingRpc>();

	const rejectAllPending = (errFactory: () => Error) => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(errFactory());
		}
	};

	const stdoutRl = child.stdout ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
	const stderrRl = child.stderr ? readline.createInterface({ input: child.stderr, crlfDelay: Infinity }) : null;

	const sendRaw = (payload: Record<string, unknown>, onWriteError?: (err: Error) => void): void => {
		if (closed || !child.stdin || child.stdin.destroyed) {
			onWriteError?.(new Error("Antigravity ACP process stdin is closed."));
			return;
		}
		const serialized = `${JSON.stringify(payload)}\n`;
		child.stdin.write(serialized, (err) => {
			if (err) {
				onWriteError?.(new Error(formatAntigravityError(`Failed sending ACP message: ${err.message}`, stderr, platform)));
			}
		});
	};

	const request = <T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
		if (closed) {
			return Promise.reject(new Error(formatAntigravityError(`Antigravity ACP process already closed before "${method}".`, stderr, platform)));
		}
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			const entry: PendingRpc = {
				method,
				resolve: (result) => resolve(result as T),
				reject,
			};
			if (typeof timeoutMs === "number" && timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					pending.delete(id);
					reject(new AcpTimeoutError(method, timeoutMs));
				}, timeoutMs);
				entry.timer.unref();
			}
			pending.set(id, entry);
			sendRaw({ jsonrpc: "2.0", id, method, params }, (err) => {
				if (!pending.has(id)) return;
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				reject(err);
			});
		});
	};

	const notify = (method: string, params: Record<string, unknown>): void => {
		sendRaw({ jsonrpc: "2.0", method, params });
	};

	const handleIncomingRequest = (id: string | number, method: string, params: Record<string, unknown> | undefined) => {
		if (method === "session/request_permission") {
			// Security boundary: LearnHarness owns tool admission via MCP; decline native/unapproved permissions.
			const permissionParams = (params ?? {}) as AcpPermissionRequestParams;
			try {
				options.onPermissionRequest?.(permissionParams);
			} catch {
				// Observer errors must never allow permission grants.
			}
			let approved = false;
			try {
				approved = options.approvePermission?.(permissionParams) === true;
			} catch {
				approved = false;
			}
			const allowOption = approved
				? (permissionParams.options?.find((o) => o?.kind === "allow_once" && typeof o.optionId === "string" && o.optionId.trim()) ??
					permissionParams.options?.find((o) => o?.kind === "allow_always" && typeof o.optionId === "string" && o.optionId.trim()))
				: undefined;
			sendRaw({
				jsonrpc: "2.0",
				id,
				result: allowOption?.optionId
					? { outcome: { outcome: "selected", optionId: allowOption.optionId } }
					: { outcome: { outcome: "cancelled" } },
			});
			return;
		}
		sendRaw({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `Unsupported client method: ${method}` },
		});
	};

	const handleNotification = (method: string, params: Record<string, unknown> | undefined) => {
		if (method !== "session/update" || !params) return;
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
		const updateCandidate = isPlainObject(params.update) ? params.update : params;
		if (typeof updateCandidate.sessionUpdate !== "string") return;
		options.onSessionUpdate?.(sessionId, updateCandidate as AcpSessionUpdate);
	};

	stdoutRl?.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg: unknown;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!isPlainObject(msg)) return;

		const hasId = typeof msg.id === "number" || typeof msg.id === "string";
		const hasMethod = typeof msg.method === "string";

		if (hasId && hasMethod) {
			handleIncomingRequest(msg.id as string | number, msg.method as string, isPlainObject(msg.params) ? msg.params : undefined);
			return;
		}

		if (!hasId && hasMethod) {
			handleNotification(msg.method as string, isPlainObject(msg.params) ? msg.params : undefined);
			return;
		}

		if (typeof msg.id === "number" && pending.has(msg.id)) {
			const entry = pending.get(msg.id)!;
			pending.delete(msg.id);
			if (entry.timer) clearTimeout(entry.timer);

			if (isPlainObject(msg.error)) {
				const rawMsg = typeof msg.error.message === "string" ? msg.error.message : `ACP ${entry.method} failed`;
				const code = typeof msg.error.code === "number" ? msg.error.code : undefined;
				entry.reject(new AcpRpcError(formatAntigravityError(rawMsg, stderr, platform), code, msg.error.data));
				return;
			}
			entry.resolve(msg.result ?? {});
		}
	});

	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderr = `${stderr}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(-65_536);
	});

	stderrRl?.on("line", (line) => {
		options.onStderrLine?.(line);
	});

	child.stdin?.on("error", () => {
		// Handled by per-request write callbacks and child close.
	});

	child.on("error", (err) => {
		const wrapped = new Error(formatAntigravityError(`Antigravity ACP process error: ${err.message}`, stderr, platform));
		rejectAllPending(() => wrapped);
		options.onError?.(wrapped);
	});

	child.on("close", (code, signal) => {
		if (closed) return;
		closed = true;
		stdoutRl?.close();
		stderrRl?.close();
		const detail = stderr.trim() ? `: ${stderr.trim().slice(-400)}` : "";
		const exitMessage = formatAntigravityError(
			`Antigravity ACP process exited (${signal ? `signal ${signal}` : `code ${code ?? "null"}`})${detail}`,
			stderr,
			platform,
		);
		rejectAllPending(() => new Error(exitMessage));
		options.onClose?.(code, signal, stderr);
	});

	return {
		child,
		stderrTail: () => stderr,
		isClosed: () => closed,
		initialize: (timeoutMs = ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS) =>
			request<AcpInitializeResult>(
				"initialize",
				{
					protocolVersion: 1,
					clientInfo: clientInfoForRuntime(options.runtime),
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
				},
				timeoutMs,
			),
		authenticate: (methodId = "oauth-personal", timeoutMs = ANTIGRAVITY_OAUTH_TIMEOUT_MS) =>
			request<Record<string, unknown>>("authenticate", { methodId }, timeoutMs),
		logout: (timeoutMs = ANTIGRAVITY_LOGOUT_TIMEOUT_MS) =>
			request<Record<string, unknown>>("logout", {}, timeoutMs),
		sessionNew: (params, timeoutMs = ANTIGRAVITY_SESSION_NEW_TIMEOUT_MS) =>
			request<AcpSessionNewResult>(
				"session/new",
				{
					cwd: params.cwd,
					mcpServers: params.mcpServers ?? [],
					_meta: buildAntigravitySessionMeta(params),
				},
				timeoutMs,
			),
		sessionLoad: (params, timeoutMs = ANTIGRAVITY_SESSION_NEW_TIMEOUT_MS) =>
			request<AcpSessionNewResult>(
				"session/load",
				{
					sessionId: params.sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers ?? [],
					_meta: buildAntigravitySessionMeta(params),
				},
				timeoutMs,
			),
		sessionResume: (params, timeoutMs = ANTIGRAVITY_SESSION_NEW_TIMEOUT_MS) =>
			request<AcpSessionNewResult>(
				"session/resume",
				{
					sessionId: params.sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers ?? [],
					_meta: buildAntigravitySessionMeta(params),
				},
				timeoutMs,
			),
		setConfigOption: (sessionId, configId, value, timeoutMs = ANTIGRAVITY_SET_CONFIG_TIMEOUT_MS) =>
			request<AcpSetConfigOptionResult>(
				"session/set_config_option",
				{ sessionId, configId, value },
				timeoutMs,
			),
		prompt: (sessionId, promptBlocks, timeoutMs) =>
			request<AcpPromptResponse>("session/prompt", { sessionId, prompt: promptBlocks }, timeoutMs),
		cancel: (sessionId) => {
			notify("session/cancel", { sessionId });
		},
		close: async (closeOptions) => {
			await terminateAcpProcess(child, closeOptions);
			stdoutRl?.close();
			stderrRl?.close();
		},
	};
}
