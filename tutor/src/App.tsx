// Tutor's window. Wide (≥ 860px) it's laid out like Claude Code: chats and goals on the left,
// the transcript in the middle, Changes on the right. A goal swaps the middle for its strategy
// map and moves the conversation (planning, or a lesson on one node) to the right.
// Narrow, it's one column and the sidebar and Changes open as panels.
import { useEffect, useMemo, useRef, useState } from "react"
import { api, type Ask, type AskAnswer, type ChangeView, type ChatEvent, type ConvLink, type CourseInfo, type Goal, type GoalSummary, type IdeContext, type IdeStatus, type KeyName, type Lens, type ModelOption, type Mode, type Msg, type NodeStatus, type Settings, type Shot, type StrategyNode } from "./api"
import * as I from "./icons"
import { Message, TurnCtx } from "./ui/Message"
import { ChangesDock, ChangesSide, firstChangedLine } from "./ui/Changes"
import { IdePicker, ModelPicker, PROVIDER_NAME } from "./ui/Pickers"
import { Empty, HistoryList, SettingsPanel } from "./ui/Panels"
import { COMMANDS, matchCommands, SlashMenu, type SlashCommand } from "./ui/Slash"
import { GoalChatEmpty, GoalList, GoalView, NewGoal } from "./ui/Goal"
import { LessonView, PathHome, platformModules, sliceGoal, type ModulePick } from "./ui/Path"
import { isDone, nextNode } from "./goalLayout"
import { Today, type ReviewInfo } from "./ui/Today"

type ConvView = { msgs: Msg[]; busy: boolean; link: ConvLink }

// A short name for a conversation (for "a question is waiting in …").
function describeConv(c?: ConvView): string {
  if (!c) return "a conversation"
  if (c.link.review) return "your review"
  const first = c.msgs.find((m) => m.role === "user")?.text.split("\n").pop()?.slice(0, 50)
  return first ? `"${first}"` : "a conversation"
}
const EMPTY_CONV: ConvView = { msgs: [], busy: false, link: {} }

const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
const newId = (): string => crypto.randomUUID()
const WIDE_AT = 860

const STARTERS: Record<Mode | "learn", { icon: () => React.ReactNode; title: string; sub: string; prompt: string }[]> = {
  tutor: [
    { icon: () => <I.Layers />, title: "Structure", sub: "The pieces and what depends on what", prompt: "Explain the structure: what the pieces are and how they depend on each other." },
    { icon: () => <I.Flow />, title: "Data flow", sub: "Follow a value from input to output", prompt: "Trace the data flow: where the values come from, where they go, and what runs when." },
    { icon: () => <I.Lightbulb />, title: "Why this way", sub: "The design decision and its trade-off", prompt: "Why is it built this way? Name the design decision, the trade-off, and the alternative that was rejected." },
    { icon: () => <I.Zap />, title: "Blast radius", sub: "What breaks if this changes", prompt: "What would break if I changed this, and how would I verify it?" }
  ],
  learn: [
    { icon: () => <I.Scan />, title: "Teach me this", sub: "What's on screen, from what you already know", prompt: "Teach me what's on my screen properly. Find out what I already know first." },
    { icon: () => <I.Lightbulb />, title: "A new topic", sub: "Say what you want to understand", prompt: "I want to understand something new. Ask me what it is and what I want out of it, then start." },
    { icon: () => <I.Layers />, title: "Close a gap", sub: "The most useful one in your profile", prompt: "Look at what you know about me and pick the gap that's most worth closing now. Teach it." },
    { icon: () => <I.Beaker />, title: "Quiz me", sub: "What stuck from last time", prompt: "Quiz me on what we covered recently and see what actually stuck. Reteach anything that didn't." }
  ],
  writer: [
    { icon: () => <I.Code />, title: "Build it", sub: "Complete, runnable code from a description", prompt: "Write it. Complete code, all imports, ready to run." },
    { icon: () => <I.Wrench />, title: "Fix the error", sub: "Read what's on screen, patch the files", prompt: "Fix the error on my screen. Find the cause, then write the fix." },
    { icon: () => <I.Sparkle />, title: "Refactor", sub: "Cleaner, same behaviour", prompt: "Refactor this properly without changing behaviour, then explain the new structure." },
    { icon: () => <I.Beaker />, title: "Tests", sub: "Pin down current behaviour", prompt: "Write tests that pin down the current behaviour, including edge cases." }
  ]
}

const LENSES: { id: Lens; label: string; hint: string }[] = [
  { id: "learn", label: "Learn", hint: "Your teaching method: probe what you know, plan a map, teach it node by node with quizzes" },
  { id: "explain", label: "Explain", hint: "Structure, flow, trade-offs" },
  { id: "paper", label: "Paper", hint: "Read a research paper together" },
  { id: "infra", label: "Infra", hint: "Docker, CI, cloud, networking as a picture" },
  { id: "socratic", label: "Socratic", hint: "It asks, you reason it out" },
  { id: "review", label: "Review", hint: "Senior code review of what's on screen" }
]

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [keys, setKeys] = useState<Record<KeyName, boolean>>({ anthropic: false, xai: false, openai: false, brave: false })
  const [models, setModels] = useState<ModelOption[]>([])
  const [ide, setIde] = useState<IdeStatus | null>(null)
  // Every conversation opened this session stays live here: turns keep running in the background
  // (a quiz left open in a lesson waits for you), and their events land in the right place.
  const [store, setStore] = useState<Record<string, ConvView>>({})
  const [convId, setConvId] = useState(newId)
  const convRef = useRef(convId)
  convRef.current = convId
  const storeRef = useRef(store)
  storeRef.current = store
  const cur = store[convId] ?? EMPTY_CONV
  const msgs = cur.msgs
  const busy = cur.busy
  const link = cur.link
  const patchConv = (id: string, fn: (c: ConvView) => ConvView) => setStore((s) => ({ ...s, [id]: fn(s[id] ?? EMPTY_CONV) }))
  const setMsgsFor = (id: string, fn: (m: Msg[]) => Msg[]) => patchConv(id, (c) => ({ ...c, msgs: fn(c.msgs) }))
  // Conversations to write to disk once the store has their latest state (a turn ended, a card appeared).
  const dirty = useRef(new Set<string>())
  const [toast, setToast] = useState<{ conv: string; text: string } | null>(null)
  const [draft, setDraft] = useState("")
  const [shots, setShots] = useState<Shot[]>([])
  const [panel, setPanel] = useState<null | "settings" | "history">(null)
  const [dockOpen, setDockOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [farmNote, setFarmNote] = useState<string | null>(null)
  const [changes, setChanges] = useState<ChangeView[]>([])
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_AT)
  // The Changes pane opens when something changes (or on ⌘⇧D); an empty one would just take room.
  const [showChanges, setShowChanges] = useState(false)
  // The sidebar folds away too; remembered per machine.
  const [sideOpen, setSideOpenState] = useState(() => {
    try {
      return localStorage.getItem("tutor.sideOpen") !== "0"
    } catch {
      return true
    }
  })
  const setSideOpen = (v: boolean) => {
    setSideOpenState(v)
    try {
      localStorage.setItem("tutor.sideOpen", v ? "1" : "0")
    } catch {}
  }
  const [histTick, setHistTick] = useState(0)
  // Goals: which one is open, and what the conversation on screen belongs to.
  // Wide, Tutor opens on Today: what's due, where each goal picks up.
  const [view, setView] = useState<"chat" | "goal" | "today" | "home" | "lesson" | "map">("home")
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
  const [modules, setModules] = useState<ModulePick[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("tutor.modules") || "[]")
      if (!Array.isArray(raw)) return []
      return raw.flatMap((m): ModulePick[] => {
        if (!m || typeof m.key !== "string" || typeof m.courseId !== "string" || typeof m.title !== "string" || !Array.isArray(m.stages)) return []
        const stages = m.stages.filter((x: unknown): x is string => typeof x === "string")
        if (!stages.length) return []
        return [{ key: m.key, courseId: m.courseId, title: m.title, detail: typeof m.detail === "string" ? m.detail : "", stages }]
      })
    } catch {
      return []
    }
  })
  const [openMod, setOpenMod] = useState<ModulePick | null>(null)
  const openSeq = useRef(0)
  const [reviews, setReviews] = useState<ReviewInfo | null>(null)
  const [goal, setGoal] = useState<Goal | null>(null)
  const [goals, setGoals] = useState<GoalSummary[]>([])
  const [sideTab, setSideTab] = useState<"chats" | "goals">("chats")
  const [newGoalOpen, setNewGoalOpen] = useState(false)
  const [ideCtx, setIdeCtx] = useState<IdeContext | null>(null)
  const goalRef = useRef<Goal | null>(null)
  goalRef.current = goal
  const [modelSignal, setModelSignal] = useState(0)
  const [slashAt, setSlashAt] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const changesRef = useRef<ChangeView[]>([])
  changesRef.current = changes
  const scroller = useRef<HTMLDivElement>(null)

  const refreshModels = () => api.listModels().then(setModels)
  const refreshIde = (fresh = false) => api.ideStatus(fresh).then(setIde).catch(() => {})

  useEffect(() => {
    api.getSettings().then(({ settings, keys }) => {
      setSettings(settings)
      setKeys(keys)
    })
    refreshModels()
    refreshIde(true)
    api.listChanges().then(setChanges)
    // Pick up where you left off (the last plain chat; goals open from the sidebar).
    api.listConversations().then(async (list) => {
      const last = list.find((c) => !c.goalId)
      if (!last) return
      const c = await api.openConversation(last.id)
      if (c) {
        patchConv(c.id, () => ({ msgs: c.messages, busy: false, link: {} }))
        setConvId(c.id)
      }
    })
    api.listGoals().then(setGoals)
    api.getReviews().then(setReviews)
    const offReviews = api.onReviews(() => api.getReviews().then(setReviews))
    const offConvs = api.onConversationsChanged(() => setHistTick((t) => t + 1))
    const offShot = api.onScreenshot((s) => {
      setShots((prev) => [...prev, s].slice(-3))
      setPanel(null)
      input.current?.focus()
    })
    const offEvent = api.onEvent((e) => applyEvent(e))
    const offPinned = api.onPinned((on) => setSettings((s) => (s ? { ...s, pinned: on } : s)))
    const offChanges = api.onChanges((list) => {
      setChanges(list)
      if (list.length) setShowChanges(true)
    })
    const offGoal = api.onGoal((g) => {
      if (goalRef.current?.id === g.id) setGoal(g)
      api.listGoals().then(setGoals)
    })
    // "Ask Tutor" in the IDE: the code lands in the composer.
    const offIde = api.onIdeContext((c) => {
      setIdeCtx(c)
      setPanel(null)
      requestAnimationFrame(() => input.current?.focus())
    })
    const onFocus = () => refreshIde()
    const onResize = () => setWide(window.innerWidth >= WIDE_AT)
    window.addEventListener("focus", onFocus)
    window.addEventListener("resize", onResize)
    return () => {
      offShot()
      offEvent()
      offPinned()
      offChanges()
      offGoal()
      offIde()
      offReviews()
      offConvs()
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("resize", onResize)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem("tutor.modules", JSON.stringify(modules))
    } catch {}
  }, [modules])

  // In the wide layout the sidebar is always there, so the History panel closes.
  useEffect(() => {
    if (wide && panel === "history") setPanel(null)
  }, [wide])

  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight
  }, [msgs])

  // Save conversations whose turn just ended or that just put up a card (so an open question
  // survives even quitting the app).
  useEffect(() => {
    if (!dirty.current.size) return
    for (const id of dirty.current) {
      const c = store[id]
      if (c?.msgs.length) api.saveConversation(id, c.msgs, c.link).then(() => setHistTick((t) => t + 1)).catch(() => {})
    }
    dirty.current.clear()
  }, [store])

  // Grow the textarea with its content, up to a limit.
  useEffect(() => {
    const ta = input.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px"
  }, [draft])

  function applyEvent(ev: ChatEvent & { conv?: string }) {
    const id = ev.conv ?? convRef.current
    const e = ev as ChatEvent
    if (e.type === "done") {
      dirty.current.add(id)
      return patchConv(id, (c) => ({ ...c, busy: false }))
    }
    if (e.type === "ask") {
      dirty.current.add(id)
      // A question in a conversation you're not looking at: say so, with a way back.
      if (id !== convRef.current) setToast({ conv: id, text: e.ask.kind === "quiz" ? "Tutor quizzed you in another conversation" : "Tutor asked you something in another conversation" })
    }
    setMsgsFor(id, (prev) => {
      const out = prev.slice()
      let last = out[out.length - 1]
      if (!last || last.role !== "assistant") {
        last = { role: "assistant", text: "", tools: [], notices: [], flow: [] }
        out.push(last)
      } else out[out.length - 1] = last = { ...last, tools: last.tools.slice(), notices: last.notices.slice(), flow: last.flow?.slice(), asks: last.asks?.slice() }
      const flow = last.flow
      if (e.type === "text") {
        last.text += e.delta
        const tail = flow?.[flow.length - 1]
        if (flow && tail?.t === "text") flow[flow.length - 1] = { t: "text", text: tail.text + e.delta }
        else flow?.push({ t: "text", text: e.delta })
      } else if (e.type === "tool") {
        last.tools.push({ id: e.id, name: e.name, detail: e.detail, input: e.input })
        flow?.push({ t: "tool", i: last.tools.length - 1 })
      } else if (e.type === "ask") {
        last.asks = [...(last.asks ?? []), e.ask]
        flow?.push({ t: "ask", id: e.ask.id })
      } else if (e.type === "ask-done") {
        last.asks = (last.asks ?? []).map((a) => (a.id === e.id ? { ...a, answer: e.answer ?? a.answer, grade: e.grade, cancelled: e.cancelled, run: e.run ?? a.run, match: e.match ?? a.match } : a))
      } else if (e.type === "trace") {
        last.traces = [...(last.traces ?? []), e.trace]
        flow?.push({ t: "trace", id: e.trace.id })
      } else if (e.type === "project") {
        // The same project can come back on later checks: update its card everywhere, and show
        // the latest state at the bottom too.
        for (let j = 0; j < out.length - 1; j++)
          if (out[j].projects?.some((x) => x.id === e.project.id)) out[j] = { ...out[j], projects: out[j].projects!.map((x) => (x.id === e.project.id ? e.project : x)) }
        if (last.projects?.some((x) => x.id === e.project.id)) last.projects = last.projects.map((x) => (x.id === e.project.id ? e.project : x))
        else {
          last.projects = [...(last.projects ?? []), e.project]
          flow?.push({ t: "project", id: e.project.id })
        }
      } else if (e.type === "tool-done") {
        const i = e.id ? last.tools.findIndex((t) => t.id === e.id) : last.tools.findIndex((t) => t.ok === undefined && (!e.name || t.name === e.name))
        if (i >= 0) last.tools[i] = { ...last.tools[i], ok: e.ok, result: e.detail, change: e.change }
      } else if (e.type === "plan") last.plan = e.items
      else if (e.type === "usage") last.usage = { input: e.input, output: e.output }
      else if (e.type === "notice") last.notices.push(e.text)
      else if (e.type === "learned") last.learned = [...(last.learned ?? []), ...e.notes]
      else if (e.type === "note") last.note = e.note.added && last.note ? { ...last.note, added: true } : e.note
      else if (e.type === "error") last.error = e.text
      return out
    })
  }

  const current = models.find((m) => m.id === settings?.modelId)
  const lastUsage = [...msgs].reverse().find((m) => m.usage)?.usage

  // shown: what appears in your bubble; text: what the model receives.
  // link/conv: send into a conversation that was only just switched to (state isn't updated yet).
  async function send(textArg?: string, opts: { apply?: boolean; shown?: string; link?: ConvLink; conv?: string } = {}) {
    let text = (textArg ?? draft).trim()
    const code = textArg === undefined ? ideCtx : null
    if (!text && !shots.length && !code) return
    let shown = opts.shown ?? text
    if (code) {
      const where = `${code.rel}:${code.start}${code.end > code.start ? `–${code.end}` : ""}`
      text = `${code.selected ? "About this code" : "About the code around line " + code.start} in ${code.file} (lines ${code.start}–${code.end}):\n\n\`\`\`${code.lang}\n${code.code}\n\`\`\`\n\n${text || "Explain this: what it does, how it fits the structure around it, and why it's written this way."}`
      shown = `${where}\n${shown || "Explain this."}`
      setIdeCtx(null)
    }
    const target = opts.conv ?? convId
    const l = opts.link ?? storeRef.current[target]?.link ?? {}
    if (storeRef.current[target]?.busy) return
    const lensLabel = l.nodeId ? "lesson" : l.goalId ? "strategy" : opts.apply ? "applying" : settings?.mode === "tutor" ? settings.lens : "writer"
    const by = `${current?.label.split(" · ")[0] ?? "model"} · ${lensLabel}`
    const user: Msg = { role: "user", text: shown, previews: shots.map((s) => s.preview), tools: [], notices: [] }
    patchConv(target, (c) => ({ msgs: [...c.msgs, user, { role: "assistant", text: "", tools: [], notices: [], by, flow: [] }], busy: true, link: l }))
    if (textArg === undefined) setDraft("")
    const images = shots.map((s) => s.jpeg)
    setShots([])
    setPanel(null)
    await api.send({ text, images, apply: opts.apply, conversationId: target, goalId: l.goalId, nodeId: l.nodeId, review: l.review })
  }

  async function snap() {
    try {
      const s = await api.capture()
      setShots((prev) => [...prev, s].slice(-3))
      input.current?.focus()
    } catch (err) {
      applyEvent({ type: "error", text: clean((err as Error).message) })
    }
  }

  async function update(patch: Partial<Settings>) {
    try {
      setSettings(await api.saveSettings(patch))
      return true
    } catch (err) {
      setFlash(clean((err as Error).message))
      return false
    }
  }

  // Nothing is stopped by moving around: a running turn carries on in its own conversation.
  function newChat() {
    const id = newId()
    patchConv(id, () => ({ ...EMPTY_CONV }))
    setShots([])
    setPanel(null)
    setConvId(id)
    setView("chat")
    setSideTab("chats")
    input.current?.focus()
  }

  async function openConversation(id: string) {
    setShots([])
    setPanel(null)
    // Live in this window already (maybe mid-turn): just show it.
    if (storeRef.current[id]) return setConvId(id)
    const c = await api.openConversation(id)
    if (!c) return
    patchConv(id, () => ({ msgs: c.messages, busy: false, link: { goalId: c.goalId, nodeId: c.nodeId } }))
    setConvId(id)
  }

  // ---------- goals ----------

  // A fresh conversation that belongs to a goal (its planning chat, or a lesson on one node).
  function freshConversation(id: string, l: ConvLink) {
    patchConv(id, () => ({ msgs: [], busy: false, link: l }))
    setShots([])
    setConvId(id)
  }

  async function openGoal(id: string) {
    const g = await api.getGoal(id)
    if (!g) return
    setGoal(g)
    setView("goal")
    setSideTab("goals")
    setPanel(null)
    if (!wide) api.setWide(true, true)
    // Its planning conversation, unless a lesson of this goal is already open.
    if (link.goalId !== g.id) await planChat(g)
  }

  async function planChat(g: Goal) {
    if (storeRef.current[g.conversationId]) return setConvId(g.conversationId)
    const c = await api.openConversation(g.conversationId)
    if (!c) return freshConversation(g.conversationId, { goalId: g.id })
    patchConv(c.id, () => ({ msgs: c.messages, busy: false, link: { goalId: g.id } }))
    setConvId(c.id)
    setShots([])
  }

  // Goals want the wide layout (the map); the sheet opens once the window has grown.
  function startNewGoal() {
    setPanel(null)
    if (!wide) api.setWide(true, true)
    setSideOpen(true)
    setSideTab("goals")
    setNewGoalOpen(true)
  }

  async function createGoal(ask: string, sources: string) {
    setNewGoalOpen(false)
    const g = await api.createGoal(ask)
    setGoal(g)
    setGoals(await api.listGoals())
    setView("goal")
    setSideTab("goals")
    setPanel(null)
    api.setWide(true, true)
    await freshConversation(g.conversationId, { goalId: g.id })
    const text = sources ? `${ask}\n\nBuild it from these too (read each one):\n${sources}` : ask
    send(text, { link: { goalId: g.id }, conv: g.conversationId })
  }

  // A ready-made course: its map is there at once; the first turn probes where you are and marks what you know.
  async function startCourse(c: CourseInfo) {
    setNewGoalOpen(false)
    const g = await api.goalFromCourse(c.id)
    setGoal(g)
    setGoals(await api.listGoals())
    setView("goal")
    setSideTab("goals")
    setPanel(null)
    api.setWide(true, true)
    freshConversation(g.conversationId, { goalId: g.id })
    send(
      `I'm starting this course.${c.after.length ? ` In my path it comes after ${c.after.map((a) => a.title).join(" and ")}, so probe those foundations briefly too.` : ""} Before I begin: probe where I am across its stages with a few quiz cards (a handful, spread over the strands the map rests on), mark every node I clearly already have as known, then tell me in a few sentences where I start and why.`,
      { link: { goalId: g.id }, conv: g.conversationId, shown: `Start the course: ${g.title}` }
    )
  }

  // A review session over everything due, in the chat column next to Today.
  function startReview() {
    const id = newId()
    const l = { review: true }
    freshConversation(id, l)
    setView("today")
    send("Start my review.", { link: l, conv: id, shown: `Review · ${reviews?.stats.due ?? 0} due` })
  }

  // "Next: X" on Today: open the goal's map and start the lesson on that node.
  async function teachFrom(goalId: string, nodeId: string) {
    const g = await api.getGoal(goalId)
    const n = g?.strategy?.nodes.find((x) => x.id === nodeId)
    if (!g || !n) return
    setGoal(g)
    setSideTab("goals")
    await openLesson(n, g)
  }

  async function lesson(n: StrategyNode, text: string, shown: string, forGoal?: Goal) {
    const target = forGoal ?? goal
    if (!target) return
    const id = newId()
    const l = { goalId: target.id, nodeId: n.id }
    await freshConversation(id, l)
    send(text, { link: l, conv: id, shown })
  }
  async function openLesson(n: StrategyNode, forGoal?: Goal) {
    const target = forGoal ?? goal
    if (!target) return
    setMenuOpen(false)
    setPanel(null)
    if (n.status === "todo") {
      const g = await api.setNodeStatus(target.id, n.id, "learning")
      if (g) setGoal(g)
    }
    setLessonId(n.id)
    setView("lesson")
  }
  async function finishLesson(n: StrategyNode) {
    if (!goal) return
    const g = await api.setNodeStatus(goal.id, n.id, "solid")
    if (g) setGoal(g)
    setLessonId(null)
    setView(openMod ? "map" : "home")
  }
  function addModule(m: ModulePick) {
    setModules((prev) => (prev.some((x) => x.key === m.key) ? prev : [...prev, m]))
  }
  function addPlatform() {
    setModules((prev) => {
      const have = new Set(prev.map((x) => x.key))
      return [...prev, ...platformModules().filter((m) => !have.has(m.key))]
    })
  }
  async function openModule(m: ModulePick) {
    const seq = ++openSeq.current
    setMenuOpen(false)
    setPanel(null)
    setLessonId(null)
    setOpenMod(m)
    setView("map")
    setPathError(null)
    try {
      const list = await api.listGoals()
      const hit = list.find((g) => g.courseId === m.courseId)
      let g = hit ? await api.getGoal(hit.id) : await api.goalFromCourse(m.courseId)
      if (!g) throw new Error("Could not open that module.")
      const news = await api.courseNews(g.id)
      if (news?.count) g = await api.takeCourseUpdate(g.id)
      if (seq !== openSeq.current) return
      setGoal(g)
      setGoals(await api.listGoals())
    } catch (err) {
      if (seq === openSeq.current) setPathError((err as Error).message)
    }
  }
  const teachNode = (n: StrategyNode) => void openLesson(n)
  // A project is checked in the lesson where it was set up (Tutor has the context there).
  const checkProjectNode = async (n: StrategyNode) => {
    if (!goal) return
    const last = goal.lessons.filter((l) => l.nodeId === n.id).sort((a, b) => b.at - a.at)[0]
    if (!last) return lesson(n, `Check my project for "${n.title}".`, `Check my project: ${n.title}`)
    await openConversation(last.conversationId)
    setView("chat")
    send(`Check my project for "${n.title}".`, { link: { goalId: goal.id, nodeId: n.id }, conv: last.conversationId, shown: "Check my project" })
  }
  // They studied the node's sources on their own first: a thorough recap of them, then the quiz.
  const recapNode = (n: StrategyNode) => lesson(n, `I've studied the sources for "${n.title}". Recap them thoroughly, then quiz me.`, `Recap & quiz: ${n.title}`)
  const quizNode = (n: StrategyNode) => lesson(n, `Quiz me on "${n.title}" to see if it's solid. If it is, mark it solid; if not, teach what's missing.`, `Quiz me: ${n.title}`)
  const setNodeStatus = async (n: StrategyNode, st: NodeStatus) => {
    if (!goal) return
    const g = await api.setNodeStatus(goal.id, n.id, st)
    if (g) setGoal(g)
  }
  const backToPlan = () => goal && planChat(goal)
  const deleteGoal = async (id: string) => {
    await api.deleteGoal(id)
    setGoals(await api.listGoals())
    if (goal?.id === id) {
      setGoal(null)
      setView("chat")
      newChat()
    }
  }

  const toggleWide = () => api.setWide(!wide)
  // Clicking a change: open it at the changed line in the IDE, and point Changes at the file.
  const showChange = (path: string) => {
    const c = changesRef.current.find((x) => x.path === path)
    api.openInIde(path, c ? firstChangedLine(c) : 1)
    setFocusPath(null)
    requestAnimationFrame(() => setFocusPath(path))
    if (wide) setShowChanges(true)
  }
  const toggleChanges = () => (wide ? setShowChanges((v) => !v) : setDockOpen((v) => !v))

  function runCommand(c: SlashCommand) {
    setDraft("")
    setSlashAt(0)
    const lens = LENSES.find((l) => l.id === c.name)
    if (lens) return update({ mode: "tutor", lens: lens.id })
    switch (c.name) {
      case "new":
        return newChat()
      case "goal":
        return startNewGoal()
      case "history":
        return wide ? undefined : setPanel("history")
      case "changes":
        return wide ? setShowChanges(true) : setDockOpen(true)
      case "keep":
        return api.keepChanges()
      case "undo":
        return api.undoChanges()
      case "model":
        return setModelSignal((n) => n + 1)
      case "tutor":
      case "writer":
        return update({ mode: c.name })
      case "snap":
        return snap()
      case "wide":
        return toggleWide()
      case "settings":
        return setPanel("settings")
    }
  }

  const openFarm = async () => {
    setFarmNote(null)
    try {
      const r = await api.openFarm()
      if (!r.ok) setFarmNote(r.error)
    } catch (err) {
      setFarmNote(clean((err as Error).message))
    }
  }

  // Menu bar commands (⌘N, ⌘Y, ⌘,, ⌘1/⌘2, ⌘O, ⌘⇧D, ⌘⇧W).
  const onMenu = useRef<(action: string) => void>(() => {})
  onMenu.current = (action) => {
    if (action === "new") newChat()
    else if (action === "settings") setPanel((p) => (p === "settings" ? null : "settings"))
    else if (action === "history") wide ? input.current?.focus() : setPanel((p) => (p === "history" ? null : "history"))
    else if (action === "changes") toggleChanges()
    else if (action === "new-goal") startNewGoal()
    else if (action === "wide") toggleWide()
    else if (action === "project") api.pickWorkspace().then(setSettings)
    else if (action.startsWith("mode:")) update({ mode: action.slice(5) as Mode })
    else if (action === "farm") void openFarm()
  }
  useEffect(() => api.onMenu((a) => onMenu.current(a)), [])

  // ? on the farm: a new conversation that starts with the farm's program, error and output.
  const onFarmAsk = useRef<(a: { text: string; shown: string }) => void>(() => {})
  onFarmAsk.current = (a) => {
    const id = newId()
    patchConv(id, () => ({ ...EMPTY_CONV }))
    setShots([])
    setPanel(null)
    setConvId(id)
    setView("chat")
    setSideTab("chats")
    void send(a.text, { shown: a.shown, conv: id, link: {} })
  }
  useEffect(() => api.onFarmAsk((a) => onFarmAsk.current(a)), [])

  const applyTarget = ide?.active ? ide.active.name : settings?.workspace ? "project" : null
  // Answering a card whose turn has ended: record it on the card, and send it as the next message.
  const answerLate = (ask: Ask, a: AskAnswer) => {
    const id = convRef.current
    setMsgsFor(id, (ms) => ms.map((m) => (m.asks?.some((x) => x.id === ask.id) ? { ...m, asks: m.asks.map((x) => (x.id === ask.id ? { ...x, answer: a, late: true } : x)) } : m)))
    if (ask.kind === "exercise") {
      const lang = ask.exercise?.language === "python" ? "python" : "ts"
      const how = a.passed ? "It passes the tests." : a.gaveUp ? "I got stuck and gave up." : "It doesn't pass yet."
      return send(
        `Here's my attempt at your earlier exercise "${ask.exercise?.title}" (its turn had ended):\n\`\`\`${lang}\n${a.code ?? ""}\n\`\`\`\n${how}${a.hintsUsed ? ` I used ${a.hintsUsed} hint${a.hintsUsed === 1 ? "" : "s"}.` : ""} Review it and carry on from there.`,
        { shown: `Exercise: ${ask.exercise?.title} · ${a.passed ? "passed" : a.gaveUp ? "stuck" : "not passing"}`, conv: id }
      )
    }
    const opts = ask.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")
    const picked = a.text ?? (a.dontKnow ? "I don't know" : [...a.picked.map((i) => `${i + 1}. ${ask.options[i]?.label}`), ...(a.other ? [`Other: ${a.other}`] : [])].join("; "))
    const sure = a.sure === undefined ? "" : a.sure ? " (I'm sure)" : " (guessing)"
    const text = `Here's my answer to your earlier ${ask.kind === "quiz" ? "quiz" : "question"} (its turn had ended before I answered):\n"${ask.question}"${opts ? `\n${opts}` : ""}\nMy answer: ${picked}${sure}${a.note ? `\nNote: ${a.note}` : ""}\n${ask.kind === "quiz" ? "Check it and carry on with the lesson from there." : "Carry on from there."}`
    send(text, { shown: `${ask.kind === "quiz" ? "Answer" : "Reply"}: ${picked}${sure}`, conv: id })
  }

  const turnCtx = useMemo(
    () => ({
      target: applyTarget,
      busy,
      answerLate,
      sendText: (text: string) => send(text, { conv: convRef.current }),
      showChange,
      apply: (code: string, lang?: string) => {
        const first = code.split("\n").find((l) => l.trim())?.trim().slice(0, 60) ?? ""
        send(`Apply this change to the project now:\n\n\`\`\`${lang ?? ""}\n${code}\n\`\`\``, { apply: true, shown: `Apply in ${applyTarget}: ${first}${first.length >= 60 ? "…" : ""}` })
      }
    }),
    [applyTarget, busy, settings, current, shots, wide]
  )

  // What's running where, and where a question is waiting for you (sidebar dots, map nodes).
  const activity = useMemo(() => {
    const convs: Record<string, "running" | "waiting"> = {}
    const goalsA: Record<string, "running" | "waiting"> = {}
    const nodes: Record<string, "running" | "waiting"> = {}
    for (const [id, c] of Object.entries(store)) {
      if (!c.busy) continue
      const last = c.msgs[c.msgs.length - 1]
      const st = last?.asks?.some((a) => !a.answer && !a.cancelled) ? "waiting" : "running"
      convs[id] = st
      if (c.link.goalId) goalsA[c.link.goalId] = goalsA[c.link.goalId] === "waiting" ? "waiting" : st
      if (c.link.goalId && c.link.goalId === goal?.id && c.link.nodeId) nodes[c.link.nodeId] = st
    }
    return { convs, goals: goalsA, nodes }
  }, [store, goal?.id])

  // Go to a conversation wherever it lives (a plain chat, a goal's planning chat, a lesson).
  async function goTo(id: string) {
    setToast(null)
    const c = storeRef.current[id]
    if (c?.link.goalId) {
      const g = await api.getGoal(c.link.goalId)
      if (g) {
        setGoal(g)
        setView("goal")
        setSideTab("goals")
        if (!wide) api.setWide(true, true)
      }
    } else setView("chat")
    setPanel(null)
    setConvId(id)
  }
  useEffect(() => {
    if (toast && toast.conv === convId) setToast(null)
  }, [convId])

  const slashItems = matchCommands(draft)
  const lastMsg = msgs[msgs.length - 1]
  const waitingCard = busy && !!lastMsg?.asks?.some((a) => !a.answer && !a.cancelled)

  if (!settings) return <div className="shell" />
  const mode = settings.mode
  // The conversation on screen belongs to a goal: the one open, or (from Chats) looked up by id.
  const goalConv = link.goalId && goal?.id === link.goalId ? goal : null
  const lessonNode = goalConv && link.nodeId ? (goalConv.strategy?.nodes.find((n) => n.id === link.nodeId) ?? null) : null
  const pathNode = (lessonId && goal?.strategy?.nodes.find((n) => n.id === lessonId)) || null
  const mapNext = goalConv?.strategy ? nextNode(goalConv.strategy) : null
  const wsName = settings.workspace?.split("/").pop()
  const changeTotals = changes.reduce((a, c) => a + c.added + c.removed, 0)

  const center = (
    <main className="center">
      <header className="bar">
        <button className="icon" title="Menu" onClick={() => setMenuOpen((o) => !o)}>
          <I.Sidebar />
        </button>
        <div className={`modes at-${mode}`} role="tablist" aria-label="Mode">
          <span className="thumb" />
          <button role="tab" aria-selected={mode === "tutor"} onClick={() => update({ mode: "tutor" })} title="Explains structure, flow and trade-offs (⌘1)">
            <I.Book size={14} /> Tutor
          </button>
          <button role="tab" aria-selected={mode === "writer"} onClick={() => update({ mode: "writer" })} title="Writes complete code and edits your files (⌘2)">
            <I.Pencil size={14} /> Writer
          </button>
        </div>
        {wide && (
          <button className={`icon ${sideOpen ? "" : "on"}`} title={sideOpen ? "Hide conversations" : "Show conversations"} onClick={() => setSideOpen(!sideOpen)}>
            <I.Sidebar />
          </button>
        )}
        <div className="grow" />
        {!wide && (
          <>
            <button className="icon" title="New conversation (⌘N)" onClick={newChat}>
              <I.Plus />
            </button>
            <button className={`icon ${panel === "history" ? "on" : ""}`} title="Past conversations (⌘Y)" onClick={() => setPanel(panel === "history" ? null : "history")}>
              <I.Clock />
            </button>
            <button className="icon" title="Goals: strategy maps (opens the wide layout)" onClick={() => (api.setWide(true, true), setSideOpen(true), setSideTab("goals"))}>
              <I.Target />
            </button>
          </>
        )}
        <button className={`icon badge-host ${(wide ? showChanges : dockOpen) ? "on" : ""}`} title="Changes (⌘⇧D)" onClick={toggleChanges}>
          <I.Diff />
          {!!changes.length && <span className="badge">{changes.length}</span>}
        </button>
        <button className={`icon ${panel === "settings" ? "on" : ""}`} title="Settings (⌘,)" onClick={() => setPanel(panel === "settings" ? null : "settings")}>
          <I.Gear />
        </button>
        <button className={`icon ${settings.pinned ? "on pin" : ""}`} title={settings.pinned ? "Kept on top of other apps (⌥⌘T)" : "Keep on top of other apps (⌥⌘T)"} onClick={() => api.setPinned(!settings.pinned)}>
          <I.Pin />
        </button>
        <button className="icon" title={wide ? "Compact layout (⌘⇧W)" : "Wide layout with sidebar and Changes (⌘⇧W)"} onClick={toggleWide}>
          {wide ? <I.Narrow /> : <I.Wide />}
        </button>
      </header>

      <div className="context">
        <ModelPicker models={models} current={current} onOpen={refreshModels} onPick={(id) => update({ modelId: id })} openSignal={modelSignal} />
        <IdePicker status={ide} onOpen={() => refreshIde(true)} onPick={async (choice) => (await update({ ide: choice }), refreshIde(true))} />
        <button className={`chip ws ${wsName ? "set" : ""}`} onClick={async () => setSettings(await api.pickWorkspace())} title={settings.workspace ?? "Choose a project folder it may read (and write in Writer mode)"}>
          <I.Folder size={14} />
          <span>{wsName ?? "Folder"}</span>
        </button>
      </div>

      {link.review && !panel && (
        <div className="convbar">
          <span className="cb-kind">Review</span>
          <b>Spaced review · fresh questions on what's due</b>
        </div>
      )}
      {goalConv && !panel && (
        <div className="convbar">
          {lessonNode ? (
            <>
              <span className="cb-kind">Lesson</span>
              <b title={lessonNode.summary}>{lessonNode.title}</b>
              {isDone(lessonNode) && <span className="pill ok">solid</span>}
              <div className="grow" />
              {isDone(lessonNode) && mapNext && mapNext.id !== lessonNode.id && (
                <button className="btn primary sm" disabled={busy} onClick={() => teachNode(mapNext)} title="Start the next ready node">
                  Next: {mapNext.title} <I.ArrowRight size={12} />
                </button>
              )}
              <button className="linkish" onClick={backToPlan}>
                <I.Chat size={12} /> Strategy chat
              </button>
            </>
          ) : (
            <>
              <span className="cb-kind">Strategy</span>
              <b>{goalConv.title}</b>
              <div className="grow" />
              {mapNext && (
                <button className="btn primary sm" disabled={busy} onClick={() => teachNode(mapNext)} title="Start the next ready node">
                  {mapNext.status === "learning" ? "Continue" : "Next"}: {mapNext.title}
                </button>
              )}
              {(view !== "goal" || !wide) && (
                <button className="linkish" onClick={() => openGoal(goalConv.id)}>
                  <I.Route size={12} /> Map
                </button>
              )}
            </>
          )}
        </div>
      )}

      {mode === "tutor" && !panel && !goalConv && !link.review && (
        <nav className="lenses" aria-label="Lens">
          {LENSES.map((l) => (
            <button key={l.id} className={settings.lens === l.id ? "on" : ""} title={l.hint} onClick={() => update({ lens: l.id })}>
              {l.label}
            </button>
          ))}
        </nav>
      )}

      {panel === "settings" ? (
        <SettingsPanel settings={settings} keys={keys} ide={ide} onKeys={(k) => (setKeys(k), refreshModels())} onSave={update} flash={flash} setFlash={setFlash} />
      ) : panel === "history" ? (
        <HistoryList currentId={convId} onOpen={openConversation} onNew={newChat} refresh={histTick} />
      ) : (
        <div className="log" ref={scroller}>
          <div className="log-inner">
            {!msgs.length && goalConv && !lessonNode && (
              <GoalChatEmpty
                goal={goalConv}
                onPrompt={(t) => send(t)}
                onDraft={(t) => {
                  setDraft(t)
                  input.current?.focus()
                }}
              />
            )}
            {!msgs.length && !goalConv && <Empty mode={mode} learn={mode === "tutor" && settings.lens === "learn"} onPick={(p) => send(p)} disabled={busy} ide={ide?.active?.name ?? null} starters={STARTERS[mode === "tutor" && settings.lens === "learn" ? "learn" : mode]} />}
            {msgs.map((m, i) => (
              <Message key={i} msg={m} live={busy && i === msgs.length - 1} />
            ))}
          </div>
        </div>
      )}

      {(!wide || view === "goal") && <ChangesDock changes={changes} focus={focusPath} open={dockOpen} setOpen={setDockOpen} />}

      <footer className="composer">
        <div className="box">
          <SlashMenu items={slashItems} active={Math.min(slashAt, slashItems.length - 1)} onPick={runCommand} />
          {ideCtx && (
            <div className="idectx" title={ideCtx.file}>
              <I.Ide size={13} />
              <code>
                {ideCtx.rel}:{ideCtx.start}
                {ideCtx.end > ideCtx.start ? `–${ideCtx.end}` : ""}
              </code>
              <span>{ideCtx.selected ? `${ideCtx.end - ideCtx.start + 1} lines selected` : "around the caret"}</span>
              <button onClick={() => setIdeCtx(null)} aria-label="Remove the code">
                <I.X size={11} />
              </button>
            </div>
          )}
          {!!shots.length && (
            <div className="shots">
              {shots.map((s, i) => (
                <div className="shot" key={i}>
                  <img src={s.preview} alt="Screenshot to send" />
                  <button onClick={() => setShots(shots.filter((_, j) => j !== i))} aria-label="Remove screenshot">
                    <I.X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={waitingCard ? "Answer the card above…" : ideCtx ? "Ask about this code… (↵ to just explain it)" : lessonNode ? `Ask about ${lessonNode.title}…` : goalConv ? "Change the plan, add a video or link, ask anything…" : mode === "tutor" ? (settings.lens === "learn" ? "What do you want to understand?   ( / for commands )" : "Ask about the code, a paper, Docker…   ( / for commands )") : "Describe what to build or change…   ( / for commands )"}
            onChange={(e) => {
              setDraft(e.target.value)
              setSlashAt(0)
            }}
            onKeyDown={(e) => {
              if (slashItems.length) {
                if (e.key === "ArrowDown") return e.preventDefault(), setSlashAt((i) => (i + 1) % slashItems.length)
                if (e.key === "ArrowUp") return e.preventDefault(), setSlashAt((i) => (i - 1 + slashItems.length) % slashItems.length)
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) return e.preventDefault(), runCommand(slashItems[Math.min(slashAt, slashItems.length - 1)])
                if (e.key === "Escape") return setDraft("")
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                const exact = COMMANDS.find((c) => `/${c.name}` === draft.trim())
                if (exact) runCommand(exact)
                else send()
              }
            }}
          />
          <div className="tools-row">
            <button className="ghost" onClick={snap} title="Capture the screen under this window">
              <I.Scan size={15} /> Screen <kbd>⌘⇧\</kbd>
            </button>
            <div className="grow" />
            {busy ? (
              <button className="go stop" onClick={() => api.stop(convId)} title="Stop">
                <I.Square size={14} />
              </button>
            ) : (
              <button className="go" onClick={() => send()} disabled={!draft.trim() && !shots.length && !ideCtx} title="Send  ↵">
                <I.ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="statusline">
          <span className={`pdot p-${current?.provider ?? "none"}`} />
          <span>{current ? `${current.label.split(" · ")[0]} · ${PROVIDER_NAME[current.provider]}` : "no model"}</span>
          <span className="sep">│</span>
          <span>{ide?.active ? `${ide.active.name} › ${ide.active.project?.split("/").pop()}` : "no IDE"}</span>
          {!!changes.length && (
            <>
              <span className="sep">│</span>
              <button className="linkish" onClick={() => (wide ? setShowChanges(true) : setDockOpen(true))}>
                {changes.length} changed · {changeTotals} lines
              </button>
            </>
          )}
          <div className="grow" />
          {lastUsage && (
            <span title="Tokens in the last answer (input / output)">
              {k(lastUsage.input)}↑ {k(lastUsage.output)}↓
            </span>
          )}
        </div>
      </footer>
    </main>
  )

  return (
    <TurnCtx.Provider value={turnCtx}>
      <div className={`shell mode-${mode} ${wide ? "wide" : "narrow"} ${wide && !sideOpen ? "side-folded" : ""}`}>
        <div className="edge" />
        {(view === "home" || view === "lesson" || view === "map") ? (
          <div className={`learn-screen ${view === "map" ? "map-open" : ""}`}>
            <header className="bar learn-bar">
              <button className="icon" title="Menu" onClick={() => setMenuOpen((o) => !o)}>
                <I.Sidebar />
              </button>
              {view !== "home" && (
                <button className="farm-text back bar-back" onClick={() => { setLessonId(null); setView(view === "lesson" && openMod ? "map" : "home") }}>
                  Back
                </button>
              )}
            </header>
            {view === "lesson" && pathNode ? (
              <LessonView node={pathNode} onDone={() => void finishLesson(pathNode)} onBack={() => { setLessonId(null); setView(openMod ? "map" : "home") }} />
            ) : view === "map" && goal?.strategy && openMod && goal.courseId === openMod.courseId ? (
              <GoalView goal={sliceGoal(goal, openMod)} activeNode={null} liveNodes={activity.nodes} busy={busy} onTeach={teachNode} onQuiz={quizNode} onRecap={recapNode} onCheckProject={checkProjectNode} onStatus={setNodeStatus} onOpenLesson={(id) => openConversation(id)} onPlan={() => { if (goal) { setView("goal"); void planChat(goal) } }} />
            ) : view === "map" ? (
              <p className="path-wait">{pathError ?? "Opening the map…"}</p>
            ) : (
              <PathHome modules={modules} onAdd={addModule} onOpen={(m) => void openModule(m)} onRemove={(key) => setModules((prev) => prev.filter((m) => m.key !== key))} onPlatform={addPlatform} onFarm={() => void openFarm()} farmNote={farmNote} />
            )}
          </div>
        ) : wide && sideOpen && (
          <aside className="sidebar">
            <div className="side-top" />
            <button className={`today-nav ${view === "today" ? "on" : ""}`} onClick={() => setView("today")}>
              <I.Clock size={14} /> Today
              {!!reviews?.stats.due && <span className="tab-n due">{reviews.stats.due} due</span>}
            </button>
            <div className="side-tabs" role="tablist">
              <button role="tab" aria-selected={sideTab === "chats"} onClick={() => setSideTab("chats")}>
                <I.Chat size={13} /> Chats
              </button>
              <button role="tab" aria-selected={sideTab === "goals"} onClick={() => setSideTab("goals")}>
                <I.Target size={13} /> Goals {!!goals.length && <span className="tab-n">{goals.length}</span>}
              </button>
            </div>
            {sideTab === "chats" ? (
              <HistoryList currentId={convId} onOpen={(id) => (setView("chat"), openConversation(id))} onNew={newChat} refresh={histTick} sidebar hideGoals live={activity.convs} />
            ) : (
              <GoalList goals={goals} current={view === "goal" ? (goal?.id ?? null) : null} onOpen={openGoal} onNew={startNewGoal} onDelete={deleteGoal} live={activity.goals} />
            )}
          </aside>
        )}
        {(view === "home" || view === "lesson" || view === "map") ? null : wide && view === "today" ? (
          <>
            <Today
              reviews={reviews}
              goals={goals}
              waiting={Object.entries(activity.convs)
                .filter(([, st]) => st === "waiting")
                .map(([conv]) => ({ conv, title: describeConv(store[conv]) }))}
              busy={false}
              onReview={startReview}
              onTeach={teachFrom}
              onGoal={openGoal}
              onGo={goTo}
              onNewGoal={startNewGoal}
            />
            <div className="goal-chat">{center}</div>
          </>
        ) : wide && view === "goal" && goal ? (
          <>
            <GoalView goal={goal} activeNode={link.goalId === goal.id ? (link.nodeId ?? null) : null} liveNodes={activity.nodes} busy={busy} onTeach={teachNode} onQuiz={quizNode} onRecap={recapNode} onCheckProject={checkProjectNode} onStatus={setNodeStatus} onOpenLesson={(id) => openConversation(id)} onPlan={backToPlan} />
            <div className="goal-chat">{center}</div>
          </>
        ) : (
          <>
            {center}
            {wide && showChanges && <ChangesSide changes={changes} focus={focusPath} reserve={(sideOpen ? 248 : 0) + 460} />}
          </>
        )}

        {menuOpen && (
          <div className="app-menu-back" onClick={() => setMenuOpen(false)}>
            <nav className="app-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setMenuOpen(false); setLessonId(null); setView("home") }}>Goal</button>
              <button onClick={() => { setMenuOpen(false); setView("today") }}>Today</button>
              <button onClick={() => { setMenuOpen(false); setSideOpen(true); setSideTab("chats"); setView("chat") }}>Chats</button>
              <button onClick={() => { setMenuOpen(false); if (goal) { setSideTab("goals"); setView("goal") } }}>Full map</button>
              <div className="muted">Goals</div>
              {goals.map((g) => (
                <button key={g.id} onClick={() => { setMenuOpen(false); void openGoal(g.id) }}>{g.title}</button>
              ))}
              <button onClick={() => { setMenuOpen(false); setPanel("settings"); setView("chat") }}>Settings</button>
            </nav>
          </div>
        )}
        {newGoalOpen && <NewGoal onCreate={createGoal} onCourse={startCourse} onOpenGoal={(id) => (setNewGoalOpen(false), openGoal(id))} onCancel={() => setNewGoalOpen(false)} />}
        {toast && (
          <div className="toast" role="status">
            <span className="live-dot waiting" />
            <span>{toast.text}</span>
            <button className="btn primary" onClick={() => goTo(toast.conv)}>
              Go there
            </button>
            <button className="icon" onClick={() => setToast(null)} aria-label="Dismiss">
              <I.X size={13} />
            </button>
          </div>
        )}
      </div>
    </TurnCtx.Provider>
  )
}
