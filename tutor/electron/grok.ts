// "Grok · my subscription": drives xAI's Grok Build CLI (`grok agent stdio`) over ACP, the
// Agent Client Protocol. It signs in with your SuperGrok / X Premium+ account (`grok login`),
// so there's no API key and no per-token bill. ACP gives us streamed text, tool calls with
// their diffs, the agent's plan, and a permission request before each risky tool, which is
// where Tutor mode says no to edits and Tutor snapshots files for the Changes pane.
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { promisify } from "node:util"
import * as acp from "@agentclientprotocol/sdk"
import type * as schema from "@agentclientprotocol/sdk"
import { isWriteTool } from "./mcp"

const run = promisify(execFile)

export type GrokHandlers = {
  update: (u: schema.SessionUpdate) => void
  permission: (req: schema.RequestPermissionRequest) => Promise<schema.RequestPermissionResponse>
}

// Grok Build's OS-level sandbox (macOS Seatbelt), applied to the whole agent process:
//   read-only: can read, can't write anything (Tutor mode)
//   workspace: can only write inside the project folder, /tmp and ~/.grok (Writer mode)
export type Sandbox = "read-only" | "workspace"

// One agent process per (binary, model, sandbox), so a Writer turn in one conversation doesn't
// restart the agent under a Tutor turn that's waiting on a quiz in another. Each conversation has
// its own ACP session; updates and permission requests are routed back by session id.
type Agent = { key: string; proc: ChildProcess; conn: acp.ClientSideConnection; caps: schema.AgentCapabilities | null; stderrTail: string; busy: number; used: number }
const agents = new Map<string, Agent>()
const handlers = new Map<string, GrokHandlers>() // by ACP session id
const sessions = new Map<string, { agent: string; id: string; key: string; instructions: string }>() // by conversation
const MAX_AGENTS = 3

export function grokSessionId(conv: string): string | null {
  return sessions.get(conv)?.id ?? null
}
export function resetGrokSession(conv?: string): void {
  if (conv) sessions.delete(conv)
  else sessions.clear()
}

// Never let an API key in the environment switch this to API billing.
function cleanEnv(sandbox?: Sandbox): Record<string, string> {
  const env: Record<string, string> = sandbox ? { GROK_SANDBOX: sandbox } : {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "XAI_API_KEY" && k !== "GROK_API_KEY" && !(sandbox && k === "GROK_SANDBOX")) env[k] = v
  return env
}

function forget(a: Agent): void {
  agents.delete(a.key)
  for (const [conv, sess] of sessions) if (sess.agent === a.key) sessions.delete(conv)
}

export async function stopGrok(): Promise<void> {
  for (const a of [...agents.values()]) {
    forget(a)
    if (!a.proc.killed) a.proc.kill()
  }
}

async function ensureAgent(binary: string, model: string, sandbox: Sandbox, cwd: string): Promise<Agent> {
  const key = `${binary}|${model}|${sandbox}`
  const have = agents.get(key)
  if (have && !have.proc.killed) return have
  // Too many agents: close the least recently used one that isn't in a turn.
  if (agents.size >= MAX_AGENTS) {
    const idle = [...agents.values()].filter((a) => !a.busy).sort((x, y) => x.used - y.used)[0]
    if (idle) {
      forget(idle)
      idle.proc.kill()
    }
  }
  const child = spawn(binary, ["agent", "--no-leader", "-m", model, "stdio"], { cwd, env: cleanEnv(sandbox), stdio: ["pipe", "pipe", "pipe"] })
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>)
  const client: acp.Client = {
    requestPermission: async (req) => {
      if (process.env.TUTOR_ACP_DEBUG) console.log("[acp] permission", JSON.stringify({ title: req.toolCall.title, kind: req.toolCall.kind, options: req.options }).slice(0, 600))
      const h = handlers.get(req.sessionId)
      return h ? h.permission(req) : { outcome: { outcome: "cancelled" } }
    },
    sessionUpdate: async (n) => handlers.get(n.sessionId)?.update(n.update)
  }
  const agent: Agent = { key, proc: child, conn: new acp.ClientSideConnection(() => client, stream), caps: null, stderrTail: "", busy: 0, used: Date.now() }
  child.stderr?.on("data", (d: Buffer) => {
    agent.stderrTail = (agent.stderrTail + d.toString()).slice(-4000)
  })
  child.on("exit", () => agents.get(key) === agent && forget(agent))
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve())
    child.once("error", (e) => reject(new Error(`Couldn't start Grok Build at ${binary}: ${e.message}`)))
  })
  const init = await agent.conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "tutor", version: "0.2.1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  } as schema.InitializeRequest)
  agent.caps = init.agentCapabilities ?? null
  agents.set(key, agent)
  return agent
}

export type GrokMcp = { name: string; type: "http"; url: string; headers: { name: string; value: string }[] } | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }

export async function grokTurn(opts: {
  conv: string // the conversation: its own ACP session
  binary: string
  model: string
  sandbox: Sandbox
  cwd: string
  mcpServers: GrokMcp[]
  instructions: string // Tutor's system prompt; sent with the first message of a session (and again when it changes)
  text: string
  images: string[]
  transcript: string // earlier conversation, for a fresh session in an existing chat
  handlers: GrokHandlers
  signal: AbortSignal
}): Promise<{ stopReason: string; usage?: { input: number; output: number } }> {
  let agent: Agent
  try {
    agent = await ensureAgent(opts.binary, opts.model, opts.sandbox, opts.cwd)
  } catch (err) {
    throw new Error(explain(err))
  }
  const c = agent.conn

  // MCP servers can only be set when a session starts, so a change of IDE or tools means a new session.
  const key = JSON.stringify({ cwd: opts.cwd, mcp: opts.mcpServers })
  let session = sessions.get(opts.conv)
  let fresh = false
  if (!session || session.key !== key || session.agent !== agent.key) {
    try {
      const res = await c.newSession({ cwd: opts.cwd, mcpServers: opts.mcpServers as schema.McpServer[] })
      session = { agent: agent.key, id: res.sessionId, key, instructions: "" }
      sessions.set(opts.conv, session)
      fresh = true
    } catch (err) {
      throw new Error(explain(err, agent))
    }
  }

  const parts: string[] = []
  if (session.instructions !== opts.instructions) {
    parts.push(`<tutor-instructions>\n${opts.instructions}\n</tutor-instructions>`)
    session.instructions = opts.instructions
  }
  if (fresh && opts.transcript) parts.push(`Conversation so far (possibly with another model):\n${opts.transcript}`)
  parts.push(opts.text)

  const imagesOk = agent.caps?.promptCapabilities?.image !== false
  const prompt: schema.ContentBlock[] = [
    ...(imagesOk ? opts.images.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" })) : []),
    { type: "text", text: parts.join("\n\n") }
  ]

  const sessionId = session.id
  const onAbort = () => void c.cancel({ sessionId }).catch(() => {})
  opts.signal.addEventListener("abort", onAbort, { once: true })
  handlers.set(sessionId, opts.handlers)
  agent.busy++
  agent.used = Date.now()
  try {
    const res = await c.prompt({ sessionId, prompt })
    const u = (res as { usage?: schema.Usage }).usage
    return { stopReason: res.stopReason, usage: u ? { input: u.inputTokens, output: u.outputTokens } : undefined }
  } catch (err) {
    throw new Error(explain(err, agent))
  } finally {
    agent.busy--
    opts.signal.removeEventListener("abort", onAbort)
    handlers.delete(sessionId)
  }
}

function explain(err: unknown, agent?: Agent): string {
  const msg = (err as { message?: string })?.message ?? String(err)
  const stderrTail = agent?.stderrTail ?? ""
  const all = `${msg}\n${stderrTail}`
  if (/auth|login|unauthori[sz]ed|not authenticated|401|403/i.test(all))
    return "Grok Build isn't signed in. Open Terminal, run `grok login`, sign in with your SuperGrok / X Premium+ account, then ask again."
  if (/ENOENT/.test(all)) return "Grok Build isn't installed where Settings says. Install it from x.ai/cli or fix the path in Settings → Local & Claude."
  return msg + (stderrTail.trim() ? `\n${stderrTail.trim().split("\n").slice(-3).join("\n")}` : "")
}

// Models your subscription offers, from `grok models`.
let modelCache: { at: number; list: string[]; def: string | null } | null = null
export async function grokModels(binary: string): Promise<{ list: string[]; def: string | null }> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache
  try {
    const { stdout } = await run(binary, ["models"], { timeout: 8000, env: cleanEnv() })
    const list = [...stdout.matchAll(/^\s*[-*]\s+([\w.\-]+)/gm)].map((m) => m[1])
    const def = /^\s*\*\s+([\w.\-]+)/m.exec(stdout)?.[1] ?? null
    modelCache = { at: Date.now(), list, def }
    return modelCache
  } catch {
    return { list: [], def: null }
  }
}

// Which tool calls change things, judged from what ACP tells us.
export function isRiskyToolCall(tc: { kind?: string | null; title?: string | null; rawInput?: unknown; _meta?: Record<string, unknown> | null }): { write: boolean; exec: boolean } {
  const kind = tc.kind ?? (tc._meta?.["x.ai/tool"] as { kind?: string } | undefined)?.kind ?? "other"
  const title = tc.title ?? ""
  const exec = kind === "execute"
  const write = kind === "edit" || kind === "delete" || kind === "move" || (kind === "other" && isWriteTool(title.split(/[\s/:(]+/).find((w) => w.includes("_")) ?? title))
  return { write, exec }
}
