import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { CodexStatus } from "../core/contracts/codex.ts";
import { emit } from "../core/events.ts";
import { connectCodex, getCodexBinary, type CodexClient } from "../agent/codex/client.ts";
import { codexModel, setCodexSource, type CodexModel } from "../agent/codex/provider.ts";
import { createCodexStream } from "../agent/codex/stream.ts";
import { settingsStore } from "../store/settings.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

export function codexEnabled(): boolean { return settingsStore.readSettings()?.codex?.enabled === true; }
export function safeCodexAuthUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try { const u = new URL(value); return u.protocol === "https:" && ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(u.hostname) && !u.username && !u.password && !u.port; } catch { return false; }
}

export class CodexOwner {
	private client?: CodexClient;
	private clients = new Set<CodexClient>();
	private pending?: Promise<void>;
	private login?: { id: string; url: string; expires: NodeJS.Timeout };
	private revision = 0;
	private refreshed = 0;
	private announcement = "";
	private status: CodexStatus = { enabled: false, state: "disabled", modelCount: 0 };
	private commands: Promise<unknown> = Promise.resolve();
	constructor(private readonly profile: string, private readonly enabled = codexEnabled, private readonly connect = connectCodex) {}
	snapshot(): CodexStatus {
		return this.enabled() ? { ...this.status, enabled: true, ...(this.login ? { state: "signing-in", authUrl: this.login.url } : {}) }
			: { enabled: false, state: "disabled", modelCount: 0 };
	}
	available(): boolean { return this.enabled() && this.status.state === "connected" && this.status.modelCount > 0; }
	private announce() {
		const status = this.snapshot();
		const next = JSON.stringify([status.enabled, status.state, status.modelCount]);
		if (next === this.announcement) return;
		this.announcement = next; emit("subscriptions-changed", {});
	}
	close() {
		this.revision++; this.refreshed = 0;
		if (this.login) clearTimeout(this.login.expires);
		this.login = undefined; this.client = undefined;
		for (const client of this.clients) client.close();
		this.clients.clear(); setCodexSource();
		this.status = { enabled: this.enabled(), state: this.enabled() ? "signed-out" : "disabled", modelCount: 0 };
		this.announce();
	}
	private async newClient(): Promise<CodexClient> {
		if (!this.enabled()) throw new Error("Codex is disabled.");
		initAuthEnv();
		const revision = this.revision;
		await mkdir(this.profile, { recursive: true, mode: 0o700 });
		const cwd = await mkdtemp(path.join(tmpdir(), "learnharness-codex-"));
		try {
			const client = await this.connect(this.profile, cwd);
			if (!this.enabled() || revision !== this.revision) { client.close(); throw new Error("Codex connection changed."); }
			this.clients.add(client);
			client.onMessage((event) => {
				if (event.method === "connection/closed") { this.clients.delete(client); void rm(cwd, { recursive: true, force: true }); }
			});
			return client;
		} catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
	}
	async refresh(force = false): Promise<void> {
		if (!this.enabled()) { this.close(); return; }
		if (this.pending) return this.pending;
		if (!force && !this.login && this.client?.alive && Date.now() - this.refreshed < 30_000) return;
		this.pending = this.inspect().finally(() => { this.pending = undefined; this.announce(); });
		return this.pending;
	}
	private async inspect() {
		const revision = this.revision;
		try {
			if (!this.client?.alive) this.client = await this.newClient();
			const client = this.client;
			const value = await client.request("account/read", { refreshToken: false });
			if (revision !== this.revision || !this.enabled()) return;
			if (value.account?.type !== "chatgpt") {
				setCodexSource(); this.status = { enabled: true, state: "signed-out", modelCount: 0 }; return;
			}
			const entries: CodexModel[] = [], cursors = new Set<string>();
			let cursor: string | undefined;
			do {
				const page = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
				if (!Array.isArray(page.data)) throw new Error("Invalid Codex model catalog.");
				entries.push(...page.data.filter((m: CodexModel) => !m.hidden && typeof m.model === "string" && Array.isArray(m.supportedReasoningEfforts)));
				cursor = page.nextCursor ?? undefined;
				if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error("Invalid Codex catalog pagination.");
				if (cursor) cursors.add(cursor);
			} while (cursor);
			if (revision !== this.revision || !this.enabled()) return;
			const models = [...new Map(entries.map((m) => [m.model, codexModel(m)])).values()];
			setCodexSource({ models, stream: createCodexStream(() => this.newClient()) });
			this.status = { enabled: true, state: "connected", modelCount: models.length }; this.refreshed = Date.now();
			if (this.login) clearTimeout(this.login.expires);
			this.login = undefined;
		} catch {
			if (revision !== this.revision) return;
			setCodexSource();
			this.status = { enabled: true, state: getCodexBinary() ? "error" : "not-found", modelCount: 0,
				error: "Codex is unavailable. Install or update the CLI (v0.163.0+), then check again." };
		}
	}
	control(op: "login" | "cancel" | "logout"): Promise<void> {
		const operation = this.commands.catch(() => {}).then(() => this.perform(op));
		this.commands = operation; return operation;
	}
	private async perform(op: "login" | "cancel" | "logout") {
		await this.refresh(true);
		if (!this.enabled() || !this.client?.alive) throw new Error("Codex is unavailable.");
		if (op === "logout") { await this.client.request("account/logout"); this.close(); return; }
		if (op === "cancel") {
			if (this.login) await this.client.request("account/login/cancel", { loginId: this.login.id });
			this.close(); return;
		}
		if (this.login || this.available()) return;
		const client = this.client, revision = this.revision;
		const result = await client.request("account/login/start", { type: "chatgpt" });
		if (revision !== this.revision || !this.enabled()) return;
		if (result.type !== "chatgpt" || typeof result.loginId !== "string" || !safeCodexAuthUrl(result.authUrl)) { this.close(); throw new Error("Invalid Codex sign-in action."); }
		const expires = setTimeout(() => { void this.control("cancel").catch(() => this.close()); }, 5 * 60_000); expires.unref();
		this.login = { id: result.loginId, url: result.authUrl, expires };
		this.announce();
		client.onMessage((message) => {
			if (message.method === "account/login/completed" && message.params?.loginId === this.login?.id) {
				clearTimeout(this.login!.expires); this.login = undefined; this.refreshed = 0;
				if (message.params.success) void this.refresh(true);
				else { this.status = { enabled: true, state: "signed-out", modelCount: 0, error: "Codex sign-in did not complete. Try again." }; this.announce(); }
			}
		});
	}
}

const key = Symbol.for("lh.codex.owner");
export function codexOwner(): CodexOwner {
	const global = globalThis as typeof globalThis & { [key]?: CodexOwner };
	return global[key] ??= new CodexOwner(path.join(path.dirname(AUTH_FILE), "codex-profile"));
}
export async function refreshCodexConnection() { if (codexEnabled()) { initAuthEnv(); await codexOwner().refresh(); } else codexOwner().close(); }
export function codexAvailable() { return codexOwner().available(); }

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function codexResponse(request: Request): Promise<Response> {
	const origin = subscriptionRequestOrigin(request), supplied = request.headers.get("origin");
	if (!origin || request.headers.get("x-learnharness-codex") !== "1" || request.headers.get("sec-fetch-site") === "cross-site"
		|| (request.method === "GET" ? supplied !== null && supplied !== origin : supplied !== origin)) {
		return Response.json({ error: "Codex controls require a same-origin LearnHarness request." }, { status: 403, headers: HEADERS });
	}
	const owner = codexOwner();
	try {
		if (request.method === "POST") {
			if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return Response.json({ error: "Expected JSON." }, { status: 415, headers: HEADERS });
			const body = await readBoundedJson(request, 1024) as { op?: string };
			if (!["enable", "disable", "login", "cancel", "logout", "refresh"].includes(body?.op ?? "")) return Response.json({ error: "Invalid Codex control." }, { status: 400, headers: HEADERS });
			if (body.op === "enable" || body.op === "disable") {
				const record = settingsStore.readSettings() ?? { version: 1 };
				settingsStore.writeSettings({ ...record, codex: { enabled: body.op === "enable" } });
				if (body.op === "disable") owner.close();
			} else if (body.op !== "refresh") await owner.control(body.op as "login" | "cancel" | "logout");
			if (body.op === "refresh") await owner.refresh(true);
		} else if (request.method !== "GET") return new Response(null, { status: 405, headers: HEADERS });
		await refreshCodexConnection();
		return Response.json(owner.snapshot(), { headers: HEADERS });
	} catch (error) {
		return Response.json({ error: "Codex connection could not be changed. Check the CLI and try again." }, { status: error instanceof CustomBodyLimitError ? 413 : 400, headers: HEADERS });
	}
}
