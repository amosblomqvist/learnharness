// Settings live in the app's userData folder. API keys are encrypted with the
// macOS Keychain (Electron safeStorage) and never leave this machine except as
// the auth header of the provider they belong to.
import { app, safeStorage } from "electron"
import fs from "node:fs"
import path from "node:path"

export type KeyName = "anthropic" | "xai" | "openai" | "brave"
export const KEY_NAMES: KeyName[] = ["anthropic", "xai", "openai", "brave"]

// How Tutor mode teaches. "learn" runs your teaching skill (learn.ts); the others are built in.
export type Lens = "learn" | "explain" | "paper" | "infra" | "socratic" | "review"

export type Settings = {
  modelId: string // "<provider>:<model>", e.g. "claude-plan:claude-sonnet-5-5"
  mode: "tutor" | "writer"
  lens: Lens
  workspace: string | null // project folder the tools may read (and, in writer mode, write)
  aboutMe: string // what the learner already knows; goes into every system prompt
  ollamaUrl: string
  claudePath: string // Claude Code CLI used for "Claude (my plan)"
  grokPath: string // Grok Build CLI used for "Grok (my subscription)"
  mcpJson: string // {"mcpServers": {...}} in the usual Claude/Cursor format
  ide: string // "auto" (frontmost JetBrains IDE with a project open), "off", or an IDE id like "pycharm"
  hideFromScreenShare: boolean
  projectsDir: string // where project checkpoints are created; "" = ~/TutorProjects
  notesDir: string // where recaps are saved as Markdown; "" = ~/TutorNotes
  learnPath: string // folder with the teaching skill (a clone of github.com/amosblomqvist/learn); "" = inside Tutor's data folder
  learnIntroduced: boolean // the Learn lens became the default once, when it was added
  pinned: boolean // keep the window above other apps (overlay style)
  bounds: { x: number; y: number; width: number; height: number } | null
}

const DEFAULTS: Settings = {
  modelId: "claude-plan:claude-sonnet-5-5",
  mode: "tutor",
  lens: "learn",
  workspace: null,
  aboutMe:
    "I write Python and TypeScript. I don't need syntax drills; I want to understand structure, data flow, trade-offs and why things are built the way they are.",
  ollamaUrl: "http://localhost:11434",
  claudePath: path.join(app.getPath("home"), ".local/bin/claude"),
  grokPath: path.join(app.getPath("home"), ".local/bin/grok"),
  mcpJson: '{\n  "mcpServers": {}\n}',
  ide: "auto",
  hideFromScreenShare: false,
  projectsDir: "",
  notesDir: "",
  learnPath: "",
  learnIntroduced: true,
  pinned: false,
  bounds: null
}

const dir = () => app.getPath("userData")
const settingsFile = () => path.join(dir(), "settings.json")
const keysFile = () => path.join(dir(), "keys.bin")
const profileFile = () => path.join(dir(), "learner-profile.md")

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
    cache = { ...DEFAULTS, ...saved }
    // Settings from before the Learn lens existed: switch to it once; picking another lens later sticks.
    if (!saved.learnIntroduced) saveSettings({ lens: "learn", learnIntroduced: true })
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(cache, null, 2))
  return cache
}

function readKeys(): Partial<Record<KeyName, string>> {
  try {
    const buf = fs.readFileSync(keysFile())
    return JSON.parse(safeStorage.decryptString(buf))
  } catch {
    return {}
  }
}

export function getKey(name: KeyName): string | undefined {
  return readKeys()[name] || undefined
}

export function setKey(name: KeyName, value: string): void {
  const keys = readKeys()
  if (value) keys[name] = value.trim()
  else delete keys[name]
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(keysFile(), safeStorage.encryptString(JSON.stringify(keys)))
}

// The renderer only learns whether a key is set, never the key itself.
export function keyStatus(): Record<KeyName, boolean> {
  const k = readKeys()
  return Object.fromEntries(KEY_NAMES.map((n) => [n, !!k[n]])) as Record<KeyName, boolean>
}

// ---------- learner profile ----------
// Short notes the tutor keeps about what you already understand and what trips you up.
// The model adds to it with <learned>…</learned> lines; you can edit it in Settings.

const PROFILE_MAX_LINES = 80

export function getProfile(): string {
  try {
    return fs.readFileSync(profileFile(), "utf8")
  } catch {
    return ""
  }
}

export function setProfile(text: string): void {
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(profileFile(), text.trim() ? text.trim() + "\n" : "")
}

export function addToProfile(notes: string[]): string[] {
  const lines = getProfile().split("\n").map((l) => l.trim()).filter(Boolean)
  const key = (l: string) => l.replace(/^- /, "").replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "").toLowerCase()
  const seen = new Set(lines.map(key))
  const added: string[] = []
  const date = new Date().toISOString().slice(0, 10)
  for (const raw of notes) {
    const note = raw.replace(/\s+/g, " ").trim().slice(0, 200)
    if (!note || seen.has(note.toLowerCase())) continue
    seen.add(note.toLowerCase())
    lines.push(`- ${note} (${date})`)
    added.push(note)
  }
  if (added.length) setProfile(lines.slice(-PROFILE_MAX_LINES).join("\n"))
  return added
}
