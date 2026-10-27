/**
 * Local Claude route (2026-10-27): the server owner — detection of the
 * user's own Claude Code, the version gate, the no-prompt account probe,
 * the catalog join, the status owner and its HTTP controls. Offline by
 * law: a fake `query` through the SDK seam, fake binaries in a temp dir,
 * no real `claude` ever spawns (the sandbox's /opt binary is deliberately
 * out of every PATH these tests use).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-local-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { claudeChildEnv, claudeChildEnvAllows, CLAUDE_CHILD_CONTROLS } = await import("../src/agent/claude-local/env.ts");
const { claudeCommand, claudeLaunchOptions } = await import("../src/agent/claude-local/launch.ts");
const { setClaudeQueryForTests } = await import("../src/agent/claude-local/sdk.ts");
type ClaudeQuery = import("../src/agent/claude-local/sdk.ts").ClaudeQuery;
const bridge = await import("../src/agent/claude-local/bridge.ts");
const server = await import("../src/server/claude-local.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { modelCatalog, refreshConnectionCatalog, validateModelsSettings, validateChatSettings } = await import("../src/server/model-catalog.ts");
const { isSubscriptionProvider, subscriptionConnected, connectionBackgroundAllowed } = await import("../src/agent/subscription-connections.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { CLAUDE_LOCAL } = await import("../src/core/contracts/claude-local.ts");

const posix = process.platform !== "win32";
after(() => { setClaudeQueryForTests(undefined); fs.rmSync(directory, { recursive: true, force: true }); });

/** A fake install: an executable script that answers --version. */
function fakeBinary(dir: string, version = "2.1.311", name = "claude"): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
	return file;
}

type FakeQueryOptions = { account?: Record<string, unknown>; models?: Array<Record<string, unknown>>; reject?: Error; hang?: boolean };
/** A fake SDK query: records the options, answers the control requests,
 *  never spawns. The iterator ends when close() is called. */
function fakeQuery(fake: FakeQueryOptions = {}) {
	const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
	let closed = 0;
	const query = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
		calls.push({ prompt: params.prompt, options: params.options ?? {} });
		let finish!: () => void;
		const ended = new Promise<void>((resolve) => { finish = resolve; });
		const iterator = (async function* () { await ended; })();
		const handle = Object.assign(iterator, {
			accountInfo: async () => { if (fake.reject) throw fake.reject; if (fake.hang) await new Promise<never>(() => {}); return fake.account ?? {}; },
			supportedModels: async () => fake.models ?? [],
			close: () => { closed++; finish(); },
		});
		return handle;
	}) as unknown as ClaudeQuery;
	return { query, calls, get closed() { return closed; } };
}

describe("the child environment allowlist", () => {
	it("passes only HOME/PATH/config-dir/proxy/locale names and never any key, token, secret or app variable", () => {
		const env = claudeChildEnv({
			PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/home/u/.claude", HTTPS_PROXY: "http://proxy", LC_ALL: "C.UTF-8", XDG_CONFIG_HOME: "/x", NODE_ENV: "test",
			ANTHROPIC_API_KEY: "sk-ant-never", CLAUDE_CODE_OAUTH_TOKEN: "oat-never", OPENAI_API_KEY: "sk-never", LH_DESKTOP_API_SECRET: "s".repeat(64), LH_DATA_DIR: "/d", NODE_OPTIONS: "--x", DEBUG: "1", SOME_PASSWORD: "p", GITHUB_TOKEN: "t",
		}, { ELECTRON_RUN_AS_NODE: "1", LH_SNEAKY_KEY: "no" });
		assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/home/u/.claude", HTTPS_PROXY: "http://proxy", LC_ALL: "C.UTF-8", XDG_CONFIG_HOME: "/x", ...CLAUDE_CHILD_CONTROLS, ELECTRON_RUN_AS_NODE: "1" });
		for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "LH_DESKTOP_API_SECRET", "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY"]) assert.equal(claudeChildEnvAllows(name), false, name);
		assert.deepEqual(CLAUDE_CHILD_CONTROLS, { DISABLE_AUTO_COMPACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
	});
	it("launch options point the SDK at the detected install with the scrubbed env, the app cwd and a spawner that runs cli.js on our own runtime", () => {
		const native = claudeLaunchOptions({ path: "/opt/x/claude", viaNode: false, cwd: "/data/claude-local" }, { PATH: "/bin", ANTHROPIC_API_KEY: "never", NODE_ENV: "test" });
		assert.equal(native.pathToClaudeCodeExecutable, "/opt/x/claude"); assert.equal(native.executable, undefined); assert.equal(native.cwd, "/data/claude-local");
		assert.deepEqual(native.env, { PATH: "/bin", ...CLAUDE_CHILD_CONTROLS });
		const viaNode = claudeLaunchOptions({ path: "/g/cli.js", viaNode: true, cwd: "/data/claude-local" }, { PATH: "/bin", NODE_ENV: "test" });
		assert.equal(viaNode.executable, "node"); assert.equal(viaNode.env?.ELECTRON_RUN_AS_NODE, "1");
		assert.deepEqual(claudeCommand({ path: "/g/cli.js", viaNode: true }, "/app/electron"), { command: "/app/electron", args: ["/g/cli.js"], extraEnv: { ELECTRON_RUN_AS_NODE: "1" } });
		assert.deepEqual(claudeCommand({ path: "/opt/x/claude", viaNode: false }, "/app/electron"), { command: "/opt/x/claude", args: [], extraEnv: {} });
	});
});

describe("detection and the version gate", () => {
	it("finds the binary on PATH first, then known locations, then nothing; an override wins; symlinked cli.js runs through Node", { skip: !posix }, () => {
		const home = path.join(directory, "home1"); fs.mkdirSync(home, { recursive: true });
		const empty = path.join(directory, "empty"); fs.mkdirSync(empty, { recursive: true });
		assert.equal(server.detectClaudeBinary({ env: { PATH: empty } as unknown as NodeJS.ProcessEnv, home, platform: "linux" }), null);
		const known = fakeBinary(path.join(home, ".local", "bin"));
		assert.deepEqual(server.detectClaudeBinary({ env: { PATH: empty } as unknown as NodeJS.ProcessEnv, home, platform: "linux" }), { path: known, viaNode: false, source: "known-location" });
		const onPath = fakeBinary(path.join(directory, "bin1"));
		assert.deepEqual(server.detectClaudeBinary({ env: { PATH: `${empty}${path.delimiter}${path.dirname(onPath)}` } as unknown as NodeJS.ProcessEnv, home, platform: "linux" }), { path: onPath, viaNode: false, source: "path" });
		// npm global: a symlink to cli.js resolves to the JavaScript entry.
		const cli = path.join(directory, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, "// cli\n");
		const shim = path.join(directory, "npmbin", "claude"); fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.symlinkSync(cli, shim);
		assert.deepEqual(server.detectClaudeBinary({ override: shim }), { path: cli, viaNode: true, source: "override" });
		assert.equal(server.detectClaudeBinary({ override: path.join(directory, "missing", "claude") }), null);
		assert.equal(server.detectClaudeBinary({ override: directory }), null, "a directory is not an executable");
	});
	it("parses and compares versions against the one pinned floor", () => {
		assert.equal(server.parseClaudeVersion("2.1.311 (Claude Code)"), "2.1.311");
		assert.equal(server.parseClaudeVersion("garbage"), null);
		assert.equal(CLAUDE_LOCAL.minVersion, "2.1.248");
		assert.equal(server.versionSupported("2.1.248"), true); assert.equal(server.versionSupported("2.1.311"), true); assert.equal(server.versionSupported("3.0.0"), true);
		assert.equal(server.versionSupported("2.1.247"), false); assert.equal(server.versionSupported("2.0.999"), false); assert.equal(server.versionSupported("1.0.0"), false);
	});
	it("reads `claude --version` from the install with a bounded, scrubbed spawn", { skip: !posix }, async () => {
		assert.equal(await server.claudeVersion({ path: fakeBinary(path.join(directory, "bin2"), "2.1.300"), viaNode: false }), "2.1.300");
		assert.equal(await server.claudeVersion({ path: path.join(directory, "nope"), viaNode: false }), null);
	});
});

describe("the account probe", () => {
	it("classifies plan logins as ready and everything else as a recoverable non-ready state", () => {
		for (const plan of ["Pro", "max", "Claude Max", "team", "Enterprise"]) assert.equal(server.classifyAccount({ subscriptionType: plan, apiProvider: "firstParty" }).state, "ready", plan);
		assert.equal(server.classifyAccount({ subscriptionType: "Claude API", apiProvider: "firstParty" }).state, "api-key");
		assert.equal(server.classifyAccount({ subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }).state, "api-key");
		assert.equal(server.classifyAccount({ subscriptionType: "max", apiKeySource: "none", apiProvider: "firstParty" }).state, "ready");
		assert.equal(server.classifyAccount({ apiProvider: "bedrock" }).state, "third-party");
		assert.equal(server.classifyAccount({ apiProvider: "firstParty" }).state, "not-signed-in");
		assert.equal(server.classifyAccount(undefined).state, "not-signed-in");
	});
	it("asks accountInfo + supportedModels with a never-yielding prompt, isolation options and the scrubbed env, then closes the child", async () => {
		const fake = fakeQuery({ account: { subscriptionType: "max", apiProvider: "firstParty" }, models: [{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" }] });
		const launch = { path: "/opt/x/claude", viaNode: false, cwd: path.join(directory, "cwd") };
		const result = await server.probeAccount(fake.query, launch, 2000);
		assert.deepEqual(result.account, { subscriptionType: "max", apiProvider: "firstParty" });
		assert.equal(result.models.length, 1);
		assert.equal(fake.closed, 1);
		const options = fake.calls[0]!.options;
		assert.equal(typeof (fake.calls[0]!.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator], "function", "never a string prompt — nothing is ever sent to the model");
		assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []); assert.equal(options.persistSession, false); assert.equal(options.strictMcpConfig, true); assert.equal(options.systemPrompt, "");
		assert.equal(options.pathToClaudeCodeExecutable, "/opt/x/claude"); assert.equal(options.cwd, launch.cwd);
		const env = options.env as Record<string, string>;
		assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.LH_DATA_DIR, undefined); assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	});
	it("times out a silent child and surfaces a failed control request, closing either way", async () => {
		const hung = fakeQuery({ hang: true });
		await assert.rejects(server.probeAccount(hung.query, { path: "/x", viaNode: false, cwd: directory }, 50), /did not answer/);
		assert.equal(hung.closed, 1);
		const broken = fakeQuery({ reject: new Error("Not logged in · Please run /login") });
		await assert.rejects(server.probeAccount(broken.query, { path: "/x", viaNode: false, cwd: directory }, 2000), /Not logged in/);
		assert.equal(broken.closed, 1);
	});
	it("joins supportedModels() with pi-ai's Anthropic catalog: names and limits from the catalog, zero cost, provider relabelled, aliases collapsed, unknowns skipped", () => {
		const models = server.claudeLocalCatalog([
			{ value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)", description: "" },
			{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "" },
			{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "" },
			{ value: "future", resolvedModel: "claude-future-9", displayName: "Future", description: "" },
		]);
		assert.deepEqual(models.map((m) => m.id), ["claude-sonnet-5-5", "claude-opus-5-5"]);
		const opus = models[1]!;
		assert.equal(opus.provider, "claude-local"); assert.equal(opus.name, "Claude Opus 5.5"); assert.equal(opus.contextWindow, 1_000_000); assert.deepEqual(opus.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.ok(opus.reasoning); assert.deepEqual(opus.input, ["text", "image"]);
	});
});

describe("the status owner, the bridge and the catalog", () => {
	const route = (init?: RequestInit & { body?: string }) => new Request("http://localhost:3000/api/claude-local", { ...init, headers: { origin: "http://localhost:3000", "x-learnharness-subscriptions": "1", "content-type": "application/json", ...(init?.headers ?? {}) } });

	it("disabled by default: not a provider the picker offers, never probed, refused by the key gate", async () => {
		const fake = fakeQuery();
		setClaudeQueryForTests(fake.query);
		writeSettings({ version: 1 });
		const status = await server.refreshClaudeLocal({ force: true });
		assert.equal(status.state, "disabled"); assert.equal(fake.calls.length, 0);
		assert.equal(subscriptionConnected("claude-local"), false); assert.equal(providerKeyPresent("claude-local"), false);
		assert.ok(isSubscriptionProvider("claude-local"));
		assert.equal(modelCatalog().providers.find((p) => p.id === "claude-local")?.keyPresent, false);
		assert.equal(modelCatalog().models.some((m) => m.provider === "claude-local"), false);
	});
	it("enabled with no install: a recoverable not-found with the right wording; a bad explicit path names the path", { skip: !posix }, async () => {
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: path.join(directory, "missing", "claude") } });
		const status = await server.refreshClaudeLocal({ force: true });
		assert.equal(status.state, "not-found"); assert.match(status.error ?? "", /No Claude Code executable at .*missing/);
		assert.equal(status.binary, null); assert.equal(subscriptionConnected("claude-local"), false);
	});
	it("an old install is refused by version with the floor named", { skip: !posix }, async () => {
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "old"), "2.0.9") } });
		const status = await server.refreshClaudeLocal({ force: true });
		assert.equal(status.state, "unsupported-version"); assert.match(status.error ?? "", /2\.0\.9 is older than the required 2\.1\.248/);
		assert.equal(status.binary?.version, "2.0.9");
	});
	it("a plan login becomes ready: models federate into the picker, scopes pin the revision, consent gates background use, the HTTP controls answer", { skip: !posix }, async () => {
		const fake = fakeQuery({ account: { subscriptionType: "max", apiProvider: "firstParty" }, models: [{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" }, { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" }] });
		setClaudeQueryForTests(fake.query);
		const binary = fakeBinary(path.join(directory, "good"));
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary } });
		const status = await server.refreshClaudeLocal({ force: true });
		assert.equal(status.state, "ready", status.error); assert.equal(status.models, 2); assert.deepEqual(status.account, { subscriptionType: "max", apiProvider: "firstParty" });
		assert.equal(status.binary?.source, "override"); assert.equal(status.binary?.version, "2.1.311");
		assert.ok(subscriptionConnected("claude-local")); assert.ok(providerKeyPresent("claude-local")); assert.ok(connectionBackgroundAllowed("claude-local"));
		assert.ok(bridge.claudeLocalLaunch()?.path.endsWith("good/claude"));
		assert.ok(JSON.stringify(status).includes('"subscriptionType":"max"') && !JSON.stringify(status).includes("email"));
		// The catalog federates the models under the route's provider.
		const catalog = modelCatalog();
		assert.ok(catalog.providers.find((p) => p.id === "claude-local")?.keyPresent);
		assert.deepEqual(catalog.models.filter((m) => m.provider === "claude-local").map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);
		assert.equal(validateModelsSettings({ strong: { model: { provider: "claude-local", id: "claude-opus-5-5" } } }).ok, true);
		assert.equal(validateModelsSettings({ strong: { model: { provider: "claude-local", id: "claude-nope" } } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "claude-local", id: "claude-sonnet-5-5" } }).ok, true);
		// Scope + admission: pinned to the revision; a re-probe that changes nothing keeps it current.
		const scope = bridge.claudeLocalScope("claude-opus-5-5");
		assert.ok(bridge.claudeLocalScopeCurrent(scope)); assert.ok(bridge.claudeLocalAdmissionCurrent(bridge.claudeLocalAdmissionScope(scope)));
		assert.throws(() => bridge.claudeLocalScope("claude-nope"));
		// A cached refresh within the TTL re-probes nothing.
		const probes = fake.calls.length;
		await refreshConnectionCatalog("claude-local"); await refreshConnectionCatalog();
		assert.equal(fake.calls.length, probes, "the pre-turn and picker refreshes ride the cache");
		// HTTP: GET answers the status, POST probe re-runs, foreign origins are refused.
		const get = await server.claudeLocalControlsResponse(route());
		assert.equal(get.status, 200); assert.equal((await get.json()).state, "ready");
		const probe = await server.claudeLocalControlsResponse(route({ method: "POST", body: JSON.stringify({ op: "probe" }) }));
		assert.equal(probe.status, 200); assert.equal(fake.calls.length, probes + 1);
		assert.equal((await server.claudeLocalControlsResponse(route({ method: "POST", body: JSON.stringify({ op: "login" }) }))).status, 400);
		assert.equal((await server.claudeLocalControlsResponse(new Request("http://localhost:3000/api/claude-local", { headers: { origin: "https://evil.invalid", "x-learnharness-subscriptions": "1" } }))).status, 403);
		// Background consent OFF: background runs abort, foreground stays; the scope stays current (same revision — consent is not catalog authority).
		const background = bridge.claudeLocalAbortController(true), foreground = bridge.claudeLocalAbortController(false);
		try {
			writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary, allowBackgroundUse: false } });
			server.invalidateClaudeLocal();
			await server.refreshClaudeLocal();
			assert.ok(background.controller.signal.aborted); assert.ok(!foreground.controller.signal.aborted);
			assert.equal(connectionBackgroundAllowed("claude-local"), false);
			assert.equal(bridge.claudeLocalDenial(scope, background.controller, false, true), "background");
		} finally { background.release(); foreground.release(); }
		// Disabling aborts everything and empties the catalog.
		const live = bridge.claudeLocalAbortController(false);
		try {
			writeSettings({ version: 1, claudeLocal: { enabled: false } });
			server.invalidateClaudeLocal();
			const off = await server.refreshClaudeLocal();
			assert.equal(off.state, "disabled"); assert.ok(live.controller.signal.aborted);
			assert.equal(bridge.claudeLocalModels().length, 0); assert.equal(bridge.claudeLocalScopeCurrent(scope), false);
		} finally { live.release(); }
	});
	it("an API-key or Console login is refused with accurate wording and stays recoverable", { skip: !posix }, async () => {
		setClaudeQueryForTests(fakeQuery({ account: { subscriptionType: "Claude API", apiProvider: "firstParty" } }).query);
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "api")) } });
		const status = await server.refreshClaudeLocal({ force: true });
		assert.equal(status.state, "api-key"); assert.match(status.error ?? "", /Console.*Claude plan login/);
		assert.equal(subscriptionConnected("claude-local"), false);
		setClaudeQueryForTests(fakeQuery({ reject: new Error("spawn ENOENT") }).query);
		const broken = await server.refreshClaudeLocal({ force: true });
		assert.equal(broken.state, "unavailable"); assert.match(broken.error ?? "", /could not be started/);
		setClaudeQueryForTests(fakeQuery({ reject: new Error("Please run /login first") }).query);
		const loggedOut = await server.refreshClaudeLocal({ force: true });
		assert.equal(loggedOut.state, "not-signed-in"); assert.match(loggedOut.error ?? "", /sign in with your Claude plan/);
	});
});
