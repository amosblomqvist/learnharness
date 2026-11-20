/** Real execFile boundary, authored fixture executables only. Never the installed CLI. */
import assert from "node:assert/strict";
import { type spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveClaudeBinary } from "../src/agent/claude-code/binary.ts";
import { readClaudeVersion } from "../src/agent/claude-code/installation.ts";
import { createClaudeLauncher } from "../src/agent/claude-code/launch.ts";

const unsupportedShebang = process.platform === "win32" || /\s/.test(process.execPath);
function fixture(t: TestContext, mode: "normal" | "oversize" | "hang", name = "claude") {
	const dir = mkdtempSync(join(tmpdir(), "lh-version-runner-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin"); mkdirSync(bin);
	const binary = join(bin, name);
	const body = mode === "hang" ? `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[1] + ".pid", String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
` : mode === "oversize" ? 'process.stdout.write("x".repeat(100000));' : `
if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') process.exit(2);
process.stdout.write("2.1.310 (Claude Code)\\n");
`;
	writeFileSync(binary, `#!${process.execPath}\n${body}`, { mode: 0o755 });
	return { dir, binary };
}

test("production version runner directly executes a spaced/metacharacter filename with only --version", { skip: unsupportedShebang }, async (t) => {
	const { binary } = fixture(t, "normal", "claude ; fixture");
	assert.equal(await readClaudeVersion(binary), "2.1.310 (Claude Code)\n");
});

test("production version runner bounds stdout", { skip: unsupportedShebang }, async (t) => {
	const { binary } = fixture(t, "oversize");
	await assert.rejects(readClaudeVersion(binary), (error: NodeJS.ErrnoException) => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});

test("production version runner times out and SIGKILLs an uncooperative fixture", { skip: unsupportedShebang, timeout: 10000 }, async (t) => {
	const { binary } = fixture(t, "hang");
	const start = Date.now();
	await assert.rejects(readClaudeVersion(binary), (error: Error & { signal?: string }) => error.signal === "SIGKILL");
	assert(Date.now() - start < 8500, "bounded five-second timeout");
	const pid = Number(readFileSync(`${binary}.pid`, "utf8"));
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "fixture no longer exists");
});

test("relative PATH is resolved at server cwd and stays the same for probe and model launch", { skip: unsupportedShebang }, async (t) => {
	const { dir, binary } = fixture(t, "normal");
	const found = resolveClaudeBinary({ env: { PATH: "./bin" }, homeDir: dir, platform: process.platform, cwd: dir,
		isExecutable: (path) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } },
	});
	assert.equal(found, binary);
	assert.equal(await readClaudeVersion(found!), "2.1.310 (Claude Code)\n", "probe changes cwd to tmpdir but executes the discovered file");
	let spawned = false;
	const launch = createClaudeLauncher({ findBinary: () => found,
		spawnProcess: ((path: string) => { assert.equal(path, binary); spawned = true; return null; }) as unknown as typeof spawn,
	});
	await launch(["-p"], { cwd: tmpdir(), env: { NODE_ENV: "test" } });
	assert(spawned, "same verified absolute identity passed to the model launcher");
});
