import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodingTestResult, CodingTests } from "./test-result.ts";

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Test run aborted", "AbortError");
}

function capture() {
  const bytes = Buffer.alloc(OUTPUT_LIMIT);
  let length = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const remaining = OUTPUT_LIMIT - length;
      const count = Math.min(remaining, chunk.length);
      chunk.copy(bytes, length, 0, count);
      length += count;
      if (chunk.length > remaining) truncated = true;
    },
    text() {
      let end = length;
      if (truncated && end > 0) {
        // A byte cap can split a valid UTF-8 character. Do not turn its
        // incomplete prefix into a replacement character (which adds bytes).
        let start = end - 1;
        while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
        const lead = bytes[start]!;
        const width = lead >= 0xf0 && lead <= 0xf4 ? 4
          : lead >= 0xe0 && lead <= 0xef ? 3
          : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
        if (end - start < width) end = start;
      }
      return bytes.subarray(0, end).toString("utf8");
    },
    truncated: () => truncated,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function observeProcess(
  cwd: string,
  tests: CodingTests,
  signal?: AbortSignal,
): Promise<CodingTestResult> {
  checkAbort(signal);
  const stdout = capture();
  const stderr = capture();
  const result = (status: CodingTestResult["status"], exitCode: number | null, message?: string): CodingTestResult => ({
    status, exitCode, stdout: stdout.text(), stderr: stderr.text(),
    stdoutTruncated: stdout.truncated(), stderrTruncated: stderr.truncated(),
    ...(message === undefined ? {} : { message }),
  });

  let child;
  try {
    child = spawn(tests.program, tests.args, {
      cwd,
      shell: false,
      // A separate POSIX process group lets us kill descendants even when the
      // driver exits first and its descendants still hold our output pipes.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    checkAbort(signal);
    return result("error", null, `Could not launch test process: ${errorMessage(error)}`);
  }

  return new Promise<CodingTestResult>((resolve, reject) => {
    let timedOut = false;
    let launchError: Error | undefined;
    let rootExited = false;
    let pipesClosed = false;
    let finishing = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      if (termination) return termination;
      if (child.pid === undefined) return Promise.resolve();
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { /* The group may already be gone or have escaped. */ }
        if (!rootExited) child.kill("SIGKILL");
        termination = Promise.resolve();
      } else {
        // Best effort on Windows: taskkill cannot recover a process tree after
        // its root has already exited. POSIX group cleanup is stronger.
        termination = new Promise<void>((done) => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
          killer.on("error", () => { child.kill("SIGKILL"); });
          killer.on("close", () => { child.kill("SIGKILL"); done(); });
        });
      }
      return termination;
    };
    const finalize = () => {
      // On deadline/cancellation, pipe EOF is not an authority to wait on:
      // an escaped descendant can retain inherited descriptors indefinitely.
      if (finishing || !rootExited || (!pipesClosed && !timedOut && !signal?.aborted)) return;
      finishing = true;
      clearTimeout(timer);
      void (async () => {
        try {
          await terminate();
          checkAbort(signal);
          if (timedOut) resolve(result("error", exitCode, "Test process exceeded the 30 second timeout"));
          else if (launchError) resolve(result("error", null, `Could not launch test process: ${launchError.message}`));
          else if (exitSignal !== null) resolve(result("error", exitCode, `Test process terminated by signal ${exitSignal}`));
          else if (exitCode === null) resolve(result("error", null, "Test process exited without an exit code"));
          else resolve(result(exitCode === 0 ? "passed" : "failed", exitCode));
        } catch (error) { reject(error); }
        finally { signal?.removeEventListener("abort", onAbort); }
      })();
    };
    const stop = () => {
      void terminate();
      // We can only kill our group/tree best-effort, not processes that create
      // another session. Release our handles even if those processes survive.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finalize();
    };
    const onAbort = () => { stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout.append(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.append(chunk); });
    // A driver is allowed to stop reading stdin (and still return a valid exit
    // status). In particular, EPIPE must not become an unhandled stream error.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      launchError = error;
      if (child.pid === undefined) rootExited = true;
      void terminate();
      finalize();
    });
    child.on("exit", (code, observedSignal) => {
      rootExited = true;
      exitCode = code;
      exitSignal = observedSignal;
      void terminate();
      finalize();
    });
    child.on("close", (code, observedSignal) => {
      if (!rootExited) {
        rootExited = true;
        exitCode = code;
        exitSignal = observedSignal;
      }
      pipesClosed = true;
      finalize();
    });
    child.stdin.end(tests.code, "utf8");
    // Account for a signal that became aborted before listener registration.
    if (signal?.aborted) onAbort();
  });
}

/** Run the teacher's process recipe verbatim, without interpreting its language. */
export async function runTests({ dataDirectory, questionId, answer, tests, signal }: {
  dataDirectory: string;
  questionId: string;
  answer: string;
  tests: CodingTests;
  signal?: AbortSignal;
}): Promise<CodingTestResult> {
  checkAbort(signal);
  if (!questionId || questionId === "." || questionId === ".." || /[/\\\0]/u.test(questionId) || path.isAbsolute(questionId)) {
    throw new Error("questionId must be a single safe path segment");
  }
  const runsDirectory = path.resolve(dataDirectory, "test-runs");
  const questionDirectory = path.resolve(runsDirectory, questionId);
  if (path.dirname(questionDirectory) !== runsDirectory) {
    throw new Error("questionId must be a single safe path segment");
  }
  let workspace: string | undefined;
  try {
    await mkdir(questionDirectory, { recursive: true });
    checkAbort(signal);
    workspace = await mkdtemp(path.join(questionDirectory, "attempt-"));
    checkAbort(signal);
    await writeFile(path.join(workspace, "answer.txt"), answer, "utf8");
    checkAbort(signal);
    return await observeProcess(workspace, tests, signal);
  } finally {
    try {
      if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
    } finally { checkAbort(signal); }
  }
}
