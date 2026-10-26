import { useMemo, useState } from "react"
import type { Goal, StrategyNode } from "../api"
import { COURSES } from "../../electron/courses"
import { DACH_LESSONS } from "../../electron/course-maps/dach-lessons"

export type ModulePick = {
  key: string
  courseId: string
  title: string
  detail: string
  stages: string[]
}

type Cat = ModulePick & { hay: string }

let cached: Cat[] | null = null

function catalog(): Cat[] {
  if (cached) return cached
  const out: Cat[] = []
  for (const c of COURSES) {
    for (const st of c.strategy.stages) {
      const nodes = c.strategy.nodes.filter((n) => n.stage === st.id)
      out.push({
        key: `${c.id}:${st.id}`,
        courseId: c.id,
        title: st.title,
        detail: c.id === "dach-remote" ? st.outcome : `${c.title} · ${st.outcome}`,
        stages: [st.id],
        hay: [st.title, st.outcome, c.title, c.blurb, ...nodes.map((n) => `${n.title} ${n.summary}`)].join("\n").toLowerCase()
      })
    }
  }
  const dach = COURSES.find((c) => c.id === "dach-remote")
  const cloudStages = ["iac", "k8s"]
  if (dach && cloudStages.every((id) => dach.strategy.stages.some((s) => s.id === id))) {
    const nodes = dach.strategy.nodes.filter((n) => cloudStages.includes(n.stage))
    out.push({
      key: "dach-remote:cloud",
      courseId: "dach-remote",
      title: "Cloud",
      detail: "Kubernetes and Terraform",
      stages: cloudStages,
      hay: ["cloud kubernetes terraform k8s", ...nodes.map((n) => `${n.title} ${n.summary}`)].join("\n").toLowerCase()
    })
  }
  cached = out
  return out
}

function bare(m: Cat): ModulePick {
  return { key: m.key, courseId: m.courseId, title: m.title, detail: m.detail, stages: m.stages }
}

const PLATFORM_KEYS = ["dach-remote:ts-craft", "dach-remote:py-light", "dach-remote:cloud", "dach-remote:linux", "dach-remote:go"]

export function platformModules(): ModulePick[] {
  const byKey = new Map(catalog().map((m) => [m.key, m]))
  return PLATFORM_KEYS.flatMap((key) => {
    const hit = byKey.get(key)
    return hit ? [bare(hit)] : []
  })
}

function searchModules(q: string): ModulePick[] {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const scored = catalog()
    .filter((m) => tokens.every((t) => m.hay.includes(t)))
    .map((m) => {
      const title = m.title.toLowerCase()
      const score = title === tokens.join(" ") ? 0 : title.startsWith(tokens[0]) ? 1 : title.includes(tokens[0]) ? 2 : 3
      return { m, score }
    })
    .sort((a, b) => a.score - b.score || a.m.title.localeCompare(b.m.title))
  return scored.slice(0, 12).map((s) => bare(s.m))
}

export function sliceGoal(g: Goal, mod: ModulePick): Goal {
  if (!g.strategy) return g
  const want = new Set(mod.stages)
  const stages = g.strategy.stages.filter((s) => want.has(s.id))
  const nodes = g.strategy.nodes.filter((n) => want.has(n.stage))
  const ids = new Set(nodes.map((n) => n.id))
  return {
    ...g,
    title: mod.title,
    strategy: {
      ...g.strategy,
      summary: stages.map((s) => s.outcome).filter(Boolean).join(" ") || mod.detail,
      stages,
      nodes: nodes.map((n) => ({ ...n, requires: n.requires.filter((r) => ids.has(r)) }))
    }
  }
}

export function lessonCards(n: StrategyNode): { label: string; text: string }[] {
  const extra = DACH_LESSONS[n.id]
  return [
    { label: "Idea", text: extra?.idea ?? n.summary },
    { label: "Use it", text: extra?.use ?? n.why ?? "Do the check once, in your own words, without notes." },
    { label: "Miss", text: extra?.miss ?? "Stopping at the definition. If you cannot do the check, you do not have it yet." }
  ]
}

export function PathHome(props: {
  modules: ModulePick[]
  onAdd: (m: ModulePick) => void
  onOpen: (m: ModulePick) => void
  onRemove: (key: string) => void
  onPlatform: () => void
  onFarm: () => void
  farmNote: string | null
}) {
  const [q, setQ] = useState("")
  const hits = useMemo(() => searchModules(q), [q])
  const have = new Set(props.modules.map((m) => m.key))
  const addFirst = () => {
    const next = hits.find((h) => !have.has(h.key))
    if (!next) return
    props.onAdd(next)
    setQ("")
  }
  return (
    <div className="path-home">
      <div className="path-now">
        <div className="kicker">Goal</div>
        <h1>Add a module</h1>
        <p className="lead">Search the courses you already have. What you add is your goal, in the order you add it.</p>
        <input
          className="mod-search"
          autoFocus
          value={q}
          placeholder="Search modules"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              addFirst()
            }
          }}
        />
        {q.trim() && (
          <ul className="mod-hits">
            {hits.length ? (
              hits.map((h) => (
                <li key={h.key}>
                  <button
                    disabled={have.has(h.key)}
                    onClick={() => {
                      props.onAdd(h)
                      setQ("")
                    }}
                  >
                    <b>{h.title}</b>
                    <span>{h.detail}</span>
                  </button>
                  {have.has(h.key) && <em>Added</em>}
                </li>
              ))
            ) : (
              <li className="mod-empty">No modules match.</li>
            )}
          </ul>
        )}
        <button className="btn platform-add" onClick={props.onPlatform}>
          Add the platform path
        </button>
        {!!props.modules.length && (
          <ol className="mod-goal">
            {props.modules.map((m, i) => (
              <li key={m.key}>
                <button className="mod-open" onClick={() => props.onOpen(m)}>
                  <span className="mod-n">{i + 1}</span>
                  <span>
                    <b>{m.title}</b>
                    <small>{m.detail}</small>
                  </span>
                </button>
                <button className="mod-x" onClick={() => props.onRemove(m.key)} aria-label={`Remove ${m.title}`}>
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        <button className="farm-text" onClick={props.onFarm}>
          Practice on the farm
        </button>
        {props.farmNote && <p className="farm-note">{props.farmNote}</p>}
      </div>
    </div>
  )
}

export function LessonView(props: { node: StrategyNode; onDone: () => void; onBack: () => void }) {
  const n = props.node
  return (
    <div className="lesson-view">
      <button className="farm-text back" onClick={props.onBack}>
        Back
      </button>
      <div className="kicker">Lesson</div>
      <h1>{n.title}</h1>
      <div className="lesson-cards">
        {lessonCards(n).map((c) => (
          <article key={c.label} className="lesson-card">
            <div className="lk">{c.label}</div>
            <p>{c.text}</p>
          </article>
        ))}
      </div>
      {n.check && (
        <div className="lesson-check">
          <div className="lk">Check</div>
          <p>{n.check}</p>
        </div>
      )}
      <button className="btn primary" onClick={props.onDone}>
        Done, next
      </button>
    </div>
  )
}
