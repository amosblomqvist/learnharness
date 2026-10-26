// Past conversations, one JSON file each in userData/conversations/.
// The window's messages (what you see) are saved next to the model's history (what it remembers),
// so reopening a conversation continues it rather than just showing it.
import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import type { ChatState } from "./chat"

export type UiMessage = {
  role: "user" | "assistant"
  text: string
  previews?: string[]
  tools: { name: string; detail: string; ok?: boolean; result?: string }[]
  notices: string[]
  error?: string
  by?: string
  learned?: string[]
  note?: { goalId: string; nodeId: string; title: string; file: string }
}

// A conversation can belong to a goal: its planning chat, or a lesson on one node of its map.
export type ConvLink = { goalId?: string; nodeId?: string; review?: boolean }

export type Conversation = ChatState & ConvLink & {
  id: string
  title: string
  mode: "tutor" | "writer"
  createdAt: number
  updatedAt: number
  messages: UiMessage[]
}

export type ConversationSummary = ConvLink & { id: string; title: string; mode: "tutor" | "writer"; updatedAt: number; count: number }

const dir = () => path.join(app.getPath("userData"), "conversations")
const file = (id: string) => path.join(dir(), `${id.replace(/[^\w-]/g, "")}.json`)

function titleFrom(messages: UiMessage[]): string {
  const first = messages.find((m) => m.role === "user")
  const text = first?.text.replace(/\s+/g, " ").trim()
  if (text) return text.length > 70 ? text.slice(0, 67) + "…" : text
  return first?.previews?.length ? "Screenshot question" : "New conversation"
}

export function saveConversation(id: string, mode: "tutor" | "writer", messages: UiMessage[], state: ChatState, link: ConvLink = {}): ConversationSummary {
  fs.mkdirSync(dir(), { recursive: true })
  const prev = loadConversation(id)
  const now = Date.now()
  // Screenshot thumbnails stay in the file (they're small), capped so a long session can't balloon.
  let thumbs = 0
  const lean = messages.map((m) => {
    if (!m.previews?.length) return m
    const keep = m.previews.filter(() => thumbs++ < 12)
    return { ...m, previews: keep }
  })
  const goalId = link.goalId ?? prev?.goalId
  const nodeId = link.nodeId ?? prev?.nodeId
  const review = link.review ?? prev?.review
  const conv: Conversation = { id, title: review ? `Review · ${new Date(prev?.createdAt ?? now).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : titleFrom(messages), mode, createdAt: prev?.createdAt ?? now, updatedAt: now, messages: lean, ...state, goalId, nodeId, review }
  fs.writeFileSync(file(id), JSON.stringify(conv))
  return { id, title: conv.title, mode, updatedAt: now, count: messages.length, goalId, nodeId, review }
}

export function loadConversation(id: string): Conversation | null {
  try {
    return JSON.parse(fs.readFileSync(file(id), "utf8"))
  } catch {
    return null
  }
}

export function listConversations(): ConversationSummary[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: ConversationSummary[] = []
  for (const n of names) {
    try {
      const c: Conversation = JSON.parse(fs.readFileSync(path.join(dir(), n), "utf8"))
      out.push({ id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt, count: c.messages.length, goalId: c.goalId, nodeId: c.nodeId, review: c.review })
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteConversation(id: string): void {
  fs.rmSync(file(id), { force: true })
}
