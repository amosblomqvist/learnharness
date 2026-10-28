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

// Canonical from the start: detection reports a cli.js by its realpath, and
// os.tmpdir() can sit under a symlink (macOS: /var → /private/var).
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-local-")));
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
const { piModels } = await import("../src/agent/models.ts");

const posix = process.platform !== "win32";
/** An empty system root: the host's own Claude Code (Homebrew, /usr/local) never decides a detection test. */
const hostless = path.join(directory, "system-root");
after(() => { setClaudeQueryForTests(undefined); fs.rmSync(directory, { recursive: true, force: true }); });

/** A fake install: an executable script that answers --version. */
function fakeBinary(dir: string, version = "2.1.311", name = "claude"): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
	return file;
}

type FakeQueryOptions = {
	account?: Record<string, unknown>; models?: Array<Record<string, unknown>>; reject?: Error; hang?: boolean; gate?: Promise<void>;
	/** Messages the iterator yields first (e.g. the zeroed result a startup failure writes), before a `reject`. */
	yields?: unknown[];
};
/** A fake SDK query: records the options, answers the control requests,
 *  never spawns. The iterator ends when close() is called. */
function fakeQuery(fake: FakeQueryOptions = {}) {
	const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
	let closed = 0;
	const query = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
		calls.push({ prompt: params.prompt, options: params.options ?? {} });
		let finish!: () => void;
		const ended = new Promise<void>((resolve) => { finish = resolve; });
		const iterator = (async function* () { yield* (fake.yields ?? []); await ended; })();
		const handle = Object.assign(iterator, {
			accountInfo: async () => { if (fake.gate) await fake.gate; if (fake.yields) await new Promise((resolve) => setTimeout(resolve, 10)); if (fake.reject) throw fake.reject; if (fake.hang) await new Promise<never>(() => {}); return fake.account ?? {}; },
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
		assert.equal(server.detectClaudeBinary({ env: { PATH: empty } as unknown as NodeJS.ProcessEnv, home, platform: "linux", systemRoot: hostless }), null);
		const known = fakeBinary(path.join(home, ".local", "bin"));
		assert.deepEqual(server.detectClaudeBinary({ env: { PATH: empty } as unknown as NodeJS.ProcessEnv, home, platform: "linux", systemRoot: hostless }), { path: known, viaNode: false, source: "known-location" });
		const onPath = fakeBinary(path.join(directory, "bin1"));
		assert.deepEqual(server.detectClaudeBinary({ env: { PATH: `${empty}${path.delimiter}${path.dirname(onPath)}` } as unknown as NodeJS.ProcessEnv, home, platform: "linux", systemRoot: hostless }), { path: onPath, viaNode: false, source: "path" });
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
		assert.equal(status.binaryPath, path.join(directory, "missing", "claude"), "the saved override is reported even when nothing is there (review P2)");
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

// ─── review fixes (S1, S5–S10, S12, N0–N0d, N4) ─────────────────────────────

/** An SDK-shaped error: the SDK stamps `errorClass` (and `exitCode`) on its own errors. */
const sdkError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const PLAN = { subscriptionType: "max", apiProvider: "firstParty" };
/** A bare id pi-ai's Anthropic catalog knows (picked at runtime, never named here). */
const knownId = (): string => piModels().getModels("anthropic").map((m) => m.id).find((id) => !/-\d{8}$|\[1m\]$/i.test(id))!;
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function readyRoute(dir: string, fake = fakeQuery({ account: PLAN, models: [{ value: "x", resolvedModel: knownId(), displayName: "X" }] })) {
	setClaudeQueryForTests(fake.query);
	const binary = fakeBinary(path.join(directory, dir));
	writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary } });
	const status = await server.refreshClaudeLocal({ force: true });
	assert.equal(status.state, "ready", status.error);
	return { fake, binary, status };
}

describe("review fixes: detection, the version gate and the probe", () => {
	it("S12: a native install's symlink is the launch path (its versioned target is only classified)", { skip: !posix }, () => {
		const target = fakeBinary(path.join(directory, "s12", "versions"), "2.1.311", "2.1.311");
		const link = path.join(directory, "s12", "bin", "claude"); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(target, link);
		assert.deepEqual(server.detectClaudeBinary({ override: link }), { path: link, viaNode: false, source: "override" });
	});
	it("N0c: exactly the SDK's script extensions (case-sensitive) run through Node", { skip: !posix }, () => {
		const dir = path.join(directory, "n0c"); fs.mkdirSync(dir, { recursive: true });
		const write = (name: string) => { const file = path.join(dir, name); fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 }); return file; };
		assert.equal(server.detectClaudeBinary({ override: write("cli.cjs") })?.viaNode, false);
		assert.equal(server.detectClaudeBinary({ override: write("CLI.JS") })?.viaNode, false);
		assert.equal(server.detectClaudeBinary({ override: write("cli.ts") })?.viaNode, true);
		assert.equal(server.detectClaudeBinary({ override: write("cli.mjs") })?.viaNode, true);
	});
	it("N0d: a non-executable `claude` earlier on PATH is skipped and the search continues", { skip: !posix }, () => {
		const blocked = path.join(directory, "n0d-a"); fs.mkdirSync(blocked, { recursive: true });
		fs.writeFileSync(path.join(blocked, "claude"), "not a program\n", { mode: 0o644 });
		const good = fakeBinary(path.join(directory, "n0d-b"));
		const home = path.join(directory, "n0d-home"); fs.mkdirSync(home, { recursive: true });
		assert.deepEqual(server.detectClaudeBinary({ env: { PATH: `${blocked}${path.delimiter}${path.dirname(good)}` } as unknown as NodeJS.ProcessEnv, home, platform: "linux", systemRoot: hostless }), { path: good, viaNode: false, source: "path" });
		assert.equal(server.detectClaudeBinary({ override: path.join(blocked, "claude") }), null);
	});
	it("N0: a spawn that throws synchronously resolves null instead of rejecting", async () => {
		assert.equal(await server.claudeVersion({ path: "/no\0such/claude", viaNode: false }), null);
	});
	it("S10: --version settles on close (stdout drained), not on exit", { skip: !posix }, async () => {
		const file = path.join(directory, "s10", "claude"); fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '#!/bin/sh\n(sleep 0.3; echo "2.1.300 (Claude Code)") &\nexit 0\n', { mode: 0o755 });
		assert.equal(await server.claudeVersion({ path: file, viaNode: false }), "2.1.300");
	});
	it("N4: --version output is read up to 4 KB only", { skip: !posix }, async () => {
		const file = path.join(directory, "n4", "claude"); fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '#!/bin/sh\nhead -c 8192 /dev/zero | tr "\\000" x\necho\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
		assert.equal(await server.claudeVersion({ path: file, viaNode: false }), null);
	});
	it("S7: the probe's silent prompt ends with the probe (no pending generator left behind)", async () => {
		const fake = fakeQuery({ account: PLAN });
		await server.probeAccount(fake.query, { path: "/x", viaNode: false, cwd: directory }, 2000);
		const prompt = fake.calls[0]!.prompt as AsyncGenerator<never>;
		const next = await Promise.race([prompt.next(), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200))]);
		assert.deepEqual(next, { done: true, value: undefined });
	});
	it("N0b + S6: failures classify on the SDK's error class, the stderr tail never reaches the status, a silent exit 1 reads as not signed in", { skip: !posix }, async () => {
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "n0b")) } });
		setClaudeQueryForTests(fakeQuery({ reject: sdkError("Claude Code process exited with code 2. stderr: oauth refresh failed for someone", { errorClass: "process_exited_nonzero", exitCode: 2 }) }).query);
		const crashed = await server.refreshClaudeLocal({ force: true });
		assert.equal(crashed.state, "unavailable"); assert.match(crashed.error ?? "", /could not be started\. .*\(exit code 2\)$/); assert.doesNotMatch(crashed.error ?? "", /stderr|oauth|someone/);
		setClaudeQueryForTests(fakeQuery({ reject: new Error("Unexpected token < in JSON at position 0") }).query);
		assert.equal((await server.refreshClaudeLocal({ force: true })).state, "unavailable");
		setClaudeQueryForTests(fakeQuery({ reject: sdkError("Claude Code process exited with code 1", { errorClass: "process_exited_nonzero", exitCode: 1 }) }).query);
		const silent = await server.refreshClaudeLocal({ force: true });
		assert.equal(silent.state, "not-signed-in"); assert.match(silent.error ?? "", /probably not signed in, or it could not start/);
	});
	it("S5: dated and [1m] ids join on the bare catalog id and keep Claude Code's id; unknown ids are reported, never invented", { skip: !posix }, async () => {
		const bare = knownId();
		const rows = [{ value: "a", resolvedModel: `${bare}-20261001`, displayName: "A", description: "" }, { value: "b", resolvedModel: `${bare}[1m]`, displayName: "B", description: "" }, { value: "c", resolvedModel: "unknown-model-x", displayName: "C", description: "" }];
		const skipped: string[] = [];
		const catalog = server.claudeLocalCatalog(rows, skipped);
		assert.deepEqual(catalog.map((m) => m.id), [`${bare}-20261001`, `${bare}[1m]`]);
		assert.equal(catalog[0]!.contextWindow, piModels().getModels("anthropic").find((m) => m.id === bare)!.contextWindow);
		assert.deepEqual(skipped, ["unknown-model-x"]);
		const { status } = await readyRoute("s5", fakeQuery({ account: PLAN, models: rows }));
		assert.equal(status.models, 2); assert.deepEqual(status.skippedModels, ["unknown-model-x"]);
		setClaudeQueryForTests(fakeQuery({ account: PLAN, models: [rows[2]!] }).query);
		const none = await server.refreshClaudeLocal({ force: true });
		assert.equal(none.state, "unavailable"); assert.match(none.error ?? "", /skipped: unknown-model-x/);
	});
});

describe("review fixes: the status owner", () => {
	const route = () => new Request("http://localhost:3000/api/claude-local", { headers: { origin: "http://localhost:3000", "x-learnharness-subscriptions": "1" } });

	it("S1: a transient probe failure keeps the last ready status, its revision and live runs; Re-check or a definitive verdict demotes", { skip: !posix }, async () => {
		const { status: ready } = await readyRoute("s1a");
		const live = bridge.claudeLocalAbortController(false);
		try {
			const flaky = fakeQuery({ reject: sdkError("Claude Code did not finish initializing", { errorClass: "initialize_timeout" }) });
			setClaudeQueryForTests(flaky.query);
			const kept = await server.refreshClaudeLocal({ maxAgeMs: 0 });
			assert.equal(flaky.calls.length, 1, "the stale status re-probed");
			assert.equal(kept.state, "ready"); assert.equal(kept.revision, ready.revision);
			assert.ok(!live.controller.signal.aborted); assert.ok(bridge.claudeLocalConnected());
			const demoted = await server.refreshClaudeLocal({ force: true });
			assert.equal(demoted.state, "unavailable"); assert.ok(live.controller.signal.aborted);
		} finally { live.release(); }
		await readyRoute("s1a");
		setClaudeQueryForTests(fakeQuery({ account: { subscriptionType: "Claude API", apiProvider: "firstParty" } }).query);
		assert.equal((await server.refreshClaudeLocal({ maxAgeMs: 0 })).state, "api-key", "a definitive verdict replaces ready without force");
	});
	it("S1 + N3: the pre-turn refresh never re-probes; the picker waits an hour, the card five minutes", { skip: !posix }, async () => {
		const { fake } = await readyRoute("s1b");
		const realNow = Date.now;
		try {
			const before = fake.calls.length;
			Date.now = () => realNow() + 6 * 60_000;
			await refreshConnectionCatalog("claude-local");
			assert.equal(fake.calls.length, before, "the pre-turn path admits on the cached snapshot");
			await refreshConnectionCatalog();
			assert.equal(fake.calls.length, before, "the picker's TTL is longer");
			assert.equal((await server.claudeLocalControlsResponse(route())).status, 200);
			assert.equal(fake.calls.length, before + 1, "the card's status read re-probes after five minutes");
			Date.now = () => realNow() + 61 * 60_000;
			await refreshConnectionCatalog("claude-local");
			assert.equal(fake.calls.length, before + 1);
			await refreshConnectionCatalog();
			assert.equal(fake.calls.length, before + 2, "the picker re-probes after an hour");
		} finally { Date.now = realNow; }
	});
	it("S8: of two overlapping probes only the latest applies; a slow older one never undoes a newer verdict or 'off'", { skip: !posix }, async () => {
		let release!: () => void;
		const slow = fakeQuery({ account: PLAN, models: [{ value: "x", resolvedModel: knownId(), displayName: "X" }], gate: new Promise<void>((resolve) => { release = resolve; }) });
		setClaudeQueryForTests(slow.query);
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "s8a")) } });
		const older = server.refreshClaudeLocal({ force: true });
		await until(() => slow.calls.length === 1);
		setClaudeQueryForTests(fakeQuery({ account: { subscriptionType: "Claude API", apiProvider: "firstParty" } }).query);
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "s8b")) } });
		assert.equal((await server.refreshClaudeLocal()).state, "api-key");
		release(); await older;
		assert.equal(server.claudeLocalStatusNow().state, "api-key"); assert.equal(bridge.claudeLocalConnected(), false);
		// Turned off while a probe is in flight: off wins.
		let release2!: () => void;
		const slow2 = fakeQuery({ account: PLAN, models: [{ value: "x", resolvedModel: knownId(), displayName: "X" }], gate: new Promise<void>((resolve) => { release2 = resolve; }) });
		setClaudeQueryForTests(slow2.query);
		const pending = server.refreshClaudeLocal({ force: true });
		await until(() => slow2.calls.length === 1);
		writeSettings({ version: 1, claudeLocal: { enabled: false } });
		server.invalidateClaudeLocal();
		release2(); await pending;
		assert.equal(server.claudeLocalStatusNow().state, "disabled"); assert.equal(bridge.claudeLocalConnected(), false);
	});
	it("S9: consent and the prompt mode apply on the write with no probe and no new revision; off makes the bridge not-ready at once", { skip: !posix }, async () => {
		const { fake, binary, status: ready } = await readyRoute("s9");
		const calls = fake.calls.length;
		const background = bridge.claudeLocalAbortController(true), foreground = bridge.claudeLocalAbortController(false);
		try {
			writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary, allowBackgroundUse: false, systemPromptMode: "preset" } });
			server.invalidateClaudeLocal();
			assert.equal(bridge.claudeLocalBackgroundAllowed(), false); assert.equal(bridge.claudeLocalSystemPromptMode(), "preset");
			assert.ok(background.controller.signal.aborted); assert.ok(!foreground.controller.signal.aborted);
			const after = await server.refreshClaudeLocal();
			assert.equal(fake.calls.length, calls, "no re-probe"); assert.equal(after.revision, ready.revision); assert.equal(after.allowBackgroundUse, false);
			writeSettings({ version: 1, claudeLocal: { enabled: false } });
			server.invalidateClaudeLocal();
			assert.equal(bridge.claudeLocalConnected(), false); assert.ok(foreground.controller.signal.aborted);
			assert.equal(server.claudeLocalStatusNow().state, "disabled"); assert.equal(bridge.claudeLocalModels().length, 0);
			assert.equal(fake.calls.length, calls);
		} finally { background.release(); foreground.release(); }
	});
	it("S1: the pre-turn refresh probes once when the route was turned on without the card (a settings change), then admits on the cache", { skip: !posix }, async () => {
		const { fake, binary } = await readyRoute("s1c");
		writeSettings({ version: 1, claudeLocal: { enabled: false } });
		server.invalidateClaudeLocal();
		assert.equal(bridge.claudeLocalConnected(), false);
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary } });
		server.invalidateClaudeLocal();
		const calls = fake.calls.length;
		await refreshConnectionCatalog("claude-local");
		assert.equal(fake.calls.length, calls + 1, "the settings changed since the last probe: the turn's refresh probes");
		assert.equal(bridge.claudeLocalConnected(), true);
		await refreshConnectionCatalog("claude-local");
		assert.equal(fake.calls.length, calls + 1, "and then admits on the cached snapshot");
	});
	it("S12: an in-place update of the same install (a new version) keeps the revision", { skip: !posix }, async () => {
		const { status: ready } = await readyRoute("s12b");
		fakeBinary(path.join(directory, "s12b"), "2.1.312");
		const updated = await server.refreshClaudeLocal({ force: true });
		assert.equal(updated.binary?.version, "2.1.312"); assert.equal(updated.revision, ready.revision);
	});
});

describe("external review (P1, P2)", () => {
	it("P2 hermetic detection: the system locations sit under the injected root, so only that root's install is found", { skip: !posix }, () => {
		const root = path.join(directory, "system-root-2"); const home = path.join(directory, "home-hermetic"); fs.mkdirSync(home, { recursive: true });
		const empty = path.join(directory, "empty-hermetic"); fs.mkdirSync(empty, { recursive: true });
		const env = { PATH: empty } as unknown as NodeJS.ProcessEnv;
		assert.equal(server.detectClaudeBinary({ env, home, platform: "linux", systemRoot: root }), null);
		const brew = fakeBinary(path.join(root, "opt", "homebrew", "bin"));
		assert.deepEqual(server.detectClaudeBinary({ env, home, platform: "darwin", systemRoot: root }), { path: brew, viaNode: false, source: "known-location" });
		assert.ok(server.knownClaudeLocations("darwin", "/Users/u", {} as NodeJS.ProcessEnv).includes("/opt/homebrew/bin/claude"), "production still looks at the real Homebrew prefix");
	});

	it("P1: a rejected SDK import is not cached — the next load retries it", async () => {
		const { loadClaudeQuery } = await import("../src/agent/claude-local/sdk.ts");
		setClaudeQueryForTests(undefined);
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("lh.claudeLocal.sdk")];
		let attempts = 0;
		const fake = (() => undefined) as unknown as ClaudeQuery;
		const load = async () => { attempts++; if (attempts === 1) throw new Error("Cannot find module './sdk-chunk.mjs'"); return { query: fake }; };
		await assert.rejects(loadClaudeQuery(load), /Cannot find module/);
		assert.equal(await loadClaudeQuery(load), fake, "the second load retried the import");
		assert.equal(await loadClaudeQuery(load), fake);
		assert.equal(attempts, 2, "a resolved import stays cached");
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("lh.claudeLocal.sdk")];
	});
});

describe("external review: the probe never logs the child's stderr (P1)", () => {
	it("a probe failure whose SDK error carries a stderr tail logs only the part before it", { skip: !posix }, async () => {
		const SECRET = "sk-ant-oat01-NEVER-LOG-THIS";
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "p1-stderr")) } });
		const failing = Object.assign(new Error(`Claude Code process exited with code 2. stderr: oauth refresh failed: ${SECRET}`), { errorClass: "process_exited_nonzero", exitCode: 2 });
		setClaudeQueryForTests(fakeQuery({ reject: failing }).query);
		const lines: string[] = [];
		const original = { error: console.error, info: console.info, warn: console.warn, log: console.log };
		const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
		Object.assign(console, { error: capture, info: capture, warn: capture, log: capture });
		let status;
		try { status = await server.refreshClaudeLocal({ force: true }); } finally { Object.assign(console, original); }
		assert.equal(status.state, "unavailable");
		const logged = lines.join("\n");
		assert.match(logged, /probe failed: process_exited_nonzero, exit code 2/);
		assert.ok(!logged.includes(SECRET) && !logged.includes("oauth refresh"), logged);
		assert.ok(!JSON.stringify(status).includes(SECRET));
		assert.equal(server.claudeLocalStatusNow().error?.includes(SECRET), false);
	});
});

describe("external review: the owner adopts a turn's API-key verdict (P2)", () => {
	it("after a turn's init reports an API key, neither a transient probe failure nor a consent toggle re-advertises ready; a successful probe re-admits", { skip: !posix }, async () => {
		const { status: ready, binary } = await readyRoute("p2-key");
		bridge.noteClaudeLocalApiKeySource("ANTHROPIC_API_KEY");
		assert.equal(server.claudeLocalStatusNow().state, "api-key");
		setClaudeQueryForTests(fakeQuery({ reject: sdkError("Claude Code did not finish initializing", { errorClass: "initialize_timeout" }) }).query);
		const after = await server.refreshClaudeLocal({ maxAgeMs: 0 });
		assert.notEqual(after.state, "ready", "a transient failure never restores a ready the turn disproved");
		assert.equal(bridge.claudeLocalConnected(), false); assert.deepEqual(bridge.claudeLocalModels(), []);
		// The in-place consent path.
		await readyRoute("p2-key");
		bridge.noteClaudeLocalApiKeySource("apiKeyHelper");
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: binary, allowBackgroundUse: false } });
		server.invalidateClaudeLocal();
		assert.equal(server.claudeLocalStatusNow().state, "api-key"); assert.equal(server.claudeLocalStatusNow().allowBackgroundUse, false);
		assert.equal(bridge.claudeLocalConnected(), false);
		// Fixing Claude Code and re-checking re-admits under a new revision.
		setClaudeQueryForTests(fakeQuery({ account: PLAN, models: [{ value: "x", resolvedModel: knownId(), displayName: "X" }] }).query);
		const back = await server.refreshClaudeLocal({ force: true });
		assert.equal(back.state, "ready"); assert.ok(back.revision > ready.revision); assert.ok(bridge.claudeLocalConnected());
	});
});

describe("external review: Windows env casing (P2)", () => {
	it("on win32 the allowlist ignores case, so Windows' `Path` reaches the child as spelled; POSIX stays exact; the deny rule still wins", () => {
		const env = claudeChildEnv({ Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u", ComSpec: "C:\\Windows\\cmd.exe", Anthropic_Api_Key: "sk-ant-never", lh_desktop_api_secret: "s" } as unknown as NodeJS.ProcessEnv, {}, "win32");
		assert.deepEqual(env, { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u", ComSpec: "C:\\Windows\\cmd.exe", ...CLAUDE_CHILD_CONTROLS });
		assert.equal(claudeChildEnvAllows("Path", "linux"), false, "POSIX names are case-sensitive");
		assert.equal(claudeChildEnvAllows("PATH", "linux"), true);
	});
});

describe("external review: isolation by construction (G1)", () => {
	it("the launch slice always carries the four isolation flags, for a native binary and a viaNode install, and both call sites send them", async () => {
		for (const launch of [{ path: "/opt/x/claude", viaNode: false, cwd: "/d" }, { path: "/g/cli.js", viaNode: true, cwd: "/d" }]) {
			const options = claudeLaunchOptions(launch, { PATH: "/bin" } as unknown as NodeJS.ProcessEnv);
			assert.deepEqual(options.tools, [], launch.path); assert.deepEqual(options.settingSources, [], launch.path);
			assert.equal(options.strictMcpConfig, true, launch.path); assert.equal(options.persistSession, false, launch.path);
		}
		const a = claudeLaunchOptions({ path: "/opt/x/claude", viaNode: false, cwd: "/d" }), b = claudeLaunchOptions({ path: "/opt/x/claude", viaNode: false, cwd: "/d" });
		assert.notEqual(a.tools, b.tools, "each call gets its own arrays (no shared mutable state)");
		const fake = fakeQuery({ account: PLAN });
		await server.probeAccount(fake.query, { path: "/x", viaNode: false, cwd: directory }, 2000);
		const probe = fake.calls[0]!.options;
		assert.deepEqual([probe.tools, probe.settingSources, probe.strictMcpConfig, probe.persistSession], [[], [], true, false], "the login probe is isolated");
	});
});

describe("external review round 3: a probe started before an adopted API-key verdict never re-admits (P3)", () => {
	const plan = (gate?: Promise<void>) => fakeQuery({ account: PLAN, models: [{ value: "x", resolvedModel: knownId(), displayName: "X" }], ...(gate ? { gate } : {}) });

	it("the held probe and every caller that joined it resolve to the adopted verdict; the route stays not-ready", { skip: !posix }, async () => {
		const { status: ready } = await readyRoute("p3-race-a");
		let release!: () => void;
		const slow = plan(new Promise<void>((resolve) => { release = resolve; }));
		setClaudeQueryForTests(slow.query);
		const p0 = server.refreshClaudeLocal({ maxAgeMs: 0 });
		await until(() => slow.calls.length === 1);
		const p1 = server.refreshClaudeLocal({ maxAgeMs: 0 });
		bridge.noteClaudeLocalApiKeySource("ANTHROPIC_API_KEY");
		release();
		const [r0, r1] = await Promise.all([p0, p1]);
		assert.equal(r0.state, "api-key"); assert.equal(r1.state, "api-key");
		const now = server.claudeLocalStatusNow();
		assert.equal(now.state, "api-key"); assert.equal(now.revision, ready.revision);
		assert.equal(bridge.claudeLocalConnected(), false); assert.deepEqual(bridge.claudeLocalModels(), []);
	});

	it("a Re-check pressed while that stale probe still runs starts a fresh probe and re-admits under a new revision", { skip: !posix }, async () => {
		const { status: ready } = await readyRoute("p3-race-b");
		let release!: () => void;
		const slow = plan(new Promise<void>((resolve) => { release = resolve; }));
		setClaudeQueryForTests(slow.query);
		const stale = server.refreshClaudeLocal({ maxAgeMs: 0 });
		await until(() => slow.calls.length === 1);
		bridge.noteClaudeLocalApiKeySource("ANTHROPIC_API_KEY");
		const fresh = plan();
		setClaudeQueryForTests(fresh.query);
		const back = await server.refreshClaudeLocal({ force: true });
		assert.equal(fresh.calls.length, 1, "the Re-check ran its own probe instead of joining the superseded one");
		assert.equal(back.state, "ready"); assert.ok(back.revision > ready.revision);
		release(); await stale;
		assert.equal(server.claudeLocalStatusNow().revision, back.revision, "the stale probe landed without effect");
		assert.ok(bridge.claudeLocalConnected());
	});
});

describe("external review round 3: a probe failure's own text never reaches a log, the status or the card (P1)", () => {
	const SECRET = "sk-ant-oat01-ROUND3-PROBE-SECRET";
	const route = () => new Request("http://localhost:3000/api/claude-local", { headers: { origin: "http://localhost:3000", "x-learnharness-subscriptions": "1" } });
	async function captured<T>(run: () => Promise<T>): Promise<{ value: T; logged: string }> {
		const lines: string[] = [];
		const original = { error: console.error, info: console.info, warn: console.warn, log: console.log };
		const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
		Object.assign(console, { error: capture, info: capture, warn: capture, log: capture });
		try { return { value: await run(), logged: lines.join("\n") }; } finally { Object.assign(console, original); }
	}
	const cases: Array<{ name: string; fake: FakeQueryOptions; error: string; logs: RegExp }> = [
		{ name: "a control request answered with Claude Code's own text", fake: { reject: new Error(`startup failed: ${SECRET}`) }, error: "Claude Code could not be started. Check the path and run `claude` in a terminal.", logs: /probe failed: unclassified failure \(Error\)$/m },
		{ name: "a control request failure with a CLI error code", fake: { reject: sdkError(`settings refused: ${SECRET}`, { errorClass: "control_request_failed", errorCode: "managed_settings_invalid" }) }, error: "Claude Code could not be started. Check the path and run `claude` in a terminal. (control request failed: managed_settings_invalid)", logs: /probe failed: control_request_failed, error code managed_settings_invalid$/m },
		{ name: "a startup failure (its result first, then the error result)", fake: { yields: [{ type: "result", subtype: "error_during_execution", is_error: true, errors: [`managed settings invalid: ${SECRET}`], startup_failure_reason: "managed_settings_invalid" }], reject: sdkError(`Claude Code returned an error result: managed settings invalid: ${SECRET}`, { errorClass: "error_result" }) }, error: "Claude Code could not be started. Check the path and run `claude` in a terminal. (startup failure: managed_settings_invalid)", logs: /probe failed: error_result, error_during_execution, startup failure: managed_settings_invalid$/m },
	];
	for (const c of cases) {
		it(`${c.name}: the card gets the fixed sentence and stable fields only; so does the log`, { skip: !posix }, async () => {
			writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary(path.join(directory, "r3-probe")) } });
			setClaudeQueryForTests(fakeQuery(c.fake).query);
			const { value: status, logged } = await captured(() => server.refreshClaudeLocal({ force: true }));
			assert.equal(status.state, "unavailable"); assert.equal(status.error, c.error);
			assert.match(logged, c.logs, logged);
			const body = await (await server.claudeLocalControlsResponse(route())).text();
			for (const sink of [logged, JSON.stringify(status), JSON.stringify(server.claudeLocalStatusNow()), body]) assert.ok(!sink.includes(SECRET), sink);
		});
	}
	it("the keep-last-ready log after a transient failure carries no failure text either", { skip: !posix }, async () => {
		await readyRoute("r3-keep");
		setClaudeQueryForTests(fakeQuery({ reject: new Error(`startup failed: ${SECRET}`) }).query);
		const { value: kept, logged } = await captured(() => server.refreshClaudeLocal({ maxAgeMs: 0 }));
		assert.equal(kept.state, "ready");
		assert.match(logged, /keeping the last ready status/);
		assert.ok(!logged.includes(SECRET), logged);
	});
});
