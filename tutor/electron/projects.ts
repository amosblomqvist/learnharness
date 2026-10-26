// Project checkpoints: the hands-on builds happen in your IDE, in a real folder. Tutor scaffolds the
// project with a spec and failing tests for the first milestone; you build it in PyCharm/WebStorm;
// "Check my project" runs the tests (sandboxed, read-only) and hands your code to Tutor for a review;
// passing unlocks the next milestone's spec and tests. Later milestones stay here until then.
// One JSON file in userData; project folders live in ~/TutorProjects by default.
import { app } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { runProjectTests, testRunForModel, type TestRun } from "./lab"
import { getSettings } from "./settings"

const exec = promisify(execFile)

export type ProjectFile = { path: string; content: string }
export type Milestone = { title: string; spec: string; tests: ProjectFile[]; passedAt?: number; review?: string }
export type Project = { id: string; title: string; language: "python" | "typescript"; dir: string; goalId?: string; nodeId?: string; milestones: Milestone[]; current: number; createdAt: number; checkedAt?: number; lastRun?: { ok: boolean; passed: number; total: number; typeErrors: number } ; done?: number }
// What the window sees: never the tests of milestones not reached yet.
export type ProjectView = { id: string; title: string; language: string; dir: string; goalId?: string; nodeId?: string; current: number; milestones: { title: string; state: "done" | "open" | "locked" }[]; lastRun?: Project["lastRun"]; done?: number }

const file = () => path.join(app.getPath("userData"), "projects.json")
let cache: Record<string, Project> | null = null
const load = () => {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(file(), "utf8"))
  } catch {
    cache = {}
  }
  return cache!
}
const save = () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(load(), null, 1))
}

export const projectsRoot = () => process.env.TUTOR_PROJECTS_DIR || getSettings().projectsDir || path.join(os.homedir(), "TutorProjects")

export function view(p: Project): ProjectView {
  return {
    id: p.id,
    title: p.title,
    language: p.language,
    dir: p.dir,
    goalId: p.goalId,
    nodeId: p.nodeId,
    current: p.current,
    milestones: p.milestones.map((m, i) => ({ title: m.title, state: m.passedAt ? "done" : i === p.current ? "open" : "locked" })),
    lastRun: p.lastRun,
    done: p.done
  }
}

export const getProject = (id: string) => load()[id] ?? null
export const listProjects = () => Object.values(load()).sort((a, b) => (b.checkedAt ?? b.createdAt) - (a.checkedAt ?? a.createdAt))
export const projectForNode = (goalId: string, nodeId: string) => listProjects().find((p) => p.goalId === goalId && p.nodeId === nodeId) ?? null

// Which project a "check my project" means: the id if given, else the one this lesson is about,
// else the one whose folder the IDE has open, else the most recent.
export function findProject(o: { id?: string; goalId?: string; nodeId?: string; workspace?: string }): Project | null {
  if (o.id) return getProject(o.id)
  if (o.goalId && o.nodeId) {
    const p = projectForNode(o.goalId, o.nodeId)
    if (p) return p
  }
  if (o.workspace) {
    const w = path.resolve(o.workspace)
    const p = listProjects().find((x) => w === x.dir || w.startsWith(x.dir + path.sep) || x.dir.startsWith(w + path.sep))
    if (p) return p
  }
  return listProjects().find((p) => !p.done) ?? null
}

function safeRel(p: string): string {
  const n = path.normalize(p).replace(/^(\.\/)+/, "")
  if (!n || path.isAbsolute(n) || n.startsWith("..")) throw new Error(`"${p}" isn't a relative path inside the project.`)
  return n
}

function writeFiles(dir: string, files: ProjectFile[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const rel = safeRel(f.path)
    if (f.content.length > 200_000) throw new Error(`${rel} is too large for a scaffold.`)
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.content)
    out.push(rel)
  }
  return out
}

const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { timeout: 15_000, env: { ...process.env, DEVELOPER_DIR: fs.existsSync("/Library/Developer/CommandLineTools") ? "/Library/Developer/CommandLineTools" : (process.env.DEVELOPER_DIR ?? "") } })

function specMarkdown(p: Project): string {
  const reached = p.milestones.slice(0, p.current + 1)
  return `# ${p.title}\n\nBuilt with Tutor. Each milestone has a spec and tests in \`tests/\`; make them pass, then ask Tutor to **check your project** (in Tutor, or in your IDE's AI chat). Passing unlocks the next milestone.\n\n${reached
    .map((m, i) => `## Milestone ${i + 1}: ${m.title}${m.passedAt ? " ✓" : ""}\n\n${m.spec.trim()}\n`)
    .join("\n")}${p.current + 1 < p.milestones.length ? `\n_${p.milestones.length - p.current - 1 === 1 ? "One more milestone unlocks" : `${p.milestones.length - p.current - 1} more milestones unlock`} as you go._\n` : ""}\n## Running the tests yourself\n\n${p.language === "python" ? "`uv run pytest` (or `python -m pytest`) from this folder." : "`node --test tests/` from this folder."}\n`
}

export async function startProject(o: { title: string; language: "python" | "typescript"; files: ProjectFile[]; milestones: Milestone[]; goalId?: string; nodeId?: string }): Promise<Project> {
  if (!o.milestones.length) throw new Error("A project needs at least one milestone.")
  const slug = o.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project"
  const root = projectsRoot()
  let dir = path.join(root, slug)
  for (let i = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; i++) dir = path.join(root, `${slug}-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  const p: Project = { id: crypto.randomUUID(), title: o.title.trim(), language: o.language, dir, goalId: o.goalId, nodeId: o.nodeId, milestones: o.milestones.map((m) => ({ title: m.title, spec: m.spec, tests: m.tests })), current: 0, createdAt: Date.now() }
  writeFiles(dir, o.files)
  writeFiles(dir, p.milestones[0].tests)
  fs.writeFileSync(path.join(dir, "README.md"), specMarkdown(p))
  if (!o.files.some((f) => safeRel(f.path) === ".gitignore")) fs.writeFileSync(path.join(dir, ".gitignore"), p.language === "python" ? ".venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n" : "node_modules/\ndist/\n")
  try {
    await git(dir, "init", "-q")
    await git(dir, "add", "-A")
    await git(dir, "-c", "user.name=Tutor", "-c", "user.email=tutor@localhost", "commit", "-q", "-m", "Scaffold from Tutor")
  } catch {}
  load()[p.id] = p
  save()
  return p
}

// What changed since the scaffold (git), or the source files if there's no git.
async function codeForReview(p: Project): Promise<string> {
  try {
    const base = (await git(p.dir, "rev-list", "--max-parents=0", "HEAD")).stdout.trim().split("\n")[0]
    await git(p.dir, "add", "-N", ".")
    const diff = (await git(p.dir, "diff", base, "--", ".", ":(exclude)tests", ":(exclude)README.md")).stdout
    if (diff.trim()) return `Changes since the scaffold (git diff):\n\`\`\`diff\n${diff.slice(0, 40_000)}\n\`\`\``
  } catch {}
  const skip = /(^|\/)(\.venv|node_modules|\.git|dist|__pycache__|tests|\.pytest_cache)(\/|$)/
  const files = fs.readdirSync(p.dir, { recursive: true }).map(String).filter((f) => !skip.test(f) && /\.(py|ts|tsx|js|mjs|json|toml)$/.test(f) && !/lock/.test(f))
  let out = ""
  for (const f of files) {
    const c = fs.readFileSync(path.join(p.dir, f), "utf8")
    if (out.length + c.length > 40_000) break
    out += `\n--- ${f}\n${c}`
  }
  return `Source files:${out || " (none)"}`
}

export async function checkProject(p: Project): Promise<{ run: TestRun; text: string }> {
  if (!fs.existsSync(p.dir)) return { run: { ok: false, tests: [], typeErrors: [], loadError: "missing", stdout: "", timedOut: false, ms: 0 }, text: `The project folder ${p.dir} is gone.` }
  const run = await runProjectTests(p.dir, p.language)
  p.checkedAt = Date.now()
  p.lastRun = { ok: run.ok, passed: run.tests.filter((t) => t.ok).length, total: run.tests.length, typeErrors: run.typeErrors.length }
  save()
  const m = p.milestones[p.current]
  const code = await codeForReview(p)
  const text = p.done
    ? `"${p.title}" is already complete (all ${p.milestones.length} milestones). Latest run:\n${testRunForModel(run)}\n${code}\nReview it if they asked; otherwise suggest a stretch goal.`
    : `Project "${p.title}" (${p.language}) at ${p.dir.replace(os.homedir(), "~")}, milestone ${p.current + 1} of ${p.milestones.length}: ${m.title}\nSpec:\n${m.spec}\n\nTest run:\n${testRunForModel(run)}\n\n${code}\n\n${
        run.ok
          ? `All tests for this milestone pass. Review the code like a senior colleague: what's good, what to fix (quote lines), one idea to learn from; keep it short. Then call advance_project with id "${p.id}" and a one-paragraph review, which unlocks the next milestone.`
          : "Not passing yet. Point them at the first failure and what it tells them, as a hint; don't write the fix into their project."
      }`
  return { run, text }
}

export function advanceProject(p: Project, review: string): { text: string; project: Project } {
  if (p.done) return { text: "The project is already complete.", project: p }
  if (!p.lastRun?.ok) return { text: "The current milestone isn't passing on the last check, so it can't advance. Run check_project first.", project: p }
  const m = p.milestones[p.current]
  m.passedAt = Date.now()
  m.review = review.trim().slice(0, 4000)
  if (p.current + 1 >= p.milestones.length) {
    p.done = Date.now()
    save()
    fs.writeFileSync(path.join(p.dir, "README.md"), specMarkdown(p))
    return { text: `That was the last milestone: "${p.title}" is complete.${p.goalId && p.nodeId ? " Mark the project node solid with mark_node." : ""}`, project: p }
  }
  p.current++
  const next = p.milestones[p.current]
  writeFiles(p.dir, next.tests)
  p.lastRun = undefined
  save()
  fs.writeFileSync(path.join(p.dir, "README.md"), specMarkdown(p))
  return { text: `Milestone ${p.current} passed and was recorded. Unlocked milestone ${p.current + 1}: ${next.title}. Its tests are now in tests/ and its spec is in README.md.\nSpec:\n${next.spec}\nTell them what's next in a sentence or two.`, project: p }
}

// Open the folder in the IDE that fits the language (PyCharm for Python, WebStorm for TypeScript).
export async function openProject(p: Project): Promise<string> {
  const prefer = p.language === "python" ? ["PyCharm", "PyCharm Professional Edition", "PyCharm CE"] : ["WebStorm", "IntelliJ IDEA", "IntelliJ IDEA Ultimate"]
  for (const name of prefer) {
    const appPath = [`/Applications/${name}.app`, path.join(os.homedir(), "Applications", `${name}.app`)].find((x) => fs.existsSync(x))
    if (!appPath) continue
    await exec("open", ["-na", appPath, "--args", p.dir])
    return name
  }
  await exec("open", [p.dir])
  return "Finder"
}
