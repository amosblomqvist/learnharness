// Runs one turn of the conversation and streams events to the window.
// Three engines, same reach (project files, the JetBrains IDE, the web, your MCP servers):
//  - "claude-plan": the Claude Agent SDK driving your installed Claude Code (your Claude plan).
//  - "grok-plan":   xAI's Grok Build CLI over ACP (your SuperGrok / X Premium+ subscription).
//  - everything else: the AI SDK (streamText) with API keys or Ollama.
// Every file edit goes through changes.ts, so the Changes pane can show, keep or undo it.
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { generateText, streamText, isStepCount, tool, type ModelMessage, type Tool, type ToolSet, type UserContent } from "ai"
import { query, type AgentDefinition, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { addToProfile, getKey, getProfile, getSettings, type Lens } from "./settings"
import { languageModel, splitId } from "./models"
import { goalSection, learnPrompt, reviewSection, tutorPrompt, writerPrompt, type PromptContext, type ToolNames } from "./prompts"
import { dueCards, dueForPrompt } from "./reviews"
import { workspaceTools } from "./tools"
import { webTools } from "./web"
import { allServers, mcpAllowedNames, mcpTools, type McpServer } from "./mcp"
import { ideForAgentSdk, ideStatus, ideTools, type Ide } from "./ide"
import { afterWrite, beforeWrite, filesTouched, isEditTool, reconcileDiff, setDisplayRoot, statsFor } from "./changes"
import { grokSessionId, grokTurn, isRiskyToolCall, resetGrokSession, type GrokMcp } from "./grok"
import { answerAsk, endTurn, installLearn, readSkill, waitForAnswer, type AskEvent, type Skill, type TurnScope } from "./learn"
import { aiTutorTools, runTutorTool, bindHttpScope, releaseHttpScope, claudeTutorNames, claudeTutorServer, isCardTool, toolName, tutorHttpServer, type Engine, type ToolGroup } from "./tutor-tools"
import { addLesson, getGoal, saveStrategy, type StrategyInput } from "./goals"
import { NOTE_ADD, RECAP, appendToNote, saveRecap, type NoteInfo } from "./notes"

export type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" }
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id?: string; name: string; detail: string; input?: string }
  | { type: "tool-done"; id?: string; name: string; ok: boolean; detail?: string; change?: { path: string; added: number; removed: number } }
  | { type: "plan"; items: PlanItem[] }
  | { type: "notice"; text: string }
  | { type: "usage"; input: number; output: number }
  | { type: "learned"; notes: string[] }
  | { type: "note"; note: NoteInfo }
  | { type: "error"; text: string }
  | { type: "done"; usage?: string }
  | AskEvent

// apply: the user pressed "Apply in IDE" on a code block, so this turn may edit even in Tutor mode.
// goalId/nodeId: the conversation belongs to a goal (its planning chat, or a lesson on one node).
// review: a spaced-review session over everything due.
// mode/lens/workspace/textCards: a turn from outside the window (the IDE's AI chat) brings its own.
export type TurnInput = { text: string; images: string[]; apply?: boolean; conversationId?: string; goalId?: string; nodeId?: string; review?: boolean; mode?: "tutor" | "writer"; lens?: Lens; workspace?: string | null; textCards?: boolean } // images = base64 JPEG

// Every conversation has its own state and can have its own turn running, so leaving a lesson
// with a quiz open (to plan, to chat, to look at another goal) doesn't stop it.
type Conv = { history: ModelMessage[]; claudeSession: string | null; abort: AbortController | null }
const convs = new Map<string, Conv>()
function convState(id: string): Conv {
  let c = convs.get(id)
  if (!c) convs.set(id, (c = { history: [], claudeSession: null, abort: null }))
  return c
}
export const isRunning = (id: string) => !!convs.get(id)?.abort

export function resetChat(id: string): void {
  convs.get(id)?.abort?.abort()
  convs.delete(id)
  resetGrokSession(id)
}

// One conversation's turn, or all of them (quitting).
export function stopTurn(id?: string): void {
  if (id) convs.get(id)?.abort?.abort()
  else for (const c of convs.values()) c.abort?.abort()
}

// For saving a conversation to disk and picking it up again later (conversations.ts).
// Screenshots are dropped: they're large and the model only needs them in the turn they were sent.
export type ChatState = { history: ModelMessage[]; claudeSession: string | null }

export function snapshot(id: string): ChatState {
  const { history, claudeSession } = convState(id)
  const lean = history.map((m) =>
    m.role === "user" && typeof m.content !== "string"
      ? { ...m, content: m.content.map((p) => (p.type === "image" ? { type: "text" as const, text: "[screenshot]" } : p)) }
      : m
  )
  return { history: lean, claudeSession }
}

// Load a saved conversation's memory, unless it's already live here (then memory is ahead of disk).
export function restore(id: string, state: ChatState): void {
  const c = convs.get(id)
  if (c && (c.abort || c.history.length)) return
  convs.set(id, { history: state.history ?? [], claudeSession: state.claudeSession ?? null, abort: null })
  resetGrokSession(id)
}

// Screenshots are big; keep only the ones from the last two user turns in history.
function trimOldImages(history: ModelMessage[]): void {
  let userTurns = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== "user") continue
    userTurns++
    if (userTurns <= 2 || typeof m.content === "string") continue
    m.content = m.content.map((p) => (p.type === "image" ? { type: "text" as const, text: "[earlier screenshot omitted]" } : p))
  }
}

function transcript(history: ModelMessage[]): string {
  return history
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join(" ")}`)
    .join("\n\n")
    .slice(-20_000)
}

function brief(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  const v = o.pathInProject ?? o.filePath ?? o.file_path ?? o.path ?? o.notebook_path ?? o.pattern ?? o.query ?? o.q ?? o.searchText ?? o.symbolName ?? o.dir ?? o.directoryPath ?? o.url ?? o.command ?? Object.values(o)[0]
  return typeof v === "string" ? v.slice(0, 120) : ""
}

const showInput = (input: unknown) => {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input, null, 2)
    return s.length > 2400 ? s.slice(0, 2400) + "\n…" : s
  } catch {
    return undefined
  }
}

const LEARNED = /<learned>([\s\S]*?)<\/learned>/g
function takeLearned(answer: string, send: (e: ChatEvent) => void) {
  if (process.env.TUTOR_DEMO) return // canned answers must never touch the real profile
  const notes = [...answer.matchAll(LEARNED)].map((m) => m[1].trim()).filter(Boolean).slice(0, 3)
  if (!notes.length) return
  const added = addToProfile(notes)
  if (added.length) send({ type: "learned", notes: added })
}

// Turn the errors people actually hit into what to do about them.
function friendly(message: string, st: Conv): string {
  const provider = splitId(getSettings().modelId).provider
  if (provider === "claude-plan" && /authenticat|oauth|not logged in|log ?in|401/i.test(message)) {
    st.claudeSession = null
    return "Claude Code isn't logged in on this Mac, so \"Claude · my plan\" can't answer yet. Open Terminal, run `claude auth login`, sign in with your Claude account, then ask again. Meanwhile, Grok or an API-key model works."
  }
  if (provider === "claude-plan" && /ENOENT|spawn/i.test(message))
    return `Couldn't start Claude Code at ${getSettings().claudePath}. Check the path in Settings → Local & Claude.`
  if (provider !== "grok-plan" && /401|invalid.*api key|incorrect api key|unauthorized/i.test(message)) return `The API key was rejected (${message.slice(0, 120)}). Paste it again in Settings.`
  if (/ECONNREFUSED/.test(message) && provider === "ollama") return "Ollama isn't running. Start the Ollama app (or run `ollama serve`) and try again."
  return message
}

// Events go to the window tagged with their conversation, so a turn running in the background
// updates the right conversation (and its cards stay answerable) while you look at another one.
export type ConvEvent = ChatEvent & { conv: string }

export async function runTurn(input: TurnInput, sendTo: (e: ConvEvent) => void): Promise<void> {
  const conv = input.conversationId ?? "default"
  const st = convState(conv)
  st.abort?.abort() // a new message in the same conversation replaces its running turn
  const ctl = (st.abort = new AbortController())
  const goal = input.goalId ? getGoal(input.goalId) : null
  const nodeId = goal && input.nodeId && goal.strategy?.nodes.some((n) => n.id === input.nodeId) ? input.nodeId : undefined
  // A recap streams in as text; it's saved to the goal's notes as soon as its closing marker arrives.
  // Their mistakes at the end of a lesson (<!-- note-add -->) are appended to that note.
  let said = ""
  let recapSaved = false
  let addSaved = false
  const send = (e: ChatEvent) => {
    sendTo({ ...e, conv } as ConvEvent)
    if (e.type !== "text" || (recapSaved && addSaved) || !goal || !nodeId || process.env.TUTOR_DEMO) return
    said += e.delta
    try {
      const m = !recapSaved && said.match(RECAP)
      if (m) {
        recapSaved = true
        const note = saveRecap(goal.id, nodeId, m[1], /studied the sources/i.test(input.text) ? "recap" : "lesson")
        if (note) sendTo({ type: "note", note, conv })
      }
      const a = !addSaved && said.match(NOTE_ADD)
      if (a) {
        addSaved = true
        const note = appendToNote(goal.id, nodeId, a[1])
        if (note) sendTo({ type: "note", note, conv })
      }
    } catch (err) {
      console.error("[notes]", err)
    }
  }
  const base = getSettings()
  const s = { ...base, mode: input.mode ?? base.mode, lens: input.lens ?? base.lens, workspace: input.workspace !== undefined ? input.workspace : base.workspace }
  const canWrite = s.mode === "writer" || !!input.apply
  const provider = splitId(s.modelId).provider
  const engine: Engine = provider === "claude-plan" || provider === "grok-plan" ? provider : "api"
  // A lesson started with "Teach me" or "Recap & quiz" opens with its write-up: cards wait for it.
  const lessonNode = goal && nodeId ? goal.strategy?.nodes.find((x) => x.id === nodeId) : undefined
  const wantsWriteup = !!lessonNode && lessonNode.kind !== "project" && /^(teach me\b|i've studied the sources)/i.test(input.text.trim())
  const gate = () =>
    wantsWriteup && !recapSaved
      ? "Refused: this lesson starts with its write-up, and it hasn't been written yet. Write the whole write-up now as text in your reply (step 2 of how this lesson runs): `<!-- recap -->` on its own line, then `# Title`, the concept map, the content sections, Source check, Tips and advice, Common mistakes, Go deeper, then `<!-- /recap -->` on its own line. Tutor saves it when the closing marker arrives. Then ask this question again."
      : null
  const scope: TurnScope = { conv, goalId: goal?.id, nodeId, send, signal: ctl.signal, textCards: input.textCards, workspace: s.workspace, gate }
  if (goal && nodeId) addLesson(goal.id, conv, nodeId)
  try {
    let ide: Ide | null = null
    try {
      ide = (await ideStatus(s.ide, s.workspace)).active
    } catch (err) {
      console.error("[ide]", err)
    }
    setDisplayRoot(ide?.project ?? s.workspace)
    const braveKey = getKey("brave")
    const names = toolNames(engine)
    const ctx: PromptContext = { aboutMe: s.aboutMe, profile: getProfile(), workspace: s.workspace, ide, webSearch: !!braveKey, applying: !!input.apply, video: names.video }
    // Goals always teach with the Learn skill (Writer mode keeps writing, with the goal in view).
    const skill = !canWrite && (s.lens === "learn" || goal || input.review) ? await teachingSkill(send) : null
    let system = canWrite ? writerPrompt(ctx) : skill ? learnPrompt(ctx, skill, names) : tutorPrompt(s.lens === "learn" ? "explain" : s.lens, ctx)
    if (goal) system += `\n\n${goalSection(goal, nodeId, names)}`
    if (input.review) system += `\n\n${reviewSection(dueForPrompt(dueCards()), names)}`
    const tools: TurnTools = { groups: ["video", ...(skill || goal || input.review ? (["learn", "lab", "project"] as const) : []), ...(goal ? (["goal"] as const) : []), ...(input.review ? (["review"] as const) : [])], skill, scope, st }
    const dirs = { workspace: s.workspace, ideProject: ide?.project ?? null }

    let answer: string
    if (process.env.TUTOR_DEMO) answer = await runDemo(send, scope)
    else if (provider === "claude-plan") answer = await runClaudePlan(input, system, canWrite, ide, braveKey, dirs, send, ctl, tools)
    else if (provider === "grok-plan") answer = await runGrokPlan(input, system, canWrite, ide, braveKey, dirs, send, ctl, tools)
    else answer = await runAiSdk(input, system, canWrite, ide, braveKey, dirs, send, ctl, tools)
    takeLearned(answer, send)
  } catch (err) {
    if (ctl.signal.aborted) send({ type: "notice", text: "Stopped." })
    else send({ type: "error", text: friendly((err as Error).message ?? String(err), st) })
  } finally {
    endTurn(scope)
    releaseHttpScope(scope)
    if (st.abort === ctl) st.abort = null
    send({ type: "done" })
  }
}

// The Learn lens's skill files; fetched from GitHub the first time they're needed.
async function teachingSkill(send: (e: ChatEvent) => void): Promise<Skill | null> {
  let skill = readSkill()
  if (!skill) {
    send({ type: "notice", text: "Getting the teaching method (github.com/amosblomqvist/learn)…" })
    try {
      await installLearn()
      skill = readSkill()
    } catch (err) {
      console.error("[learn]", err)
    }
  }
  if (!skill) send({ type: "notice", text: "Couldn't load the teaching skill, so this answer uses the Explain lens. Settings → Teaching method." })
  return skill
}

// Tutor's own tools this turn: which groups, and the skill (for the researcher) when teaching.
type TurnTools = { groups: ToolGroup[]; skill: Skill | null; scope: TurnScope; st: Conv }

// What Tutor's tools are called on each engine, for the prompts.
const RESEARCH: Record<Engine, string> = {
  "claude-plan": 'the "researcher" subagent: call the Agent tool with subagent_type "researcher", run_in_background false, and one self-contained question (it sees nothing else of the conversation); wait for its brief before going on',
  "grok-plan": "your own web search and page-reading tools (there's no researcher subagent here, so do the check yourself before you state the fact)",
  api: "the `research` tool (a separate researcher that searches the web and returns a short sourced brief; give it one self-contained question)"
}
function toolNames(engine: Engine): ToolNames {
  const t = (n: string) => toolName(engine, n)
  return { quiz: t("quiz"), ask: t("ask_user_question"), render: t("render_diagram"), save: t("save_strategy"), mark: t("mark_node"), video: t("video_transcript"), predict: t("predict"), run: t("run_code"), trace: t("trace_code"), exercise: t("exercise"), checkExercise: t("check_exercise"), startProject: t("start_project"), checkProject: t("check_project"), advanceProject: t("advance_project"), review: t("record_review"), research: RESEARCH[engine] }
}

// The skill's researcher, told which tools it has here.
function researcherPrompt(skill: Skill, tools: string): string {
  const base =
    skill.researcher ||
    "You are a research specialist. Given one question, search the web from a few angles, read the two or three best primary sources, and reply with a short brief: a direct answer, numbered findings each with a source link, and what you couldn't confirm."
  return `${base}\n\nTools you have here: ${tools}. Other tool names mentioned above don't exist here.`
}

type Dirs = { workspace: string | null; ideProject: string | null }

// Wrap a write tool so the Changes pane sees the file before and after.
function tracked(name: string, t: Tool, dirs: Dirs): Tool {
  if (!isEditTool(name) || !t.execute) return t
  const exec = t.execute
  return {
    ...t,
    execute: async (input: unknown, opts: Parameters<typeof exec>[1]) => {
      const files = filesTouched(name, input, dirs)
      beforeWrite(files, name)
      try {
        return await exec(input as never, opts)
      } finally {
        afterWrite(files)
      }
    }
  } as Tool
}

const changeFor = (name: string, input: unknown, dirs: Dirs) => {
  const f = filesTouched(name, input, dirs)[0]
  const st = f ? statsFor(f) : null
  return f && st ? { path: f, ...st } : undefined
}

async function runAiSdk(input: TurnInput, system: string, canWrite: boolean, ide: Ide | null, braveKey: string | undefined, dirs: Dirs, send: (e: ChatEvent) => void, ctl: AbortController, turn: TurnTools): Promise<string> {
  const s = getSettings()
  const { skill, st } = turn
  const history = st.history
  const content: UserContent = [
    ...input.images.map((b64) => ({ type: "image" as const, image: b64, mediaType: "image/jpeg" })),
    { type: "text" as const, text: input.text || "Explain what's on my screen." }
  ]
  history.push({ role: "user", content })
  trimOldImages(history)

  const mcp = await mcpTools(s.mcpJson, braveKey, canWrite)
  for (const e of mcp.errors) send({ type: "notice", text: `MCP: ${e}` })
  const raw: ToolSet = {
    ...(dirs.workspace ? workspaceTools(dirs.workspace, canWrite) : {}),
    ...webTools(),
    ...mcp.tools,
    ...(ide ? ideTools(ide, canWrite) : {}),
    ...aiTutorTools(turn.groups, turn.scope),
    ...(skill ? { research: researchTool(skill, { ...webTools(), ...mcp.tools }, !!braveKey) } : {})
  }
  const tools: ToolSet = Object.fromEntries(Object.entries(raw).map(([n, t]) => [n, tracked(n, t, dirs)]))

  const result = streamText({
    model: languageModel(s.modelId),
    system,
    messages: history,
    tools,
    // A Learn probe can be a dozen questions in one turn.
    stopWhen: isStepCount(canWrite ? 30 : turn.groups.includes("learn") ? 60 : 14),
    abortSignal: ctl.signal
  })

  let answer = ""
  const inputs = new Map<string, unknown>()
  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        answer += part.text
        send({ type: "text", delta: part.text })
        break
      case "tool-call":
        inputs.set(part.toolCallId, part.input)
        if (isCardTool(part.toolName)) break // shown as a card instead
        send({ type: "tool", id: part.toolCallId, name: part.toolName, detail: brief(part.input), input: showInput(part.input) })
        break
      case "tool-result":
        if (isCardTool(part.toolName)) break
        send({
          type: "tool-done",
          id: part.toolCallId,
          name: part.toolName,
          ok: true,
          detail: typeof part.output === "string" ? part.output.slice(0, 1500) : showInput(leanOutput(part.output))?.slice(0, 1500),
          change: isEditTool(part.toolName) ? changeFor(part.toolName, inputs.get(part.toolCallId), dirs) : undefined
        })
        break
      case "tool-error":
        send({ type: "tool-done", id: part.toolCallId, name: part.toolName, ok: false, detail: String((part as { error?: unknown }).error ?? "") })
        break
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  const response = await result.response
  history.push(...response.messages)
  const u = await result.totalUsage
  if (u?.inputTokens) send({ type: "usage", input: u.inputTokens, output: u.outputTokens ?? 0 })
  return answer
}

// The Learn skill's researcher for API models: a separate call with only the web tools, so its
// searching doesn't fill the lesson's context. Returns a short, sourced brief.
function researchTool(skill: Skill, all: ToolSet, hasSearch: boolean): Tool {
  const web = Object.fromEntries(Object.entries(all).filter(([n]) => n === "fetch_url" || n.startsWith("brave__")))
  const names = hasSearch ? "brave__brave_web_search (search), brave__brave_llm_context (search with page extracts), fetch_url (read a page)" : "fetch_url (read a page; there's no search engine connected, so go straight to official docs, specs and arXiv)"
  return tool({
    description: "Give a separate researcher one self-contained question; it searches the web, reads sources and returns a short, sourced brief. Use it to map a topic before planning a lesson and to check any fact you aren't sure of.",
    inputSchema: z.object({ question: z.string().describe("Self-contained: the researcher sees nothing else of the conversation.") }),
    execute: async ({ question }, opts) => {
      const r = await generateText({ model: languageModel(getSettings().modelId), system: researcherPrompt(skill, names), prompt: question, tools: web, stopWhen: isStepCount(12), abortSignal: (opts as { abortSignal?: AbortSignal }).abortSignal })
      return r.text || "The researcher came back empty."
    }
  })
}

// Diagram checks return a picture; the step's detail only needs the words.
function leanOutput(out: unknown): unknown {
  return out && typeof out === "object" && "png" in out ? { ...(out as object), png: "[image]" } : out
}

// Claude Code's own tool names. Tutor may look; writer may also edit files and keep a to-do list.
const READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "TodoWrite"]

function claudeEnv(): Record<string, string | undefined> {
  // Never let an API key in the environment silently switch this to API billing.
  // Also drop a parent Claude Code session's variables if Tutor was launched from inside one.
  const env: Record<string, string | undefined> = { ...process.env }
  const nested = !!env.CLAUDECODE
  for (const k of Object.keys(env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK")) delete env[k]
    if (nested && k === "ANTHROPIC_BASE_URL") delete env[k]
  }
  // The researcher's brief is needed before the answer goes on, so no background agents;
  // and a long video transcript (~22k tokens) should arrive inline, not be diverted to a file.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1"
  env.MAX_MCP_OUTPUT_TOKENS = "40000"
  return env
}

async function runClaudePlan(input: TurnInput, system: string, canWrite: boolean, ide: Ide | null, braveKey: string | undefined, dirs: Dirs, send: (e: ChatEvent) => void, ctl: AbortController, turn: TurnTools): Promise<string> {
  const s = getSettings()
  const { model } = splitId(s.modelId)
  const { skill, st } = turn

  // If the conversation started on another model, hand Claude the transcript so far.
  let text = input.text || "Explain what's on my screen."
  if (!st.claudeSession && st.history.length) text = `Conversation so far (with another model):\n${transcript(st.history)}\n\nNew message:\n${text}`

  async function* prompt() {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: [
          ...input.images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } })),
          { type: "text" as const, text }
        ]
      }
    }
  }

  // Exactly the tools this mode may use; anything else is denied without asking ("dontAsk").
  // Tutor's own tools run in-process; teaching adds the skill's researcher as a subagent.
  const builtIn = canWrite && (dirs.workspace || ide) ? [...READ_TOOLS, ...WRITE_TOOLS] : skill ? [...READ_TOOLS, "Agent"] : READ_TOOLS
  const ideCfg = ide ? ideForAgentSdk(ide, canWrite) : null
  const mcpServers = { ...allServers(s.mcpJson, braveKey), ...(ideCfg?.server ?? {}), tutor: claudeTutorServer(turn.groups, turn.scope) }
  const mcpNames = await mcpAllowedNames(s.mcpJson, braveKey, canWrite)
  const allowedTools = [...builtIn, ...mcpNames, ...(ideCfg?.allowed ?? []), ...claudeTutorNames(turn.groups)]
  const braveNames = mcpNames.filter((n) => n.startsWith("mcp__brave__"))
  const agents: Record<string, AgentDefinition> | undefined = skill
    ? {
        researcher: {
          description: "Web researcher. Give it one self-contained question; it searches, reads primary sources and returns a short, sourced brief.",
          prompt: researcherPrompt(skill, ["WebSearch", "WebFetch", ...braveNames].join(", ")),
          tools: ["WebSearch", "WebFetch", ...braveNames],
          model: "sonnet"
        }
      }
    : undefined

  // Snapshot files right before Claude edits them, and read them right after.
  const touched = new Map<string, string[]>()
  const hooks: Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure", HookCallbackMatcher[]>> = {
    PreToolUse: [
      {
        hooks: [
          async (h) => {
            if (h.hook_event_name === "PreToolUse" && isEditTool(h.tool_name)) {
              const files = filesTouched(h.tool_name, h.tool_input, dirs)
              touched.set(h.tool_use_id, files)
              beforeWrite(files, h.tool_name)
            }
            return {}
          }
        ]
      }
    ],
    PostToolUse: [
      {
        hooks: [
          async (h) => {
            if (h.hook_event_name === "PostToolUse") afterWrite(touched.get(h.tool_use_id) ?? [])
            return {}
          }
        ]
      }
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (h) => {
            if ("tool_use_id" in h) afterWrite(touched.get((h as { tool_use_id: string }).tool_use_id) ?? [])
            return {}
          }
        ]
      }
    ]
  }

  const q = query({
    prompt: prompt(),
    options: {
      model,
      systemPrompt: system,
      cwd: ide?.project ?? dirs.workspace ?? os.homedir(),
      tools: builtIn,
      allowedTools,
      disallowedTools: ideCfg?.disallowed ?? [],
      permissionMode: "dontAsk",
      mcpServers: mcpServers as never,
      agents,
      hooks,
      includePartialMessages: true,
      resume: st.claudeSession ?? undefined,
      pathToClaudeCodeExecutable: s.claudePath,
      abortController: ctl,
      env: claudeEnv(),
      stderr: (d: string) => console.error("[claude]", d.trim())
    }
  })

  let wroteText = false
  let answer = ""
  const names = new Map<string, { name: string; input: unknown }>()
  for await (const msg of q) {
    if (msg.type === "system" && "session_id" in msg) st.claudeSession = msg.session_id
    // The researcher subagent's own steps stay inside its "Research" row.
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) continue
    if (msg.type === "stream_event") {
      const ev = msg.event
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        send({ type: "text", delta: ev.delta.text })
        answer += ev.delta.text
        wroteText = true
      }
      if (ev.type === "message_start" && wroteText) {
        send({ type: "text", delta: "\n\n" })
        answer += "\n\n"
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue
        if (isCardTool(block.name)) continue // shown as a card instead
        if (block.name === "TodoWrite") {
          const todos = ((block.input as { todos?: { content: string; status: PlanItem["status"] }[] }).todos ?? []).map((t) => ({ content: t.content, status: t.status }))
          send({ type: "plan", items: todos })
          continue
        }
        names.set(block.id, { name: block.name, input: block.input })
        send({ type: "tool", id: block.id, name: block.name, detail: brief(block.input), input: showInput(block.input) })
      }
    } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block !== "object" || block.type !== "tool_result") continue
        const call = names.get(block.tool_use_id)
        if (!call) continue
        const out = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((c) => ("text" in c ? c.text : "")).join("\n") : ""
        send({
          type: "tool-done",
          id: block.tool_use_id,
          name: call.name,
          ok: !block.is_error,
          detail: out.slice(0, 1500),
          change: isEditTool(call.name) ? changeFor(call.name, call.input, dirs) : undefined
        })
      }
    } else if (msg.type === "result") {
      st.claudeSession = msg.session_id
      // A failed call (e.g. not logged in) also ends in a "result"; only real answers count against the plan.
      if (msg.subtype !== "success") send({ type: "error", text: `Claude stopped: ${msg.subtype}` })
      else if (!msg.is_error) {
        const u = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined
        if (u) send({ type: "usage", input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 })
        send({ type: "notice", text: `${Math.round(msg.duration_ms / 100) / 10}s · counted against your Claude plan` })
      }
    }
  }
  // Keep a text-only copy so switching to another model mid-conversation still has context.
  st.history.push({ role: "user", content: input.text }, { role: "assistant", content: answer })
  return answer
}

// Grok calls MCP tools through a "use_tool" wrapper: { tool_name: "webstorm__replace_text_in_file", <args> }.
function unwrapUseTool(title: string, raw: unknown): { name: string; input: unknown } {
  const o = (raw ?? {}) as Record<string, unknown>
  if (typeof o.tool_name !== "string") return { name: title, input: raw }
  const args = o.arguments ?? o.tool_input ?? o.input ?? o.args ?? o.parameters ?? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "tool_name"))
  return { name: o.tool_name, input: typeof args === "string" ? safeJson(args) : args }
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ACP tool calls: Grok puts the kind in its own metadata on the first notification.
function acpKind(u: { kind?: string | null; _meta?: Record<string, unknown> | null }): string | undefined {
  return u.kind ?? ((u._meta?.["x.ai/tool"] as { kind?: string } | undefined)?.kind ?? undefined)
}
function acpPaths(u: { locations?: { path: string }[] | null; content?: unknown[] | null; rawInput?: unknown }, title: string, dirs: Dirs): string[] {
  const out = new Set<string>()
  for (const l of u.locations ?? []) out.add(l.path)
  for (const c of (u.content ?? []) as { type?: string; path?: string }[]) if (c.type === "diff" && c.path) out.add(c.path)
  const raw = (u.rawInput ?? {}) as Record<string, unknown>
  for (const key of ["file_path", "target_file", "path", "filePath", "pathInProject"]) {
    const v = raw[key]
    if (typeof v === "string" && v) out.add(v.startsWith("/") ? v : filesTouched("write_file", { path: v }, dirs)[0] ?? v)
  }
  for (const f of filesTouched(title.split(/[\s`(]+/)[0] ?? title, u.rawInput, dirs)) out.add(f)
  return [...out]
}

// ACP wants MCP servers as lists with name/value pairs.
function toAcpServers(servers: Record<string, McpServer>): GrokMcp[] {
  return Object.entries(servers).map(([name, cfg]) =>
    "url" in cfg
      ? { name, type: "http" as const, url: cfg.url, headers: Object.entries(cfg.headers ?? {}).map(([k, v]) => ({ name: k, value: v })) }
      : { name, command: cfg.command, args: cfg.args ?? [], env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ name: k, value: v })) }
  )
}

async function runGrokPlan(input: TurnInput, system: string, canWrite: boolean, ide: Ide | null, braveKey: string | undefined, dirs: Dirs, send: (e: ChatEvent) => void, ctl: AbortController, turn: TurnTools): Promise<string> {
  const s = getSettings()
  const { model } = splitId(s.modelId)
  const { skill, st, scope } = turn
  // The IDE's MCP server edits inside the IDE, outside Grok's sandbox, so Grok only gets it when it may write.
  // Tutor's own tools (cards, goals, videos) come from its local MCP server, at this conversation's path.
  const learn = await tutorHttpServer(scope.conv)
  bindHttpScope(scope)
  const servers: Record<string, McpServer> = {
    ...allServers(s.mcpJson, braveKey),
    ...(ide && canWrite ? { [ide.id]: { type: "http", url: ide.url } } : {}),
    tutor: { type: "http", url: learn.url, headers: { Authorization: `Bearer ${learn.token}` } }
  }
  const modeLine = canWrite
    ? "[Writer mode: you may edit files. Never run shell commands.]"
    : skill
      ? "[Tutor mode, Learn lens: teach with the method in your instructions; quiz and ask with the tutor__ tools. Don't edit files or run commands.]"
      : "[Tutor mode: explain; don't edit files or run commands (you're in a read-only sandbox). Propose changes as code blocks with the file path in a comment on the first line; the user can apply them with one click.]"

  let answer = ""
  const calls = new Map<string, { title: string; files: string[]; input: unknown; snapped: boolean; write: boolean; diffs: Map<string, { oldText?: string | null; newText: string }> }>()
  const cards = new Set<string>() // quiz/ask calls: the card is the step
  const hadSession = !!grokSessionId(scope.conv)

  const res = await grokTurn({
    conv: scope.conv,
    binary: s.grokPath,
    model,
    sandbox: canWrite ? "workspace" : "read-only",
    cwd: ide?.project ?? dirs.workspace ?? os.homedir(),
    mcpServers: toAcpServers(servers),
    instructions: system,
    text: `${modeLine}\n\n${input.text || "Explain what's on my screen."}`,
    images: input.images,
    transcript: hadSession ? "" : transcript(st.history),
    signal: ctl.signal,
    handlers: {
      update: (u) => {
        if (process.env.TUTOR_ACP_DEBUG && u.sessionUpdate.startsWith("tool_call")) console.log("[acp]", JSON.stringify(u).slice(0, 700))
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") {
              answer += u.content.text
              send({ type: "text", delta: u.content.text })
            }
            break
          case "tool_call": {
            const inner = unwrapUseTool((u.title ?? u.kind ?? "tool").trim(), u.rawInput)
            const toolName = inner.name
            if (isCardTool(toolName)) {
              cards.add(u.toolCallId)
              break
            }
            const files = [...new Set([...acpPaths({ ...u, rawInput: inner.input }, toolName, dirs), ...filesTouched(toolName, inner.input, dirs)])]
            const write = isRiskyToolCall({ ...u, kind: acpKind(u) }).write || isEditTool(toolName)
            calls.set(u.toolCallId, { title: toolName, files, input: u.rawInput, snapped: write && canWrite && files.length > 0, write, diffs: new Map() })
            // Snapshot now: Grok announces the call before it touches the file.
            if (write && canWrite) beforeWrite(files, toolName)
            send({ type: "tool", id: u.toolCallId, name: toolName, detail: brief(inner.input) || (u.locations?.[0]?.path ?? ""), input: showInput(inner.input) })
            break
          }
          case "tool_call_update": {
            if (cards.has(u.toolCallId)) break
            const call = calls.get(u.toolCallId)
            if (call) {
              const more = acpPaths(u, call.title, dirs)
              const fresh = more.filter((f) => !call.files.includes(f))
              call.files = [...call.files, ...fresh]
              if (fresh.length && canWrite && isRiskyToolCall({ ...u, kind: acpKind(u) }).write && u.status !== "completed") beforeWrite(fresh, call.title)
            }
            // Keep the edit's own old/new text; it can rebuild the "before" if the snapshot was late.
            for (const c of (u.content ?? []) as { type?: string; path?: string; oldText?: string | null; newText?: string }[])
              if (c.type === "diff" && c.path && call && canWrite) call.diffs.set(c.path, { oldText: c.oldText, newText: c.newText ?? "" })
            if (u.status === "completed" || u.status === "failed") {
              let change: { path: string; added: number; removed: number } | undefined
              if (u.status === "completed" && call) for (const [f, d] of call.diffs) reconcileDiff(f, d.oldText, d.newText, call.title)
              if (call?.write && call.files.length) {
                afterWrite(call.files)
                const st = statsFor(call.files[0])
                if (st) change = { path: call.files[0], ...st }
              }
              const out = (u.content ?? []).map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : "")).join("\n")
              send({ type: "tool-done", id: u.toolCallId, name: call?.title ?? "", ok: u.status === "completed", detail: out.slice(0, 1500), change })
            }
            break
          }
          case "plan":
            send({ type: "plan", items: u.entries.map((e) => ({ content: e.content, status: e.status })) })
            break
        }
      },
      // Grok asks before risky tools. Tutor mode says no to edits; nobody gets a shell.
      permission: async (req) => {
        const tc = req.toolCall
        const risk = isRiskyToolCall(tc)
        const allow = risk.exec ? false : risk.write ? canWrite : true
        if (allow && risk.write) {
          const known = calls.get(tc.toolCallId)
          const files = [...new Set([...(known?.files ?? []), ...(tc.locations ?? []).map((l) => l.path)])]
          if (known) known.files = files
          beforeWrite(files, tc.title ?? "edit")
        }
        const want = allow ? "allow_once" : "reject_once"
        const opt = req.options.find((o) => o.kind === want) ?? req.options.find((o) => o.kind.startsWith(allow ? "allow" : "reject"))
        if (!allow) send({ type: "notice", text: risk.exec ? `Blocked a shell command (${tc.title ?? "command"}).` : `Tutor mode: declined an edit (${tc.title ?? "edit"}). Use Writer mode or Apply.` })
        return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } }
      }
    }
  })
  if (res.usage) send({ type: "usage", input: res.usage.input, output: res.usage.output })
  send({ type: "notice", text: `Grok Build · ${model} · your subscription${res.stopReason !== "end_turn" ? ` · stopped: ${res.stopReason}` : ""}` })
  st.history.push({ role: "user", content: input.text }, { role: "assistant", content: answer })
  return answer
}

// Dev only (TUTOR_DEMO=1): a canned answer so the UI can be checked without spending tokens.
async function runDemo(send: (e: ChatEvent) => void, scope: TurnScope): Promise<string> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const s = getSettings()
  if (process.env.TUTOR_DEMO === "lab") return runLabDemo(send, wait, scope)
  if (process.env.TUTOR_DEMO === "practice") return runPracticeDemo(send, scope)
  if (scope.goalId && !scope.nodeId) return runGoalDemo(scope.goalId, send, wait)
  if (scope.nodeId || (s.mode === "tutor" && s.lens === "learn")) return runLearnDemo(send, wait, scope)
  send({ type: "plan", items: [{ content: "Read the order service", status: "completed" }, { content: "Explain the dependency flow", status: "in_progress" }, { content: "Suggest a test seam", status: "pending" }] })
  send({ type: "tool", id: "d1", name: "pycharm__get_file_text_by_path", detail: "app/services/orders.py", input: '{\n  "pathInProject": "app/services/orders.py"\n}' })
  send({ type: "tool-done", id: "d1", name: "pycharm__get_file_text_by_path", ok: true, detail: "class OrderService:\n    def __init__(self, repo): ..." })
  // A real edit of a throwaway temp file, so the Changes pane has something genuine to show.
  const demoFile = path.join(os.tmpdir(), "tutor-demo", "app", "services", "orders.py")
  fs.mkdirSync(path.dirname(demoFile), { recursive: true })
  fs.writeFileSync(demoFile, "class OrderService:\n    def __init__(self):\n        self.db = connect()\n\n    async def place(self, cart):\n        return await self.db.insert(cart)\n")
  setDisplayRoot(path.join(os.tmpdir(), "tutor-demo"))
  send({ type: "tool", id: "d2", name: "pycharm__replace_text_in_file", detail: "app/services/orders.py", input: '{\n  "pathInProject": "app/services/orders.py"\n}' })
  beforeWrite([demoFile], "replace_text_in_file")
  fs.writeFileSync(demoFile, "class OrderService:\n    def __init__(self, repo: OrderRepository) -> None:\n        self.repo = repo\n\n    async def place(self, cart: Cart) -> Order:\n        if not cart.items:\n            raise ValueError(\"empty cart\")\n        return await self.repo.save(Order.from_cart(cart))\n")
  afterWrite([demoFile])
  send({ type: "tool-done", id: "d2", name: "pycharm__replace_text_in_file", ok: true, detail: "ok", change: { path: demoFile, ...(statsFor(demoFile) ?? { added: 0, removed: 0 }) } })
  const demoTest = path.join(os.tmpdir(), "tutor-demo", "tests", "test_orders.py")
  fs.rmSync(demoTest, { force: true })
  send({ type: "tool", id: "d3", name: "pycharm__create_new_file", detail: "tests/test_orders.py" })
  beforeWrite([demoTest], "create_new_file")
  fs.mkdirSync(path.dirname(demoTest), { recursive: true })
  fs.writeFileSync(demoTest, "import pytest\n\nfrom app.services.orders import OrderService\n\n\nclass FakeRepo:\n    def __init__(self):\n        self.saved = []\n\n    async def save(self, order):\n        self.saved.append(order)\n        return order\n\n\nasync def test_empty_cart_is_rejected():\n    with pytest.raises(ValueError):\n        await OrderService(FakeRepo()).place(Cart(items=[]))\n")
  afterWrite([demoTest])
  send({ type: "tool-done", id: "d3", name: "pycharm__create_new_file", ok: true, detail: "ok", change: { path: demoTest, ...(statsFor(demoTest) ?? { added: 0, removed: 0 }) } })
  const answer = `**Short version:** \`OrderService\` doesn't talk to the database itself. It gets a repository handed in, so the business rules can be tested without Postgres.

### Structure
- **\`OrderService\`** holds the rules (totals, stock checks).
- **\`OrderRepository\`** is the only layer that knows SQL.
- The FastAPI route wires them together with \`Depends\`, which is *dependency injection*: like a café that gets its milk delivered instead of keeping a cow.

\`\`\`python
# app/services/orders.py
class OrderService:
    def __init__(self, repo: OrderRepository) -> None:
        self.repo = repo
\`\`\`
<learned>Knows FastAPI routing basics; new to dependency injection</learned>`
  for (let i = 0; i < answer.length; i += 24) {
    send({ type: "text", delta: answer.slice(i, i + 24) })
    await wait(Number(process.env.TUTOR_DEMO_SPEED ?? 12))
  }
  send({ type: "usage", input: 12840, output: 412 })
  send({ type: "plan", items: [{ content: "Read the order service", status: "completed" }, { content: "Explain the dependency flow", status: "completed" }, { content: "Suggest a test seam", status: "completed" }] })
  return answer
}

// Dev only: a Learn turn with one answered quiz, one waiting for you, then a plan with a map and math.
async function runLearnDemo(send: (e: ChatEvent) => void, wait: (ms: number) => Promise<unknown>, scope: TurnScope): Promise<string> {
  let answer = ""
  const say = async (t: string) => {
    for (let i = 0; i < t.length; i += 30) {
      send({ type: "text", delta: t.slice(i, i + 30) })
      await wait(Number(process.env.TUTOR_DEMO_SPEED ?? 8))
    }
    answer += t
  }
  await say("Before explaining anything, let me find where your picture of generators ends.\n\n")
  const first = waitForAnswer(
    scope,
    { id: "demo-q1", kind: "quiz", question: "What does calling `count_up()` return, if its body contains `yield`?", options: [{ label: "A generator object; none of the body has run yet" }, { label: "The first yielded value" }, { label: "`None`, until `next()` is called" }, { label: "A list of every value it will yield" }], multi: false },
    [0],
    "A function whose body contains `yield` is compiled differently: calling it builds a generator object with its own frame and runs **none** of the body. The body starts on the first `next()`."
  )
  await wait(150)
  void answerAsk("demo-q1", { picked: [0] })
  await first
  await say("Solid. That's your floor. Now a harder one, to find the ceiling:\n\n")
  await waitForAnswer(
    scope,
    { id: "demo-q2", kind: "quiz", question: "After `g = count_up()` and one `next(g)`, where is the generator's frame?", details: "```python\ndef count_up():\n    n = 0\n    while True:\n        yield n\n        n += 1\n```", options: [{ label: "Suspended at the `yield`, with `n` kept in its frame" }, { label: "Gone; `n` is recomputed from the start on the next call" }, { label: "Suspended at `n += 1`, which already ran" }], multi: false },
    [0],
    "`next()` runs the body until it hits `yield n`, hands `n` out, and freezes the frame right there: locals, instruction pointer and all. `n += 1` runs on the **next** `next()`."
  )
  await say(`That's the edge: you know *what* a call returns, but not yet *where the frame lives* between calls. Here's the plan.

**Approach.** Start from one thing you can take at face value, a frame is just data, then build pausing out of it.

\`\`\`mermaid
graph TD
  A["A frame is data: locals + where you are"] --> B["Calling a gen function builds a frame, runs nothing"]
  B --> C["next() runs until yield, then keeps the frame"]
  C --> D["Lazy sequences: work happens only when asked"]
\`\`\`

A list of $n$ items costs $O(n)$ memory up front; a generator holds one frame, so

$$
\\text{memory} = O(1) \\quad \\text{however long the sequence runs.}
$$

Does that map look right before we start with the first node?`)
  return answer
}

// Dev only: a goal's first turn, drawing a (hand-written) Kubernetes strategy.
async function runGoalDemo(goalId: string, send: (e: ChatEvent) => void, wait: (ms: number) => Promise<unknown>): Promise<string> {
  const say = async (t: string) => {
    for (let i = 0; i < t.length; i += 30) {
      send({ type: "text", delta: t.slice(i, i + 30) })
      await wait(Number(process.env.TUTOR_DEMO_SPEED ?? 8))
    }
  }
  await say("You already run containers, so the probe went quickly. Mapping the field from the official docs and the CKA outline, then drawing it.\n\n")
  const D = "https://kubernetes.io/docs/concepts/"
  const K8S: StrategyInput = {
    summary: "From \"everything is an object and controllers make it true\" to running, exposing, debugging and shipping your own apps on a cluster.",
    approach: "Everything in Kubernetes follows from two facts: the cluster's state is a set of API objects, and controllers loop until reality matches them. We lock those in first, then derive each workload type as a controller over pods, then networking as objects that route to pods, then state, then operating it. Each stage ends in something you run.",
    stages: [
      { id: "core", title: "The core model", outcome: "Explain what actually happens when you kubectl apply a file." },
      { id: "work", title: "Running workloads", outcome: "Run, scale, roll out and roll back an app." },
      { id: "net", title: "Networking", outcome: "Trace a request from outside the cluster to a container." },
      { id: "state", title: "State and config", outcome: "Run a stateful app with config, secrets and storage." },
      { id: "ops", title: "Operating it", outcome: "Debug a broken deployment and ship with Helm." }
    ],
    nodes: [
      { id: "containers", title: "A container is a process", kind: "truth", stage: "core", summary: "A container is an ordinary Linux process with its own namespaces and resource limits, started from an image.", status: "known" },
      { id: "objects", title: "Everything is an API object", kind: "truth", stage: "core", summary: "All cluster state (pods, services, nodes, config) is objects stored through the API server.", resources: [{ title: "Objects in Kubernetes", url: D + "overview/working-with-objects/" }], status: "known" },
      { id: "loop", title: "Controllers close the loop", kind: "truth", stage: "core", summary: "A controller watches objects and acts until the actual state matches the desired state in their spec.", why: "Something has to turn stored intent into running processes, and keep doing it when things fail.", requires: ["objects"], resources: [{ title: "Controllers", url: D + "architecture/controller/" }], status: "solid" },
      { id: "declarative", title: "Declarative apply", kind: "concept", stage: "core", summary: "You write the desired state; kubectl apply stores it; controllers make it so.", why: "Imperative commands can't be re-run safely; desired state can.", requires: ["objects", "loop"], check: "Predict what happens if you apply the same file twice.", minutes: 20, status: "learning" },
      { id: "scheduler", title: "The scheduler places pods", kind: "concept", stage: "core", summary: "The scheduler assigns each unscheduled pod to a node that has room for it.", requires: ["loop", "containers"], minutes: 20 },
      { id: "pods", title: "Pods", kind: "concept", stage: "work", summary: "A pod is one or more containers that share a network namespace and are scheduled together.", why: "Some processes must share localhost and a lifecycle.", requires: ["containers", "scheduler"], resources: [{ title: "Pods", url: D + "workloads/pods/" }], minutes: 25 },
      { id: "labels", title: "Labels and selectors", kind: "concept", stage: "work", summary: "Labels are key/value tags; selectors are queries over them, and they are how objects find each other.", requires: ["objects"], minutes: 15 },
      { id: "replicasets", title: "ReplicaSets keep N", kind: "concept", stage: "work", summary: "A ReplicaSet is a controller that keeps N pods matching its selector running.", requires: ["pods", "labels", "loop"], minutes: 20 },
      { id: "deployments", title: "Deployments roll out", kind: "concept", stage: "work", summary: "A Deployment manages ReplicaSets to roll a new version out gradually and roll it back.", requires: ["replicasets"], resources: [{ title: "Deployments", url: D + "workloads/controllers/deployment/" }], minutes: 30 },
      { id: "p-rollout", title: "Roll out and roll back", kind: "project", stage: "work", summary: "Deploy a small web app, scale it, ship a broken version and roll it back.", requires: ["deployments", "declarative"], check: "The rollback restores the old version with no downtime.", minutes: 60 },
      { id: "services", title: "Services", kind: "concept", stage: "net", summary: "A Service gives a set of pods (chosen by labels) one stable virtual IP and name.", why: "Pods come and go with new IPs; clients need something that stays.", requires: ["labels", "pods"], resources: [{ title: "Service", url: D + "services-networking/service/" }], minutes: 30 },
      { id: "dns", title: "Cluster DNS", kind: "concept", stage: "net", summary: "Every Service gets a DNS name inside the cluster.", requires: ["services"], minutes: 15 },
      { id: "proxy", title: "kube-proxy and virtual IPs", kind: "concept", stage: "net", summary: "kube-proxy programs each node so traffic to a Service IP reaches one of its pods.", requires: ["services"], minutes: 25 },
      { id: "ingress", title: "Ingress", kind: "concept", stage: "net", summary: "An Ingress routes outside HTTP traffic to Services by host and path, through an ingress controller.", requires: ["services"], resources: [{ title: "Ingress", url: D + "services-networking/ingress/" }], minutes: 25 },
      { id: "p-expose", title: "Expose an app", kind: "project", stage: "net", summary: "Put two services behind one Ingress and trace a request hop by hop.", requires: ["ingress", "dns", "proxy", "deployments"], minutes: 75 },
      { id: "config", title: "ConfigMaps and Secrets", kind: "concept", stage: "state", summary: "ConfigMaps and Secrets are objects whose data is injected into pods as env vars or files.", requires: ["pods"], minutes: 20 },
      { id: "volumes", title: "Volumes and claims", kind: "concept", stage: "state", summary: "A PersistentVolumeClaim asks for storage; the cluster binds it to a volume that outlives any pod.", requires: ["pods"], resources: [{ title: "Persistent Volumes", url: D + "storage/persistent-volumes/" }], minutes: 30 },
      { id: "statefulsets", title: "StatefulSets", kind: "concept", stage: "state", summary: "A StatefulSet gives each pod a stable name and its own volume, created in order.", requires: ["volumes", "services", "replicasets"], resources: [{ title: "StatefulSets", url: D + "workloads/controllers/statefulset/" }], minutes: 30 },
      { id: "p-db", title: "Run Postgres on it", kind: "project", stage: "state", summary: "Run Postgres with a StatefulSet, a Secret for the password and a volume that survives restarts.", requires: ["statefulsets", "config"], minutes: 90 },
      { id: "debug", title: "Debug: describe, logs, events", kind: "skill", stage: "ops", summary: "Find why something isn't running from its events, status and logs.", requires: ["deployments", "services"], minutes: 40 },
      { id: "probes", title: "Probes and resource limits", kind: "concept", stage: "ops", summary: "Probes tell Kubernetes when a container is ready or stuck; requests and limits bound what it may use.", requires: ["pods", "scheduler"], minutes: 30 },
      { id: "rbac", title: "RBAC", kind: "concept", stage: "ops", summary: "Roles grant verbs on resources; bindings give roles to users and service accounts.", requires: ["objects"], minutes: 25 },
      { id: "helm", title: "Package with Helm", kind: "skill", stage: "ops", summary: "Helm templates a set of manifests into one versioned release you can install and upgrade.", requires: ["deployments", "config"], minutes: 40 },
      { id: "p-ship", title: "Ship your app with Helm", kind: "project", stage: "ops", summary: "Package your own app as a chart with probes and limits, break it, and debug it back.", requires: ["helm", "debug", "probes"], minutes: 120 }
    ]
  }
  const r = saveStrategy(goalId, K8S)
  if (!r.ok) throw new Error(r.error)
  const text = "It starts from two things you can take as given (everything is an API object; controllers loop until reality matches it), and every workload type after that is \"a controller over pods\". You already have containers and objects, so you start at **Declarative apply**. Each stage ends in something you run. Change anything, or press Start."
  await say(text)
  return text
}

// Dev only (TUTOR_DEMO=lab): a predict card, then a stepper through the same idea.
async function runLabDemo(send: (e: ChatEvent) => void, wait: (ms: number) => Promise<unknown>, scope: TurnScope): Promise<string> {
  const say = async (t: string) => {
    for (let i = 0; i < t.length; i += 40) {
      send({ type: "text", delta: t.slice(i, i + 40) })
      await wait(6)
    }
  }
  const code = "xs = [1, 2]\nys = xs\nys.append(3)\nprint(xs)\n"
  await say("Before any explanation, commit to a prediction:\n\n")
  await waitForAnswer(scope, { id: "demo-p1", kind: "predict", question: "What will this print?", options: [], multi: false, code, language: "python" })
  await say("Now watch it run. Keep an eye on the `#` numbers next to `xs` and `ys`:\n\n")
  const { traceCode } = await import("./lab")
  const t = await traceCode("def make_counter():\n    count = 0\n    def bump():\n        nonlocal count\n        count += 1\n        return count\n    return bump\n\nc = make_counter()\nc()\nc()\nxs = [1, 2]\nys = xs\nys.append(3)\nprint(xs, c())\n")
  send({ type: "trace", trace: { ...t, id: "demo-t1", code: "def make_counter():\n    count = 0\n    def bump():\n        nonlocal count\n        count += 1\n        return count\n    return bump\n\nc = make_counter()\nc()\nc()\nxs = [1, 2]\nys = xs\nys.append(3)\nprint(xs, c())\n", title: "watch count survive between calls, and xs and ys share #" } } as ChatEvent)
  const text = "`ys = xs` doesn't copy anything: both names carry the same `#` number because they point at the same list, so appending through one shows up through the other."
  await say(text)
  return text
}

// TUTOR_DEMO=practice: a real project scaffold and a real exercise card, through the real tools.
async function runPracticeDemo(send: (e: ChatEvent) => void, scope: TurnScope): Promise<string> {
  const say = (t: string) => send({ type: "text", delta: t })
  say("Your project lives in a real folder; open it in PyCharm and make milestone 1 pass:\n\n")
  const p = await runTutorTool(
    "start_project",
    {
      title: "Word stats CLI",
      language: "python",
      files: [
        { path: "pyproject.toml", content: '[project]\nname = "wordstats"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n\n[dependency-groups]\ndev = ["pytest"]\n' },
        { path: "src/wordstats/__init__.py", content: "" },
        { path: "src/wordstats/core.py", content: 'def word_counts(text: str) -> dict[str, int]:\n    """Count words, case-insensitively, ignoring punctuation."""\n    raise NotImplementedError\n' }
      ],
      milestones: [
        { title: "Count words", spec: "`word_counts(text)` returns how often each word appears, lowercased, punctuation stripped.", tests: [{ path: "tests/test_counts.py", content: "from wordstats.core import word_counts\n\ndef test_counts_words():\n    assert word_counts('a b a') == {'a': 2, 'b': 1}\n\ndef test_ignores_case_and_punctuation():\n    assert word_counts('Hi, hi!') == {'hi': 2}\n" }] },
        { title: "Top words", spec: "`top_words(text, n)` returns the n most common words.", tests: [{ path: "tests/test_top.py", content: "from wordstats.core import top_words\n\ndef test_top():\n    assert top_words('a a b', 1) == ['a']\n" }] }
      ]
    },
    scope
  )
  say(`\n\n_${p.text.split(".")[0]}._\n\nMeanwhile, a quick rep on the idea behind it:\n\n`)
  const r = await runTutorTool(
    "exercise",
    {
      title: "Group words by first letter",
      kind: "write",
      task: "Write `group_by(items, key)` that returns a dict mapping each `key(item)` to the list of items with that key, **in their original order**.\n\n```python\ngroup_by([\"apple\", \"avocado\", \"banana\"], lambda w: w[0])\n# {'a': ['apple', 'avocado'], 'b': ['banana']}\n```",
      language: "python",
      starter: "def group_by(items, key):\n    # your code here\n    pass\n",
      tests: "from solution import group_by\n\ndef test_groups_by_first_letter():\n    assert group_by(['apple', 'avocado', 'banana'], lambda w: w[0]) == {'a': ['apple', 'avocado'], 'b': ['banana']}\n\ndef test_empty_input():\n    assert group_by([], len) == {}\n\ndef test_keeps_original_order():\n    assert group_by([3, 1, 2], lambda x: x % 2) == {1: [3, 1], 0: [2]}\n",
      hints: ["Start with an empty dict and loop over the items once.", "`dict.setdefault(k, [])` gives you the list for a key, creating it the first time.", "`out.setdefault(key(x), []).append(x)` inside the loop, then return out."],
      solution: "def group_by(items, key):\n    out = {}\n    for x in items:\n        out.setdefault(key(x), []).append(x)\n    return out\n"
    },
    scope
  )
  say(`\n\n${r.text.split("\n")[0]}`)
  return r.text
}
