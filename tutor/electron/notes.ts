// Notes: every "Recap & quiz" recap is saved as a Markdown file you can reread later, one folder per
// goal, numbered in the map's order, with an index. Each recap opens with its own concept map
// (a mermaid graph), which Tutor, Obsidian and PyCharm all draw. With Obsidian installed they go
// into your vault (<vault>/Tutor/<goal>/) and open there; otherwise into ~/TutorNotes.
// The model marks the recap in its reply with <!-- recap --> … <!-- /recap --> (invisible when rendered).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getGoal, setNoteFile, type Goal, type StrategyNode } from "./goals"
import { getSettings } from "./settings"

export type NoteInfo = { goalId: string; nodeId: string; title: string; stage: string; stageTitle: string; file: string; at: number; added?: boolean }
export type NotesWhere = { root: string; vault: string | null; obsidian: boolean }

// Obsidian's own list of vaults; the one open last (or the first) is where notes go by default.
function obsidianVaults(): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), "Library/Application Support/obsidian/obsidian.json"), "utf8"))
    const vs = Object.values(j.vaults ?? {}) as { path: string; open?: boolean; ts?: number }[]
    return vs
      .filter((v) => v.path && fs.existsSync(v.path))
      .sort((a, b) => Number(!!b.open) - Number(!!a.open) || (b.ts ?? 0) - (a.ts ?? 0))
      .map((v) => v.path)
  } catch {
    return []
  }
}
const hasObsidian = () => ["/Applications/Obsidian.app", path.join(os.homedir(), "Applications/Obsidian.app")].some((p) => fs.existsSync(p))
const vaultOf = (p: string) => obsidianVaults().find((v) => p === v || p.startsWith(v + path.sep)) ?? null

export function notesRoot(): string {
  const set = process.env.TUTOR_NOTES_DIR || getSettings().notesDir
  if (set) return set
  const vault = hasObsidian() ? obsidianVaults()[0] : undefined
  return vault ? path.join(vault, "Tutor") : path.join(os.homedir(), "TutorNotes")
}

export function notesWhere(): NotesWhere {
  const root = notesRoot()
  return { root, vault: vaultOf(root), obsidian: hasObsidian() }
}

// obsidian://open opens a file (or folder) by path when it's inside a vault Obsidian knows.
export function obsidianUrl(p: string): string | null {
  if (!hasObsidian()) return null
  const v = vaultOf(p)
  if (!v) return null
  return `obsidian://open?vault=${encodeURIComponent(path.basename(v))}&file=${encodeURIComponent(path.relative(v, p).split(path.sep).join("/"))}`
}
export const RECAP = /<!--\s*recap\s*-->([\s\S]*?)<!--\s*\/recap\s*-->/
export const NOTE_ADD = /<!--\s*note-add\s*-->([\s\S]*?)<!--\s*\/note-add\s*-->/

// Readable file and folder names (Obsidian shows them as titles); only what macOS or Obsidian reject goes.
const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80) || "Note"
const INDEX = "00 Index.md"

// The goal's folder: chosen once (from its title) and remembered, so renaming the goal keeps the files.
function goalDir(g: Goal): string {
  if (g.notesDir) return g.notesDir
  const root = notesRoot()
  let dir = path.join(root, safeName(g.title))
  for (let i = 2; fs.existsSync(dir) && !fs.existsSync(path.join(dir, ".tutor-notes")); i++) dir = path.join(root, `${safeName(g.title)} ${i}`)
  return dir
}

// Map order: stage by stage, nodes in the order the map lists them.
function ordered(g: Goal): StrategyNode[] {
  const s = g.strategy!
  const stageIx = new Map(s.stages.map((st, i) => [st.id, i]))
  return s.nodes.map((n, i) => ({ n, i })).sort((a, b) => (stageIx.get(a.n.stage) ?? 99) - (stageIx.get(b.n.stage) ?? 99) || a.i - b.i).map((x) => x.n)
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
const yaml = (s: string) => JSON.stringify(s)

export function saveRecap(goalId: string, nodeId: string, markdown: string, kind: "recap" | "lesson" = "recap", short = false): NoteInfo | null {
  const g = getGoal(goalId)
  const n = g?.strategy?.nodes.find((x) => x.id === nodeId)
  if (!g || !n) return null
  const body = markdown.trim().replace(/^#\s+.*\n+/, "") // the file supplies the title
  if (!short && body.length < 200) return null
  const dir = goalDir(g)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".tutor-notes"), g.id)
  const order = ordered(g)
  const num = String(order.findIndex((x) => x.id === n.id) + 1).padStart(2, "0")
  const file = g.notes?.[n.id]?.file ?? `${num} ${safeName(n.title)}.md`
  const stage = g.strategy!.stages.find((st) => st.id === n.stage)
  const at = Date.now()
  const front = [
    "---",
    `title: ${yaml(n.title)}`,
    `goal: ${yaml(g.title)}`,
    `stage: ${yaml(stage?.title ?? n.stage)}`,
    `saved: ${day(at)}`,
    ...(n.resources?.length ? ["sources:", ...n.resources.map((r) => `  - ${r.url}`)] : []),
    `tags: [tutor, ${kind}]`,
    "---"
  ].join("\n")
  const head = `# ${n.title}\n\n${header(g, n, file)}`
  const sources = n.resources?.length && !/\]\(https?:/.test(body.slice(-600)) ? `\n\n## Sources\n\n${n.resources.map((r) => `- [${r.title}](${r.url})`).join("\n")}` : ""
  fs.writeFileSync(path.join(dir, file), `${front}\n\n${head}\n\n${body}${sources}\n`)
  const g2 = setNoteFile(g.id, n.id, file, dir, at)
  if (g2) {
    writeIndex(g2)
    relink(g2)
  }
  return { goalId: g.id, nodeId: n.id, title: n.title, stage: n.stage, stageTitle: stage?.title ?? n.stage, file: path.join(dir, file), at }
}

// Under the title: stage, the index, and what it builds on (linked when that note exists).
function header(g: Goal, n: StrategyNode, file: string): string {
  const s = g.strategy!
  const stage = s.stages.find((st) => st.id === n.stage)
  const notes = { ...g.notes, [n.id]: { file, at: 0 } }
  const needs = n.requires.map((r) => s.nodes.find((x) => x.id === r)).filter((x): x is StrategyNode => !!x)
  const link = (x: StrategyNode) => (notes[x.id] ? `[${x.title}](${encodeURI(notes[x.id].file)})` : x.title)
  return `> ${stage?.title ?? n.stage} · [${g.title}](${encodeURI(INDEX)})${needs.length ? ` · builds on ${needs.map(link).join(", ")}` : ""}\n>\n> ${n.summary}`
}

// A new note can be what older ones build on: refresh their header links (Obsidian's graph follows them).
function relink(g: Goal) {
  for (const [id, { file }] of Object.entries(g.notes ?? {})) {
    const n = g.strategy?.nodes.find((x) => x.id === id)
    const f = path.join(g.notesDir!, file)
    if (!n || !fs.existsSync(f)) continue
    const old = fs.readFileSync(f, "utf8")
    const next = old.replace(/^(# .*\n\n)> .*\n(?:>\n)?> .*$/m, (_m, h1) => h1 + header(g, n, file))
    if (next !== old) fs.writeFileSync(f, next)
  }
}

// The index: the notes in map order, stage by stage, with what's not recapped yet listed plainly.
function writeIndex(g: Goal) {
  if (!g.notesDir || !g.strategy) return
  const notes = g.notes ?? {}
  const lines = [`# ${g.title}: notes`, "", `Notes from your lessons and recaps, saved by Tutor in the map's order. ${Object.keys(notes).length} so far.`, ""]
  for (const st of g.strategy.stages) {
    const ns = ordered(g).filter((n) => n.stage === st.id && n.kind !== "project")
    if (!ns.length) continue
    lines.push(`## ${st.title}`, "")
    for (const n of ns) lines.push(notes[n.id] ? `- [${n.title}](${encodeURI(notes[n.id].file)}) · ${day(notes[n.id].at)}` : `- ${n.title} _(no note yet)_`)
    lines.push("")
  }
  fs.writeFileSync(path.join(g.notesDir, INDEX), lines.join("\n"))
}

// The end of a lesson: their own mistakes, appended to the node's note (dated, so lessons can stack).
export function appendToNote(goalId: string, nodeId: string, markdown: string): NoteInfo | null {
  const g = getGoal(goalId)
  const n = g?.strategy?.nodes.find((x) => x.id === nodeId)
  const add = markdown.trim().replace(/^##\s*Watch out\b.*$/m, (h) => `${h.replace(/\s*·.*$/, "")} · ${day(Date.now())}`)
  if (!g || !n || !add) return null
  const f = g.notesDir && g.notes?.[nodeId] ? path.join(g.notesDir, g.notes[nodeId].file) : null
  if (!f || !fs.existsSync(f)) return saveRecap(goalId, nodeId, `# ${n.title}\n\n${add}`, "lesson", true)
  const text = fs.readFileSync(f, "utf8").replace(/\s*$/, "")
  // Before the Sources list Tutor added, if there is one, so the sources stay last.
  const at = text.lastIndexOf("\n## Sources\n")
  fs.writeFileSync(f, at >= 0 ? `${text.slice(0, at)}\n\n${add}\n${text.slice(at)}\n` : `${text}\n\n${add}\n`)
  const time = Date.now()
  const g2 = setNoteFile(g.id, nodeId, g.notes![nodeId].file, g.notesDir!, time)
  const stage = g2?.strategy?.stages.find((s) => s.id === n.stage)
  return { goalId, nodeId, title: n.title, stage: n.stage, stageTitle: stage?.title ?? n.stage, file: f, at: time, added: true }
}

// The "Watch out" points from a node's note: the mistakes they actually made, newest last.
export function watchOut(goalId: string, nodeId: string, max = 4): string[] {
  const text = readNote(goalId, nodeId)
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(/^##\s*Watch out\b.*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm))
    for (const para of m[1].split(/\n(?=- )|\n\s*\n/)) {
      const t = para.replace(/^-\s*/, "").replace(/\s+/g, " ").trim()
      if (t) out.push(t.length > 220 ? t.slice(0, 217) + "…" : t)
    }
  return out.slice(-max)
}

export function listNotes(goalId: string): NoteInfo[] {
  const g = getGoal(goalId)
  if (!g?.strategy || !g.notesDir) return []
  const stages = new Map(g.strategy.stages.map((s) => [s.id, s.title]))
  return ordered(g)
    .filter((n) => g.notes?.[n.id] && fs.existsSync(path.join(g.notesDir!, g.notes[n.id].file)))
    .map((n) => ({ goalId: g.id, nodeId: n.id, title: n.title, stage: n.stage, stageTitle: stages.get(n.stage) ?? n.stage, file: path.join(g.notesDir!, g.notes![n.id].file), at: g.notes![n.id].at }))
}

// The note as Tutor shows it: without the front matter.
export function readNote(goalId: string, nodeId: string): string | null {
  const g = getGoal(goalId)
  const f = g?.notesDir && g.notes?.[nodeId] ? path.join(g.notesDir, g.notes[nodeId].file) : null
  if (!f || !fs.existsSync(f)) return null
  return fs.readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "")
}

export const notesIndex = (dir: string) => path.join(dir, INDEX)

export function notesFolder(goalId: string): string | null {
  const g = getGoal(goalId)
  return g?.notesDir && fs.existsSync(g.notesDir) ? g.notesDir : null
}
