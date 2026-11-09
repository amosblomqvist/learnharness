import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { runTests } from "../src/runner.ts";
import type { CodingTests } from "../src/test-result.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "plugin-data");
  const questionId = "Question-Case-Preserved";
  return { root, dataDirectory, questionId, answer: "answer" };
}

function nodeTests(source: string, args: string[] = [], code = ""): CodingTests {
  return { program: process.execPath, args: ["-e", source, ...args], code };
}

async function assertEmptyWorkspace(dataDirectory: string, questionId: string) {
  assert.deepEqual(await readdir(path.join(dataDirectory, "test-runs", questionId)), []);
}

function assertDead(pid: number) {
  if (process.platform === "win32") return;
  try { process.kill(pid, 0); }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
  // Linux may retain a killed process as a zombie until its init reaps it.
  if (process.platform === "linux") {
    const observation = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (observation.stdout.trim().startsWith("Z")) return;
  }
  assert.fail(`Process ${pid} is still running`);
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(20);
    }
  }
  throw new Error(`Fixture did not create ${file}`);
}

const descendantSource = `
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const childCode = \`
  const {spawn} = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 'inherit', 'inherit']});
  process.send(grandchild.pid);
  setInterval(() => {}, 1000);
\`;
const child = spawn(process.execPath, ['-e', childCode], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
child.once('message', grandchildPid => {
  const pids = JSON.stringify([process.pid, child.pid, grandchildPid]);
  process.stdout.write(pids);
  if (process.argv[1]) fs.writeFileSync(process.argv[1], pids);
  if (process.argv[2] === 'exit') process.exit(0);
});
setInterval(() => {}, 1000);
`;

const escapedDescendantSource = `
const {spawn} = require('node:child_process');
const escapedCode = \`
  const fs = require('node:fs');
  fs.writeFileSync(process.argv[1], JSON.stringify([Number(process.argv[2]), process.pid]));
  setInterval(() => {}, 1000);
\`;
const escaped = spawn(process.execPath, ['-e', escapedCode, process.argv[1], String(process.pid)], {
  detached: true, stdio: ['ignore', 'inherit', 'inherit'],
});
escaped.once('spawn', () => process.exit(0));
`;

async function cleanupEscaped(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  await delay(20);
  assertDead(pid);
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error("Runner did not settle independently of escaped pipe holders")); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test("writes exact UTF-8 answer and stdin; isolated absolute cwd; preserves ID case; fresh attempts; only removes run files", async (t) => {
  const f = await fixture(t);
  const answer = " \tλ\r\nline\rfinal  \n\n";
  const code = "  stdin\r\nλ\t \n\n";
  const siblingDirectory = path.join(f.dataDirectory, "test-runs", "another-question", "existing-attempt");
  await mkdir(siblingDirectory, { recursive: true });
  await writeFile(path.join(siblingDirectory, "answer.txt"), "untouched");
  await writeFile(path.join(f.dataDirectory, "settings.json"), "preserved plugin settings");
  const source = `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => console.log(JSON.stringify({cwd: process.cwd(), files: fs.readdirSync('.'), answer: fs.readFileSync('answer.txt', 'utf8'), input})));
`;
  const workspaces = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const result = await runTests({ ...f, answer, tests: nodeTests(source, [], code) });
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutTruncated, false);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.answer, answer);
    assert.equal(actual.input, code);
    assert.deepEqual(actual.files, ["answer.txt"]);
    assert.equal(path.isAbsolute(actual.cwd), true);
    assert.equal(path.dirname(actual.cwd), await realpath(path.join(f.dataDirectory, "test-runs", f.questionId)));
    workspaces.add(actual.cwd);
    await assert.rejects(access(actual.cwd));
  }
  assert.equal(workspaces.size, 2);
  assert.equal(await readFile(path.join(siblingDirectory, "answer.txt"), "utf8"), "untouched");
  assert.equal(await readFile(path.join(f.dataDirectory, "settings.json"), "utf8"), "preserved plugin settings");
  await assertEmptyWorkspace(f.dataDirectory, f.questionId);
});

test("passes argv literally with no shell expansion and inherits environment", async (t) => {
  const f = await fixture(t);
  const args = ["hello world", "*", "$HOME", "$(echo injected)", "; echo injected", "\"quotes\"", ""];
  const source = `console.log(JSON.stringify({args: process.argv.slice(1), path: process.env.PATH, home: process.env.HOME}))`;
  const result = await runTests({ ...f, tests: nodeTests(source, args) });
  assert.equal(result.status, "passed");
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.args, args);
  assert.equal(actual.path, process.env.PATH);
  assert.equal(actual.home, process.env.HOME);
});

test("removes saved API keys and other secret-like variables from the test environment", async (t) => {
  const f = await fixture(t);
  const injected = {
    FIXTURE_API_KEY: "key", HF_TOKEN: "token", fixture_secret: "secret", DB_PASSWORD_FILE: "password",
    FIXTURE_TOOLCHAIN_HOME: "/opt/toolchain", FIXTURE_KEYBOARD: "kept",
  };
  for (const [name, value] of Object.entries(injected)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const source = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(injected))}.map(name => [name, process.env[name] ?? null]))))`;
  const result = await runTests({ ...f, tests: nodeTests(source) });
  assert.equal(result.status, "passed");
  assert.deepEqual(JSON.parse(result.stdout), {
    FIXTURE_API_KEY: null, HF_TOKEN: null, fixture_secret: null, DB_PASSWORD_FILE: null,
    FIXTURE_TOOLCHAIN_HOME: "/opt/toolchain", FIXTURE_KEYBOARD: "kept",
  });
});

test("uses normal PATH lookup instead of requiring an absolute program", async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: { program: path.basename(process.execPath), args: ["-e", "process.stdout.write('found')"], code: "" } });
  assert.equal(result.status, "passed");
  assert.equal(result.stdout, "found");
});

test("returns nonzero as failed with both streams, not as an exception", async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 23") });
  assert.deepEqual(result, { status: "failed", exitCode: 23, stdout: "out", stderr: "err", stdoutTruncated: false, stderrTruncated: false });
});

test("reports missing executables and synchronous invalid spawn arguments as errors", async (t) => {
  const f = await fixture(t);
  for (const tests of [
    { program: "this-executable-does-not-exist-coding-runner-test", args: [], code: "" },
    { program: "", args: [], code: "" },
    { program: process.execPath, args: 42 as unknown as string[], code: "" },
    { program: process.execPath, args: ["bad\0argument"], code: "" },
  ]) {
    const result = await runTests({ ...f, tests });
    assert.equal(result.status, "error");
    assert.equal(result.exitCode, null);
    assert.match(result.message!, /launch/i);
    await assertEmptyWorkspace(f.dataDirectory, f.questionId);
  }
});

test("an early closed stdin/EPIPE does not crash or replace a valid nonzero exit", async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests("require('node:fs').closeSync(0); process.exit(17)", [], "x".repeat(2 * 1024 * 1024)) });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 17);
});

test("captures only the first 64 KiB of each stream and drains much larger output", async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests(`
const {once} = require('node:events');
(async () => {
  process.stdout.write('OUT:'); process.stderr.write('ERR:');
  for (let i = 0; i < 128; i++) {
    if (!process.stdout.write('a'.repeat(65536))) await once(process.stdout, 'drain');
    if (!process.stderr.write('b'.repeat(65536))) await once(process.stderr, 'drain');
  }
})().catch(() => process.exit(3));
`) });
  assert.equal(result.status, "passed");
  assert.equal(result.stdout, "OUT:" + "a".repeat(65532));
  assert.equal(result.stderr, "ERR:" + "b".repeat(65532));
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("exactly 64 KiB is not marked truncated", async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests("process.stdout.write('a'.repeat(65536)); process.stderr.write('b'.repeat(65536));") });
  assert.equal(result.stdout.length, 65536);
  assert.equal(result.stderr.length, 65536);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
});

test("UTF-8 output caps drop only incomplete truncated suffixes and preserve complete Unicode at the cap", async (t) => {
  const f = await fixture(t);
  for (const character of ["λ", "€", "😀"]) {
    const width = Buffer.byteLength(character);
    for (let retained = 1; retained < width; retained++) {
      const prefix = "a".repeat(65536 - retained);
      const output = prefix + character + "tail";
      const result = await runTests({ ...f, tests: nodeTests(`const output = ${JSON.stringify(output)}; process.stdout.write(output); process.stderr.write(output);`) });
      assert.equal(result.status, "passed");
      for (const stream of [result.stdout, result.stderr]) {
        assert.equal(stream, prefix);
        assert.equal(stream.includes("\ufffd"), false);
        assert.ok(Buffer.byteLength(stream) <= 65536);
      }
      assert.equal(result.stdoutTruncated, true);
      assert.equal(result.stderrTruncated, true);
    }
    const complete = "a".repeat(65536 - width) + character;
    for (const suffix of ["", "extra"]) {
      const result = await runTests({ ...f, tests: nodeTests(`const output = ${JSON.stringify(complete + suffix)}; process.stdout.write(output); process.stderr.write(output);`) });
      assert.equal(result.stdout, complete);
      assert.equal(result.stderr, complete);
      assert.equal(Buffer.byteLength(result.stdout), 65536);
      assert.equal(Buffer.byteLength(result.stderr), 65536);
      assert.equal(result.stdoutTruncated, suffix !== "");
      assert.equal(result.stderrTruncated, suffix !== "");
    }
  }
});

test("rejects path-escaping question IDs before any filesystem effects", async (t) => {
  const f = await fixture(t);
  for (const questionId of ["", ".", "..", "../escape", "a/b", "a\\b", "/absolute", "a\0b"]) {
    await assert.rejects(runTests({ ...f, questionId, tests: nodeTests("") }), /safe path segment/);
  }
  await assert.rejects(access(f.dataDirectory));
});

test("already aborted signals reject AbortError without any filesystem effects", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("custom reason must not disguise cancellation"));
  await assert.rejects(runTests({ ...f, tests: nodeTests(""), signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(access(f.dataDirectory));
});

test("unexpected signal termination is an error observation", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests("process.kill(process.pid, 'SIGTERM')") });
  assert.equal(result.status, "error");
  assert.equal(result.exitCode, null);
  assert.match(result.message!, /SIGTERM/);
});

test("kills inherited-pipe descendants when their driver exits", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const result = await runTests({ ...f, tests: nodeTests(descendantSource, ["", "exit"]) });
  assert.equal(result.status, "passed");
  for (const pid of JSON.parse(result.stdout)) assertDead(pid);
  await assertEmptyWorkspace(f.dataDirectory, f.questionId);
});

test("abort rejects only after driver/descendant and workspace cleanup; sibling data survives", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "pids.json");
  const controller = new AbortController();
  const running = runTests({ ...f, tests: nodeTests(descendantSource, [marker]), signal: controller.signal });
  // Install rejection handling immediately, before requesting cancellation.
  const rejected = assert.rejects(running, { name: "AbortError" });
  const pids: number[] = JSON.parse(await waitForFile(marker));
  controller.abort();
  await rejected;
  for (const pid of pids) assertDead(pid);
  assert.equal(await readFile(marker, "utf8"), JSON.stringify(pids));
  await assertEmptyWorkspace(f.dataDirectory, f.questionId);
});

test("abort settles and cleans its workspace even after an exited driver leaves an escaped pipe holder", { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "escaped-pids.json");
  const controller = new AbortController();
  const running = runTests({ ...f, tests: nodeTests(escapedDescendantSource, [marker]), signal: controller.signal });
  const rejected = assert.rejects(running, { name: "AbortError" });
  const [rootPid, escapedPid]: number[] = JSON.parse(await waitForFile(marker));
  try {
    controller.abort();
    await within(rejected, 2000);
    assertDead(rootPid!);
    await assertEmptyWorkspace(f.dataDirectory, f.questionId);
    // The fixture deliberately escaped the runner's process group. Confirm
    // settlement was not contingent on killing it, then clean it ourselves.
    process.kill(escapedPid!, 0);
  } finally { await cleanupEscaped(escapedPid!); }
});

test("fixed 30 second timeout settles with ordinary and escaped inherited-pipe descendants", { concurrency: true, timeout: 38_000 }, async (t) => {
  await Promise.all([
    t.test("kills the ordinary process tree and cleans only its attempt", async (t) => {
      const f = await fixture(t);
      const marker = path.join(f.root, "pids.json");
      const started = Date.now();
      const result = await runTests({ ...f, tests: nodeTests(descendantSource, [marker]) });
      assert.ok(Date.now() - started >= 29_900);
      assert.equal(result.status, "error");
      assert.match(result.message!, /30 second timeout/);
      for (const pid of JSON.parse(result.stdout)) assertDead(pid);
      assert.equal(await readFile(marker, "utf8"), result.stdout);
      await assertEmptyWorkspace(f.dataDirectory, f.questionId);
    }),
    t.test("settles independently of EOF from an escaped descendant", { skip: process.platform === "win32" }, async (t) => {
      const f = await fixture(t);
      const marker = path.join(f.root, "escaped-pids.json");
      const started = Date.now();
      const running = within(runTests({ ...f, tests: nodeTests(escapedDescendantSource, [marker]) }), 33_000);
      const [rootPid, escapedPid]: number[] = JSON.parse(await waitForFile(marker));
      try {
        const result = await running;
        assert.ok(Date.now() - started >= 29_900);
        assert.equal(result.status, "error");
        assert.equal(result.exitCode, 0); // Driver exit observed before deadline.
        assert.match(result.message!, /30 second timeout/);
        assertDead(rootPid!);
        await assertEmptyWorkspace(f.dataDirectory, f.questionId);
        process.kill(escapedPid!, 0);
      } finally { await cleanupEscaped(escapedPid!); }
    }),
  ]);
});
