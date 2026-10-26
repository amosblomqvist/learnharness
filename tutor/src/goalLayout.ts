// Lays a goal's strategy out like a syllabus: stages are rows from top to bottom; inside a stage,
// ideas flow left to right, each one column right of the deepest thing it needs from the same
// stage. Rows in a column are ordered by where their prerequisites sit, so lines cross less.
// Links inside a stage are drawn solid; links from earlier stages are faint until you hover.
import type { Strategy, StrategyNode } from "./api"

export const NODE_W = 212
export const NODE_H = 72
const GAP_X = 50
const GAP_Y = 14
const PAD_X = 22
const STAGE_GAP = 22
export const HEAD_H = 58 // stage title + outcome above its nodes

export type Placed = { node: StrategyNode; x: number; y: number }
export type Band = { id: string; title: string; outcome: string; index: number; y: number; h: number; done: number; total: number }
export type Edge = { from: string; to: string; d: string; cross: boolean }
export type Layout = { placed: Map<string, Placed>; bands: Band[]; edges: Edge[]; width: number; height: number }

export function layoutStrategy(s: Strategy): Layout {
  const stageIdx = new Map(s.stages.map((st, i) => [st.id, i]))
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  const stageCount = s.stages.length + (s.nodes.some((n) => !stageIdx.has(n.stage)) ? 1 : 0)
  const stageOf = (n: StrategyNode) => stageIdx.get(n.stage) ?? s.stages.length

  // Depth inside the node's own stage.
  const depth = new Map<string, number>()
  const d = (n: StrategyNode, seen = new Set<string>()): number => {
    if (depth.has(n.id)) return depth.get(n.id)!
    if (seen.has(n.id)) return 0
    seen.add(n.id)
    let v = 0
    for (const r of n.requires) {
      const m = byId.get(r)
      if (m && stageOf(m) === stageOf(n)) v = Math.max(v, d(m, seen) + 1)
    }
    depth.set(n.id, v)
    return v
  }
  s.nodes.forEach((n) => d(n))

  const placed = new Map<string, Placed>()
  const bands: Band[] = []
  const done = (n: StrategyNode) => n.status === "solid" || n.status === "known"
  let y = 0
  let width = 0
  for (let si = 0; si < stageCount; si++) {
    const nodes = s.nodes.filter((n) => stageOf(n) === si)
    const cols: StrategyNode[][] = []
    for (const n of nodes) (cols[depth.get(n.id)!] ??= []).push(n)
    // Order each column by the average position of what it needs (earlier stages by x, same stage by row).
    const row = new Map<string, number>()
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c] ?? []
      const key = (n: StrategyNode, i: number) => {
        const ps = n.requires.map((r) => {
          const p = placed.get(r)
          return p ? p.x / (NODE_W + GAP_X) : row.get(r)
        })
        const nums = ps.filter((v): v is number => v !== undefined)
        return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : i
      }
      const keyed = col.map((n, i) => [n, key(n, i)] as const).sort((a, b) => a[1] - b[1])
      cols[c] = keyed.map(([n]) => n)
      cols[c].forEach((n, i) => row.set(n.id, i))
    }
    const rows = Math.max(1, ...cols.map((c) => c?.length ?? 0))
    const top = y + HEAD_H
    const bodyH = rows * NODE_H + (rows - 1) * GAP_Y
    cols.forEach((col, c) => {
      const h = col.length * NODE_H + (col.length - 1) * GAP_Y
      col.forEach((n, i) => placed.set(n.id, { node: n, x: PAD_X + c * (NODE_W + GAP_X), y: top + (bodyH - h) / 2 + i * (NODE_H + GAP_Y) }))
    })
    const st = s.stages[si] ?? { id: "_other", title: "Other", outcome: "" }
    const h = HEAD_H + bodyH + 18
    bands.push({ id: st.id, title: st.title, outcome: st.outcome, index: si, y, h, done: nodes.filter(done).length, total: nodes.length })
    width = Math.max(width, PAD_X * 2 + cols.length * (NODE_W + GAP_X) - GAP_X)
    y += h + STAGE_GAP
  }

  const edges: Edge[] = []
  for (const n of s.nodes)
    for (const r of n.requires) {
      const a = placed.get(r)
      const b = placed.get(n.id)
      if (!a || !b) continue
      const cross = stageOf(byId.get(r)!) !== stageOf(n)
      if (!cross) {
        const x1 = a.x + NODE_W
        const y1 = a.y + NODE_H / 2
        const x2 = b.x
        const y2 = b.y + NODE_H / 2
        const dx = Math.max(24, (x2 - x1) / 2)
        edges.push({ from: r, to: n.id, cross, d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` })
      } else {
        // Down from an earlier stage: bottom edge of the prerequisite to the top of the node.
        const x1 = a.x + NODE_W / 2
        const y1 = a.y + NODE_H
        const x2 = b.x + NODE_W / 2
        const y2 = b.y
        const dy = Math.max(30, (y2 - y1) / 2)
        edges.push({ from: r, to: n.id, cross, d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}` })
      }
    }

  return { placed, bands, edges, width: Math.max(width, 480), height: y - STAGE_GAP + 10 }
}

// Everything a node needs (transitively), and everything that needs it.
export function lineage(s: Strategy, id: string): Set<string> {
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  const out = new Set<string>([id])
  const up = (x: string) => byId.get(x)?.requires.forEach((r) => !out.has(r) && (out.add(r), up(r)))
  const deps = new Map<string, string[]>()
  for (const n of s.nodes) for (const r of n.requires) deps.set(r, [...(deps.get(r) ?? []), n.id])
  const down = (x: string) => deps.get(x)?.forEach((c) => !out.has(c) && (out.add(c), down(c)))
  up(id)
  down(id)
  return out
}

export const isDone = (n: StrategyNode) => n.status === "solid" || n.status === "known"

// Ready now: not done, and everything it needs is.
export function readyNodes(s: Strategy): StrategyNode[] {
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  return s.nodes.filter((n) => !isDone(n) && n.requires.every((r) => !byId.has(r) || isDone(byId.get(r)!)))
}

// What "Continue" opens: something already in progress, else the earliest ready node.
export function nextNode(s: Strategy): StrategyNode | null {
  const order = new Map(s.stages.map((st, i) => [st.id, i]))
  const ready = readyNodes(s).sort((a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99))
  return ready.find((n) => n.status === "learning") ?? ready.find((n) => !n.optional) ?? ready[0] ?? null
}
