/**
 * Automatic sync and host integration: the format check, union merge of the
 * graph ledgers, the per-machine state file, the lifecycle hooks, the
 * exclusive hold around manual operations, restart after a pull and the
 * push after work ends.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { PluginBackendContext, PluginHostControl, PluginLifecycleContext } from "learnharness-plugin-api";
import { createGitSync, GITATTRIBUTES_ENTRIES, type DataFormats } from "../src/git-sync.ts";
import { activate, automatic, BUSY_MESSAGE, HOLD_REASON, type Outcome } from "../src/backend.ts";
import { createLocalState } from "../src/local-state.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "github-sync-auto-"));
const emptyConfig = path.join(base, "gitconfig");
fs.writeFileSync(emptyConfig, "");
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

const FORMATS: DataFormats = { chat: 2, graph: 1, settings: 1 };
let root: string, remote: string, counter = 0;
beforeEach(() => {
	root = path.join(base, `case-${++counter}`);
	remote = path.join(root, "remote.git");
	fs.mkdirSync(root, { recursive: true });
	git(root, "init", "-q", "--bare", "-b", "main", remote);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function write(directory: string, file: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
	fs.writeFileSync(path.join(directory, file), text);
}
const read = (directory: string, file: string) => fs.readFileSync(path.join(directory, file), "utf8");
const remoteFile = (file: string) => git(root, "--git-dir", remote, "show", `main:${file}`);
/** A learning-data folder with the plugin's data folder inside it. */
function machine(name: string, files: Record<string, string> = {}) {
	const directory = path.join(root, name);
	const dataDirectory = path.join(directory, "plugins", "github-sync", "data");
	fs.mkdirSync(dataDirectory, { recursive: true });
	for (const [file, text] of Object.entries(files)) write(directory, file, text);
	const state = createLocalState(dataDirectory);
	const ignore = path.relative(directory, state.file).split(path.sep).join("/");
	return { directory, dataDirectory, state, sync: createGitSync({ directory, host: name, dataFormats: FORMATS, ignore: [ignore] }) };
}
async function setUpTwo() {
	const a = machine("a", { "chats/one.json": "a1", "graph/nodes.jsonl": '{"id":"n_1"}\n' });
	assert.equal((await a.sync.initialize(remote)).status, "done");
	const b = machine("b");
	await b.sync.initializeFromRemote(remote, "use-remote", "main");
	return { a, b };
}
function lifecycle(m: ReturnType<typeof machine>, signal = AbortSignal.timeout(10_000)): PluginLifecycleContext {
	return { manifest: {} as never, directory: "", dataDirectory: m.dataDirectory, learningDirectory: m.directory, dataFormats: FORMATS, signal };
}

test("setup writes .gitattributes (committed) and .git/info/attributes (local), and ignores the state file", async () => {
	const a = machine("a", { "settings.json": "{}" });
	a.state.update({ autoSync: true });
	await a.sync.initialize(remote);
	for (const entry of GITATTRIBUTES_ENTRIES) {
		assert.ok(remoteFile(".gitattributes").split("\n").includes(entry));
		assert.ok(read(a.directory, ".git/info/attributes").split("\n").includes(entry));
	}
	assert.ok(remoteFile(".gitignore").split("\n").includes("plugins/github-sync/data/local.json"));
	assert.throws(() => remoteFile("plugins/github-sync/data/local.json"));
});

test("folders set up before .gitattributes get it on the next sync", async () => {
	const a = machine("a", { "settings.json": "{}" });
	await a.sync.initialize(remote);
	fs.rmSync(path.join(a.directory, ".gitattributes"));
	git(a.directory, "commit", "-qam", "drop attributes");
	await a.sync.sync();
	assert.ok(remoteFile(".gitattributes").includes("merge=union"));
});

test("graph ledgers appended on both machines merge without a conflict", async () => {
	const { a, b } = await setUpTwo();
	fs.appendFileSync(path.join(a.directory, "graph/nodes.jsonl"), '{"id":"n_a"}\n');
	assert.equal((await a.sync.sync()).status, "done");
	fs.appendFileSync(path.join(b.directory, "graph/nodes.jsonl"), '{"id":"n_b"}\n');
	const result = await b.sync.sync();
	assert.equal(result.status, "done");
	const lines = read(b.directory, "graph/nodes.jsonl").trim().split("\n");
	assert.deepEqual(lines.sort(), ['{"id":"n_1"}', '{"id":"n_a"}', '{"id":"n_b"}']);
	assert.equal(remoteFile("graph/nodes.jsonl").trim().split("\n").length, 3);
});

test("a pull refuses GitHub data stamped with a newer format and changes nothing locally", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "data-format.json", JSON.stringify({ chat: 2, graph: 2, settings: 1 }));
	write(a.directory, "chats/one.json", "newer app");
	await a.sync.sync();
	const before = git(b.directory, "rev-parse", "HEAD");
	const result = await b.sync.pull();
	assert.equal(result.status, "newer-data");
	assert.match(result.message, /graph format 2; this app reads 1/);
	assert.equal(git(b.directory, "rev-parse", "HEAD"), before);
	assert.equal(read(b.directory, "chats/one.json"), "a1");
	assert.equal((await b.sync.sync()).status, "newer-data");
});

test("an equal or older stamp, or none, syncs normally", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "data-format.json", JSON.stringify({ chat: 1, graph: 1, settings: 1 }));
	await a.sync.sync();
	assert.equal((await b.sync.pull()).status, "done");
});

test("use-remote setup refuses newer data before touching the folder", async () => {
	const a = machine("a", { "data-format.json": JSON.stringify({ chat: 9, graph: 1, settings: 1 }) });
	await a.sync.initialize(remote);
	const b = machine("b", { "chats/local.json": "mine" });
	const result = await b.sync.initializeFromRemote(remote, "use-remote", "main");
	assert.equal(result.status, "newer-data");
	assert.equal(fs.existsSync(path.join(b.directory, ".git")), false);
	assert.equal(read(b.directory, "chats/local.json"), "mine");
	assert.deepEqual(fs.readdirSync(root).filter(n => n.includes("backup")), []);
});

test("automatic pull/sync do nothing for a folder that is not set up", async () => {
	const a = machine("a", { "settings.json": "{}" });
	assert.equal(await a.sync.autoPull(), null);
	assert.equal(await a.sync.autoSync(), null);
	await automatic(lifecycle(a), "pull");
	assert.equal(fs.existsSync(path.join(a.directory, ".git")), false);
});

test("beforeLoad pulls; beforeQuit pulls and pushes", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	await automatic(lifecycle(b), "pull");
	assert.equal(read(b.directory, "chats/one.json"), "from a");
	assert.equal(b.state.read().lastAuto?.status, "done");
	write(b.directory, "chats/two.json", "from b");
	await automatic(lifecycle(b), "sync");
	assert.equal(remoteFile("chats/two.json"), "from b");
});

test("an automatic conflict leaves local data, records the conflict and pauses automatic sync", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	write(b.directory, "chats/one.json", "from b");
	await automatic(lifecycle(b), "sync");
	const state = b.state.read();
	assert.equal(state.conflict?.remote, git(root, "--git-dir", remote, "rev-parse", "main"));
	assert.equal(read(b.directory, "chats/one.json"), "from b");
	assert.equal(remoteFile("chats/one.json"), "from a");
	// Paused: a later automatic run does not touch git while the conflict waits.
	const head = git(b.directory, "rev-parse", "HEAD");
	write(b.directory, "chats/three.json", "x");
	await automatic(lifecycle(b), "sync");
	assert.equal(git(b.directory, "rev-parse", "HEAD"), head);
});

test("automatic sync is off when the per-machine toggle is off", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	b.state.update({ autoSync: false });
	await automatic(lifecycle(b), "pull");
	assert.equal(read(b.directory, "chats/one.json"), "a1");
});

test("a cancelled automatic run stops git and records the error", async () => {
	const { b } = await setUpTwo();
	const controller = new AbortController();
	controller.abort();
	await automatic(lifecycle(b, controller.signal), "sync");
	assert.equal(b.state.read().lastAuto?.status, "error");
	assert.match(b.state.read().lastAuto!.message, /cancelled/);
});

test("autoCommit + autoPush push committed work and never pull", async () => {
	const { a, b } = await setUpTwo();
	write(b.directory, "chats/two.json", "from b");
	assert.deepEqual(await b.sync.autoCommit(), { branch: "main", committed: true });
	assert.equal(await b.sync.autoPush(), "pushed");
	assert.equal(remoteFile("chats/two.json"), "from b");
	assert.equal(await b.sync.autoPush(), "nothing");
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	write(b.directory, "chats/three.json", "x");
	await b.sync.autoCommit();
	assert.equal(await b.sync.autoPush(), "behind");
	assert.equal(read(b.directory, "chats/one.json"), "a1", "no pull happened");
});

// ── backend activation with a fake host ─────────────────────────────────────

interface FakeHost extends PluginHostControl { holds: { released: boolean }[]; restarts: number; busy: boolean; idle?: () => void }
function fakeHost(restart: { restarted: boolean; reason?: "unavailable" } = { restarted: true }): FakeHost {
	const host: FakeHost = {
		holds: [], restarts: 0, busy: false, dataFormats: FORMATS,
		acquireHold(options) {
			assert.equal(options.reason, HOLD_REASON);
			if (host.busy || host.holds.some(h => !h.released)) return null;
			const record = { released: false };
			host.holds.push(record);
			return { signal: new AbortController().signal, release: () => { record.released = true; } };
		},
		onIdle(listener) { host.idle = listener; return () => { host.idle = undefined; }; },
		async requestRestart() { host.restarts++; return restart; },
	};
	return host;
}
function activated(m: ReturnType<typeof machine>, host?: FakeHost) {
	const handlers = new Map<string, (input: unknown) => unknown>();
	const notifications: string[] = [];
	const ctx = {
		signal: new AbortController().signal, dataDirectory: m.dataDirectory,
		learning: { directory: m.directory },
		handle(name: string, fn: (input: unknown) => unknown) { handlers.set(name, fn); return () => {}; },
		events: { emit: (topic: string) => notifications.push(topic), on: () => () => {} },
		...(host ? { host } : {}),
	} as unknown as PluginBackendContext;
	activate(ctx);
	const call = async <T = Outcome>(name: string, input?: unknown) => await handlers.get(name)!(input) as T;
	return { call, notifications };
}

test("manual operations take the hold and refuse while the app is busy", async () => {
	const { b } = await setUpTwo();
	const host = fakeHost();
	const plugin = activated(b, host);
	host.busy = true;
	await assert.rejects(plugin.call("sync"), new RegExp(BUSY_MESSAGE));
	host.busy = false;
	const result = await plugin.call("sync");
	assert.equal(result.status, "done");
	assert.equal(result.after, undefined);
	assert.deepEqual(host.holds, [{ released: true }]);
});

test("a pull that changed files asks for a restart and keeps the hold", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	const host = fakeHost();
	const result = await activated(b, host).call("pull");
	assert.equal(result.changed, true);
	assert.equal(result.after, "restarting");
	assert.equal(host.restarts, 1);
	assert.deepEqual(host.holds, [{ released: false }]);
});

test("without a desktop shell the learner is asked to restart; older apps reload", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	const result = await activated(b, fakeHost({ restarted: false, reason: "unavailable" })).call("pull");
	assert.equal(result.after, "restart-manually");
	write(a.directory, "chats/one.json", "again");
	await a.sync.sync();
	assert.equal((await activated(b).call("pull")).after, "reload");
});

test("status reports per-machine state; set-auto toggles it", async () => {
	const { b } = await setUpTwo();
	const plugin = activated(b, fakeHost());
	const status = await plugin.call<{ autoSync: boolean; conflict: unknown; automaticAvailable: boolean }>("status");
	assert.equal(status.autoSync, true);
	assert.equal(status.conflict, null);
	assert.equal(status.automaticAvailable, true);
	await plugin.call("set-auto", { enabled: false });
	assert.equal(b.state.read().autoSync, false);
	assert.deepEqual(plugin.notifications, ["state"]);
	await assert.rejects(plugin.call("set-auto", { enabled: "no" }));
	assert.equal((await activated(b).call<{ automaticAvailable: boolean }>("status")).automaticAvailable, false);
});

test("a manual conflict is recorded; resolving clears it", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	write(b.directory, "chats/one.json", "from b");
	const host = fakeHost();
	const plugin = activated(b, host);
	const result = await plugin.call("sync");
	assert.equal(result.status, "conflict");
	assert.ok(b.state.read().conflict);
	if (result.status !== "conflict") return;
	await plugin.call("resolve", { choice: "keep-local", remote: result.remote });
	assert.equal(b.state.read().conflict, undefined);
	assert.equal(remoteFile("chats/one.json"), "from b");
});

test("after work ends: commit under the hold, release, then push", async () => {
	const { b } = await setUpTwo();
	const host = fakeHost();
	activated(b, host);
	write(b.directory, "chats/two.json", "from b");
	host.idle!();
	for (let i = 0; i < 100 && !host.holds.length; i++) await new Promise(r => setTimeout(r, 10));
	for (let i = 0; i < 300 && b.state.read().lastAuto?.status !== "pushed"; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(remoteFile("chats/two.json"), "from b");
	assert.deepEqual(host.holds, [{ released: true }]);
	assert.equal(b.state.read().lastAuto?.status, "pushed");
});

test("after work ends does nothing while busy, paused by a conflict, or switched off", async () => {
	const { b } = await setUpTwo();
	const host = fakeHost();
	activated(b, host);
	write(b.directory, "chats/two.json", "x");
	b.state.update({ autoSync: false });
	host.idle!();
	b.state.update({ autoSync: true, conflict: { branch: "main", remote: "a".repeat(40), message: "m", at: new Date().toISOString() } });
	host.idle!();
	b.state.update({ conflict: undefined });
	host.busy = true;
	host.idle!();
	await new Promise(r => setTimeout(r, 200));
	assert.deepEqual(host.holds, []);
	assert.throws(() => remoteFile("chats/two.json"));
});
