import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { externalCliEnv } from "../../core/auth-env.ts";

export function getCodexBinary(): string | null {
	const home = homedir();
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(home, ".local/bin"),
		"/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global/bin")];
	for (const dir of dirs) {
		const file = path.resolve(dir, process.platform === "win32" ? "codex.exe" : "codex");
		try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* next candidate */ }
	}
	return null;
}

export function codexEnv(profile: string): NodeJS.ProcessEnv {
	const env = externalCliEnv();
	// This connection is ChatGPT-authenticated. Never inherit an API billing route
	// or the parent Codex application's process/transport identity.
	for (const key of Object.keys(env)) {
		if (/^(CODEX_|OPENAI_|CHATGPT_)/.test(key)) delete env[key];
	}
	return { ...env, CODEX_HOME: profile };
}

export const CODEX_ARGS = ["app-server", "--listen", "stdio://",
	"-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"',
	"-c", 'model_provider="openai"', "-c", 'web_search="disabled"',
	"-c", "features.shell_tool=false", "-c", "features.apply_patch_freeform=false",
	"-c", "features.code_mode=false", "-c", "features.multi_agent=false",
	"-c", "features.apps=false", "-c", "features.shell_snapshot=false",
	"-c", 'history.persistence="none"', "-c", "project_doc_max_bytes=0"];

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: unknown };
export type CodexListener = (message: RpcMessage) => void;
export type SpawnCodex = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

/** Only the documented stdio JSON-RPC protocol crosses this boundary. */
export class CodexClient {
	private sequence = 0;
	private closed = false;
	private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	private listeners = new Set<CodexListener>();
	private readonly lines;
	constructor(private readonly child: ChildProcessWithoutNullStreams) {
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => {
			try {
				const message = JSON.parse(line) as RpcMessage;
				if (typeof message.id === "number" && !message.method) {
					const call = this.pending.get(message.id);
					if (call) {
						clearTimeout(call.timer); this.pending.delete(message.id);
						if (message.error) call.reject(new Error("Codex rejected the request. Update the CLI or reconnect in Providers."));
						else call.resolve(message.result);
					}
				} else for (const listener of this.listeners) listener(message);
			} catch { this.fail(); }
		});
		// Never log provider stderr: it can contain private request/credential data.
		child.stderr.resume();
		child.stdin.on("error", () => this.fail());
		child.once("error", () => this.fail());
		child.once("close", () => this.fail());
	}
	get alive() { return !this.closed; }
	onMessage(listener: CodexListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	notify(method: string, params: unknown = {}) { this.send({ method, params }); }
	request<T = any>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Codex connection closed."));
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex request timed out.")); }, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ id, method, params });
		});
	}
	private send(message: unknown) {
		if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	private fail() {
		if (this.closed) return;
		this.closed = true;
		for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("Codex connection closed.")); }
		this.pending.clear();
		for (const listener of this.listeners) listener({ method: "connection/closed" });
		this.lines.close();
	}
	close() {
		this.fail(); this.child.stdin.destroy(); this.child.kill("SIGTERM");
		const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 1000);
		timer.unref(); this.child.once("close", () => clearTimeout(timer));
	}
}

export async function connectCodex(profile: string, cwd: string, launch: SpawnCodex = spawn): Promise<CodexClient> {
	const binary = getCodexBinary();
	if (!binary) throw new Error("Codex CLI not found. Install @openai/codex, then check again.");
	const client = new CodexClient(launch(binary, [...CODEX_ARGS], { cwd, env: codexEnv(profile), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
	try {
		await client.request("initialize", { clientInfo: { name: "learnharness", title: "LearnHarness", version: "0.5.0" }, capabilities: { experimentalApi: true } });
		client.notify("initialized");
		return client;
	} catch (error) { client.close(); throw error; }
}
