// Goals: "I want to build X" or "I want to master Y" becomes a strategy, a dependency map in
// the Learn skill's shape at curriculum scale. Unconditional truths at the roots, each idea
// hanging off what it needs, stages that end in something you build, the goal as the sink.
// The model writes it with save_strategy; lessons mark nodes as they land; you see it as a map.
// One JSON file per goal in userData/goals/.
import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { COURSES } from "./courses"

export type NodeStatus = "todo" | "learning" | "solid" | "known"
export type NodeKind = "truth" | "concept" | "skill" | "project"
export type Resource = { title: string; url: string }
export type StrategyNode = {
  id: string
  title: string
  kind: NodeKind
  stage: string
  summary: string // one sentence: what it is
  why?: string // the problem that makes you need it ("how could I have discovered this?")
  requires: string[]
  check?: string // how you'll show you have it
  minutes?: number
  resources?: Resource[]
  status: NodeStatus
  note?: string // what the last lesson or probe found
  optional?: boolean // an extra, not needed for the goal
}
export type Stage = { id: string; title: string; outcome: string }
export type Strategy = { summary: string; approach: string; stages: Stage[]; nodes: StrategyNode[]; updatedAt: number }
export type Source = { id: string; kind: "video" | "page"; title: string; url: string; channel?: string; duration?: number; addedAt: number }
export type Lesson = { conversationId: string; nodeId: string; at: number }
export type Goal = {
  id: string
  title: string
  ask: string // what you typed
  createdAt: number
  updatedAt: number
  conversationId: string // the planning conversation
  strategy: Strategy | null
  sources: Source[]
  lessons: Lesson[]
  courseId?: string // started from a ready-made course
  courseNodes?: string[] // the course's node ids when this goal last took its map
  practice?: Record<string, { passed: number; assisted: number; lastAt: number }> // exercises per node
  notesDir?: string // where this goal's recaps are saved (notes.ts)
  notes?: Record<string, { file: string; at: number }> // node id → its recap file in notesDir
}
export type GoalSummary = { id: string; title: string; courseId?: string; updatedAt: number; total: number; done: number; drafting: boolean; next: { id: string; title: string; status: NodeStatus } | null }

const dir = () => path.join(app.getPath("userData"), "goals")
const file = (id: string) => path.join(dir(), `${id.replace(/[^\w-]/g, "")}.json`)

let listener: ((g: Goal) => void) | null = null
export const onGoalChanged = (fn: (g: Goal) => void) => (listener = fn)

export function getGoal(id: string): Goal | null {
  try {
    return withCourseSources(JSON.parse(fs.readFileSync(file(id), "utf8")))
  } catch {
    return null
  }
}

// A course's sources get better over time; a goal started from it sees the current ones next to any it added.
function withCourseSources(g: Goal): Goal {
  const c = g.courseId ? COURSES.find((x) => x.id === g.courseId) : undefined
  if (!c || !g.strategy) return g
  const byId = new Map(c.strategy.nodes.map((n) => [n.id, n]))
  for (const n of g.strategy.nodes) {
    const extra = (byId.get(n.id)?.resources ?? []).filter((r) => !n.resources?.some((x) => x.url === r.url))
    if (extra.length) n.resources = [...(n.resources ?? []), ...extra]
  }
  return g
}

function write(g: Goal): Goal {
  g.updatedAt = Date.now()
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(file(g.id), JSON.stringify(g, null, 1))
  listener?.(g)
  return g
}

const done = (n: StrategyNode) => n.status === "solid" || n.status === "known"

export function summarize(g: Goal): GoalSummary {
  const nodes = g.strategy?.nodes ?? []
  const order = new Map((g.strategy?.stages ?? []).map((s, i) => [s.id, i]))
  const ready = g.strategy ? frontier(g.strategy).sort((a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99)) : []
  const next = ready.find((n) => n.status === "learning") ?? ready.find((n) => !n.optional) ?? ready[0] ?? null
  return { id: g.id, title: g.title, courseId: g.courseId, updatedAt: g.updatedAt, total: nodes.length, done: nodes.filter(done).length, drafting: !g.strategy, next: next ? { id: next.id, title: next.title, status: next.status } : null }
}

export function listGoals(): GoalSummary[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: GoalSummary[] = []
  for (const n of names) {
    const g = getGoal(n.replace(/\.json$/, ""))
    if (g) out.push(summarize(g))
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createGoal(ask: string): Goal {
  const clean = ask.replace(/\s+/g, " ").trim()
  const title = clean.replace(/^(i want to|i'd like to|i wanna|help me|teach me( about)?|learn( about)?)\s+/i, "").replace(/^\w/, (c) => c.toUpperCase())
  const now = Date.now()
  return write({ id: crypto.randomUUID(), title: title.length > 60 ? title.slice(0, 57) + "…" : title || "New goal", ask: ask.trim(), createdAt: now, updatedAt: now, conversationId: crypto.randomUUID(), strategy: null, sources: [], lessons: [] })
}

// A ready-made course (courses.ts): the goal starts with its whole map already drawn.
export function createGoalFromCourse(course: { id: string; title: string; ask: string; strategy: StrategyInput }): Goal {
  const g = createGoal(course.ask)
  g.title = course.title
  g.courseId = course.id
  g.courseNodes = course.strategy.nodes.map((n) => n.id)
  write(g)
  const r = saveStrategy(g.id, course.strategy)
  if (!r.ok) throw new Error(`The course map is invalid: ${r.error}`)
  return r.goal
}

// When a ready-made course grows, a goal started from it can take the new nodes. Progress and
// notes stay; nodes you or the strategist removed stay removed (courseNodes remembers what the
// course had last time; goals from before that fall back to their own current nodes).
function courseAdditions(g: Goal, course: { strategy: StrategyInput }) {
  if (!g.strategy) return []
  const have = new Set(g.strategy.nodes.map((n) => n.id))
  const seen = new Set(g.courseNodes ?? have)
  return course.strategy.nodes.filter((n) => !seen.has(n.id) && !have.has(n.id))
}

export function courseNews(goalId: string, course: { strategy: StrategyInput }): { count: number; titles: string[] } | null {
  const g = getGoal(goalId)
  const add = g ? courseAdditions(g, course) : []
  return add.length ? { count: add.length, titles: add.map((n) => n.title) } : null
}

export function takeCourseUpdate(goalId: string, course: { id: string; strategy: StrategyInput }): Goal {
  const g = getGoal(goalId)
  if (!g?.strategy) throw new Error("This goal has no map yet.")
  const add = courseAdditions(g, course)
  const byId = new Map(course.strategy.nodes.map((n) => [n.id, n]))
  const ids = new Set([...g.strategy.nodes.map((n) => n.id), ...add.map((n) => n.id)])
  // Stages in the course's order (those this goal uses), then any the goal added itself.
  const used = new Set([...g.strategy.nodes, ...add].map((n) => n.stage))
  const stages = [...course.strategy.stages.filter((st) => used.has(st.id)), ...g.strategy.stages.filter((st) => !course.strategy.stages.some((c) => c.id === st.id))]
  const nodes: StrategyInput["nodes"] = [
    // Existing nodes keep everything; they also pick up any new prerequisites the course gained.
    ...g.strategy.nodes.map((n) => ({ ...n, requires: [...new Set([...n.requires, ...(byId.get(n.id)?.requires ?? []).filter((r) => ids.has(r))])] })),
    ...add.map((n) => ({ ...n, requires: (n.requires ?? []).filter((r) => ids.has(r)), status: "todo" as NodeStatus }))
  ]
  const r = saveStrategy(g.id, { summary: g.strategy.summary, approach: g.strategy.approach, stages, nodes })
  if (!r.ok) throw new Error(`Couldn't add the new nodes: ${r.error}`)
  r.goal.courseId = course.id
  r.goal.courseNodes = course.strategy.nodes.map((n) => n.id)
  return write(r.goal)
}

export function deleteGoal(id: string): void {
  fs.rmSync(file(id), { force: true })
}

export function renameGoal(id: string, title: string): Goal | null {
  const g = getGoal(id)
  if (!g || !title.trim()) return g
  g.title = title.trim().slice(0, 80)
  return write(g)
}

// Nodes you can start now: not done, and everything they require is.
export function frontier(s: Strategy): StrategyNode[] {
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  return s.nodes.filter((n) => !done(n) && n.requires.every((r) => !byId.has(r) || done(byId.get(r)!)))
}

// ---------- written by the model ----------

export type StrategyInput = Omit<Strategy, "updatedAt" | "nodes"> & { nodes: (Omit<StrategyNode, "status" | "requires"> & { requires?: string[]; status?: NodeStatus })[] }

// Checks the map is a real DAG before it's saved; problems go back to the model to fix.
export function saveStrategy(goalId: string, input: StrategyInput): { ok: true; goal: Goal } | { ok: false; error: string } {
  const g = getGoal(goalId)
  if (!g) return { ok: false, error: "That goal doesn't exist any more." }
  const problems: string[] = []
  const ids = new Set<string>()
  for (const n of input.nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id "${n.id}"`)
    ids.add(n.id)
  }
  const stages = new Set(input.stages.map((s) => s.id))
  for (const n of input.nodes) {
    if (!stages.has(n.stage)) problems.push(`node "${n.id}" is in stage "${n.stage}", which isn't in stages`)
    for (const r of n.requires ?? []) if (!ids.has(r)) problems.push(`node "${n.id}" requires "${r}", which isn't a node`)
  }
  // Cycles: a node can't (indirectly) require itself.
  const req = new Map(input.nodes.map((n) => [n.id, n.requires ?? []]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      problems.push(`cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")}`)
      return
    }
    state.set(id, 1)
    for (const r of req.get(id) ?? []) if (ids.has(r)) visit(r, [...trail, id])
    state.set(id, 2)
  }
  for (const id of ids) visit(id, [])
  if (!input.nodes.length) problems.push("no nodes")
  if (problems.length) return { ok: false, error: `Not saved. Fix these and call save_strategy again with the whole strategy:\n- ${[...new Set(problems)].slice(0, 12).join("\n- ")}` }

  // Keep progress for nodes that survive a rewrite (same id).
  const before = new Map((g.strategy?.nodes ?? []).map((n) => [n.id, n]))
  const nodes: StrategyNode[] = input.nodes.map((n) => {
    const old = before.get(n.id)
    const status: NodeStatus = old && old.status !== "todo" ? old.status : (n.status ?? "todo")
    return { ...n, title: n.title.trim(), requires: n.requires ?? [], status, note: n.note ?? old?.note, resources: n.resources?.filter((r) => /^https?:\/\//.test(r.url)) }
  })
  g.strategy = { summary: input.summary, approach: input.approach, stages: input.stages, nodes, updatedAt: Date.now() }
  return { ok: true, goal: write(g) }
}

// In the coding courses, a concept or skill turns solid only once an exercise for it has passed
// (without opening the solution): writing the code is the check, not answering about it.
export function needsPractice(g: Goal, n: StrategyNode): boolean {
  const c = COURSES.find((x) => x.id === g.courseId)
  if (!c?.practice || (n.kind !== "concept" && n.kind !== "skill")) return false
  return c.practice === true || c.practice.includes(n.stage)
}

export function recordPractice(goalId: string, nodeId: string, own: boolean): void {
  const g = getGoal(goalId)
  if (!g?.strategy?.nodes.some((n) => n.id === nodeId)) return
  const p = (g.practice ??= {})
  const r = (p[nodeId] ??= { passed: 0, assisted: 0, lastAt: 0 })
  if (own) r.passed++
  else r.assisted++
  r.lastAt = Date.now()
  write(g)
}

export function setNoteFile(goalId: string, nodeId: string, file: string, dir: string, at: number): Goal | null {
  const g = getGoal(goalId)
  if (!g) return null
  g.notesDir = dir
  ;(g.notes ??= {})[nodeId] = { file, at }
  return write(g)
}

export function markNode(goalId: string, nodeId: string, status: NodeStatus, note?: string, waive?: string): { ok: boolean; text: string } {
  const g = getGoal(goalId)
  const n = g?.strategy?.nodes.find((x) => x.id === nodeId)
  if (!g || !n) return { ok: false, text: `No node "${nodeId}" in this goal's map.` }
  if (status === "solid" && needsPractice(g, n) && !(g.practice?.[nodeId]?.passed ?? 0)) {
    if (!waive?.trim())
      return { ok: false, text: `Not marked: in this course "${n.title}" turns solid only after an exercise for it passes (they write the code; hidden tests check it). Give one with the exercise tool now, small and aimed at exactly this idea. If an exercise is genuinely impossible for this node, call mark_node again with waive set to the reason.` }
    note = `${note ? `${note} ` : ""}(exercise waived: ${waive.trim()})`
  }
  n.status = status
  if (note?.trim()) n.note = note.trim().slice(0, 400)
  write(g)
  const next = frontier(g.strategy!).slice(0, 3).map((x) => `"${x.title}" (${x.id})`)
  return { ok: true, text: `Marked "${n.title}" ${status}.${next.length ? ` Ready next: ${next.join(", ")}.` : " Every node is done."}` }
}

export function addSource(goalId: string, s: Omit<Source, "id" | "addedAt">): void {
  const g = getGoal(goalId)
  if (!g || g.sources.some((x) => x.url === s.url)) return
  g.sources.push({ ...s, id: crypto.randomUUID(), addedAt: Date.now() })
  write(g)
}

export function addLesson(goalId: string, conversationId: string, nodeId: string): void {
  const g = getGoal(goalId)
  if (!g || g.lessons.some((l) => l.conversationId === conversationId)) return
  g.lessons.push({ conversationId, nodeId, at: Date.now() })
  const n = g.strategy?.nodes.find((x) => x.id === nodeId)
  if (n && n.status === "todo") n.status = "learning"
  write(g)
}

export function setNodeStatusByUser(goalId: string, nodeId: string, status: NodeStatus): Goal | null {
  const g = getGoal(goalId)
  const n = g?.strategy?.nodes.find((x) => x.id === nodeId)
  if (!g || !n) return g
  n.status = status
  return write(g)
}

// The map as the model sees it in its prompt: compact, one line per node.
export function strategyForPrompt(g: Goal): string {
  const s = g.strategy
  if (!s) return "(no strategy saved yet)"
  const lines = [`Summary: ${s.summary}`, `Approach: ${s.approach}`, "Stages:"]
  for (const st of s.stages) lines.push(`- ${st.id}: ${st.title}: ${st.outcome}`)
  lines.push("Nodes (id · kind · stage · status · title · requires):")
  for (const n of s.nodes) lines.push(`- ${n.id} · ${n.kind} · ${n.stage} · ${n.status} · ${n.title}${n.requires.length ? ` · needs ${n.requires.join(", ")}` : ""}${n.note ? ` · note: ${n.note}` : ""}`)
  const next = frontier(s)
  if (next.length) lines.push(`Ready now (all prerequisites done): ${next.map((n) => n.id).join(", ")}`)
  if (g.sources.length) lines.push("Sources they've given:", ...g.sources.map((x) => `- ${x.kind}: ${x.title} ${x.url}`))
  return lines.join("\n")
}
