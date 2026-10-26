// Progress and what comes next. The state is plain JSON (saved by the main process); every rule
// about it lives here: when a lesson counts as done, what Continue opens, which cards are due.
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs"
import { careerById, courseLessons, LESSON_BONUS, PROJECT_BONUS, READING_XP, REVIEW_XP, stepXp, TYPED_XP, type Course } from "./course"
import { parseModule } from "./parse"
import { reviewable, type Lesson, type Module, type Step } from "./types"
import { wpm } from "./typing"

// ---------- content ----------
const files = import.meta.glob("./content/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>

// A module that doesn't parse (say, mid-edit) is left out with a console error, instead of
// taking every other module down with it. npm run check:study names the problem.
export const MODULES: Module[] = Object.entries(files).flatMap(([f, src]) => {
  try {
    return [parseModule(src, f.replace(/^.*\//, ""))]
  } catch (e) {
    console.error(`Skipping ${f}: ${(e as Error).message}`)
    return []
  }
})
// The SWE path, in teaching order. wargame, server, and ops stay where they were added.
// Phase B inserts sql after python, web and testing after typescript, cicd after terraform,
// distributed after kubernetes, and system-design plus the optional dsa track after that.
export const SWE_PATH = ["linux", "git", "wargame", "server", "ops", "quest", "workshop", "python", "sql", "tsquest", "typescript", "web", "testing", "containers", "cloud", "terraform", "cicd", "kubernetes", "distributed", "system-design", "dsa"]

export const moduleById = (id: string) => MODULES.find((m) => m.id === id)
export const lessonKey = (l: Lesson) => `${l.module}/${l.id}`
export const stepKey = (l: Lesson, i: number) => `${lessonKey(l)}#${i}`

export function findLesson(key: string): Lesson | undefined {
  const [m, id] = key.split("/")
  return moduleById(m)?.lessons.find((l) => l.id === id)
}

// ---------- state ----------
export type StepState = { ok: boolean; tries: number; shown?: boolean; draft?: string; at?: number } // at: when it first passed
export type CardState = { card: Card; log: { at: number; ok: boolean }[] }
// Typing a lesson's docs page: how far you got (in blocks) and how it went.
export type Typed = { block: number; done: boolean; skipped?: boolean; chars: number; keys: number; mistakes: number; ms: number }
export type State = {
  v: 1
  path: string[]
  done: Record<string, { at: number; assisted: boolean }>
  steps: Record<string, StepState>
  cards: Record<string, CardState>
  days: string[]
  farm: Record<string, number>
  removed: string[] // SWE path modules you took off; they don't come back by themselves
  typeDocs: boolean // type the docs page a lesson cites before its tasks open
  typed: Record<string, Typed> // by lesson key
  career: string // "swe" (your own module list) or a career path from course.ts
}

export function fresh(): State {
  return { v: 1, path: SWE_PATH.filter((id) => moduleById(id)), done: {}, steps: {}, cards: {}, days: [], farm: {}, removed: [], typeDocs: false, typed: {}, career: "swe" }
}

export function revive(raw: unknown): State {
  const s = { ...fresh(), ...(raw && typeof raw === "object" ? (raw as Partial<State>) : {}) }
  s.path = (Array.isArray(s.path) ? s.path : []).filter((id) => typeof id === "string" && moduleById(id))
  s.removed = Array.isArray(s.removed) ? s.removed : []
  s.typed = s.typed && typeof s.typed === "object" ? s.typed : {}
  if (s.career !== "swe" && !careerById(s.career)) s.career = "swe"
  // A module added to the SWE path after this progress was saved joins the path where it
  // belongs (after the module before it), unless you took it off on purpose.
  SWE_PATH.forEach((id, i) => {
    if (!moduleById(id) || s.path.includes(id) || s.removed.includes(id)) return
    const before = SWE_PATH.slice(0, i).reverse().find((x) => s.path.includes(x))
    s.path.splice(before ? s.path.indexOf(before) + 1 : 0, 0, id)
  })
  for (const c of Object.values(s.cards ?? {})) {
    c.card.due = new Date(c.card.due)
    if (c.card.last_review) c.card.last_review = new Date(c.card.last_review)
  }
  // Lessons finished before blank-file mode existed get their rewrites too.
  s.cards = { ...s.cards }
  for (const [key, d] of Object.entries(s.done)) {
    const l = findLesson(key)
    if (l) addRewrites(s.cards, l, new Date(d.at))
  }
  return s
}

const today = () => new Date().toLocaleDateString("sv-SE")
const touch = (s: State): State => (s.days.includes(today()) ? s : { ...s, days: [...s.days, today()].slice(-400) })

// ---------- lessons ----------
export const isDone = (s: State, l: Lesson) => !!s.done[lessonKey(l)]

// ---------- paths ----------
// On the SWE path you study whole modules in the order you set. On a career path you study its
// courses in order, and a course may be only some chapters of a module.
export const career = (s: State) => (s.career === "swe" ? undefined : careerById(s.career))
export const courseLessonsOf = (c: Course) => courseLessons(c, moduleById)
// Every lesson on the current path, in teaching order.
export function pathLessons(s: State): Lesson[] {
  const c = career(s)
  const all = c ? c.courses.flatMap(courseLessonsOf) : s.path.flatMap((id) => moduleById(id)?.lessons ?? [])
  const seen = new Set<string>()
  return all.filter((l) => !seen.has(lessonKey(l)) && !!seen.add(lessonKey(l)))
}
// The modules your path touches: reviews and "needs" count only these.
export const pathModules = (s: State): string[] => {
  const c = career(s)
  return c ? [...new Set(c.courses.flatMap((x) => x.parts.map((p) => p.module)))].filter((id) => moduleById(id)) : s.path
}

// A need may name a lesson in another module ("python/functions"); it counts only if that module is
// on your path, and, on a career path, only if the path teaches it before this lesson.
function need(l: Lesson, n: string): Lesson | undefined {
  return n.includes("/") ? findLesson(n) : moduleById(l.module)?.lessons.find((x) => x.id === n)
}
export function isReady(s: State, l: Lesson): boolean {
  const order = career(s) ? new Map(pathLessons(s).map((x, i) => [lessonKey(x), i])) : null
  return l.needs.every((n) => {
    const x = need(l, n)
    if (!x || !pathModules(s).includes(x.module) || isDone(s, x)) return true
    if (!order) return false
    const before = order.get(lessonKey(x))
    return before === undefined || before > (order.get(lessonKey(l)) ?? Infinity)
  })
}

// Next lesson: the first not-done, ready lesson along the path.
export function nextLesson(s: State): Lesson | null {
  if (career(s)) {
    const left = pathLessons(s).filter((l) => !isDone(s, l))
    return left.find((l) => isReady(s, l)) ?? left[0] ?? null
  }
  for (const id of s.path) {
    const m = moduleById(id)
    if (!m) continue
    const l = m.lessons.find((x) => !isDone(s, x) && isReady(s, x))
    if (l) return l
    if (m.lessons.some((x) => !isDone(s, x))) return m.lessons.find((x) => !isDone(s, x)) ?? null
  }
  return null
}

export function progress(s: State, m: Module): { done: number; total: number } {
  return { done: m.lessons.filter((l) => isDone(s, l)).length, total: m.lessons.length }
}

// A step passed (or answered); when every step of the lesson has passed, the lesson is done and its
// recall steps become review cards. A step you needed the answer for brings its card back sooner.
export function passStep(s: State, l: Lesson, i: number, ok: boolean, draft?: string): State {
  const k = stepKey(l, i)
  const prev = s.steps[k] ?? { ok: false, tries: 0 }
  const at = prev.at ?? (ok ? Date.now() : undefined)
  let next: State = { ...s, steps: { ...s.steps, [k]: { ...prev, ok: prev.ok || ok, tries: prev.tries + 1, draft: draft ?? prev.draft, at } } }
  next = touch(next)
  return finishIfDone(next, l)
}

export function showAnswer(s: State, l: Lesson, i: number): State {
  const k = stepKey(l, i)
  return { ...s, steps: { ...s.steps, [k]: { ...(s.steps[k] ?? { ok: false, tries: 0 }), shown: true } } }
}

// Blank-file mode: in a "rewrite" module, every write step of a finished lesson comes back as a
// review to write again from nothing (its key is the step's key plus "~blank"), first a few days on.
export const BLANK = "~blank"
export const isBlank = (key: string) => key.endsWith(BLANK)
function addRewrites(cards: State["cards"], l: Lesson, at: Date) {
  if (!moduleById(l.module)?.rewrite) return
  l.steps.forEach((st, i) => {
    const k = stepKey(l, i) + BLANK
    if (st.kind !== "write" || cards[k]) return
    cards[k] = { card: scheduler.next(createEmptyCard(at), at, Rating.Good).card, log: [] }
  })
}
// What the blank editor starts with: nothing, or only the protected lines an output task prints with.
export function blankStarter(starter: string): string {
  const mark = "# Don't touch below this line"
  const i = starter.indexOf(mark)
  return i < 0 ? "" : starter.slice(i)
}

function finishIfDone(s: State, l: Lesson): State {
  const key = lessonKey(l)
  if (s.done[key] || !l.steps.every((_, i) => s.steps[stepKey(l, i)]?.ok)) return s
  const assisted = l.steps.some((_, i) => s.steps[stepKey(l, i)]?.shown)
  const cards = { ...s.cards }
  const now = new Date()
  l.steps.forEach((st, i) => {
    if (!reviewable(st)) return
    const k = stepKey(l, i)
    if (cards[k]) return
    const firstTry = (s.steps[k]?.tries ?? 1) <= 1 && !s.steps[k]?.shown
    // First review: right first time → a few days out; otherwise tomorrow.
    const card = scheduler.next(createEmptyCard(now), now, firstTry ? Rating.Good : Rating.Again).card
    cards[k] = { card, log: [] }
  })
  addRewrites(cards, l, now)
  return { ...s, cards, done: { ...s.done, [key]: { at: Date.now(), assisted } } }
}

// A lesson with no steps (reading only) is done when you say so.
export function markRead(s: State, l: Lesson): State {
  return touch({ ...s, done: { ...s.done, [lessonKey(l)]: { at: Date.now(), assisted: false } } })
}

// ---------- typing the docs ----------
// With typeDocs on, a lesson's tasks open only after you've typed the human-written page it cites
// (its first source that is a docs page). A lesson with tasks asks for the cited section, up to
// GATE_WORDS, so the tasks stay in reach; a reading-only lesson asks for the whole page.
export const GATE_WORDS = 1200
const NOT_DOCS = new Set(["github.com", "youtube.com", "www.youtube.com", "youtu.be"])

export function docSource(l: Lesson): { title: string; url: string } | undefined {
  return l.sources.find((s) => {
    try {
      return !NOT_DOCS.has(new URL(s.url).hostname)
    } catch {
      return false
    }
  })
}

export const typingGate = (s: State, l: Lesson) => s.typeDocs && !isDone(s, l) && !!docSource(l) && !s.typed[lessonKey(l)]?.done

export function saveTyped(s: State, l: Lesson, t: Typed): State {
  const next = touch({ ...s, typed: { ...s.typed, [lessonKey(l)]: t } })
  // A reading-only lesson is done once its page is typed.
  return t.done && !l.steps.length && !t.skipped ? markRead(next, l) : next
}

export function typingTotals(s: State): { pages: number; wpm: number } {
  const done = Object.values(s.typed).filter((t) => t.done && !t.skipped && t.ms > 0)
  const chars = done.reduce((a, t) => a + t.chars, 0)
  const ms = done.reduce((a, t) => a + t.ms, 0)
  return { pages: done.length, wpm: wpm(chars, ms) }
}

// ---------- reviews ----------
const scheduler = fsrs(generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9, maximum_interval: 365 }))

export type Due = { key: string; lesson: Lesson; step: Extract<Step, { kind: "quiz" | "predict" | "card" }> } | { key: string; lesson: Lesson; step: Extract<Step, { kind: "write" }>; blank: true }

export function dueCards(s: State, now = Date.now()): Due[] {
  const out: Due[] = []
  for (const [k, c] of Object.entries(s.cards)) {
    if (c.card.due.getTime() > now) continue
    const [lk, idx] = k.split("#")
    const l = findLesson(lk)
    const st = l?.steps[Number(idx.replace(BLANK, ""))]
    if (!l || !st || !pathModules(s).includes(l.module)) continue
    if (isBlank(k)) {
      if (st.kind === "write") out.push({ key: k, lesson: l, step: st, blank: true })
    } else if (reviewable(st)) out.push({ key: k, lesson: l, step: st })
  }
  return out.sort((a, b) => s.cards[a.key].card.due.getTime() - s.cards[b.key].card.due.getTime())
}

export function review(s: State, key: string, ok: boolean): State {
  const c = s.cards[key]
  if (!c) return s
  const now = new Date()
  const card = scheduler.next(c.card, now, ok ? Rating.Good : Rating.Again).card
  return touch({ ...s, cards: { ...s.cards, [key]: { card, log: [...c.log, { at: now.getTime(), ok }].slice(-30) } } })
}

export function streak(s: State): number {
  const set = new Set(s.days)
  let n = 0
  const d = new Date()
  if (!set.has(d.toLocaleDateString("sv-SE"))) d.setDate(d.getDate() - 1)
  while (set.has(d.toLocaleDateString("sv-SE"))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

// ---------- XP ----------
// Worked out from saved progress: passed steps (half for a step whose answer you looked at), a
// bonus per finished lesson, reviews, and typed docs pages. "on" limits it to one day (YYYY-MM-DD).
const dayOf = (t: number) => new Date(t).toLocaleDateString("sv-SE")

export function lessonEarned(s: State, l: Lesson, on?: string): number {
  const key = lessonKey(l)
  const done = s.done[key]
  let xp = 0
  l.steps.forEach((st, i) => {
    const x = s.steps[stepKey(l, i)]
    // A step passed before steps had a time counts on the day its lesson was finished.
    if (x?.ok && (!on || dayOf(x.at ?? done?.at ?? 0) === on)) xp += stepXp(st, x.shown)
  })
  if (done && (!on || dayOf(done.at) === on)) xp += (l.steps.length ? LESSON_BONUS : READING_XP) + (l.project ? PROJECT_BONUS : 0)
  return xp
}

export function xpTotal(s: State, on?: string): number {
  let xp = 0
  for (const m of MODULES) for (const l of m.lessons) xp += lessonEarned(s, l, on)
  for (const c of Object.values(s.cards)) for (const r of c.log) if (!on || dayOf(r.at) === on) xp += r.ok ? REVIEW_XP.right : REVIEW_XP.wrong
  if (!on) xp += Object.values(s.typed).filter((t) => t.done && !t.skipped).length * TYPED_XP
  return xp
}
export const xpToday = (s: State) => xpTotal(s, today())

// ---------- answers ----------
// Output comparison for predict and shell steps: the same lines, ignoring spacing differences.
export const normOut = (t: string) =>
  t
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .join("\n")
    .trim()
