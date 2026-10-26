// JetBrains IDEs (PyCharm, WebStorm, IntelliJ…) ship an MCP server (Settings → Tools → MCP Server).
// This finds the running ones, works out which project is open, and hands the model a curated
// set of IDE tools. Edits made through these land in the open editor, so ⌘Z undoes them.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import type { Tool, ToolSet } from "ai"

const run = promisify(execFile)

const NAMES: Record<string, string> = {
  pycharm: "PyCharm",
  webstorm: "WebStorm",
  idea: "IntelliJ IDEA",
  goland: "GoLand",
  rustrover: "RustRover",
  clion: "CLion",
  phpstorm: "PhpStorm",
  rubymine: "RubyMine",
  rider: "Rider",
  datagrip: "DataGrip",
  studio: "Android Studio"
}

// Looking around is always allowed.
export const IDE_READ = [
  "get_all_open_file_paths",
  "get_file_text_by_path",
  "read_file",
  "list_directory_tree",
  "find_files_by_glob",
  "find_files_by_name_keyword",
  "search_in_files_by_text",
  "search_in_files_by_regex",
  "search_symbol",
  "get_symbol_info",
  "get_file_problems",
  "get_project_modules",
  "get_project_dependencies",
  "get_repositories",
  "get_run_configurations",
  "open_file_in_editor"
]
// Changing code: Writer mode, or when you press "Apply in IDE".
export const IDE_WRITE = ["replace_text_in_file", "apply_patch", "create_new_file", "reformat_file", "rename_refactoring", "build_project", "execute_run_configuration"]
// Deliberately never offered: execute_terminal_command, SQL execution, notebooks, inspection scripting.

export type Ide = {
  id: string // "pycharm"
  name: string // "PyCharm"
  app: string | null // "/Applications/PyCharm.app", for "open at line"
  port: number
  url: string
  projects: string[]
  project: string | null // the one we'll act on
  editor: string // what's open, as the IDE reports it (for the prompt)
}

type Conn = { client: MCPClient; tools: ToolSet }
const conns = new Map<number, Conn>()

async function connect(port: number): Promise<Conn | null> {
  const known = conns.get(port)
  if (known) return known
  try {
    const client = await createMCPClient({ transport: { type: "http", url: `http://127.0.0.1:${port}/stream` } })
    const conn = { client, tools: await client.tools() }
    conns.set(port, conn)
    return conn
  } catch {
    return null
  }
}

function dropConn(port: number) {
  const c = conns.get(port)
  conns.delete(port)
  void c?.client.close().catch(() => {})
}

// JetBrains processes listening in the MCP port range (64342, then +1 per extra IDE).
async function listeningIdes(): Promise<{ id: string; port: number; pid: number }[]> {
  const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 3000 }).catch(() => ({ stdout: "" }))
  const out: { id: string; port: number; pid: number }[] = []
  let cmd = ""
  let pid = 0
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("c")) cmd = line.slice(1).toLowerCase()
    else if (line.startsWith("n") && NAMES[cmd]) {
      const port = Number(line.split(":").pop())
      if (port >= 64342 && port < 64400 && !out.some((o) => o.port === port)) out.push({ id: cmd, port, pid })
    }
  }
  return out
}

// "/Applications/WebStorm.app/Contents/MacOS/webstorm" → "/Applications/WebStorm.app"
const appPaths = new Map<number, string | null>()
async function appFor(pid: number): Promise<string | null> {
  if (appPaths.has(pid)) return appPaths.get(pid)!
  const { stdout } = await run("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 2000 }).catch(() => ({ stdout: "" }))
  const app = /^(.*?\.app)\//.exec(stdout.trim())?.[1] ?? null
  appPaths.set(pid, app)
  return app
}

// Front-to-back order of visible apps, so "auto" can prefer the IDE you used last.
async function frontOrder(): Promise<string[]> {
  const { stdout } = await run("lsappinfo", ["visibleProcessList"], { timeout: 2000 }).catch(() => ({ stdout: "" }))
  return [...stdout.matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/_/g, " ").toLowerCase())
}

const text = (r: unknown) =>
  typeof r === "string" ? r : ((r as { content?: { type: string; text?: string }[] })?.content ?? []).map((p) => p.text ?? "").join("\n")

async function call(conn: Conn, name: string, input: Record<string, unknown>): Promise<string> {
  const t = conn.tools[name] as Tool<Record<string, unknown>, unknown> | undefined
  if (!t?.execute) throw new Error(`IDE has no ${name} tool`)
  return text(await t.execute(input, { toolCallId: `tutor-${Date.now()}`, messages: [], context: undefined } as never))
}

// Which projects are open. Without projectPath the IDE answers with a list of them.
async function openProjects(conn: Conn): Promise<string[]> {
  const t = await call(conn, "get_all_open_file_paths", {}).catch((e) => String(e))
  const m = /Currently open projects:\s*(\{[\s\S]*\})/.exec(t)
  if (!m) return []
  try {
    return ((JSON.parse(m[1]).projects ?? []) as { path: string }[]).map((p) => p.path)
  } catch {
    return []
  }
}

function pickProject(projects: string[], workspace: string | null): string | null {
  if (!projects.length) return null
  if (workspace) {
    const inside = projects.filter((p) => workspace === p || workspace.startsWith(p + path.sep) || p.startsWith(workspace + path.sep))
    if (inside.length) return inside.sort((a, b) => b.length - a.length)[0]
  }
  return projects[0]
}

let cached: { at: number; key: string; list: Ide[]; active: Ide | null } | null = null

export async function ideStatus(choice: string, workspace: string | null, fresh = false): Promise<{ list: Ide[]; active: Ide | null }> {
  const key = `${choice}|${workspace}`
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < 15_000) return cached
  const list: Ide[] = []
  for (const { id, port, pid } of await listeningIdes()) {
    const conn = await connect(port)
    if (!conn || !conn.tools.get_all_open_file_paths) continue
    const projects = await openProjects(conn)
    list.push({ id, name: NAMES[id] ?? id, app: await appFor(pid), port, url: `http://127.0.0.1:${port}/stream`, projects, project: pickProject(projects, workspace), editor: "" })
  }
  for (const port of conns.keys()) if (!list.some((i) => i.port === port)) dropConn(port) // IDE was closed

  let active: Ide | null = null
  if (choice !== "off") {
    const withProject = list.filter((i) => i.project)
    // A specific IDE that isn't running falls back to whichever one is.
    if (choice !== "auto") active = withProject.find((i) => i.id === choice) ?? null
    if (!active) {
      const order = await frontOrder()
      const rank = (i: Ide) => {
        const at = order.indexOf(i.name.toLowerCase())
        return at < 0 ? 999 : at
      }
      active = withProject.sort((a, b) => rank(a) - rank(b))[0] ?? null
    }
  }
  if (active) {
    const conn = conns.get(active.port)!
    active.editor = await call(conn, "get_all_open_file_paths", { projectPath: active.project }).catch(() => "")
    active.editor = active.editor.slice(0, 1200)
  }
  cached = { at: Date.now(), key, list, active }
  return cached
}

// The IDE's tools for this turn, named "<ide>__<tool>", with projectPath filled in for the model.
export function ideTools(ide: Ide, canWrite: boolean): ToolSet {
  const conn = conns.get(ide.port)
  if (!conn) return {}
  const names = canWrite ? [...IDE_READ, ...IDE_WRITE] : IDE_READ
  const out: ToolSet = {}
  for (const name of names) {
    const t = conn.tools[name] as Tool<Record<string, unknown>, unknown> | undefined
    if (!t?.execute) continue
    const exec = t.execute
    out[`${ide.id}__${name}`] = {
      ...t,
      execute: (input: Record<string, unknown>, opts: Parameters<typeof exec>[1]) => exec({ projectPath: ide.project ?? undefined, ...input }, opts)
    } as Tool
  }
  return out
}

// Same thing for the Claude Agent SDK route, which connects to MCP servers itself.
// Everything else the IDE offers goes on the disallowed list, which hides it from the model entirely.
export function ideForAgentSdk(ide: Ide, canWrite: boolean) {
  const names = new Set(canWrite ? [...IDE_READ, ...IDE_WRITE] : IDE_READ)
  const all = Object.keys(conns.get(ide.port)?.tools ?? {})
  return {
    server: { [ide.id]: { type: "http" as const, url: ide.url } },
    allowed: [...names].map((n) => `mcp__${ide.id}__${n}`),
    disallowed: all.filter((n) => !names.has(n)).map((n) => `mcp__${ide.id}__${n}`)
  }
}

export async function closeIdes(): Promise<void> {
  for (const port of [...conns.keys()]) dropConn(port)
}

// Open a file at a line in the IDE whose project contains it (else the active one).
// JetBrains forwards `open -na <IDE>.app --args --line N file` to the running window.
export async function openInIde(file: string, line: number, choice: string, workspace: string | null): Promise<{ ok: boolean; ide?: string }> {
  const { list, active } = await ideStatus(choice, workspace)
  const owner = list.filter((i) => i.projects.some((p) => file === p || file.startsWith(p + path.sep))).sort((a, b) => (b.project?.length ?? 0) - (a.project?.length ?? 0))[0]
  const ide = owner ?? active ?? list[0]
  if (!ide?.app) return { ok: false }
  await run("open", ["-na", ide.app, "--args", "--line", String(Math.max(1, line)), file], { timeout: 8000 })
  return { ok: true, ide: ide.name }
}
