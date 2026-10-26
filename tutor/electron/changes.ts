// Every file an agent edits, with what it looked like before, so you can review the diff,
// keep it, or undo it (like Claude Code's changes view). Works for all three engines:
// the AI SDK wraps tool execute(), the Claude Agent SDK uses Pre/PostToolUse hooks, and
// Grok (ACP) snapshots at permission time. Undo writes the original back to disk; JetBrains
// IDEs notice and reload the file.
import fs from "node:fs"
import path from "node:path"
import { structuredPatch } from "diff"

export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type ChangeView = {
  id: string
  path: string // absolute
  rel: string // for display
  created: boolean
  deleted: boolean
  added: number
  removed: number
  hunks: Hunk[]
  tool: string
  at: number
}

type Change = { id: string; path: string; before: string | null; after: string | null; tool: string; at: number }

let pending = new Map<string, Change>() // by absolute path; cumulative until you keep or undo
let root: string | null = null // for display paths
let notify: (list: ChangeView[]) => void = () => {}

export function onChanges(fn: (list: ChangeView[]) => void): void {
  notify = fn
}
export function setDisplayRoot(dir: string | null): void {
  root = dir
}

const read = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

// Call just before a tool writes to these files.
export function beforeWrite(files: string[], tool: string): void {
  for (const f of files) {
    const p = path.resolve(f)
    if (pending.has(p)) continue // keep the original from the first edit
    pending.set(p, { id: `${Date.now().toString(36)}-${pending.size}`, path: p, before: read(p), after: null, tool, at: Date.now() })
  }
}

// Call after the tool finished (success or not).
export function afterWrite(files: string[]): void {
  let changed = false
  for (const f of files) {
    const c = pending.get(path.resolve(f))
    if (!c) continue
    c.after = read(c.path)
    c.at = Date.now()
    if (c.after === c.before) pending.delete(c.path)
    changed = true
  }
  if (changed) notify(listChanges())
}

// For agents that report an edit as it happens (Grok over ACP), the "before" snapshot can lose the
// race and already contain the change. Every ACP edit carries its old and new text, so rebuild the
// original by reversing it, but only when that's unambiguous.
export function reconcileDiff(file: string, oldText: string | null | undefined, newText: string, tool: string): void {
  const p = path.resolve(file)
  const now = read(p)
  const c = pending.get(p)
  if (c && c.before !== now) return // the snapshot really was taken before the write
  let before: string | null
  if (oldText === null || oldText === undefined) before = null // a new file
  else if (now !== null && newText && now.split(newText).length === 2) before = now.replace(newText, () => oldText)
  else if (now !== null && newText === now) before = oldText // a whole-file write
  else return
  if (c) c.before = before
  else pending.set(p, { id: `${Date.now().toString(36)}-${pending.size}`, path: p, before, after: now, tool, at: Date.now() })
}

function view(c: Change): ChangeView {
  const before = c.before ?? ""
  const after = c.after ?? ""
  const patch = structuredPatch(c.path, c.path, before, after, "", "", { context: 3 })
  let added = 0
  let removed = 0
  const hunks = patch.hunks.map((h) => {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++
      else if (l.startsWith("-")) removed++
    }
    return { oldStart: h.oldStart, newStart: h.newStart, lines: h.lines }
  })
  const rel = root && c.path.startsWith(root + path.sep) ? path.relative(root, c.path) : c.path.replace(process.env.HOME ?? "~", "~")
  return { id: c.id, path: c.path, rel, created: c.before === null, deleted: c.after === null, added, removed, hunks, tool: c.tool, at: c.at }
}

export function listChanges(): ChangeView[] {
  return [...pending.values()].filter((c) => c.after !== c.before).sort((a, b) => a.at - b.at).map(view)
}

export function statsFor(file: string): { added: number; removed: number } | null {
  const c = pending.get(path.resolve(file))
  if (!c) return null
  const v = view(c)
  return { added: v.added, removed: v.removed }
}

export function keepChanges(ids?: string[]): ChangeView[] {
  for (const c of [...pending.values()]) if (!ids || ids.includes(c.id)) pending.delete(c.path)
  const list = listChanges()
  notify(list)
  return list
}

// Undo refuses to clobber edits you made after the agent did, unless forced.
export function undoChanges(ids?: string[], force = false): { list: ChangeView[]; conflicts: string[] } {
  const conflicts: string[] = []
  for (const c of [...pending.values()]) {
    if (ids && !ids.includes(c.id)) continue
    const now = read(c.path)
    if (!force && now !== c.after) {
      conflicts.push(view(c).rel)
      continue
    }
    if (c.before === null) fs.rmSync(c.path, { force: true })
    else {
      fs.mkdirSync(path.dirname(c.path), { recursive: true })
      fs.writeFileSync(c.path, c.before)
    }
    pending.delete(c.path)
  }
  const list = listChanges()
  notify(list)
  return { list, conflicts }
}

export function clearChanges(): void {
  pending = new Map()
  notify([])
}

// ---------- which files does a tool call touch? ----------
// Covers Claude Code's tools, the JetBrains MCP tools (any route) and Tutor's own file tools.

function patchPaths(patch: string): string[] {
  const out = new Set<string>()
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.add(m[1].trim())
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(m[1].trim())
  for (const m of patch.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/gm)) if (m[1].trim() !== "/dev/null") out.add(m[1].trim())
  return [...out]
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "write_file", "edit_file", "replace_text_in_file", "apply_patch", "create_new_file", "reformat_file", "search_replace", "write", "edit", "create_file"])

// name may be "Edit", "write_file", "pycharm__replace_text_in_file" or "mcp__pycharm__apply_patch".
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name.split("__").pop() ?? name)
}

export function filesTouched(name: string, input: unknown, dirs: { workspace: string | null; ideProject: string | null }): string[] {
  const base = name.split("__").pop() ?? name
  const o = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  const isIde = name.includes("__") && !["write_file", "edit_file"].includes(base)
  const anchor = (isIde ? dirs.ideProject : dirs.workspace) ?? dirs.ideProject ?? dirs.workspace ?? process.env.HOME ?? "/"
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(anchor, p))
  switch (base) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return str(o.file_path) ? [abs(o.file_path as string)] : []
    case "NotebookEdit":
      return str(o.notebook_path) ? [abs(o.notebook_path as string)] : []
    case "write_file":
    case "edit_file":
      return str(o.path) ? [abs(o.path as string)] : []
    case "search_replace": // Grok Build
    case "write":
    case "edit":
    case "create_file":
      return str(o.file_path ?? o.target_file ?? o.path) ? [abs((o.file_path ?? o.target_file ?? o.path) as string)] : []
    case "replace_text_in_file":
    case "create_new_file":
      return str(o.pathInProject) ? [abs(o.pathInProject as string)] : []
    case "reformat_file":
      return str(o.filePath ?? o.pathInProject) ? [abs((o.filePath ?? o.pathInProject) as string)] : []
    case "apply_patch":
      return patchPaths(String(o.input ?? o.patch ?? "")).map(abs)
    default:
      return []
  }
}
