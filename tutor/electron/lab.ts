// The Lab: run code the model (or you) wrote, safely, and watch Python run step by step.
//   runCode    Python, JavaScript or TypeScript (Node strips the types), in a macOS sandbox:
//              no network, no writes outside a throwaway folder, no reading your home folder
//              (so nothing like ~/.ssh or an API key file can end up in the chat), 8 s limit.
//   traceCode  Python under sys.settrace: every line with the call stack and each frame's
//              variables; mutable objects get a #number so shared references are visible.
//   runExercise / runProjectTests  hidden tests (and tsc) against your code; see below.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

export type Language = "python" | "javascript" | "typescript"
export type RunResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; ms: number }
export type TraceFrame = { fn: string; line: number; locals: [string, string][] }
export type TraceStep = { event: "call" | "line" | "return" | "exception"; line: number; stack: TraceFrame[]; out: string; ret?: string }
export type Trace = { steps: TraceStep[]; stdout: string; error: string | null; truncated: boolean }

const LIMIT_MS = 8000
const MAX_OUT = 20_000

export function onPath(cmd: string, skip: string[] = []): string | null {
  const dirs = (process.env.PATH ?? "").split(":").concat(["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")])
  for (const d of dirs) {
    const p = path.join(d, cmd)
    if (skip.some((s) => p.startsWith(s))) continue
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return null
}

// Without a Node install, Tutor's own Electron runs JavaScript and TypeScript as Node
// (ELECTRON_RUN_AS_NODE, Node 24: it strips types and has node:test).
function electronNode(): string | null {
  return process.versions.electron ? process.execPath : null
}
const asNode = (cmd: string) => process.versions.electron && fs.realpathSync(cmd) === fs.realpathSync(process.execPath)

// Which tools exercises can use on this Mac (shown on the path when something is missing).
export function toolStatus(): { python: string | null; node: "system" | "bundled" | null; git: boolean; tsc: boolean } {
  return {
    python: onPath("python3", ["/usr/bin"]),
    node: onPath("node") ? "system" : electronNode() ? "bundled" : null,
    git: fs.existsSync(GIT_DIR + "/git"),
    tsc: !!tscPath()
  }
}

// /usr/bin/python3 is Xcode's stub (it can hang on a license prompt); prefer a real install.
function interpreter(lang: Language): string {
  const p = lang === "python" ? onPath("python3", ["/usr/bin"]) : (onPath("node") ?? electronNode())
  if (!p) throw new Error(lang === "python" ? "No Python 3 found. Install it from python.org (3.12 or newer) or with Homebrew (brew install python), then try again." : "No Node.js found. Install Node and try again.")
  // Run the real file: a link inside your home folder couldn't be followed from inside the sandbox.
  return fs.realpathSync(p)
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

// Everything allowed, then: no network, no writes except the scratch folder, no reads in your home
// folder except the scratch folder and wherever the interpreter itself lives.
function profile(scratch: string, interp: string, extraReads: string[] = []): string {
  const home = fs.realpathSync(os.homedir())
  const real = fs.realpathSync(interp)
  const prefix = path.dirname(path.dirname(real)) // …/bin/python3 → the install's root
  const reads = [scratch, ...extraReads, ...(prefix.startsWith(home) ? [prefix] : [])]
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath ${q(scratch)}) (literal "/dev/null") (regex #"^/dev/(tty|fd/)"))
(deny file-read* (subpath ${q(home)}))
(allow file-read* ${reads.map((r) => `(subpath ${q(r)})`).join(" ")})`
}

function run(cmd: string, args: string[], scratch: string, stdin?: string, o: { cwd?: string; reads?: string[]; limitMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile(scratch, cmd, o.reads), cmd, ...args], {
      cwd: o.cwd ?? scratch,
      env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", ...(asNode(cmd) ? { ELECTRON_RUN_AS_NODE: "1" } : {}), ...o.env },
      stdio: ["pipe", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(0, MAX_OUT * 2)))
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(0, MAX_OUT)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, o.limitMs ?? LIMIT_MS)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr.replace(new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/", "g"), ""), exitCode: code, timedOut, ms: Date.now() - t0 })
    })
    child.stdin.end(stdin ?? "")
  })
}

function scratchDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tutor-lab-")))
}

export async function runCode(lang: Language, code: string, stdin?: string): Promise<RunResult> {
  const cmd = interpreter(lang)
  const dir = scratchDir()
  try {
    const file = path.join(dir, lang === "python" ? "main.py" : lang === "typescript" ? "main.ts" : "main.mjs")
    fs.writeFileSync(file, code)
    const args = lang === "python" ? ["-I", "-B", file] : ["--no-warnings", file]
    const r = await run(cmd, args, dir, stdin)
    return { ...r, stdout: r.stdout.slice(0, MAX_OUT) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The tracer runs the user's code as "<lab>" and records every step inside it.
const TRACER = String.raw`
import sys, json, io, types
src = open(sys.argv[1], encoding="utf-8").read()
steps, out, ids = [], io.StringIO(), {}
MAX = 500
def ref(v):
    n = ids.setdefault(id(v), len(ids) + 1)
    return "#" + str(n)
def fmt(v, depth=0):
    try:
        if isinstance(v, types.GeneratorType):
            f = v.gi_frame
            return ref(v) + " generator " + (("paused at line " + str(f.f_lineno)) if f else "finished")
        if isinstance(v, (list, dict, set)) or (hasattr(v, "__dict__") and not isinstance(v, (type, types.FunctionType, types.ModuleType))):
            r = ref(v) + " " + repr(v)
        else:
            r = repr(v)
    except Exception:
        r = "<unprintable>"
    return r if len(r) <= 90 else r[:87] + "..."
def local_vars(f):
    out_ = []
    for k, v in f.f_locals.items():
        if k.startswith("__") or isinstance(v, (types.ModuleType, types.FunctionType, type, types.BuiltinFunctionType)):
            continue
        out_.append([k, fmt(v)])
    return out_[:30]
def stack(frame):
    s, f = [], frame
    while f is not None:
        if f.f_code.co_filename == "<lab>":
            s.append({"fn": "<module>" if f.f_code.co_name == "<module>" else f.f_code.co_name, "line": f.f_lineno, "locals": local_vars(f)})
        f = f.f_back
    return list(reversed(s))
class Stop(Exception): pass
def tracer(frame, event, arg):
    if frame.f_code.co_filename != "<lab>":
        return None
    if event in ("call", "line", "return", "exception"):
        if len(steps) >= MAX:
            raise Stop()
        step = {"event": event, "line": frame.f_lineno, "stack": stack(frame), "out": out.getvalue()[-3000:]}
        if event == "return":
            step["ret"] = fmt(arg)
        steps.append(step)
    return tracer
err, truncated = None, False
real = sys.stdout
sys.stdout = out
try:
    code = compile(src, "<lab>", "exec")
    sys.settrace(tracer)
    exec(code, {"__name__": "__main__"})
except Stop:
    truncated = True
except BaseException as e:
    err = type(e).__name__ + ": " + str(e)
finally:
    sys.settrace(None)
    sys.stdout = real
print(json.dumps({"steps": steps, "stdout": out.getvalue()[-20000:], "error": err, "truncated": truncated}))
`

export async function traceCode(code: string): Promise<Trace> {
  const cmd = interpreter("python")
  const dir = scratchDir()
  try {
    fs.writeFileSync(path.join(dir, "user.py"), code)
    fs.writeFileSync(path.join(dir, "tracer.py"), TRACER)
    const r = await run(cmd, ["-I", "-B", path.join(dir, "tracer.py"), path.join(dir, "user.py")], dir)
    if (r.timedOut) throw new Error("It ran longer than 8 seconds (an endless loop?), so there's no trace.")
    const line = r.stdout.trim().split("\n").pop() ?? ""
    try {
      return JSON.parse(line) as Trace
    } catch {
      throw new Error(r.stderr.trim().split("\n").slice(-3).join("\n") || "The tracer didn't return a trace.")
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function runForModel(lang: Language, r: RunResult): string {
  const head = r.timedOut ? `Stopped after ${LIMIT_MS / 1000}s (still running: endless loop or waiting for input).` : `Exit code ${r.exitCode} in ${r.ms} ms (${lang}).`
  return `${head}\nstdout:\n${r.stdout || "(nothing)"}${r.stderr.trim() ? `\nstderr:\n${r.stderr.trim()}` : ""}`
}

// ---------- exercises and project tests ----------
// An exercise is your code plus hidden tests. Python tests are plain `def test_…()` functions with
// assert (pytest runs them too); TypeScript/JavaScript tests use node:test and node:assert, run by
// Node's own test runner. TypeScript is also type-checked with tsc --strict (the native compiler
// only reads files, so it runs outside the sandbox). Projects run the same way over their tests/ folder.

export type TestCase = { name: string; ok: boolean; message?: string }
export type TypeError_ = { file: string; line: number; message: string }
export type TestRun = { ok: boolean; tests: TestCase[]; typeErrors: TypeError_[]; loadError?: string; stdout: string; timedOut: boolean; ms: number }

const MARK = "@@TUTOR-RESULT@@"
const PY_HARNESS = String.raw`
import sys, json, traceback, importlib.util, io, contextlib, os, ast
root = sys.argv[1]
files = sys.argv[3:]
preload = sys.argv[2]
for p in (os.path.join(root, "src"), root):
    sys.path.insert(0, p)
out = io.StringIO()
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m
def where(tb, suffix):
    fr = [f for f in traceback.extract_tb(tb) if f.filename.endswith(suffix)]
    return fr[-1] if fr else None
def done(obj):
    obj["stdout"] = out.getvalue()[-4000:]
    print("${MARK}" + json.dumps(obj))
    sys.exit(0)
if preload:
    try:
        with contextlib.redirect_stdout(out):
            load("solution", preload)
    except BaseException as e:
        f = where(e.__traceback__, "solution.py")
        line = f.lineno if f else getattr(e, "lineno", None)
        text = type(e).__name__ + ": " + str(e)
        done({"loadError": text + (" (line " + str(line) + ")" if line and "line " + str(line) not in text else "")})
results = []
for i, path in enumerate(files):
    try:
        with contextlib.redirect_stdout(out):
            mod = load("tests_" + str(i), path)
    except BaseException as e:
        f = where(e.__traceback__, os.path.basename(path))
        results.append({"name": os.path.basename(path), "ok": False, "message": "The tests couldn't load: " + type(e).__name__ + ": " + str(e)})
        continue
    for name, fn in list(vars(mod).items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        label = name[5:].replace("_", " ")
        try:
            with contextlib.redirect_stdout(out):
                fn()
            results.append({"name": label, "ok": True})
        except AssertionError as e:
            f = where(e.__traceback__, os.path.basename(path))
            msg = str(e)
            detail = ""
            # Like pytest: for a failed "assert a == b", show what each side actually was.
            try:
                frame = [fr for fr, _ in traceback.walk_tb(e.__traceback__) if fr.f_code.co_filename.endswith(os.path.basename(path))][-1]
                node = ast.parse(f.line.strip()).body[0]
                if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare) and len(node.test.ops) == 1:
                    ev = lambda n: eval(compile(ast.Expression(n), "<assert>", "eval"), frame.f_globals, frame.f_locals)
                    left, right = ev(node.test.left), ev(node.test.comparators[0])
                    detail = "got:      " + repr(left)[:300] + "\nexpected: " + repr(right)[:300]
            except Exception:
                pass
            results.append({"name": label, "ok": False, "message": (msg + "\n" if msg else "") + (detail or (("assert failed: " + f.line) if f and f.line else "assertion failed"))})
        except BaseException as e:
            f = where(e.__traceback__, "solution.py") or where(e.__traceback__, ".py")
            at = (" (" + os.path.basename(f.filename) + " line " + str(f.lineno) + ")") if f else ""
            results.append({"name": label, "ok": False, "message": type(e).__name__ + ": " + str(e) + at})
done({"tests": results})
`

function parseTap(out: string): TestCase[] {
  const tests: TestCase[] = []
  const lines = out.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(lines[i])
    if (!m) continue
    const t: TestCase = { name: m[2].trim(), ok: m[1] === "ok" }
    if (!t.ok) {
      const block: string[] = []
      for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) block.push(lines[j])
      const err = block.findIndex((l) => /^\s+error: /.test(l))
      let msg = ""
      if (err >= 0) {
        const first = block[err].replace(/^\s+error: /, "")
        if (first.startsWith("|")) {
          for (let k = err + 1; k < block.length && /^\s{4}/.test(block[k]); k++) msg += block[k].trim() + "\n"
        } else msg = first.replace(/^'|'$/g, "")
      }
      const exp = block.find((l) => /^\s+expected: /.test(l))
      const act = block.find((l) => /^\s+actual: /.test(l))
      if (exp && act) msg = `${msg.trim()}\nexpected: ${exp.replace(/^\s+expected: /, "")}\nactual:   ${act.replace(/^\s+actual: /, "")}`
      t.message = msg.trim().slice(0, 800) || "failed"
    }
    tests.push(t)
  }
  return tests
}

// The native TypeScript compiler: bundled with the app, or from node_modules in development.
function tscPath(): string | null {
  const roots: string[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron")
    if (app?.getAppPath) roots.push(app.getAppPath())
  } catch {}
  roots.push(process.cwd())
  const cands = [process.env.TUTOR_TSC ?? "", ...roots.flatMap((r) => [path.join(r, "vendor/typescript-native/lib/tsc"), path.join(r, "node_modules/@typescript/typescript-darwin-arm64/lib/tsc")])]
  return cands.find((c) => c && fs.existsSync(c)) ?? null
}

const STRICT = ["--noEmit", "--strict", "--noUncheckedIndexedAccess", "--erasableSyntaxOnly", "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext", "--allowImportingTsExtensions", "--skipLibCheck", "--pretty", "false"]

function typeCheck(cwd: string, args: string[]): Promise<TypeError_[]> {
  const tsc = tscPath()
  if (!tsc) return Promise.resolve([{ file: "", line: 0, message: "The TypeScript compiler isn't available, so types weren't checked." }])
  return new Promise((resolve) => {
    const child = spawn(tsc, args, { cwd, env: { PATH: "/usr/bin:/bin" } })
    let out = ""
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.stderr.on("data", (d: Buffer) => (out += d.toString()))
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    child.on("close", () => {
      clearTimeout(timer)
      const errs: TypeError_[] = []
      for (const l of out.split("\n")) {
        const m = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(l.trim())
        if (m) errs.push({ file: path.basename(m[1]), line: Number(m[2]), message: m[3] })
      }
      resolve(errs.slice(0, 30))
    })
  })
}

function fromPython(r: RunResult): Omit<TestRun, "typeErrors"> {
  const line = r.stdout.split("\n").find((l) => l.startsWith(MARK))
  if (r.timedOut) return { ok: false, tests: [], loadError: `Stopped after ${LIMIT_MS / 1000}s: an endless loop, or something waiting for input.`, stdout: "", timedOut: true, ms: r.ms }
  if (!line) return { ok: false, tests: [], loadError: r.stderr.trim().split("\n").slice(-4).join("\n") || "The tests didn't report back.", stdout: r.stdout.slice(0, 4000), timedOut: false, ms: r.ms }
  const j = JSON.parse(line.slice(MARK.length)) as { tests?: TestCase[]; loadError?: string; stdout: string }
  const tests = j.tests ?? []
  return { ok: !j.loadError && tests.length > 0 && tests.every((t) => t.ok), tests, loadError: j.loadError, stdout: j.stdout, timedOut: false, ms: r.ms }
}

function fromNode(r: RunResult): Omit<TestRun, "typeErrors"> {
  if (r.timedOut) return { ok: false, tests: [], loadError: `Stopped after ${LIMIT_MS / 1000}s: an endless loop, or something waiting for input.`, stdout: "", timedOut: true, ms: r.ms }
  const tests = parseTap(r.stdout)
  // A file that fails to load shows up as one failed "test" named after the file.
  const loadError = !tests.length ? r.stderr.trim().split("\n").slice(-6).join("\n") || r.stdout.trim().split("\n").slice(-6).join("\n") || "The tests didn't run." : undefined
  const stdout = r.stdout.split("\n").filter((l) => /^# (?!Subtest|tests|suites|pass|fail|cancelled|skipped|todo|duration)/.test(l)).map((l) => l.slice(2)).join("\n")
  return { ok: !loadError && tests.every((t) => t.ok), tests, loadError, stdout, timedOut: false, ms: r.ms }
}

export async function runExercise(lang: Language, code: string, tests: string, typeTests?: string): Promise<TestRun> {
  const dir = scratchDir()
  try {
    if (lang === "python") {
      fs.writeFileSync(path.join(dir, "solution.py"), code)
      fs.writeFileSync(path.join(dir, "test_solution.py"), tests)
      fs.writeFileSync(path.join(dir, "harness.py"), PY_HARNESS)
      const r = await run(interpreter("python"), ["-I", "-B", path.join(dir, "harness.py"), dir, path.join(dir, "solution.py"), path.join(dir, "test_solution.py")], dir)
      return { ...fromPython(r), typeErrors: [] }
    }
    const ts = lang === "typescript"
    const sol = ts ? "solution.ts" : "solution.mjs"
    fs.writeFileSync(path.join(dir, sol), code)
    // Whatever the model wrote as the import path, point it at the real file.
    const t = tests.replace(/(from\s+["'])\.\/solution(\.[mc]?[jt]s)?(["'])/g, `$1./${sol}$3`)
    const testFile = ts ? "solution.test.ts" : "solution.test.mjs"
    fs.writeFileSync(path.join(dir, testFile), t)
    const checks: Promise<TypeError_[]> = ts
      ? (() => {
          const files = [sol]
          if (typeTests?.trim()) {
            fs.writeFileSync(path.join(dir, "types.check.ts"), typeTests.replace(/(from\s+["'])\.\/solution(\.[mc]?[jt]s)?(["'])/g, `$1./${sol}$3`))
            files.push("types.check.ts")
          }
          return typeCheck(dir, [...STRICT, ...files])
        })()
      : Promise.resolve([])
    const [r, typeErrors] = await Promise.all([t.trim() ? run(interpreter(lang), ["--no-warnings", "--test", "--test-reporter=tap", testFile], dir) : null, checks])
    const res = r ? fromNode(r) : { ok: true, tests: [], stdout: "", timedOut: false, ms: 0 }
    return { ...res, ok: res.ok && !typeErrors.length, typeErrors }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Run a lesson's `show:` fixture against solution code and return the value as JSON: the world
// card's picture is what a function returned, not what it printed. Python evaluates the expression
// inside the solution module's namespace; TypeScript imports it and evaluates in sloppy mode so a
// bare `play(...)` works like it does in the tests.
const SHOW_MARK = "@@TUTOR-SHOW@@"
export async function runShow(lang: "python" | "typescript", code: string, expr: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const dir = scratchDir()
  try {
    let script: string
    let args: string[]
    if (lang === "python") {
      fs.writeFileSync(path.join(dir, "solution.py"), code)
      script = path.join(dir, "show.py")
      fs.writeFileSync(
        script,
        // -I drops the script's own folder from sys.path, so put the solution's folder back in.
        "import json, os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\ntry:\n    import solution\n    v = eval(" +
          JSON.stringify(expr) +
          ", vars(solution))\n    out = json.dumps(v)\nexcept BaseException as e:\n    out = json.dumps({'__error__': type(e).__name__ + ': ' + str(e)})\nprint('" +
          SHOW_MARK +
          "' + out)\n"
      )
      args = ["-I", "-B", script]
    } else {
      fs.writeFileSync(path.join(dir, "solution.ts"), code)
      script = path.join(dir, "show.mjs")
      fs.writeFileSync(
        script,
        'import * as sol from "./solution.ts"\n' +
          "try {\n" +
          "  const fn = new Function('sol', 'with (sol) { return eval(' + " +
          JSON.stringify(JSON.stringify(expr)) +
          " + ') }')\n" +
          "  const v = fn(sol)\n" +
          "  console.log('" +
          SHOW_MARK +
          "' + JSON.stringify(v ?? null))\n" +
          "} catch (e) {\n" +
          "  console.log('" +
          SHOW_MARK +
          "' + JSON.stringify({__error__: String(e && e.message ? e.message : e)}))\n" +
          "}\n"
      )
      args = ["--no-warnings", script]
    }
    const r = await run(interpreter(lang), args, dir)
    if (r.timedOut) return { ok: false, error: "The fixture ran for more than 8 seconds." }
    const line = [...r.stdout.split("\n")].reverse().find((l) => l.startsWith(SHOW_MARK))
    if (!line) return { ok: false, error: r.stderr.trim().split("\n").slice(-3).join("\n") || "The fixture didn't return a value." }
    let j: unknown
    try {
      j = JSON.parse(line.slice(SHOW_MARK.length))
    } catch {
      return { ok: false, error: "The fixture's value isn't JSON." }
    }
    const o = j as { __error__?: string }
    if (o && typeof o === "object" && typeof o.__error__ === "string") return { ok: false, error: o.__error__ }
    return { ok: true, value: j }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A project's own tests (tests/ folder), run read-only in the sandbox with its own environment
// (.venv for Python, node_modules for TypeScript), plus tsc against its tsconfig.
export async function runProjectTests(root: string, lang: "python" | "typescript"): Promise<TestRun> {
  const real = fs.realpathSync(root)
  const dir = scratchDir()
  try {
    const testsDir = path.join(real, "tests")
    const all = fs.existsSync(testsDir) ? fs.readdirSync(testsDir, { recursive: true }).map(String) : []
    if (lang === "python") {
      const files = all.filter((f) => /(^|\/)test_[^/]*\.py$/.test(f)).sort().map((f) => path.join(testsDir, f))
      if (!files.length) return { ok: false, tests: [], typeErrors: [], loadError: "There are no tests/test_*.py files yet.", stdout: "", timedOut: false, ms: 0 }
      const venv = path.join(real, ".venv/bin/python")
      const py = fs.existsSync(venv) ? venv : interpreter("python")
      fs.writeFileSync(path.join(dir, "harness.py"), PY_HARNESS)
      const r = await run(py, ["-B", path.join(dir, "harness.py"), real, "", ...files], dir, undefined, { cwd: real, reads: [real], limitMs: 30_000 })
      return { ...fromPython(r), typeErrors: [] }
    }
    const files = all.filter((f) => /\.test\.[mc]?[jt]s$/.test(f)).sort().map((f) => path.join("tests", f))
    if (!files.length) return { ok: false, tests: [], typeErrors: [], loadError: "There are no tests/*.test.ts files yet.", stdout: "", timedOut: false, ms: 0 }
    const [r, typeErrors] = await Promise.all([
      run(interpreter("typescript"), ["--no-warnings", "--test", "--test-reporter=tap", ...files], dir, undefined, { cwd: real, reads: [real], limitMs: 30_000 }),
      fs.existsSync(path.join(real, "tsconfig.json")) ? typeCheck(real, ["--noEmit", "-p", real, "--pretty", "false"]) : Promise.resolve([])
    ])
    const res = fromNode(r)
    return { ...res, ok: res.ok && !typeErrors.length, typeErrors }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A project lesson's hidden acceptance tests (test_*.py, the same harness as exercises) against a
// folder on your Mac. The tests sit in a scratch folder; the project folder is on sys.path and in
// PROJECT_ROOT, readable but not writable, and the tests' own files go to the scratch folder (the
// working directory and TMPDIR). The project's .venv Python is used when there is one. A "local"
// project needs its own toolchain (packages, a database, the network), so it runs outside the
// sandbox, in the project folder, the way you'd run it in Terminal.
export async function runFolderTests(root: string, tests: Record<string, string>, local = false): Promise<TestRun> {
  if (!fs.existsSync(root)) return { ok: false, tests: [], typeErrors: [], loadError: "The project folder doesn't exist yet. Press Open the folder first.", stdout: "", timedOut: false, ms: 0 }
  const real = fs.realpathSync(root)
  const dir = scratchDir()
  try {
    const files = Object.entries(tests).map(([name, body]) => {
      const f = path.join(dir, path.basename(name))
      fs.writeFileSync(f, body)
      return f
    })
    fs.writeFileSync(path.join(dir, "harness.py"), PY_HARNESS)
    const venv = path.join(real, ".venv/bin/python")
    const py = fs.existsSync(venv) ? venv : interpreter("python")
    const args = ["-B", path.join(dir, "harness.py"), real, "", ...files]
    const r = local
      ? await runOutside(py, args, { cwd: real, env: { PROJECT_ROOT: real, TEST_TMP: dir }, limitMs: 120_000 })
      : await run(py, args, dir, undefined, { cwd: dir, reads: [real], limitMs: 30_000, env: { PROJECT_ROOT: real, TEST_TMP: dir } })
    return { ...fromPython(r), typeErrors: [] }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// No sandbox: only for "local" projects, whose code is yours, in your own folder.
function runOutside(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; limitMs: number }): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8", NO_COLOR: "1", ...o.env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(0, MAX_OUT * 2)))
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(0, MAX_OUT)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, o.limitMs)
    child.on("error", (e) => (stderr += e.message))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut, ms: Date.now() - t0 })
    })
  })
}

export function testRunForModel(t: TestRun): string {
  if (t.timedOut) return t.loadError ?? "Timed out."
  const lines: string[] = []
  if (t.loadError) lines.push(`It didn't load: ${t.loadError}`)
  if (t.tests.length) lines.push(`Tests: ${t.tests.filter((x) => x.ok).length}/${t.tests.length} passed.`, ...t.tests.map((x) => `${x.ok ? "✓" : "✗"} ${x.name}${x.ok ? "" : `: ${(x.message ?? "").replace(/\n/g, " | ")}`}`))
  if (t.typeErrors.length) lines.push(`Type errors (${t.typeErrors.length}):`, ...t.typeErrors.map((e) => `${e.file}:${e.line} ${e.message}`))
  if (t.stdout.trim()) lines.push(`Printed:\n${t.stdout.trim().slice(0, 1500)}`)
  lines.push(t.ok ? "All passing." : "Not passing yet.")
  return lines.join("\n")
}

// ---------- shell steps ----------
// A lesson's shell task: its files in a throwaway folder, an optional setup script (say, a few git
// commits), then your commands under bash, then the step's verify script (exit 0 = pass). Same
// sandbox as the rest of the Lab. git is the Command Line Tools one (/usr/bin/git is Xcode's stub).
export type ShellRun = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; verify?: { ok: boolean; out: string } }

const GIT_DIR = "/Library/Developer/CommandLineTools/usr/bin"

export async function runShell(o: { files: Record<string, string>; setup?: string; script: string; verify?: string }): Promise<ShellRun> {
  const dir = scratchDir()
  const work = path.join(dir, "work")
  try {
    fs.mkdirSync(work)
    for (const [name, body] of Object.entries(o.files)) {
      const f = path.join(work, name)
      if (!f.startsWith(work + path.sep)) continue
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, body)
      if (/\.sh$/.test(name) || body.startsWith("#!")) fs.chmodSync(f, 0o755)
    }
    const env = {
      PATH: `${fs.existsSync(GIT_DIR) ? GIT_DIR + ":" : ""}/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      USER: "learner",
      PS1: "$ ",
      DEVELOPER_DIR: "/Library/Developer/CommandLineTools",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Learner",
      GIT_AUTHOR_EMAIL: "learner@example.com",
      GIT_COMMITTER_NAME: "Learner",
      GIT_COMMITTER_EMAIL: "learner@example.com",
      GIT_AUTHOR_DATE: "2026-01-05T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-05T10:00:00Z",
      GIT_PAGER: "cat",
      PAGER: "cat",
      TERM: "dumb"
    }
    fs.writeFileSync(path.join(dir, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n")
    const bash = (script: string) => run("/bin/bash", ["--noprofile", "--norc", "-c", script], dir, undefined, { cwd: work, env })
    if (o.setup?.trim()) {
      const s = await bash(o.setup)
      if (s.exitCode !== 0) return { stdout: "", stderr: `The exercise's setup failed: ${s.stderr || s.stdout}`, exitCode: s.exitCode, timedOut: s.timedOut }
    }
    const r = await bash(o.script)
    const clip = (t: string) => t.split(work + "/").join("").split(dir).join("~").slice(0, MAX_OUT)
    const res: ShellRun = { stdout: clip(r.stdout), stderr: clip(r.stderr), exitCode: r.exitCode, timedOut: r.timedOut }
    if (o.verify?.trim() && !r.timedOut) {
      const v = await bash(o.verify)
      res.verify = { ok: v.exitCode === 0, out: clip((v.stdout + v.stderr).trim()) }
    }
    return res
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
