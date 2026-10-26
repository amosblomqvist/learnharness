// Tutor behaves like a normal Mac app: Dock, ⌘Tab, Stage Manager, traffic lights,
// menu bar, remembers its size and place. "Keep on Top" turns it into an overlay.
//   ⌘\        show / hide (works from any app)
//   ⌘⇧\       snap the screen and ask about it (works from any app)
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, shell, Tray, nativeImage, type MenuItemConstructorOptions } from "electron"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { getKey, getProfile, getSettings, keyStatus, saveSettings, setKey, setProfile, type KeyName, type Settings } from "./settings"
import { listModels } from "./models"
import { captureScreen } from "./capture"
import { resetChat, restore, runTurn, snapshot, stopTurn, type TurnInput } from "./chat"
import { closeMcp, mcpTools, parseMcpJson } from "./mcp"
import { closeIdes, ideStatus, openInIde } from "./ide"
import { keepChanges, listChanges, onChanges, undoChanges, clearChanges } from "./changes"
import { stopGrok } from "./grok"
import { answerAsk, installLearn, learnPath, learnStatus, type AskAnswer, exerciseSolution, runExerciseAttempt, peekSolution } from "./learn"
import { COURSES, PHASES } from "./courses"
import { getProject, openProject, projectForNode, view as projectView } from "./projects"
import { listNotes, notesFolder, notesIndex, notesWhere, obsidianUrl, readNote } from "./notes"
import { courseNews, createGoal, createGoalFromCourse, deleteGoal, takeCourseUpdate, getGoal, listGoals, onGoalChanged, recordPractice, renameGoal, setNodeStatusByUser, type NodeStatus } from "./goals"
import { acpAgentStatus, ideHandoff, installAcpAgent, installIdeAction, ideActionStatus } from "./handoff"
import { acpSocketPath, startAcpServer, stopAcpServer } from "./acp-agent"
import { dropGoal, dueCards, onReviewsChanged, reviewStats, syncGoal } from "./reviews"
import { closeDiagrams } from "./diagram"
import { isFarmSender, openFarm, stopOwnedFarm } from "./farm"
import { openVisualizer, stopVisualizer, visualizerUrl } from "./visualizer"
import { recordFarm, registerStudy, loadStudy } from "./study"
import { registerDocs } from "./docs"
import { closeAllMachines } from "./linuxlab"
import { deleteConversation, listConversations, loadConversation, saveConversation, type ConvLink, type UiMessage } from "./conversations"

const DEV_URL = process.env.TUTOR_DEV_URL
const TESTING = !!(process.env.TUTOR_SHOT || process.env.TUTOR_SELFTEST)
// Dev checks can point at a throwaway data folder so they never touch your settings, chats or profile.
if (process.env.TUTOR_USERDATA) app.setPath("userData", process.env.TUTOR_USERDATA)

// One Tutor at a time: opening it again (or "Ask Tutor" from the IDE) hands over to the running one.
// First thing, so a hand-off from the IDE doesn't wait for anything else.
if (!TESTING && !app.requestSingleInstanceLock()) app.exit(0)

// app.isPackaged only looks at the executable's name, and Tutor.app still runs a binary called
// "Electron", so check where the code lives instead.
const packaged = app.getAppPath().includes(".app/Contents/Resources/app")

// Apps opened from Finder get a bare PATH (/usr/bin:/bin…), so `npx`, `uvx`, `ollama`
// and friends wouldn't be found by MCP servers. Borrow the login shell's PATH.
if (packaged) {
  try {
    const shellPath = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "%s" "$PATH"'], { timeout: 4000, killSignal: "SIGKILL", encoding: "utf8" })
    if (shellPath) process.env.PATH = shellPath
  } catch {
    process.env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", path.join(app.getPath("home"), ".local/bin"), process.env.PATH].join(":")
  }
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function savedBounds() {
  const b = getSettings().bounds
  if (!b) return null
  // Only reuse it if it's still on a connected display.
  const area = screen.getDisplayMatching(b).workArea
  const visible = b.x < area.x + area.width - 40 && b.x + b.width > area.x + 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40
  return visible ? b : null
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(1040, area.width - 80)
  const height = Math.min(860, area.height - 60)
  // Lessons need room to read: a window saved at the old chat-panel width opens wider.
  const saved = savedBounds()
  const bounds = saved && saved.width >= 720 ? saved : { x: area.x + Math.round((area.width - width) / 2), y: area.y + 30, width, height }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 420,
    title: "Tutor",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 17 },
    backgroundColor: "#121316",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Test runs keep painting when the window is behind others, so their screenshots are current.
      backgroundThrottling: !TESTING
    }
  })
  applyPinned(getSettings().pinned)
  win.setContentProtection(getSettings().hideFromScreenShare)

  // Links open in the real browser, never inside Tutor.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // Remember size and position.
  let t: NodeJS.Timeout | undefined
  const remember = () => {
    clearTimeout(t)
    t = setTimeout(() => win && !win.isMinimized() && !win.isFullScreen() && saveSettings({ bounds: win.getBounds() }), 400)
  }
  win.on("moved", remember)
  win.on("resized", remember)

  // The red button hides the window like most Mac apps; the conversation stays. ⌘Q quits.
  win.on("close", (e) => {
    if (!quitting && !TESTING) {
      e.preventDefault()
      if (win?.isFullScreen()) win.setFullScreen(false)
      win?.hide()
    }
  })
  win.on("closed", () => (win = null))

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, "../dist/index.html"))
  win.once("ready-to-show", () => win?.show())

  // Dev check: TUTOR_SHOT=/path/out.png saves a picture of the window, then quits.
  const shotPath = process.env.TUTOR_SHOT
  if (shotPath)
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.TUTOR_SHOT_DELAY ?? 1500)))
      if (process.env.TUTOR_SHOT_JS)
        try {
          console.log("[shot js]", JSON.stringify(await win!.webContents.executeJavaScript(process.env.TUTOR_SHOT_JS)))
        } catch (err) {
          console.log("[shot js error]", (err as Error).message)
        }
      await new Promise((r) => setTimeout(r, 600))
      const img = await win!.webContents.capturePage()
      require("node:fs").writeFileSync(shotPath, img.toPNG())
      app.quit()
    })
}

function showWindow() {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function toggle() {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

function applyPinned(on: boolean) {
  if (!win) return
  win.setAlwaysOnTop(on, "floating")
  win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on })
}

function setPinned(on: boolean) {
  saveSettings({ pinned: on })
  applyPinned(on)
  buildMenu()
  win?.webContents.send("pinned", on)
}

async function snapAndAsk() {
  if (!win) createWindow()
  try {
    const shot = await captureScreen(win)
    showWindow()
    win!.webContents.send("screenshot", shot)
  } catch (err) {
    showWindow()
    win?.webContents.send("chat:event", { type: "error", text: (err as Error).message })
  }
}

// The Python visualizer window (a local Python Tutor). Says why if it can't open.
async function showVisualizer(code?: string, edit?: boolean) {
  const r = await openVisualizer(code, edit)
  if (!r.ok) void dialog.showMessageBox({ type: "warning", message: "Couldn't open the Python Visualizer", detail: r.error })
  return r
}

const menuAction = (action: string) => () => {
  showWindow()
  win?.webContents.send("menu", action)
}

function buildMenu() {
  const pinned = getSettings().pinned
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Tutor",
      submenu: [{ role: "about", label: "About Tutor" }, { type: "separator" }, { role: "hide", label: "Hide Tutor" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "Quit Tutor" }]
    },
    { role: "editMenu" },
    {
      label: "Study",
      submenu: [
        { label: "Your Path", accelerator: "CmdOrCtrl+0", click: menuAction("home") },
        { label: "Practice Python on the Farm", click: menuAction("farm") },
        { label: "Python Visualizer", accelerator: "CmdOrCtrl+Alt+V", click: () => void showVisualizer() }
      ]
    },
    {
      label: "View",
      submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(packaged ? [] : ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[]))]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Keep on Top", type: "checkbox", checked: pinned, accelerator: "CmdOrCtrl+Alt+T", click: () => setPinned(!getSettings().pinned) },
        { label: "Show / Hide Tutor", accelerator: "CmdOrCtrl+\\", registerAccelerator: false, click: toggle },
        { type: "separator" },
        { role: "close" },
        { role: "front" }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle("◐")
  tray.setToolTip("Tutor")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / Hide Tutor   ⌘\\", click: toggle },
      { type: "separator" },
      { label: "Quit Tutor", click: () => app.quit() }
    ])
  )
}

function ipc() {
  const send = (e: unknown) => win?.webContents.send("chat:event", e)
  ipcMain.handle("settings:get", () => ({ settings: getSettings(), keys: keyStatus() }))
  ipcMain.handle("settings:save", (_e, patch: Partial<Settings>) => {
    if (patch.mcpJson !== undefined) parseMcpJson(patch.mcpJson) // throws on bad JSON → shown in the UI
    const s = saveSettings(patch)
    win?.setContentProtection(s.hideFromScreenShare)
    return s
  })
  ipcMain.handle("key:set", (_e, name: KeyName, value: string) => {
    setKey(name, value)
    return keyStatus()
  })
  ipcMain.handle("models:list", () => listModels())
  ipcMain.handle("workspace:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], message: "Project folder Tutor may read (and write, in Writer mode)" })
    if (r.canceled || !r.filePaths[0]) return getSettings()
    return saveSettings({ workspace: r.filePaths[0] })
  })
  ipcMain.handle("ide:status", async (_e, fresh?: boolean) => {
    const s = getSettings()
    const { list, active } = await ideStatus(s.ide, s.workspace, !!fresh)
    const view = (i: (typeof list)[number]) => ({ id: i.id, name: i.name, project: i.project, projects: i.projects })
    return { list: list.map(view), active: active ? view(active) : null, choice: s.ide }
  })
  onChanges((list) => win?.webContents.send("changes", list))
  ipcMain.handle("changes:list", () => listChanges())
  ipcMain.handle("changes:keep", (_e, ids?: string[]) => keepChanges(ids))
  ipcMain.handle("changes:undo", (_e, ids?: string[], force?: boolean) => undoChanges(ids, !!force))
  // big: a goal's map wants most of a laptop screen.
  ipcMain.handle("window:wide", (_e, wide: boolean, big?: boolean) => {
    if (!win) return
    const b = win.getBounds()
    const area = screen.getDisplayMatching(b).workArea
    const width = wide ? (big ? Math.min(1640, area.width - 24) : Math.min(1240, area.width - 40)) : 480
    const x = Math.max(area.x + 10, Math.min(b.x, area.x + area.width - width - 10))
    const height = big ? Math.max(b.height, Math.min(1000, area.height - 16)) : Math.max(b.height, wide ? 760 : 0)
    const y = big ? Math.max(area.y + 8, Math.min(b.y, area.y + area.height - height - 8)) : b.y
    win.setBounds({ x, y, width, height }, true)
  })
  ipcMain.handle("ide:open", async (_e, file: string, line: number) => {
    const s = getSettings()
    // "app/orders.py:12" in an answer: relative to the IDE's project (or the project folder).
    if (!path.isAbsolute(file)) {
      const base = (await ideStatus(s.ide, s.workspace).catch(() => null))?.active?.project ?? s.workspace
      if (!base) return { ok: false }
      file = path.join(base, file)
    }
    if (!require("node:fs").existsSync(file)) return { ok: false }
    const r = await openInIde(file, line, s.ide, s.workspace).catch(() => ({ ok: false }))
    if (!r.ok) shell.openPath(file) // no JetBrains IDE running: the default app
    return r
  })
  ipcMain.handle("profile:get", () => getProfile())
  ipcMain.handle("profile:set", (_e, text: string) => setProfile(text))
  ipcMain.handle("conv:list", () => listConversations())
  ipcMain.handle("conv:save", (_e, id: string, messages: UiMessage[], link?: ConvLink) => saveConversation(id, getSettings().mode, messages, snapshot(id), link))
  ipcMain.handle("conv:open", (_e, id: string) => {
    const c = loadConversation(id)
    if (!c) return null
    restore(id, c)
    return { id: c.id, messages: c.messages, goalId: c.goalId, nodeId: c.nodeId, review: c.review }
  })
  ipcMain.handle("conv:delete", (_e, id: string) => deleteConversation(id))
  ipcMain.handle("screen:capture", () => captureScreen(win))
  ipcMain.handle("chat:send", (_e, input: TurnInput) => runTurn(input, send))
  // A node turning solid (or known) gets a review card; one going back to "to learn" loses it.
  onGoalChanged((g) => {
    syncGoal(g)
    win?.webContents.send("goal", g)
  })
  onReviewsChanged(() => win?.webContents.send("reviews", reviewStats()))
  ipcMain.handle("reviews:get", () => ({ stats: reviewStats(), due: dueCards().map((c) => ({ goalId: c.goalId, nodeId: c.nodeId, title: c.title, goalTitle: c.goalTitle })) }))
  ipcMain.handle("goals:list", () => listGoals())
  ipcMain.handle("goals:get", (_e, id: string) => getGoal(id))
  ipcMain.handle("goals:create", (_e, ask: string) => createGoal(ask))
  ipcMain.handle("goals:courses", () => {
    const goals = listGoals()
    return COURSES.map((c) => {
      // A course already started opens its goal instead of making a second copy.
      const g = goals.find((x) => x.courseId === c.id) ?? goals.find((x) => !x.courseId && x.title === c.title)
      return {
        id: c.id,
        phase: c.phase,
        step: c.step,
        realHours: c.realHours,
        after: (c.after ?? []).map((a) => COURSES.find((x) => x.id === a)!).filter(Boolean).map((x) => ({ step: x.step, title: x.title })),
        title: c.title,
        blurb: c.blurb,
        hours: c.hours,
        stages: c.strategy.stages.length,
        nodes: c.strategy.nodes.length,
        started: g ? { goalId: g.id, done: g.done, total: g.total } : null
      }
    })
  })
  // The course a goal came from (older goals: matched by title).
  const courseOf = (goalId: string) => {
    const g = getGoal(goalId)
    return g ? (COURSES.find((c) => c.id === g.courseId) ?? (g.courseId ? undefined : COURSES.find((c) => c.title === g.title))) : undefined
  }
  ipcMain.handle("goals:courseNews", (_e, goalId: string) => {
    const c = courseOf(goalId)
    return c ? courseNews(goalId, c) : null
  })
  ipcMain.handle("goals:courseUpdate", (_e, goalId: string) => {
    const c = courseOf(goalId)
    if (!c) throw new Error("This goal didn't come from a course.")
    return takeCourseUpdate(goalId, c)
  })
  ipcMain.handle("goals:phases", () => PHASES)
  ipcMain.handle("goals:fromCourse", (_e, id: string) => {
    const c = COURSES.find((x) => x.id === id)
    if (!c) throw new Error("No such course.")
    return createGoalFromCourse(c)
  })
  ipcMain.handle("goals:delete", (_e, id: string) => (dropGoal(id), deleteGoal(id)))
  ipcMain.handle("goals:rename", (_e, id: string, title: string) => renameGoal(id, title))
  ipcMain.handle("goals:status", (_e, goalId: string, nodeId: string, status: NodeStatus) => setNodeStatusByUser(goalId, nodeId, status))
  ipcMain.handle("ide:action-status", () => ideActionStatus())
  ipcMain.handle("ide:action-install", () => installIdeAction())
  ipcMain.handle("ide:agent-status", () => acpAgentStatus())
  ipcMain.handle("ide:agent-install", () => installAcpAgent(acpSocketPath()))
  ipcMain.handle("ask:answer", (_e, id: string, answer: AskAnswer) => answerAsk(id, answer))
  ipcMain.handle("exercise:run", (_e, id: string, code: string) => runExerciseAttempt(id, code))
  ipcMain.handle("exercise:solution", (_e, id: string) => exerciseSolution(id))
  ipcMain.handle("projects:forNode", (_e, goalId: string, nodeId: string) => {
    const p = projectForNode(goalId, nodeId)
    return p ? projectView(p) : null
  })
  ipcMain.handle("projects:open", async (_e, id: string) => {
    const p = getProject(id)
    if (!p) throw new Error("That project doesn't exist any more.")
    return openProject(p)
  })
  ipcMain.handle("notes:list", (_e, goalId: string) => listNotes(goalId))
  ipcMain.handle("notes:read", (_e, goalId: string, nodeId: string) => readNote(goalId, nodeId))
  ipcMain.handle("notes:open", (_e, goalId: string, file?: string) => {
    const dir = notesFolder(goalId)
    if (!dir) return
    if (file && file.startsWith(dir + path.sep)) shell.showItemInFolder(file)
    else void shell.openPath(dir)
  })
  // In Obsidian: the note, or the goal's index; false when the folder isn't in a vault.
  ipcMain.handle("notes:obsidian", async (_e, goalId: string, file?: string) => {
    const dir = notesFolder(goalId)
    if (!dir) return false
    const url = obsidianUrl(file && file.startsWith(dir + path.sep) ? file : notesIndex(dir))
    if (!url) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle("notes:where", () => notesWhere())
  ipcMain.handle("notes:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], message: "Where Tutor saves recaps (a folder inside your Obsidian vault works well)" })
    if (!r.canceled && r.filePaths[0]) saveSettings({ notesDir: r.filePaths[0] })
    return notesWhere()
  })
  ipcMain.handle("notes:reset", () => (saveSettings({ notesDir: "" }), notesWhere()))
  ipcMain.handle("learn:status", () => learnStatus())
  ipcMain.handle("learn:install", () => installLearn())
  ipcMain.handle("learn:open", () => shell.openPath(learnPath()))
  ipcMain.handle("learn:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], message: "Folder with the teaching skill (skills/teach/SKILL.md inside)" })
    if (!r.canceled && r.filePaths[0]) saveSettings({ learnPath: r.filePaths[0] })
    return learnStatus()
  })
  ipcMain.handle("chat:stop", (_e, conv?: string) => stopTurn(conv))
  ipcMain.handle("chat:reset", (_e, conv: string) => resetChat(conv))
  ipcMain.handle("window:hide", () => win?.hide())
  ipcMain.handle("farm:open", () => openFarm())
  ipcMain.handle("viz:url", () => visualizerUrl())
  ipcMain.handle("viz:open", (_e, code?: unknown, edit?: unknown) => showVisualizer(typeof code === "string" ? code : undefined, edit === true))
  // A lesson finished on the farm counts as practice on the study lesson with the same id.
  ipcMain.handle("farm:practice", (e, p: { node?: unknown; title?: unknown }) => {
    if (!isFarmSender(e.sender) || typeof p?.node !== "string" || p.node.length > 80) return { counted: false }
    recordFarm(p.node)
    win?.webContents.send("study-farm", (loadStudy() as { farm?: object } | null)?.farm ?? {})
    return { counted: true, node: typeof p.title === "string" ? p.title.slice(0, 120) : p.node }
  })
  registerStudy()
  registerDocs()
  ipcMain.handle("window:pin", (_e, on: boolean) => setPinned(on))
}

// Dev check without the UI: TUTOR_SELFTEST="<model id>|<mode>|<prompt>" npx electron .
async function selfTest(spec: string) {
  const [modelId, mode, prompt] = spec.split("|")
  const before = { ...getSettings() }
  // mode "apply" = Tutor mode plus the "Apply in IDE" button; "goal" = start a goal from the prompt
  saveSettings({ modelId, mode: mode === "apply" || mode === "goal" || mode === "review" ? "tutor" : (mode as Settings["mode"]) })
  // Goals made before reviews existed get their cards.
  for (const g of listGoals()) {
    const full = getGoal(g.id)
    if (full) syncGoal(full)
  }
  // "lesson:<course>:<node>" = a lesson on one node of a fresh goal from that course.
  const [, courseId, lessonNode] = mode.startsWith("lesson:") ? mode.split(":") : []
  const course = courseId ? COURSES.find((c) => c.id === courseId) : undefined
  const goal = mode === "goal" ? createGoal(prompt) : course ? createGoalFromCourse(course) : null
  let text = ""
  await runTurn({ text: prompt, images: [], apply: mode === "apply", goalId: goal?.id, nodeId: lessonNode, conversationId: course ? `selftest-lesson-${Date.now()}` : (goal?.conversationId ?? `selftest-${mode}`), review: mode === "review" }, (e) => {
    if (e.type === "text") text += e.delta
    else console.log("[event]", JSON.stringify(e).slice(0, 1500))
    // Nobody's at a window: answer cards automatically (first option, or a short reply). An exercise
    // gets a failing run (the starter), then a pass with a hint used.
    if (e.type === "ask" && e.ask.kind === "exercise")
      setTimeout(async () => {
        const first = await runExerciseAttempt(e.ask.id, e.ask.exercise!.starter)
        console.log("[exercise run 1]", first?.ok, first?.tests.map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`).join(" · "))
        const sol = peekSolution(e.ask.id) ?? ""
        const second = await runExerciseAttempt(e.ask.id, sol)
        console.log("[exercise run 2]", second?.ok, second?.tests.length, "tests", second?.typeErrors.length, "type errors")
        answerAsk(e.ask.id, { picked: [], code: sol, hintsUsed: 1, passed: !!second?.ok })
      }, 300)
    else if (e.type === "ask") setTimeout(() => answerAsk(e.ask.id, e.ask.options.length ? { picked: [0], note: "auto-answered by the self-test" } : { picked: [], text: "Go with your recommendation." }), Number(process.env.TUTOR_SELFTEST_ANSWER_DELAY ?? 300))
  })
  console.log("[answer]", text)
  if (mode === "review") console.log("[reviews]", JSON.stringify(reviewStats()))
  if (goal && lessonNode) {
    const g = getGoal(goal.id)
    const n = g?.strategy?.nodes.find((x) => x.id === lessonNode)
    console.log("[node]", lessonNode, n?.status, "| practice", JSON.stringify(g?.practice?.[lessonNode] ?? null), "| note", n?.note)
  } else if (goal) {
    const g = getGoal(goal.id)
    const st = g?.strategy
    console.log("[strategy]", st ? `${st.nodes.length} nodes, ${st.stages.length} stages` : "none saved")
    if (st) for (const n of st.nodes) console.log(`  ${n.stage.padEnd(10)} ${n.kind.padEnd(8)} ${n.status.padEnd(8)} ${n.title}  ← ${n.requires.join(", ")}`)
  }
  saveSettings({ modelId: before.modelId, mode: before.mode })
  app.quit()
}

// A second launch: plain (bring the window forward), or "Ask Tutor" from the IDE with the selection.
app.on("second-instance", async (_e, argv) => {
  showWindow()
  if (process.env.TUTOR_HANDOFF_SHOT) console.log("[handoff argv]", JSON.stringify(argv))
  const ctx = await ideHandoff(argv).catch((e) => (console.error("[handoff]", e), null))
  if (ctx) win?.webContents.send("ide-context", ctx)
  // Dev check: TUTOR_HANDOFF_SHOT=/path/out.png pictures the window after a hand-off, then quits.
  if (ctx && process.env.TUTOR_HANDOFF_SHOT)
    setTimeout(async () => {
      require("node:fs").writeFileSync(process.env.TUTOR_HANDOFF_SHOT!, (await win!.webContents.capturePage()).toPNG())
      quitting = true
      app.quit()
    }, 1200)
})

app.whenReady().then(() => {
  if (process.env.TUTOR_SELFTEST) return void selfTest(process.env.TUTOR_SELFTEST)
  ipc()
  buildMenu()
  createWindow()
  createTray()
  globalShortcut.register("CommandOrControl+\\", toggle)
  // Dev runs as "Electron"; give it the Tutor icon in the Dock too (the packaged app has it built in).
  // Cosmetic, so it goes last and can never stop the window from opening.
  if (!packaged) {
    try {
      app.dock?.setIcon(path.join(__dirname, "../assets/icon.png"))
    } catch {}
  }
})

app.on("before-quit", () => (quitting = true))
app.on("will-quit", () => {
  globalShortcut.unregisterAll()
  void closeMcp()
  void closeIdes()
  void stopGrok()
  closeDiagrams()
  stopOwnedFarm()
  stopVisualizer()
  stopAcpServer()
  closeAllMachines()
})
app.on("window-all-closed", () => {}) // stays in the Dock until you quit, like other Mac apps
app.on("activate", showWindow) // clicking the Dock icon brings the window back
