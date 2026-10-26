// A goal's strategy as a map you can move around: stages left to right, what each idea builds on
// drawn as curves, progress as colour. Hover a node to trace its chain; click it for the details
// and "Teach me this". Trackpad: two fingers to pan, pinch to zoom.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api, type CourseInfo, type Goal, type PhaseInfo, type ProjectView, type NodeKind, type NodeStatus, type StrategyNode } from "../api"
import { HEAD_H, isDone, layoutStrategy, lineage, nextNode, NODE_H, NODE_W, readyNodes } from "../goalLayout"
import { Md } from "./Message"
import { NotesReader } from "./Notes"
import * as I from "../icons"

const KIND: Record<NodeKind, { label: string; glyph: string }> = {
  truth: { label: "Given", glyph: "◆" },
  concept: { label: "Concept", glyph: "●" },
  skill: { label: "Skill", glyph: "▲" },
  project: { label: "Project", glyph: "⚑" }
}
const STATUS: { id: NodeStatus; label: string }[] = [
  { id: "todo", label: "To learn" },
  { id: "learning", label: "Learning" },
  { id: "solid", label: "Solid" },
  { id: "known", label: "Knew it" }
]

export function GoalView(props: {
  goal: Goal
  activeNode: string | null // the node whose lesson is open on the right
  liveNodes: Record<string, "running" | "waiting"> // lessons running (or waiting on you) in the background
  busy: boolean
  onTeach: (n: StrategyNode) => void
  onQuiz: (n: StrategyNode) => void
  onRecap: (n: StrategyNode) => void
  onStatus: (n: StrategyNode, s: NodeStatus) => void
  onOpenLesson: (conversationId: string) => void
  onCheckProject: (n: StrategyNode) => void
  onPlan: () => void
}) {
  const { goal, activeNode, liveNodes, busy, onTeach, onQuiz, onStatus, onOpenLesson, onPlan } = props
  const s = goal.strategy
  const lay = useMemo(() => (s ? layoutStrategy(s) : null), [s])
  const ready = useMemo(() => new Set(s ? readyNodes(s).map((n) => n.id) : []), [s])
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const trace = useMemo(() => (s && (hover ?? sel) ? lineage(s, (hover ?? sel)!) : null), [s, hover, sel])
  const selected = s?.nodes.find((n) => n.id === sel) ?? null
  // The notes reader: closed (null), or open at a node's recap ("" = the first one).
  const [reading, setReading] = useState<string | null>(null)
  const noteCount = Object.keys(goal.notes ?? {}).length
  useEffect(() => setReading(null), [goal.id])
  // "Read" on a recap in the lesson chat.
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ goalId: string; nodeId: string }>).detail
      if (d.goalId === goal.id) setReading(d.nodeId)
    }
    window.addEventListener("tutor:open-note", open)
    return () => window.removeEventListener("tutor:open-note", open)
  }, [goal.id])

  // Pan and zoom.
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const fitted = useRef<string | null>(null)
  const fit = (min = 0.3) => {
    const el = box.current
    if (!el || !lay) return
    const k = Math.max(min, Math.min(1.1, (el.clientWidth - 40) / lay.width, (el.clientHeight - 40) / lay.height))
    setView({ k, x: Math.max(20, (el.clientWidth - lay.width * k) / 2), y: Math.max(20, (el.clientHeight - lay.height * k) / 2) })
  }
  // First time a map appears: fit it, but never so small it can't be read; then show where to start.
  useLayoutEffect(() => {
    if (!lay || fitted.current === goal.id) return
    fitted.current = goal.id
    const el = box.current
    if (!el) return
    // Readable first: fit the width if that keeps labels at 75% or more, top of the map in view,
    // then make sure the next node to learn is on screen.
    const k = Math.max(0.75, Math.min(1, (el.clientWidth - 32) / lay.width))
    const x = lay.width * k < el.clientWidth ? (el.clientWidth - lay.width * k) / 2 : 16
    let y = 16
    const start = s && nextNode(s)
    const p = start ? lay.placed.get(start.id) : null
    if (p && y + (p.y + NODE_H) * k > el.clientHeight - 40) y = el.clientHeight / 3 - p.y * k
    setView({ k, x, y })
  }, [lay, goal.id])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const px = e.clientX - r.left
        const py = e.clientY - r.top
        setView((v) => {
          const k = Math.min(1.8, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.01)))
          return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
        })
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const zoomBy = (f: number) => {
    const el = box.current
    if (!el) return
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    setView((v) => {
      const k = Math.min(1.8, Math.max(0.25, v.k * f))
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, textarea")) return
      if (e.key === "Escape") setSel(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const total = s?.nodes.length ?? 0
  const done = s?.nodes.filter(isDone).length ?? 0
  const next = s ? nextNode(s) : null

  // The ready-made course this came from has grown since: offer the new nodes.
  const [news, setNews] = useState<{ count: number; titles: string[] } | null>(null)
  const [taking, setTaking] = useState(false)
  useEffect(() => {
    let live = true
    api.courseNews(goal.id).then((n) => live && setNews(n), () => live && setNews(null))
    return () => {
      live = false
    }
  }, [goal.id, goal.updatedAt])

  return (
    <section className="goal">
      <header className="goal-head">
        <div className="goal-title">
          <span className="goal-kicker">Goal</span>
          <h1>{goal.title}</h1>
          {s && <p className="goal-summary">{s.summary}</p>}
        </div>
        {s && (
          <div className="goal-progress">
            <div className="gp-num">
              <b>{done}</b>/{total} <span>· {ready.size} ready</span>
            </div>
            <div className="gp-stages">
              {lay?.bands.map((b) => (
                <span key={b.id} title={`${b.title}: ${b.done}/${b.total}`}>
                  <i style={{ width: `${b.total ? (b.done / b.total) * 100 : 0}%` }} />
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="goal-actions">
          {noteCount > 0 && (
            <button className={`btn ${reading != null ? "on" : ""}`} onClick={() => setReading(reading != null ? null : (sel && goal.notes?.[sel] ? sel : ""))} title="Your notes from lessons and recaps, to reread">
              <I.Book size={13} /> Notes <span className="count">{noteCount}</span>
            </button>
          )}
          <button className="btn" onClick={onPlan} title="The conversation where the strategy is made and changed">
            <I.Chat size={13} /> Plan
          </button>
          {next && (
            <button className="btn primary next-btn" disabled={busy} onClick={() => (setSel(next.id), onTeach(next))} title={`Teach "${next.title}" next`}>
              <span>
                <b>{next.status === "learning" ? "Continue" : "Start next"}</b>
                <small>{next.title}</small>
              </span>
              <I.ArrowRight size={14} />
            </button>
          )}
        </div>
      </header>
      {news && (
        <div className="course-news">
          <span>
            <b>The course has {news.count} new {news.count === 1 ? "node" : "nodes"}</b> · {news.titles.slice(0, 4).join(", ")}
            {news.count > 4 ? ` and ${news.count - 4} more` : ""}. Your progress stays as it is.
          </span>
          <button
            className="btn primary"
            disabled={taking}
            onClick={() => {
              setTaking(true)
              api.takeCourseUpdate(goal.id).finally(() => setTaking(false))
            }}
          >
            Add them
          </button>
        </div>
      )}

      <div
        ref={box}
        className={`goal-canvas ${trace ? "tracing" : ""}`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".gnode, .map-tools")) return
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
          setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
        }}
        onPointerUp={() => {
          if (drag.current && !drag.current.moved) setSel(null)
          drag.current = null
        }}
      >
        {!s || !lay ? (
          <Drafting />
        ) : (
          <div className="map" style={{ width: lay.width, height: lay.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            {lay.bands.map((b) => (
              <div key={b.id} className="band" style={{ top: b.y, height: b.h, width: lay.width }}>
                <div className="band-head" style={{ height: HEAD_H - 8 }}>
                  <span className="band-n">Stage {b.index + 1}</span>
                  <b>{b.title}</b>
                  <span className="band-count">
                    {b.done}/{b.total}
                  </span>
                  <span className="band-out">{b.outcome}</span>
                </div>
              </div>
            ))}
            <svg className="edges" width={lay.width} height={lay.height}>
              {lay.edges.map((e) => {
                const on = trace?.has(e.from) && trace.has(e.to)
                const doneEdge = isDone(lay.placed.get(e.from)!.node)
                return <path key={`${e.from}>${e.to}`} d={e.d} className={`${e.cross ? "cross" : ""} ${on ? "on" : ""} ${doneEdge ? "done" : ""}`} />
              })}
            </svg>
            {[...lay.placed.values()].map(({ node: n, x, y }) => (
              <button
                key={n.id}
                className={`gnode k-${n.kind} s-${n.status} ${n.optional ? "opt" : ""} ${ready.has(n.id) ? "ready" : ""} ${sel === n.id ? "sel" : ""} ${activeNode === n.id ? "active" : ""} ${liveNodes[n.id] === "waiting" ? "waiting" : ""} ${trace && !trace.has(n.id) ? "faded" : ""}`}
                style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setSel(sel === n.id ? null : n.id)}
              >
                <span className="gn-top">
                  <span className="gn-kind">
                    {KIND[n.kind].glyph} {KIND[n.kind].label}
                  </span>
                  {n.status === "solid" || n.status === "known" ? (
                    <span className="gn-state ok">
                      <I.Check size={11} /> {n.status === "known" ? "knew it" : "solid"}
                    </span>
                  ) : n.status === "learning" ? (
                    <span className="gn-state learning">learning</span>
                  ) : ready.has(n.id) ? (
                    <span className="gn-state next">ready</span>
                  ) : n.optional ? (
                    <span className="gn-state extra" title="An extra: not needed for the goal">extra</span>
                  ) : n.minutes ? (
                    <span className="gn-state">{n.minutes}m</span>
                  ) : null}
                </span>
                <span className="gn-title">{n.title}</span>
              </button>
            ))}
          </div>
        )}

        {s && (
          <div className="map-tools">
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out (pinch)">
              −
            </button>
            <button onClick={() => fit()} title="Fit the whole map">
              <I.Wide size={13} />
            </button>
            <button onClick={() => zoomBy(1.2)} title="Zoom in (pinch)">
              +
            </button>
          </div>
        )}
        {s && (
          <div className="map-legend">
            {Object.entries(KIND).map(([k, v]) => (
              <span key={k} className={`lg k-${k}`}>
                {v.glyph} {v.label}
              </span>
            ))}
          </div>
        )}

        {selected && s && (
          <NodePanel
            node={selected}
            goal={goal}
            ready={ready.has(selected.id)}
            busy={busy}
            nextReady={next}
            onClose={() => setSel(null)}
            onSelect={setSel}
            onTeach={() => onTeach(selected)}
            onQuiz={() => onQuiz(selected)}
            onRecap={() => props.onRecap(selected)}
            onReadNote={() => setReading(selected.id)}
            onStatus={(st) => onStatus(selected, st)}
            onOpenLesson={onOpenLesson}
            onCheckProject={() => props.onCheckProject(selected)}
            onTeachNext={(n) => (setSel(n.id), onTeach(n))}
          />
        )}
        {reading != null && <NotesReader goal={goal} open={reading} onOpen={setReading} onClose={() => setReading(null)} />}
      </div>
    </section>
  )
}

function Drafting() {
  return (
    <div className="drafting">
      <div className="skeleton">
        {[3, 4, 3, 2].map((n, c) => (
          <div key={c} className="sk-col">
            {Array.from({ length: n }, (_, i) => (
              <i key={i} style={{ animationDelay: `${(c * 3 + i) * 90}ms` }} />
            ))}
          </div>
        ))}
      </div>
      <p>
        <b>Drawing your strategy.</b> Answer the questions on the right first: what you want out of it, and a few quick checks of where you are. Then the map appears here.
      </p>
    </div>
  )
}

function NodePanel(props: {
  node: StrategyNode
  goal: Goal
  ready: boolean
  busy: boolean
  nextReady: StrategyNode | null
  onClose: () => void
  onSelect: (id: string) => void
  onTeach: () => void
  onQuiz: () => void
  onRecap: () => void
  onReadNote: () => void
  onStatus: (s: NodeStatus) => void
  onOpenLesson: (conversationId: string) => void
  onCheckProject: () => void
  onTeachNext: (n: StrategyNode) => void
}) {
  const { node: n, goal, ready, busy } = props
  // A project node built in the IDE: its folder and milestones.
  const [project, setProject] = useState<ProjectView | null>(null)
  useEffect(() => {
    let live = true
    setProject(null)
    if (n.kind === "project") api.projectForNode(goal.id, n.id).then((p) => live && setProject(p))
    return () => {
      live = false
    }
  }, [goal.id, n.id, goal.updatedAt])
  const nodes = goal.strategy!.nodes
  const byId = new Map(nodes.map((x) => [x.id, x]))
  const needs = n.requires.map((r) => byId.get(r)).filter((x): x is StrategyNode => !!x)
  const unlocks = nodes.filter((x) => x.requires.includes(n.id))
  const stage = goal.strategy!.stages.find((st) => st.id === n.stage)
  const lessons = goal.lessons.filter((l) => l.nodeId === n.id).sort((a, b) => b.at - a.at)
  const Chip = ({ x }: { x: StrategyNode }) => (
    <button className={`nchip s-${x.status}`} onClick={() => props.onSelect(x.id)}>
      {isDone(x) ? <I.Check size={10} /> : <span className="dot" />} {x.title}
    </button>
  )
  return (
    <aside className="npanel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="np-top">
        <span className={`np-kind k-${n.kind}`}>
          {KIND[n.kind].glyph} {KIND[n.kind].label}
        </span>
        {stage && <span className="np-stage">{stage.title}</span>}
        <div className="grow" />
        <button className="icon" onClick={props.onClose} title="Close (Esc)">
          <I.X size={14} />
        </button>
      </div>
      <h2>{n.title}</h2>
      <div className="np-status" role="radiogroup">
        {STATUS.map((st) => (
          <button key={st.id} role="radio" aria-checked={n.status === st.id} className={n.status === st.id ? `on s-${st.id}` : ""} onClick={() => props.onStatus(st.id)}>
            {st.label}
          </button>
        ))}
      </div>
      <div className="np-body">
        <div className="np-summary">
          <Md text={n.summary} />
        </div>
        {n.why && (
          <section>
            <h4>Why you'd need it</h4>
            <p>
              <Md text={n.why} />
            </p>
          </section>
        )}
        {!!needs.length && (
          <section>
            <h4>Builds on</h4>
            <div className="nchips">
              {needs.map((x) => (
                <Chip key={x.id} x={x} />
              ))}
            </div>
          </section>
        )}
        {!!unlocks.length && (
          <section>
            <h4>Unlocks</h4>
            <div className="nchips">
              {unlocks.map((x) => (
                <Chip key={x.id} x={x} />
              ))}
            </div>
          </section>
        )}
        {n.check && (
          <section>
            <h4>You'll have it when</h4>
            <p>
              <Md text={n.check} />
            </p>
          </section>
        )}
        {!!n.resources?.length && (
          <section>
            <h4>Sources</h4>
            <ul className="np-res">
              {n.resources.map((r, i) => (
                <li key={i}>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {/youtube\.com|youtu\.be|vimeo\.com/.test(r.url) ? <I.Play size={11} /> : <I.Link size={11} />} {r.title}
                  </a>
                </li>
              ))}
            </ul>
            {n.kind !== "project" && (
              <p className="np-hint np-study">
                Press <b>{lessons.length ? "Teach again" : "Teach me this"}</b> and Tutor reads the sources, writes the lesson, then quizzes you. Or read them yourself and hit <b>Recap &amp; quiz</b>. Either way: lesson first, quiz when you're ready, saved to your notes.
              </p>
            )}
          </section>
        )}
        {goal.notes?.[n.id] && (
          <section>
            <h4>Your note</h4>
            <button className="linkish" onClick={props.onReadNote}>
              <I.Book size={11} /> Read it · {new Date(goal.notes[n.id].at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </button>
          </section>
        )}
        {n.note && (
          <section>
            <h4>Last time</h4>
            <p className="np-note">{n.note}</p>
          </section>
        )}
        {project && (
          <section>
            <h4>Project</h4>
            <p className="np-note">
              {project.dir.replace(/^\/Users\/[^/]+/, "~")}
              <br />
              {project.done ? "Complete" : `Milestone ${project.current + 1} of ${project.milestones.length}: ${project.milestones[project.current]?.title}`}
              {project.lastRun && !project.done ? ` · last check ${project.lastRun.passed}/${project.lastRun.total} tests` : ""}
            </p>
          </section>
        )}
        {!!lessons.length && (
          <section>
            <h4>Lessons</h4>
            <ul className="np-lessons">
              {lessons.map((l) => (
                <li key={l.conversationId}>
                  <button className="linkish" onClick={() => props.onOpenLesson(l.conversationId)}>
                    {new Date(l.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · open
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="np-foot">
        {isDone(n) && props.nextReady && props.nextReady.id !== n.id ? (
          <button className="btn primary" disabled={busy} onClick={() => props.onTeachNext(props.nextReady!)} title={`Continue with "${props.nextReady.title}"`}>
            <I.ArrowRight size={13} /> Next: {props.nextReady.title}
          </button>
        ) : null}
        <button className={`btn${n.kind === "project" || !isDone(n) ? " primary" : ""}`} disabled={busy} onClick={props.onTeach} title={n.kind === "project" ? undefined : "Tutor reads the sources and writes the whole lesson, then quizzes you"}>
          <I.Book size={13} /> {n.kind === "project" ? (project ? "Continue the project" : "Start the project") : lessons.length ? "Teach again" : "Teach me this"}
        </button>
        {n.kind !== "project" && (
          <button className="btn" disabled={busy} onClick={props.onRecap} title="You've read the sources: Tutor recaps them in their own order, checks them, then quizzes you">
            <I.Check size={13} /> Recap &amp; quiz
          </button>
        )}
        {project ? (
          <>
            <button className="btn" onClick={() => api.openProject(project.id)}>
              Open in IDE
            </button>
            <button className="btn" disabled={busy} onClick={props.onCheckProject}>
              Check my project
            </button>
          </>
        ) : (
          <button className="btn" disabled={busy} onClick={props.onQuiz} title="Straight to questions, no lesson: for checking what you already know">
            Quiz me
          </button>
        )}
        {!ready && !isDone(n) && <span className="np-hint">Builds on things not done yet · finish those first, or pick a ready node</span>}
      </div>
    </aside>
  )
}

// "What do you want to be able to do?" A goal plus optional videos and links to build it from.
export function NewGoal({ onCreate, onCourse, onOpenGoal, onCancel }: { onCreate: (ask: string, sources: string) => void; onCourse: (c: CourseInfo) => void; onOpenGoal: (id: string) => void; onCancel: () => void }) {
  const [tab, setTab] = useState<"own" | "path">(() => {
    try {
      return localStorage.getItem("newGoalTab") === "path" ? "path" : "own"
    } catch {
      return "own"
    }
  })
  const pick = (t: "own" | "path") => {
    setTab(t)
    try {
      localStorage.setItem("newGoalTab", t)
    } catch {}
  }
  const [ask, setAsk] = useState("")
  const [sources, setSources] = useState("")
  const [courses, setCourses] = useState<CourseInfo[]>([])
  const [phases, setPhases] = useState<PhaseInfo[]>([])
  const [perWeek, setPerWeek] = useState(() => {
    try {
      return Number(localStorage.getItem("studyHoursPerWeek")) || 21
    } catch {
      return 21
    }
  })
  const setWeekly = (n: number) => {
    const v = Math.max(1, Math.min(80, Math.round(n) || 1))
    setPerWeek(v)
    try {
      localStorage.setItem("studyHoursPerWeek", String(v))
    } catch {}
  }
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    api.listCourses().then(setCourses)
    api.listPhases().then(setPhases)
  }, [])
  useEffect(() => {
    if (tab === "own") ta.current?.focus()
  }, [tab])
  const EXAMPLES = [
    ["Master", "Everything about Kubernetes, well enough to run and debug my own cluster"],
    ["Master", "Read LLM research papers fluently: the math, the architectures, the evals"],
    ["Master", "Rust well enough to write a fast CLI tool and a small web service"],
    ["Build", "Build a RAG app over my own notes, with evals, deployed in Docker"],
    ["Build", "Build a multiplayer web game with a TypeScript backend and websockets"]
  ]
  const submit = () => ask.trim() && onCreate(ask.trim(), sources.trim())
  return (
    <div className="sheet-back" onPointerDown={onCancel}>
      <div className="sheet" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.key === "Escape" ? onCancel() : e.key === "Enter" && e.metaKey ? submit() : null)}>
        <span className="goal-kicker">New goal</span>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "own"} className={tab === "own" ? "on" : ""} onClick={() => pick("own")}>
            Your own goal
          </button>
          <button role="tab" aria-selected={tab === "path"} className={tab === "path" ? "on" : ""} onClick={() => pick("path")}>
            Product engineer path{courses.length ? ` · ${courses.length} courses` : ""}
          </button>
        </div>
        {tab === "own" ? (
          <>
            <h2>What do you want to be able to do?</h2>
            <p className="hint">Something to build or something to master. Tutor asks a few questions, checks where you are, researches the field, then draws the whole strategy as a map, from the things you can take as given up to your goal.</p>
            <textarea ref={ta} rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Understand Kubernetes end to end, well enough to run my own cluster" />
            <div className="examples">
              {EXAMPLES.map(([k, t]) => (
                <button key={t} onClick={() => setAsk(t)}>
                  <em>{k}</em> {t}
                </button>
              ))}
            </div>
            <label className="field">
              <span>Videos or links to build it from (optional, one per line)</span>
              <textarea className="mono" rows={2} value={sources} onChange={(e) => setSources(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
            </label>
          </>
        ) : (
          <>
            <h2>The product engineer path</h2>
            <p className="hint">
              Cloud and AI, in priority order. Start anywhere; each course opens with a short quiz round and marks what you already have. Times are realistic (practice, projects and reviews included), not lesson time.
            </p>
            <label className="path-pace">
              Study time
              <input type="number" min={1} max={80} value={perWeek} onChange={(e) => setWeekly(Number(e.target.value))} />
              hours a week
            </label>
            {(() => {
              let cum = 0
              return phases.map((ph) => {
                const list = courses.filter((c) => c.phase === ph.id)
                if (!list.length) return null
                const from = cum
                const rows = list.map((c) => {
                  if (ph.id) cum += c.realHours
                  return { c, week: Math.ceil(cum / perWeek) }
                })
                const range = ph.id ? `weeks ${Math.floor(from / perWeek) + 1}–${Math.ceil(cum / perWeek)}` : "optional"
                return (
                  <section key={ph.id} className={`path-phase ${ph.id ? "" : "side"}`}>
                    <div className="path-ph">
                      <span className="path-ph-t">{ph.id ? `Phase ${ph.id} · ${ph.title}` : ph.title}</span>
                      <span className="path-ph-w">{range}</span>
                    </div>
                    <p className="path-ph-n">{ph.note}</p>
                    <ol className="path">
                      {rows.map(({ c, week }) => (
                        <li key={c.id} className={`path-c ${c.started ? "started" : ""}`} title={c.after.length ? `Builds on ${c.after.map((a) => a.title).join(" and ")}` : undefined}>
                          <span className="path-n">{c.step || "◇"}</span>
                          <div className="path-main">
                            <span className="course-t">{c.title}</span>
                            <span className="course-b">{c.blurb}</span>
                            <span className="course-m">
                              {c.nodes} nodes · ~{c.realHours} h{ph.id ? ` · done by week ${week}` : ""}
                              {c.after.length ? ` · builds on ${c.after.map((a) => (a.step ? a.step : a.title)).join(" & ")}` : ""}
                            </span>
                          </div>
                          {c.started ? (
                            <button className="btn" onClick={() => onOpenGoal(c.started!.goalId)} title="You've started this course">
                              Open · {c.started.done}/{c.started.total}
                            </button>
                          ) : (
                            <button className="btn primary" onClick={() => onCourse(c)}>
                              Start
                            </button>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>
                )
              })
            })()}
          </>
        )}
        <div className="sheet-foot">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          {tab === "own" && (
            <button className="btn primary" disabled={!ask.trim()} onClick={submit}>
              Build my strategy <kbd>⌘↵</kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function GoalList(props: { goals: { id: string; title: string; total: number; done: number; drafting: boolean }[]; current: string | null; onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void; live?: Record<string, "running" | "waiting"> }) {
  return (
    <div className="sidebar-body">
      <div className="hist-top">
        <button className="new-chat" onClick={props.onNew}>
          <I.Plus size={14} /> New goal
        </button>
      </div>
      {!props.goals.length && <p className="hint pad">Say what you want to build or master, and Tutor draws the whole path as a map you work through.</p>}
      <ul className="hist goals">
        {props.goals.map((g) => (
          <li key={g.id} className={g.id === props.current ? "cur" : ""}>
            <button className="hist-open" onClick={() => props.onOpen(g.id)}>
              <Ring done={g.done} total={g.total} drafting={g.drafting} />
              <span className="ht">
                {props.live?.[g.id] && <span className={`live-dot ${props.live[g.id]}`} />}
                {g.title}
              </span>
              <span className="hm">{props.live?.[g.id] === "waiting" ? "a question is waiting for you" : g.drafting ? "drawing the map…" : `${g.done} of ${g.total} done`}</span>
            </button>
            <button
              className="icon del"
              title="Delete this goal"
              onClick={() => {
                if (window.confirm(`Delete the goal "${g.title}" and its map? Its conversations stay in Chats.`)) props.onDelete(g.id)
              }}
            >
              <I.Trash size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Ring({ done, total, drafting }: { done: number; total: number; drafting: boolean }) {
  const r = 7
  const c = 2 * Math.PI * r
  const f = total ? done / total : 0
  return (
    <svg className={`ring ${drafting ? "drafting" : ""}`} width="18" height="18" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r={r} className="ring-bg" />
      <circle cx="9" cy="9" r={r} className="ring-fg" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  )
}

// The goal's chat before anything's been said (or a lesson that hasn't started).
export function GoalChatEmpty({ goal, onPrompt, onDraft }: { goal: Goal; onPrompt: (text: string) => void; onDraft: (text: string) => void }) {
  const s = goal.strategy
  const next = s ? nextNode(s) : null
  const items = [
    { t: "Walk me through it", sub: "Why this order, what each stage gets you", run: () => onPrompt("Walk me through the strategy: why this order, and what each stage gets me.") },
    { t: "Add a video or link", sub: "It maps it onto the plan, with timestamps", run: () => onDraft("Fold this into the plan: ") },
    { t: "Tighten it", sub: "Fewer nodes, only what the goal needs", run: () => onPrompt("Tighten the map: cut anything the goal doesn't really need, and tell me what you cut.") },
    { t: next ? `Start: ${next.title}` : "Go deeper", sub: next ? "The first node that's ready" : "Add the next level", run: () => onPrompt(next ? `Teach me "${next.title}".` : "Extend the map to the next level of depth.") }
  ]
  return (
    <div className="empty goal-empty">
      <span className="goal-kicker">Strategy chat</span>
      <h1>{goal.title}</h1>
      <p className="sub">Change the plan here, give it videos and links to build from, or ask anything about it. Lessons on single nodes start from the map.</p>
      <div className="starters">
        {items.map((i) => (
          <button key={i.t} className="starter" onClick={i.run}>
            <span className="st">{i.t}</span>
            <span className="ss">{i.sub}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
