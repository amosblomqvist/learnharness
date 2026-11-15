import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createGitSync, GITIGNORE_ENTRIES, type SyncResult } from "../src/git-sync.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "github-sync-test-"));
const emptyConfig = path.join(base, "gitconfig");
fs.writeFileSync(emptyConfig, "");
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

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
function machine(name: string, files: Record<string, string> = {}) {
	const directory = path.join(root, name);
	fs.mkdirSync(directory, { recursive: true });
	for (const [file, text] of Object.entries(files)) write(directory, file, text);
	let tick = 0;
	return { directory, sync: createGitSync({ directory, host: name, now: () => new Date(2026, 10, 12, 10, 0, tick++) }) };
}
function write(directory: string, file: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
	fs.writeFileSync(path.join(directory, file), text);
}
const read = (directory: string, file: string) => fs.readFileSync(path.join(directory, file), "utf8");
const remoteFile = (file: string) => git(root, "--git-dir", remote, "show", `main:${file}`);

async function setUpTwo() {
	const a = machine("a", { "chats/one.json": "a1" });
	assert.equal((await a.sync.initialize(remote)).status, "done");
	const b = machine("b");
	const init = await b.sync.initialize(remote);
	assert.equal(init.status, "remote-has-data");
	await b.sync.initializeFromRemote(remote, "use-remote", "main");
	return { a, b };
}

test("initialize with an empty remote commits, writes .gitignore and pushes", async () => {
	const a = machine("a", { "settings.json": "{}" });
	const result = await a.sync.initialize(remote);
	assert.deepEqual(result, { status: "done", changed: false, message: "GitHub Sync is set up and your learning data was pushed." });
	assert.equal(remoteFile("settings.json"), "{}");
	const ignore = remoteFile(".gitignore").split("\n");
	for (const entry of GITIGNORE_ENTRIES) assert.ok(ignore.includes(entry), entry);
	const status = await a.sync.status();
	assert.equal(status.repository, true);
	assert.equal(status.branch, "main");
	assert.equal(status.ahead, 0);
	assert.equal(status.behind, 0);
	assert.equal(status.changes, 0);
});

test("initialize leaves the folder untouched when the remote already has data", async () => {
	const a = machine("a", { "x.txt": "a" });
	await a.sync.initialize(remote);
	const b = machine("b", { "x.txt": "b" });
	const result = await b.sync.initialize(remote);
	assert.equal(result.status, "remote-has-data");
	assert.equal(result.status === "remote-has-data" && result.branch, "main");
	assert.equal(fs.existsSync(path.join(b.directory, ".git")), false);
	assert.equal((await b.sync.status()).repository, false);
});

test("use-remote backs up the folder, takes remote files and keeps local-only files", async () => {
	const a = machine("a", { "shared.txt": "remote" });
	await a.sync.initialize(remote);
	const b = machine("b", { "shared.txt": "local", "only-b.txt": "b" });
	const result = await b.sync.initializeFromRemote(remote, "use-remote", "main");
	assert.equal(result.status, "done");
	assert.equal(result.changed, true);
	assert.equal(read(b.directory, "shared.txt"), "remote");
	assert.equal(read(b.directory, "only-b.txt"), "b");
	const backups = fs.readdirSync(root).filter(name => name.startsWith("b.github-sync-backup-"));
	assert.equal(backups.length, 1);
	assert.equal(read(path.join(root, backups[0]!), "shared.txt"), "local");
	assert.equal((await b.sync.sync()).status, "done");
	assert.equal(remoteFile("only-b.txt"), "b");
});

test("merge setup rebases local data onto remote data and pushes both", async () => {
	const a = machine("a", { "a.txt": "a" });
	await a.sync.initialize(remote);
	const b = machine("b", { "b.txt": "b" });
	const result = await b.sync.initializeFromRemote(remote, "merge", "main");
	assert.equal(result.status, "done");
	assert.equal(remoteFile("a.txt"), "a");
	assert.equal(remoteFile("b.txt"), "b");
	assert.equal(read(b.directory, "a.txt"), "a");
});

test("sync and pull move changes between machines", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/two.json", "a2");
	const pushed = await a.sync.sync();
	assert.equal(pushed.status, "done");
	assert.equal(pushed.changed, false);
	assert.match(git(a.directory, "log", "-1", "--format=%s"), /^sync: a 2026-11-12 10:00$/);
	const pulled = await b.sync.pull();
	assert.deepEqual(pulled, { status: "done", changed: true, message: "Pulled new learning data from GitHub." });
	assert.equal(read(b.directory, "chats/two.json"), "a2");
	assert.equal((await b.sync.pull()).changed, false);
});

test("push reports behind instead of merging when GitHub moved", async () => {
	const { a, b } = await setUpTwo();
	write(a.directory, "a.txt", "1");
	await a.sync.push();
	write(b.directory, "b.txt", "2");
	const result = await b.sync.push();
	assert.equal(result.status, "behind");
	assert.equal(fs.existsSync(path.join(b.directory, "a.txt")), false);
	const synced = await b.sync.sync();
	assert.equal(synced.status, "done");
	assert.equal(synced.changed, true);
	assert.equal(remoteFile("b.txt"), "2");
});

async function conflict() {
	const { a, b } = await setUpTwo();
	write(a.directory, "chats/one.json", "from a");
	await a.sync.sync();
	write(b.directory, "chats/one.json", "from b");
	const result = await b.sync.sync();
	assert.equal(result.status, "conflict");
	return { a, b, result: result as Extract<SyncResult, { status: "conflict" }> };
}

test("a conflict aborts the rebase and pushes nothing", async () => {
	const { b, result } = await conflict();
	assert.equal(result.branch, "main");
	assert.equal(result.remote, git(root, "--git-dir", remote, "rev-parse", "main"));
	assert.equal(fs.existsSync(path.join(b.directory, ".git", "rebase-merge")), false);
	assert.equal(read(b.directory, "chats/one.json"), "from b");
	assert.equal(remoteFile("chats/one.json"), "from a");
});

test("keep-local backs up GitHub's version and force-pushes local data", async () => {
	const { b, result } = await conflict();
	const resolved = await b.sync.resolve("keep-local", result.remote);
	assert.equal(resolved.status, "done");
	assert.equal(resolved.changed, false);
	assert.equal(remoteFile("chats/one.json"), "from b");
	const backup = git(b.directory, "branch", "--list", "lh-backup/*", "--format=%(refname:short)");
	assert.match(backup, /^lh-backup\/b-\d{8}-\d{6}-remote$/);
	assert.equal(git(b.directory, "rev-parse", backup), result.remote);
});

test("take-remote backs up local data and resets to GitHub's version", async () => {
	const { b, result } = await conflict();
	const localHead = git(b.directory, "rev-parse", "HEAD");
	const resolved = await b.sync.resolve("take-remote", result.remote);
	assert.equal(resolved.changed, true);
	assert.equal(read(b.directory, "chats/one.json"), "from a");
	const backup = git(b.directory, "branch", "--list", "lh-backup/*", "--format=%(refname:short)");
	assert.match(backup, /-local$/);
	assert.equal(git(b.directory, "rev-parse", backup), localHead);
});

test("keep-local refuses to overwrite when GitHub moved after the conflict was shown", async () => {
	const { a, b, result } = await conflict();
	write(a.directory, "later.txt", "later");
	await a.sync.sync();
	await assert.rejects(b.sync.resolve("keep-local", result.remote), /GitHub changed again/);
	assert.equal(remoteFile("later.txt"), "later");
});

test("operations do not overlap", async () => {
	const { a } = await setUpTwo();
	const first = a.sync.sync();
	await assert.rejects(a.sync.pull(), /Another GitHub Sync operation/);
	assert.equal((await first).status, "done");
});

test("a folder that is not its own repository is reported, not synced", async () => {
	const parent = machine("parent");
	git(parent.directory, "init", "-q", "-b", "main");
	const nested = createGitSync({ directory: path.join(parent.directory, "data") });
	fs.mkdirSync(path.join(parent.directory, "data"));
	assert.equal((await nested.status()).repository, false);
	await assert.rejects(nested.sync(), /not set up for GitHub Sync/);
});

test("invalid inputs are rejected before running git", async () => {
	const a = machine("a");
	await assert.rejects(a.sync.initialize("  "), /Enter the GitHub repository URL/);
	await assert.rejects(a.sync.initialize("--upload-pack=x"), /not valid/);
	await assert.rejects(a.sync.initializeFromRemote(remote, "merge", "-x"), /Invalid branch/);
	const { b } = await setUpTwo();
	await assert.rejects(b.sync.resolve("keep-local", "nope"), /Invalid remote commit/);
});
