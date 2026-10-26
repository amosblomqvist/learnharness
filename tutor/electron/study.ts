// The study app's progress, in one JSON file (userData/study.json): your path (modules in order),
// finished lessons, step attempts, review cards and the days you studied. The window owns the
// logic; this file only loads, saves, and runs code and shell steps in the Lab's sandbox.
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { runCode, runExercise, runFolderTests, runShell, runShow, toolStatus, type Language } from "./lab"
import { checkMachine, closeMachine, closeOwnedBy, killShell, labStatus, openMachine, openShell, resizeShell, runServerTask, runSetup, writeShell, type LabTask } from "./linuxlab"

const file = () => path.join(app.getPath("userData"), "study.json")

export function loadStudy(): unknown {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"))
  } catch {
    return null
  }
}

export function saveStudy(state: unknown): void {
  const f = file()
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, f)
}

// A lesson finished on the farm (Root Access) is noted against the lesson id it teaches.
export function recordFarm(node: string): void {
  const s = (loadStudy() ?? { v: 1 }) as { farm?: Record<string, number> }
  s.farm = { ...s.farm, [node]: (s.farm?.[node] ?? 0) + 1 }
  saveStudy(s)
}

// Project lessons are built in real folders, one per project, opened in your own editor.
export const projectsRoot = () => process.env.TUTOR_PROJECTS ?? path.join(app.getPath("home"), "Desktop", "projects", "quest-projects")
const projectDir = (folder: string) => {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(folder)) throw new Error("bad project folder name")
  return path.join(projectsRoot(), folder)
}
// The starting files are written once; after that the folder is yours and is never overwritten.
function ensureProject(folder: string, files: Record<string, string>): string {
  const dir = projectDir(folder)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel)
    if (!f.startsWith(dir + path.sep) || fs.existsSync(f)) continue
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, body)
  }
  return dir
}
// PyCharm (Professional, then Community) if it's installed, otherwise Finder.
function openInEditor(dir: string): Promise<string> {
  const tryBundle = (ids: string[]): Promise<string> =>
    ids.length ? new Promise((res) => execFile("/usr/bin/open", ["-b", ids[0], dir], (err) => (err ? tryBundle(ids.slice(1)).then(res) : res("PyCharm")))) : shell.openPath(dir).then(() => "Finder")
  return tryBundle(["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"])
}

type RunReq =
  | { kind: "code"; lang: Language; code: string; tests: string; types?: string }
  | { kind: "run"; lang: Language; code: string; stdin?: string }
  | { kind: "show"; lang: "python" | "typescript"; code: string; expr: string }
  | ({ kind: "shell"; files: Record<string, string>; setup?: string; script: string; verify?: string; vm?: boolean; peerVerify?: string } & Omit<LabTask, "files" | "setup">)

export function registerStudy(): void {
  ipcMain.handle("study:load", () => loadStudy())
  ipcMain.handle("study:tools", () => toolStatus())
  ipcMain.handle("study:project", async (_e, r: { action: "open" | "finder" | "check" | "where"; folder: string; files?: Record<string, string>; tests?: Record<string, string>; local?: boolean }) => {
    const dir = projectDir(r.folder)
    if (r.action === "where") return { dir, exists: fs.existsSync(dir) }
    if (r.action === "open") return { dir: ensureProject(r.folder, r.files ?? {}), app: await openInEditor(ensureProject(r.folder, r.files ?? {})) }
    if (r.action === "finder") return { dir: ensureProject(r.folder, r.files ?? {}), app: await shell.openPath(ensureProject(r.folder, r.files ?? {})).then(() => "Finder") }
    return runFolderTests(dir, r.tests ?? {}, !!r.local)
  })
  ipcMain.handle("study:save", (_e, state: unknown) => {
    if (!state || typeof state !== "object") return false
    // The farm's counts are written here, never by the window: keep them.
    const disk = loadStudy() as { farm?: unknown } | null
    saveStudy({ ...state, farm: disk?.farm ?? {} })
    return true
  })
  ipcMain.handle("study:run", (_e, r: RunReq) => {
    if (r.kind === "code") return runExercise(r.lang, r.code, r.tests, r.types)
    if (r.kind === "run") return runCode(r.lang, r.code, typeof r.stdin === "string" ? r.stdin : undefined)
    if (r.kind === "show") return runShow(r.lang, r.code, r.expr)
    const o = { files: r.files ?? {}, setup: r.setup, script: String(r.script ?? ""), verify: r.verify }
    return r.vm ? runServerTask({ ...o, peer: r.peer, peerSetup: r.peerSetup, peerVerify: r.peerVerify, fullvm: r.fullvm, disks: r.disks }) : runShell(o)
  })
  // Live lab machines: one per step on screen, deleted when the step or its window goes away.
  const owners = new Set<number>()
  ipcMain.handle("lab:open", (e, t: LabTask) => {
    const wc = e.sender
    if (!owners.has(wc.id)) {
      owners.add(wc.id)
      const id = wc.id
      wc.once("destroyed", () => (owners.delete(id), closeOwnedBy(id)))
    }
    return openMachine({ files: t.files ?? {}, setup: t.setup, peer: t.peer, peerSetup: t.peerSetup, fullvm: t.fullvm, disks: t.disks }, wc.id)
  })
  ipcMain.handle("lab:check", (_e, id: string, verify?: string, peerVerify?: string) => checkMachine(id, verify, peerVerify))
  ipcMain.handle("lab:close", (_e, id: string) => closeMachine(id).then(() => true))
  ipcMain.handle("lab:shell", (e, id: string, machine: string, cols: number, rows: number) => {
    const wc = e.sender
    return openShell(id, machine, cols, rows, (ev) => !wc.isDestroyed() && wc.send("lab-shell", ev))
  })
  ipcMain.on("lab:write", (_e, key: string, data: string) => writeShell(key, data))
  ipcMain.on("lab:resize", (_e, key: string, cols: number, rows: number) => resizeShell(key, cols, rows))
  ipcMain.on("lab:kill", (_e, key: string) => killShell(key))
  ipcMain.handle("lab:status", () => labStatus())
  let settingUp: Promise<number> | null = null
  ipcMain.handle("lab:setup", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    settingUp ??= runSetup((line) => win?.webContents.send("lab-log", line)).finally(() => (settingUp = null))
    return settingUp
  })
}
