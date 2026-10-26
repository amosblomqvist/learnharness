// Tutor as a self-study app, shaped like boot.dev: a career path of courses, a course of chapters,
// a lesson with the reading on the left and the work on the right, XP for every passed step.
// One obvious action per screen; nothing waits on a model.
import { useEffect, useMemo, useRef, useState } from "react"
import { layoutStrategy, NODE_H, NODE_W } from "../goalLayout"
import type { Strategy, StrategyNode } from "../api"
import { CAREERS, courseChapters, DAILY_GOAL, level, lessonXp, moduleCourse, rank, type Career, type Course } from "./course"
import { Md, StepView } from "./Steps"
import { TypeThrough } from "./TypeThrough"
import {
  career,
  courseLessonsOf,
  dueCards,
  fresh,
  isDone,
  isReady,
  lessonEarned,
  lessonKey,
  markRead,
  MODULES,
  moduleById,
  nextLesson,
  passStep,
  pathLessons,
  progress,
  review,
  revive,
  blankStarter,
  saveTyped,
  showAnswer,
  stepKey,
  streak,
  typingGate,
  typingTotals,
  xpToday,
  xpTotal,
  type Due,
  type State
} from "./store"
import type { Lesson, Module } from "./types"
import { accuracy, wpm } from "./typing"
import "./study.css"

type Bridge = {
  studyLoad(): Promise<unknown>
  studySave(s: State): Promise<boolean>
  openFarm(): Promise<{ ok: true } | { ok: false; error: string }>
  openVisualizer(code?: string): Promise<{ ok: true } | { ok: false; error: string }>
  onStudyFarm(cb: (farm: Record<string, number>) => void): () => void
  onMenu(cb: (a: string) => void): () => void
  studyTools(): Promise<Tools>
}
type Tools = { python: string | null; node: "system" | "bundled" | null; git: boolean; tsc: boolean }
const bridge = () => (window as unknown as { tutor: Bridge }).tutor

type View =
  | { at: "home" }
  | { at: "paths" }
  | { at: "course"; course: string }
  | { at: "map"; module: string }
  | { at: "lesson"; key: string; course?: string }
  | { at: "review"; queue: string[] }

// A course by id: the current career's, any career's, or a whole module.
function findCourse(s: State, id: string): Course | undefined {
  const own = career(s)?.courses.find((c) => c.id === id)
  if (own) return own
  const any = CAREERS.flatMap((c) => c.courses).find((c) => c.id === id)
  if (any) return any
  const m = moduleById(id)
  return m && moduleCourse(m)
}
// The course a lesson belongs to on your path (for its chapter and next/previous arrows).
function courseOfLesson(s: State, l: Lesson): Course | undefined {
  const c = career(s)?.courses.find((x) => courseLessonsOf(x).some((y) => lessonKey(y) === lessonKey(l)))
  return c ?? (moduleById(l.module) && moduleCourse(moduleById(l.module)!))
}
const courseProgress = (s: State, c: Course) => {
  const ls = courseLessonsOf(c)
  return { done: ls.filter((l) => isDone(s, l)).length, total: ls.length }
}

type Toast = { id: number; text: string; big?: boolean }

export function Study() {
  const [state, setState] = useState<State | null>(null)
  const [view, setView] = useState<View>({ at: "home" })
  const [toasts, setToasts] = useState<Toast[]>([])
  const loaded = useRef(false)
  const lastXp = useRef<number | null>(null)

  useEffect(() => {
    bridge()
      .studyLoad()
      .then((raw) => setState(raw ? revive(raw) : fresh()))
      .catch(() => setState(fresh()))
    return bridge().onStudyFarm?.((farm) => setState((s) => (s ? { ...s, farm } : s)))
  }, [])
  // Save shortly after every change.
  useEffect(() => {
    if (!state) return
    if (!loaded.current) {
      loaded.current = true
      return
    }
    const t = setTimeout(() => void bridge().studySave(state), 250)
    return () => clearTimeout(t)
  }, [state])

  // XP you just earned floats up for a moment; a new level gets a bigger one.
  const xp = useMemo(() => (state ? xpTotal(state) : 0), [state])
  useEffect(() => {
    if (!state) return
    const before = lastXp.current
    lastXp.current = xp
    if (before === null || xp <= before) return
    const id = Date.now()
    const up = level(xp).level > level(before).level
    const add: Toast[] = [{ id, text: `Correct! You earned ${xp - before} XP` }]
    if (up) add.push({ id: id + 1, text: `Level ${level(xp).level} · ${rank(level(xp).level)}`, big: true })
    setToasts((t) => [...t, ...add])
    const timer = setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id && x.id !== id + 1)), up ? 4000 : 2200)
    return () => clearTimeout(timer)
  }, [xp])

  const go = useRef<(a: string) => void>(() => {})
  go.current = (a) => {
    if (a === "home") setView({ at: "home" })
    if (a === "farm") void bridge().openFarm()
  }
  useEffect(() => bridge().onMenu?.((a) => go.current(a)), [])

  // Back with ⌘[ or Escape (outside text fields).
  const back = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, .cm-editor, .s-type")
      if ((e.metaKey && e.key === "[") || (e.key === "Escape" && !typing)) {
        e.preventDefault()
        back.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!state) return <div className="study" />

  const update = (f: (s: State) => State) => setState((s) => (s ? f(s) : s))
  const openLesson = (l: Lesson, course?: string) => setView({ at: "lesson", key: lessonKey(l), course: course ?? courseOfLesson(state, l)?.id })
  const openCourse = (id: string) => setView({ at: "course", course: id })
  const home = { label: "Path", to: { at: "home" } as View }
  const crumb: { label: string; to: View }[] =
    view.at === "home"
      ? []
      : view.at === "course" || view.at === "paths" || view.at === "review"
        ? [home]
        : view.at === "map"
          ? [home, { label: moduleById(view.module)?.title ?? "", to: { at: "course", course: view.module } }]
          : (() => {
              const c = view.course ? findCourse(state, view.course) : undefined
              return c ? [home, { label: c.title, to: { at: "course", course: c.id } as View }] : [home]
            })()
  back.current = () => setView(crumb.length ? crumb[crumb.length - 1].to : { at: "home" })
  const split = view.at === "lesson"
  return (
    <div className="study">
      <header className="s-bar">
        {crumb.map((c, i) => (
          <button key={i} className="s-crumb" onClick={() => setView(c.to)}>
            {i === 0 ? "← " : ""}
            {c.label}
          </button>
        ))}
        <XpBar state={state} xp={xp} />
      </header>
      <div className={`s-scroll ${split ? "split" : ""}`} key={view.at === "lesson" ? view.key : view.at === "map" ? view.module : view.at === "course" ? view.course : view.at}>
        {view.at === "home" && <Home state={state} setState={update} onCourse={openCourse} onPaths={() => setView({ at: "paths" })} onLesson={(l) => openLesson(l)} onReview={(q) => setView({ at: "review", queue: q })} />}
        {view.at === "paths" && <Paths state={state} onPick={(id) => (update((s) => ({ ...s, career: id })), setView({ at: "home" }))} />}
        {view.at === "course" && findCourse(state, view.course) && <CourseView state={state} course={findCourse(state, view.course)!} onLesson={(l) => openLesson(l, view.course)} onMap={(m) => setView({ at: "map", module: m })} />}
        {view.at === "map" && <MapView state={state} module={moduleById(view.module)!} onLesson={(l) => openLesson(l)} />}
        {view.at === "lesson" && <LessonView state={state} setState={update} lessonKey_={view.key} course={view.course ? findCourse(state, view.course) : undefined} onOpen={(l, c) => openLesson(l, c)} onHome={() => setView({ at: "home" })} />}
        {view.at === "review" && <Review state={state} setState={update} queue={view.queue} onDone={() => setView({ at: "home" })} />}
      </div>
      <div className="s-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`s-toast ${t.big ? "big" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- the bar: streak, level, today's XP ----------
const Flame = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
    <path d="M12 2c1 4 5 5.5 5 10.5A5 5 0 0 1 7 12.5c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-6 1-9z" fill="currentColor" />
  </svg>
)
function XpBar({ state, xp }: { state: State; xp: number }) {
  const lv = level(xp)
  const days = streak(state)
  const today = xpToday(state)
  return (
    <div className="s-xpbar" title={`${xp} XP in all. Level ${lv.level + 1} at ${xp - lv.into + lv.span} XP.`}>
      <span className={`s-streak ${days > 0 ? "on" : ""}`} title={days ? `${days}-day streak` : "Study today to start a streak"}>
        <Flame /> {days}
      </span>
      <span className="s-goalxp" title={`Today: ${today} of ${DAILY_GOAL} XP`}>
        <span className="s-ring" style={{ ["--p" as string]: `${Math.min(100, (100 * today) / DAILY_GOAL)}%` }} />
        {today}/{DAILY_GOAL} today
      </span>
      <span className="s-level">
        <b>Lv {lv.level}</b>
        <span className="s-lvmeter">
          <span style={{ width: `${(100 * lv.into) / lv.span}%` }} />
        </span>
      </span>
    </div>
  )
}

// ---------- home ----------
function Home({ state, setState, onCourse, onPaths, onLesson, onReview }: { state: State; setState: (f: (s: State) => State) => void; onCourse: (id: string) => void; onPaths: () => void; onLesson: (l: Lesson) => void; onReview: (q: string[]) => void }) {
  const due = dueCards(state)
  const next = nextLesson(state)
  const c = career(state)
  const all = pathLessons(state)
  const done = all.filter((l) => isDone(state, l)).length
  const xp = xpTotal(state)
  const lv = level(xp)
  const typing = typingTotals(state)
  const [adding, setAdding] = useState(false)
  const [tools, setTools] = useState<Tools | null>(null)
  useEffect(() => {
    bridge().studyTools?.().then(setTools, () => {})
  }, [])
  const missing = tools ? [!tools.python && "Python 3.12+ (python.org, or brew install python)", !tools.git && "git (in Terminal: xcode-select --install)"].filter(Boolean) : []
  const nextCourse = next && courseOfLesson(state, next)

  // Reviews first when a handful are waiting, so they don't pile up; otherwise the next lesson.
  const reviewFirst = due.length >= 5 || (!next && due.length > 0)
  const go = () => (reviewFirst ? onReview(due.slice(0, 20).map((d) => d.key)) : next && onLesson(next))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target as HTMLElement).closest("input, textarea, button")) go()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div className="s-page s-home">
      <div className="s-kicker">{c ? "Career path" : "Your goal"}</div>
      <h1>{c ? c.title : "SWE path"}</h1>
      {c && <p className="s-lead">{c.blurb}</p>}
      <p className="s-stat">
        {done} of {all.length} lessons · level {lv.level}, {rank(lv.level)} · {xp.toLocaleString()} XP
        {due.length > 0 && !reviewFirst && <> · {due.length} to review</>}
        {typing.pages > 0 && (
          <>
            {" "}
            · {typing.pages} page{typing.pages === 1 ? "" : "s"} of docs typed at {Math.round(typing.wpm)} wpm
          </>
        )}
        {" · "}
        <button className="s-link" onClick={onPaths}>
          Change path
        </button>
      </p>

      {(next || due.length > 0) && (
        <button className="s-continue" onClick={go}>
          <span className="s-c-label">{reviewFirst ? "Review" : state.steps[`${lessonKey(next!)}#0`] ? "Continue" : "Start"}</span>
          <span className="s-c-what">{reviewFirst ? `${Math.min(20, due.length)} question${due.length === 1 ? "" : "s"} you learned before` : next!.title}</span>
          <span className="s-c-meta">{reviewFirst ? "about " + Math.max(2, Math.round(Math.min(20, due.length) * 0.6)) + " min" : `${nextCourse?.title} · ${next!.minutes} min · ${lessonXp(next!)} XP`}</span>
        </button>
      )}
      {!next && !due.length && <p className="s-lead">Everything on your path is done. {c ? "Pick another path to keep going." : "Add a module to keep going."}</p>}
      {reviewFirst && next && (
        <button className="s-link s-after" onClick={() => onLesson(next)}>
          Or skip to the next lesson: {next.title}
        </button>
      )}
      {!reviewFirst && due.length > 0 && (
        <button className="s-link s-after" onClick={() => onReview(due.slice(0, 20).map((d) => d.key))}>
          Review {due.length} now
        </button>
      )}

      {missing.length > 0 && (
        <p className="s-warn s-tools">
          Some exercises need tools this Mac doesn't have yet: {missing.join("; ")}. Lessons and the other exercises work without them.
        </p>
      )}

      {c ? <Track state={state} career={c} here={nextCourse?.id} onCourse={onCourse} /> : <ModuleList state={state} setState={setState} here={next?.module} onCourse={onCourse} />}

      <div className="s-foot">
        {!c && (adding ? <AddModule state={state} onAdd={(id) => (setState((s) => ({ ...s, path: [...s.path, id], removed: s.removed.filter((x) => x !== id) })), setAdding(false))} onClose={() => setAdding(false)} /> : <button className="s-link" onClick={() => setAdding(true)}>Add a module</button>)}
        <button className="s-link" onClick={() => void bridge().openFarm()}>
          Practice Python on the farm
        </button>
        <button className="s-link" title="Watch Python run step by step, like pythontutor.com (⌘⌥V)" onClick={() => void bridge().openVisualizer()}>
          Python visualizer
        </button>
        <label className="s-toggle">
          <input type="checkbox" checked={state.typeDocs} onChange={(e) => setState((s) => ({ ...s, typeDocs: e.target.checked }))} />
          Type the docs before each lesson's tasks
          <small>The human-written page the lesson cites: the Python docs, the TypeScript Handbook, man pages and so on.</small>
        </label>
      </div>
    </div>
  )
}

// A career path's courses, in order, like a boot.dev track.
function Track({ state, career: c, here, onCourse }: { state: State; career: Career; here?: string; onCourse: (id: string) => void }) {
  return (
    <ol className="s-path s-track">
      {c.courses.map((x, i) => {
        const p = courseProgress(state, x)
        const missing = x.parts.some((pt) => !moduleById(pt.module))
        return (
          <li key={x.id} className={`${here === x.id ? "here" : ""} ${p.total && p.done === p.total ? "complete" : ""} ${missing ? "soon" : ""}`}>
            <button className="s-mod" onClick={() => !missing && onCourse(x.id)} disabled={missing}>
              <span className="s-n">{p.total && p.done === p.total ? "✓" : i + 1}</span>
              <span className="s-mod-text">
                <b>
                  {x.title}
                  {x.project && <em className="s-tag">project</em>}
                </b>
                <small>{missing ? "Coming soon" : x.blurb}</small>
              </span>
              <span className="s-meter" aria-label={`${p.done} of ${p.total}`}>
                <span style={{ width: `${(100 * p.done) / Math.max(1, p.total)}%` }} />
              </span>
              <span className="s-count">
                {p.done}/{p.total}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// The SWE path: your own modules, in the order you dragged them into.
function ModuleList({ state, setState, here, onCourse }: { state: State; setState: (f: (s: State) => State) => void; here?: string; onCourse: (id: string) => void }) {
  const [drag, setDrag] = useState<number | null>(null)
  const mods = state.path.map(moduleById).filter((m): m is Module => !!m)
  return (
    <ol className="s-path">
      {mods.map((m, i) => {
        const p = progress(state, m)
        return (
          <li
            key={m.id}
            draggable
            onDragStart={() => setDrag(i)}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              e.preventDefault()
              if (drag === null || drag === i) return
              setState((s) => {
                const path = [...s.path]
                const [x] = path.splice(drag, 1)
                path.splice(i, 0, x)
                return { ...s, path }
              })
              setDrag(i)
            }}
            className={`${here === m.id ? "here" : ""} ${p.done === p.total ? "complete" : ""} ${drag === i ? "dragging" : ""}`}
          >
            <button className="s-mod" onClick={() => onCourse(m.id)}>
              <span className="s-n">{i + 1}</span>
              <span className="s-mod-text">
                <b>{m.title}</b>
                <small>{m.blurb}</small>
              </span>
              <span className="s-meter" aria-label={`${p.done} of ${p.total}`}>
                <span style={{ width: `${(100 * p.done) / Math.max(1, p.total)}%` }} />
              </span>
              <span className="s-count">
                {p.done}/{p.total}
              </span>
            </button>
            <button className="s-x" title="Take off the path (progress is kept)" onClick={() => setState((s) => ({ ...s, path: s.path.filter((x) => x !== m.id), removed: [...s.removed.filter((x) => x !== m.id), m.id] }))}>
              ×
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ---------- choosing a path ----------
function Paths({ state, onPick }: { state: State; onPick: (id: string) => void }) {
  const options: { id: string; title: string; blurb: string; months?: string; courses: string[]; lessons: Lesson[] }[] = [
    ...CAREERS.map((c) => ({ id: c.id, title: c.title, blurb: c.blurb, months: c.months, courses: c.courses.map((x) => x.title), lessons: c.courses.flatMap(courseLessonsOf) })),
    {
      id: "swe",
      title: "SWE path (your own)",
      blurb: "Whole modules in the order you set. Add modules from the catalogue and drag them into place.",
      courses: state.path.map((id) => moduleById(id)?.title ?? id),
      lessons: state.path.flatMap((id) => moduleById(id)?.lessons ?? [])
    }
  ]
  return (
    <div className="s-page s-paths">
      <div className="s-kicker">Career paths</div>
      <h1>Pick a path</h1>
      <p className="s-lead">A path is a fixed run of courses from your first line of Python to job-ready. Your progress, XP and reviews carry over when you switch: a lesson done on one path is done on all of them.</p>
      <div className="s-cards">
        {options.map((o) => {
          const seen = new Set<string>()
          const ls = o.lessons.filter((l) => !seen.has(lessonKey(l)) && !!seen.add(lessonKey(l)))
          const done = ls.filter((l) => isDone(state, l)).length
          const hours = Math.round(ls.reduce((a, l) => a + l.minutes, 0) / 60)
          const on = state.career === o.id
          return (
            <section key={o.id} className={`s-card ${on ? "on" : ""}`}>
              <h2>{o.title}</h2>
              <p>{o.blurb}</p>
              <p className="s-fine">
                {o.courses.length} courses · {ls.length} lessons · about {hours} h of lessons{o.months ? ` · ${o.months}` : ""} · {done} done
              </p>
              <ol className="s-chips">
                {o.courses.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
              <button className={`s-btn ${on ? "" : "s-submit"}`} onClick={() => onPick(o.id)} disabled={on}>
                {on ? "Your path" : "Follow this path"}
              </button>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function AddModule({ state, onAdd, onClose }: { state: State; onAdd: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("")
  const left = MODULES.filter((m) => !state.path.includes(m.id))
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = left.filter((m) => {
    const hay = [m.title, m.blurb, ...m.lessons.map((l) => l.title)].join(" ").toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return (
    <div className="s-add">
      <input autoFocus value={q} placeholder={left.length ? "Search modules" : "Every module is on your path"} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.key === "Escape" ? onClose() : e.key === "Enter" && hits[0] && onAdd(hits[0].id))} />
      <ul>
        {hits.map((m) => (
          <li key={m.id}>
            <button onClick={() => onAdd(m.id)}>
              <b>{m.title}</b> <small>{m.lessons.length} lessons · {m.blurb}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- course ----------
// A course page: its chapters, each a list of lessons with what they're worth. The chapter you're
// in is open; click any other to look inside.
function CourseView({ state, course, onLesson, onMap }: { state: State; course: Course; onLesson: (l: Lesson) => void; onMap: (module: string) => void }) {
  const chapters = courseChapters(course, moduleById)
  const lessons = chapters.flatMap((c) => c.lessons)
  const p = courseProgress(state, course)
  const left = lessons.filter((l) => !isDone(state, l))
  const next = left.find((l) => isReady(state, l)) ?? left[0]
  const cur = chapters.find((ch) => next && ch.lessons.includes(next))
  const [open, setOpen] = useState<Set<string>>(() => new Set(cur ? [cur.key] : chapters.slice(0, 1).map((c) => c.key)))
  const earned = lessons.reduce((a, l) => a + lessonEarned(state, l), 0)
  const worth = lessons.reduce((a, l) => a + lessonXp(l), 0)
  const hours = Math.round(lessons.reduce((a, l) => a + l.minutes, 0) / 60)
  const single = course.parts.length === 1 && !course.parts[0].stages ? course.parts[0].module : null
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  return (
    <div className="s-page s-course">
      <div className="s-kicker">
        Course · {lessons.length} lessons · about {hours} h
      </div>
      <h1>{course.title}</h1>
      <p className="s-lead">{course.blurb}</p>
      <div className="s-coursestat">
        <span className="s-meter big">
          <span style={{ width: `${(100 * p.done) / Math.max(1, p.total)}%` }} />
        </span>
        <span>
          {p.done} of {p.total} lessons · {earned.toLocaleString()} of {worth.toLocaleString()} XP
        </span>
      </div>
      {next && (
        <button className="s-continue small" onClick={() => onLesson(next)}>
          <span className="s-c-label">{p.done ? "Continue" : "Start"}</span>
          <span className="s-c-what">{next.title}</span>
          <span className="s-c-meta">
            {cur?.title} · {next.minutes} min · {lessonXp(next)} XP
          </span>
        </button>
      )}
      {single && (
        <p className="s-fine">
          <button className="s-link" onClick={() => onMap(single)}>
            See the lessons as a map of what builds on what
          </button>
        </p>
      )}
      <ol className="s-chapters">
        {chapters.map((ch, i) => {
          const d = ch.lessons.filter((l) => isDone(state, l)).length
          const complete = d === ch.lessons.length
          const isOpen = open.has(ch.key)
          return (
            <li key={ch.key} className={`s-chapter ${complete ? "complete" : ""} ${cur?.key === ch.key ? "here" : ""}`}>
              <button className="s-chapter-head" onClick={() => toggle(ch.key)} aria-expanded={isOpen}>
                <span className="s-chapter-n">{complete ? "✓" : i + 1}</span>
                <span className="s-chapter-text">
                  <small>
                    Chapter {i + 1}
                    {course.parts.length > 1 ? ` · ${ch.module.title}` : ""}
                  </small>
                  <b>{ch.title}</b>
                  <span>{ch.outcome}</span>
                </span>
                <span className="s-count">
                  {d}/{ch.lessons.length}
                </span>
              </button>
              {isOpen && (
                <ol className="s-lessons">
                  {ch.lessons.map((l) => {
                    const cls = isDone(state, l) ? "done" : next && lessonKey(next) === lessonKey(l) ? "next" : isReady(state, l) ? "ready" : "locked"
                    return (
                      <li key={l.id}>
                        <button className={`s-lessonrow ${cls}`} onClick={() => onLesson(l)} title={l.goal}>
                          <span className="s-dot" />
                          <span className="s-lr-title">
                            {l.title}
                            {l.project && <em className="s-tag">project</em>}
                          </span>
                          <span className="s-lr-meta">
                            {l.minutes} min · {isDone(state, l) ? `${lessonEarned(state, l)} XP` : `${lessonXp(l)} XP`}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---------- map ----------
function MapView({ state, module: m, onLesson }: { state: State; module: Module; onLesson: (l: Lesson) => void }) {
  const next = nextLesson(state)
  const strategy: Strategy = useMemo(
    () => ({
      summary: m.blurb,
      approach: m.why,
      stages: m.stages,
      updatedAt: 0,
      nodes: m.lessons.map(
        (l): StrategyNode => ({
          id: l.id,
          title: l.title,
          kind: l.project ? "project" : "concept",
          stage: l.stage,
          summary: l.goal,
          requires: l.needs.filter((n) => !n.includes("/")),
          minutes: l.minutes,
          status: isDone(state, l) ? "solid" : l.steps.some((_, i) => state.steps[stepKey(l, i)]) ? "learning" : "todo"
        })
      )
    }),
    [m, state]
  )
  const lay = useMemo(() => layoutStrategy(strategy), [strategy])
  const byId = new Map(m.lessons.map((l) => [l.id, l]))
  const p = progress(state, m)
  const [hover, setHover] = useState<string | null>(null)
  return (
    <div className="s-page s-mappage">
      <div className="s-head">
        <div className="s-kicker">
          Module · {p.done} of {p.total} lessons
        </div>
        <h1>{m.title}</h1>
        <p className="s-lead">{m.why || m.blurb}</p>
      </div>
      <div className="s-map" style={{ width: lay.width, height: lay.height }}>
        {lay.bands.map((b) => (
          <div key={b.id} className="s-band" style={{ top: b.y, height: b.h }}>
            <b>{b.title}</b>
            <span>{b.outcome}</span>
          </div>
        ))}
        <svg className="s-edges" width={lay.width} height={lay.height}>
          {lay.edges.map((e) => (
            <path key={`${e.from}>${e.to}`} d={e.d} className={`${e.cross ? "cross" : ""} ${hover && (hover === e.from || hover === e.to) ? "on" : ""} ${isDone(state, byId.get(e.from)!) ? "done" : ""}`} />
          ))}
        </svg>
        {[...lay.placed.values()].map(({ node, x, y }) => {
          const l = byId.get(node.id)!
          const cls = isDone(state, l) ? "done" : next && lessonKey(next) === lessonKey(l) ? "next" : isReady(state, l) ? "ready" : "locked"
          return (
            <button key={node.id} className={`s-node ${cls} ${l.project ? "project" : ""}`} style={{ left: x, top: y, width: NODE_W, height: NODE_H }} onClick={() => onLesson(l)} onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(null)} title={l.goal}>
              <b>{l.title}</b>
              <small>
                {cls === "done" ? "Done" : cls === "next" ? "Next" : l.project ? "Project" : ""}
                {cls !== "done" && cls !== "next" && !l.project ? "" : " · "}
                {l.minutes} min
              </small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------- lesson ----------
// Reading on the left, the assignment on the right (one column in a narrow window). The bar on
// top shows where you are in the chapter, with arrows to the lessons either side; the arrow to
// the next lesson turns gold once this one is done.
function LessonView({ state, setState, lessonKey_: key, course, onOpen, onHome }: { state: State; setState: (f: (s: State) => State) => void; lessonKey_: string; course?: Course; onOpen: (l: Lesson, course?: string) => void; onHome: () => void }) {
  const [mid, lid] = key.split("/")
  const m = moduleById(mid)
  const l = m?.lessons.find((x) => x.id === lid)
  const [pick, setPick] = useState<number | null>(null)
  if (!m || !l) return <div className="s-page">This lesson no longer exists.</div>
  const chapters = course ? courseChapters(course, moduleById) : courseChapters(moduleCourse(m), moduleById)
  const ci = chapters.findIndex((ch) => ch.lessons.some((x) => lessonKey(x) === key))
  const chapter = chapters[ci]
  const inCourse = chapters.flatMap((ch) => ch.lessons)
  const at = inCourse.findIndex((x) => lessonKey(x) === key)
  const prev = at > 0 ? inCourse[at - 1] : undefined
  const after = at >= 0 && at < inCourse.length - 1 ? inCourse[at + 1] : undefined
  const passed = l.steps.map((_, i) => !!state.steps[stepKey(l, i)]?.ok)
  // Steps open one at a time: the next appears once the one before it has passed.
  const open = passed.findIndex((x) => !x)
  const shown = open < 0 ? l.steps.length : open + 1
  // One task at a time, as on boot.dev: you stay on a step after it passes until you press Next step.
  const cur = Math.min(pick ?? (open < 0 ? Math.max(0, l.steps.length - 1) : open), shown - 1)
  const curStep = l.steps[cur]
  const done = isDone(state, l)
  // Past the end of this course, Next goes to the next lesson on your path.
  const onward = after ?? (done ? nextLesson(state) : null) ?? undefined
  const farm = state.farm[l.id]
  // With "type the docs" on, the tasks wait until the cited page is typed.
  const gate = typingGate(state, l)
  const typed = state.typed[key]
  const unmet = l.needs.map((n) => (n.includes("/") ? undefined : m.lessons.find((x) => x.id === n))).filter((x): x is Lesson => !!x && !isDone(state, x))
  const chapterDone = !!chapter && chapter.lessons.every((x) => isDone(state, x))
  const earned = lessonEarned(state, l)
  const worth = lessonXp(l)
  return (
    <>
      <nav className="s-lessonbar">
        <button className="s-arrow" onClick={() => prev && onOpen(prev, course?.id)} disabled={!prev} title={prev ? `Back: ${prev.title}` : undefined}>
          ←
        </button>
        <div className="s-dots" aria-label="Lessons in this chapter">
          {chapter?.lessons.map((x) => (
            <button key={x.id} className={`s-dot ${isDone(state, x) ? "done" : ""} ${lessonKey(x) === key ? "cur" : ""} ${x.project ? "project" : ""}`} title={x.title} onClick={() => lessonKey(x) !== key && onOpen(x, course?.id)} />
          ))}
        </div>
        <button className={`s-arrow ${done && onward ? "go" : ""}`} onClick={() => onward && onOpen(onward, after ? course?.id : undefined)} disabled={!onward} title={onward ? `Next: ${onward.title}` : undefined}>
          →
        </button>
      </nav>
      <div className="s-split">
        <article className="s-read">
          <div className="s-kicker">
            {course ? `${course.title} · ` : ""}
            {chapter ? `Chapter ${ci + 1}: ${chapter.title}` : ""}
          </div>
          <h1>{l.title}</h1>
          {l.goal && <p className="s-goal">{l.goal}</p>}
          {unmet.length > 0 && <p className="s-warn">This builds on {unmet.map((x) => x.title).join(", ")}, which you haven't done yet.</p>}
          {l.sources.length > 0 && (
            <p className="s-docs">
              Read with it:{" "}
              {l.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && " · "}
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                </span>
              ))}
            </p>
          )}
          <div className="s-body">
            <Md text={l.body} />
          </div>
          {farm ? <p className="s-fine">You practised this on the farm {farm === 1 ? "once" : `${farm} times`}.</p> : null}
          {typed?.done && !typed.skipped && (
            <p className="s-fine">
              You typed this lesson's docs at {Math.round(wpm(typed.chars, typed.ms))} wpm, {Math.round(accuracy(typed.keys, typed.mistakes))}% right.
            </p>
          )}
        </article>
        <section className={`s-work ${!gate && curStep?.kind === "write" ? "ide" : ""}`}>
          <div className={`s-work-head`}>
            <span className="s-kicker">{l.project ? "Project" : "Assignment"}</span>
            <span className="s-fine">
              {l.steps.length ? `${l.steps.length} step${l.steps.length === 1 ? "" : "s"} · ` : ""}
              {done ? `${earned} XP earned` : `${worth} XP`} · {l.minutes} min
            </span>
            <span className="s-steppips">
              {l.steps.map((_, i) => (
                <button key={i} className={`${passed[i] ? "ok" : ""} ${i === cur ? "cur" : ""}`} disabled={i >= shown} title={`Step ${i + 1}`} onClick={() => setPick(i)} />
              ))}
            </span>
          </div>
          {gate && <TypeThrough lesson={l} saved={typed} onSave={(t) => setState((s) => saveTyped(s, l, t))} />}
          {!gate && curStep && (
            <StepView
              key={cur}
              step={curStep}
              st={state.steps[stepKey(l, cur)]}
              show={l.show}
              onResult={(ok, draft) => (setPick(cur), setState((s) => passStep(s, l, cur, ok, draft)))}
              onShow={() => setState((s) => showAnswer(s, l, cur))}
            />
          )}
          {!gate && curStep && passed[cur] && cur < l.steps.length - 1 && (
            <div className="s-stepnext">
              <button className="s-continue small gold" onClick={() => setPick(cur + 1)}>
                <span className="s-c-label">Next step</span>
                <span className="s-c-meta">
                  {cur + 2} of {l.steps.length}
                </span>
              </button>
            </div>
          )}
          <div className="s-end">
            {!l.steps.length && !done && !gate && (
              <button className="s-continue small" onClick={() => setState((s) => markRead(s, l))}>
                <span className="s-c-label">I've read it</span>
              </button>
            )}
            {done && (
              <>
                <p className="s-done">
                  Lesson done · {earned} XP.{chapterDone ? ` Chapter ${ci + 1} complete.` : ""}
                  {l.steps.some((st) => st.kind === "quiz" || st.kind === "predict" || st.kind === "card") ? " Its questions will come back for review." : ""}
                </p>
                {onward ? (
                  <button className="s-continue small gold" onClick={() => onOpen(onward, after ? course?.id : undefined)}>
                    <span className="s-c-label">Next</span>
                    <span className="s-c-what">{onward.title}</span>
                    <span className="s-c-meta">
                      {onward.minutes} min · {lessonXp(onward)} XP
                    </span>
                  </button>
                ) : (
                  <button className="s-continue small" onClick={onHome}>
                    <span className="s-c-label">Back to your path</span>
                  </button>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

// ---------- review ----------
// A lesson's "### Assignment" section (the whole body when it has none).
const assignmentOf = (body: string) => {
  const i = body.indexOf("### Assignment")
  return i < 0 ? body : body.slice(i + "### Assignment".length).trim()
}

function Review({ state, setState, queue, onDone }: { state: State; setState: (f: (s: State) => State) => void; queue: string[]; onDone: () => void }) {
  const [i, setI] = useState(0)
  const [answered, setAnswered] = useState<boolean | null>(null)
  const [right, setRight] = useState(0)
  const items = useMemo(() => {
    const all = new Map(dueCards(state, Infinity).map((d) => [d.key, d]))
    return queue.map((k) => all.get(k)).filter((d): d is Due => !!d)
  }, [queue])
  const cur = items[i]
  const next = () => {
    setAnswered(null)
    setI((x) => x + 1)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && answered !== null && !(e.target as HTMLElement).closest("textarea")) {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  if (!cur)
    return (
      <div className="s-page s-review">
        <div className="s-kicker">Review</div>
        <h1>Done</h1>
        <p className="s-lead">
          {right} of {items.length} right first time. The ones you missed come back tomorrow; the rest move further out.
        </p>
        <button className="s-continue small" onClick={onDone}>
          <span className="s-c-label">Back to your path</span>
        </button>
      </div>
    )
  return (
    <div className="s-page s-review">
      <div className="s-kicker">
        Review · {i + 1} of {items.length} · {moduleById(cur.lesson.module)?.title} › {cur.lesson.title}
      </div>
      {"blank" in cur ? (
        // Blank-file mode: the assignment, an empty editor, the same hidden tests. Passing counts as
        // remembered; looking at the solution or giving up brings it back sooner.
        <div className="s-rewrite">
          <h2>Write it again from memory</h2>
          <div className="s-body">
            <Md text={assignmentOf(cur.lesson.body)} />
          </div>
          <div className="s-rewrite-ide s-work ide">
            <StepView
              key={cur.key}
              step={{ ...cur.step, starter: blankStarter(cur.step.starter) }}
              st={undefined}
              review
              show={cur.lesson.show}
              onResult={(ok) => {
                if (answered !== null || !ok) return
                setAnswered(true)
                setRight((r) => r + 1)
                setState((s) => review(s, cur.key, true))
              }}
              onShow={() => {
                if (answered !== null) return
                setAnswered(false)
                setState((s) => review(s, cur.key, false))
              }}
            />
          </div>
          {answered === null && (
            <button className="s-link" onClick={() => (setAnswered(false), setState((s) => review(s, cur.key, false)))}>
              I can't remember it: show me later
            </button>
          )}
        </div>
      ) : (
        <StepView
          key={cur.key}
          step={cur.step}
          st={undefined}
          review
          onResult={(ok) => {
            if (answered !== null) return
            setAnswered(ok)
            if (ok) setRight((r) => r + 1)
            setState((s) => review(s, cur.key, ok))
          }}
          onShow={() => {}}
        />
      )}
      {answered !== null && (
        <div className="s-actions">
          <span className={`s-verdict ${answered ? "ok" : "bad"}`}>{answered ? "Right." : "Missed. It comes back tomorrow."}</span>
          <button className="s-btn" onClick={next}>
            Next <kbd>↵</kbd>
          </button>
        </div>
      )}
    </div>
  )
}
