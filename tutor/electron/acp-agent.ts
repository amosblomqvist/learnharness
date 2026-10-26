// Tutor inside PyCharm / WebStorm's AI chat. The IDE starts a small bridge (acp-bridge.ts) as a
// custom ACP agent (~/.jetbrains/acp.json); the bridge connects to this socket, and each IDE chat
// session becomes a Tutor conversation: same engines, teaching skill, goals, profile and tools.
// Modes in the IDE's picker: Learn, Explain, Writer. Cards can't be drawn there, so questions go
// out as text and the answer is the user's next message. Every IDE chat also lands in Tutor's history.
import { app } from "electron"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import type * as schema from "@agentclientprotocol/sdk"
import { runTurn, stopTurn, snapshot, type ConvEvent } from "./chat"
import { saveConversation, type UiMessage } from "./conversations"
import { describeTool } from "../src/describe"

type ModeId = "learn" | "explain" | "writer"
const MODES: schema.SessionMode[] = [
  { id: "learn", name: "Learn", description: "Teaches with your method: finds what you know, plans, checks each idea lands" },
  { id: "explain", name: "Explain", description: "Structure, data flow and trade-offs of the code in front of you" },
  { id: "writer", name: "Writer", description: "Writes the code into your project" }
]

type Session = { id: string; conv: string; cwd: string; mode: ModeId; messages: UiMessage[]; turn: AbortController | null }

// A Unix socket path must stay under ~104 bytes; a deep data folder falls back to a short,
// stable one in the per-user temp folder.
export function acpSocketPath(): string {
  const p = path.join(app.getPath("userData"), "acp.sock")
  if (Buffer.byteLength(p) < 100) return p
  return path.join(os.tmpdir(), `tutor-${crypto.createHash("sha1").update(app.getPath("userData")).digest("hex").slice(0, 10)}.sock`)
}

let server: net.Server | null = null

export function startAcpServer(onSaved: () => void): void {
  if (server) return
  const sock = acpSocketPath()
  try {
    fs.rmSync(sock, { force: true })
  } catch {}
  server = net.createServer((socket) => {
    const sessions = new Map<string, Session>()
    const stream = acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>)
    const conn: acp.AgentSideConnection = new acp.AgentSideConnection(
      (client) => ({
        initialize: async () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true, audio: false } },
          authMethods: []
        }),
        authenticate: async () => ({}),
        newSession: async (p: schema.NewSessionRequest) => {
          const id = crypto.randomUUID()
          sessions.set(id, { id, conv: `ide-${id}`, cwd: p.cwd, mode: "learn", messages: [], turn: null })
          return { sessionId: id, modes: { currentModeId: "learn", availableModes: MODES } }
        },
        setSessionMode: async (p: schema.SetSessionModeRequest) => {
          const s = sessions.get(p.sessionId)
          if (s && MODES.some((m) => m.id === p.modeId)) s.mode = p.modeId as ModeId
          return {}
        },
        cancel: async (p: schema.CancelNotification) => {
          const s = sessions.get(p.sessionId)
          if (s) stopTurn(s.conv)
        },
        prompt: async (p: schema.PromptRequest): Promise<schema.PromptResponse> => {
          const s = sessions.get(p.sessionId)
          if (!s) throw acp.RequestError.invalidParams({ sessionId: p.sessionId })
          const { text, images, shown } = fromBlocks(p.prompt, s.cwd)
          const update = (u: schema.SessionUpdate) => void client.sessionUpdate({ sessionId: s.id, update: u }).catch(() => {})
          const reply: UiMessage = { role: "assistant", text: "", tools: [], notices: [], by: `IDE · ${s.mode}` }
          s.messages.push({ role: "user", text: shown, tools: [], notices: [] }, reply)
          let aborted = false
          await runTurn(
            { text, images, conversationId: s.conv, mode: s.mode === "writer" ? "writer" : "tutor", lens: s.mode === "writer" ? undefined : s.mode, workspace: s.cwd, textCards: true },
            (e: ConvEvent) => {
              switch (e.type) {
                case "text":
                  reply.text += e.delta
                  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } })
                  break
                case "tool": {
                  const { verb, server: via } = describeTool(e.name)
                  reply.tools.push({ name: e.name, detail: e.detail })
                  update({ sessionUpdate: "tool_call", toolCallId: e.id ?? crypto.randomUUID(), title: `${verb}${e.detail ? ` ${e.detail}` : ""}${via ? ` · ${via}` : ""}`, kind: kindOf(verb), status: "in_progress", rawInput: safe(e.input) })
                  break
                }
                case "tool-done":
                  if (e.id) update({ sessionUpdate: "tool_call_update", toolCallId: e.id, status: e.ok ? "completed" : "failed", content: e.detail ? [{ type: "content", content: { type: "text", text: e.detail.slice(0, 1500) } }] : undefined })
                  break
                case "plan":
                  update({ sessionUpdate: "plan", entries: e.items.map((i) => ({ content: i.content, status: i.status, priority: "medium" })) })
                  break
                case "error":
                  reply.error = e.text
                  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n⚠ ${e.text}` } })
                  break
                case "notice":
                  if (e.text === "Stopped.") aborted = true
                  reply.notices.push(e.text)
                  break
                case "learned":
                  reply.learned = [...(reply.learned ?? []), ...e.notes]
                  break
              }
            }
          )
          // Keep the IDE chat in Tutor's history too (source: the IDE), so it shows up in Chats.
          try {
            saveConversation(s.conv, s.mode === "writer" ? "writer" : "tutor", s.messages, snapshot(s.conv))
            onSaved()
          } catch {}
          return { stopReason: aborted ? "cancelled" : "end_turn" }
        }
      }),
      stream
    )
    socket.on("close", () => {
      for (const s of sessions.values()) stopTurn(s.conv)
      void conn
    })
    socket.on("error", () => {})
  })
  server.on("error", (err) => console.error("[acp]", err))
  server.listen(sock, () => fs.chmodSync(sock, 0o600))
}

export function stopAcpServer(): void {
  server?.close()
  server = null
  try {
    fs.rmSync(acpSocketPath(), { force: true })
  } catch {}
}

// The IDE sends text plus context: files it links to, and selections/files it embeds.
function fromBlocks(blocks: schema.ContentBlock[], cwd: string): { text: string; images: string[]; shown: string } {
  const parts: string[] = []
  const shown: string[] = []
  const images: string[] = []
  const rel = (uri: string) => {
    const p = decodeURIComponent(uri.replace(/^file:\/\//, ""))
    return p.startsWith(cwd) ? path.relative(cwd, p) : p.replace(os.homedir(), "~")
  }
  for (const b of blocks) {
    if (b.type === "text") {
      parts.push(b.text)
      shown.push(b.text)
    } else if (b.type === "image") images.push(b.data)
    else if (b.type === "resource_link") {
      parts.push(`(Attached file: ${decodeURIComponent(b.uri.replace(/^file:\/\//, ""))})`)
      shown.push(`📎 ${rel(b.uri)}`)
    } else if (b.type === "resource") {
      const r = b.resource as { uri: string; text?: string; mimeType?: string }
      if (r.text !== undefined) {
        const lang = path.extname(r.uri).slice(1)
        parts.push(`From ${decodeURIComponent(r.uri.replace(/^file:\/\//, ""))}:\n\`\`\`${lang}\n${r.text.slice(0, 40_000)}\n\`\`\``)
        shown.push(`📎 ${rel(r.uri)}`)
      }
    }
  }
  return { text: parts.join("\n\n"), images, shown: shown.join("\n") }
}

function kindOf(verb: string): schema.ToolKind {
  if (/^(Read|List|Open editors|Symbol info|Check problems|Find symbol)/.test(verb)) return "read"
  if (/^(Edit|Write|Patch|Create|Reformat|Rename)/.test(verb)) return "edit"
  if (/search|Find files/i.test(verb)) return "search"
  if (/^(Fetch|Web)/.test(verb)) return "fetch"
  if (/^(Research|Check diagram)/.test(verb)) return "think"
  if (/^Run/.test(verb)) return "execute"
  return "other"
}

const safe = (s?: string) => {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return { input: s }
  }
}
