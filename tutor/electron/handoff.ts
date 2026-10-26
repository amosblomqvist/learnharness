// "Ask Tutor" from PyCharm / WebStorm: an External Tool in the IDE (right-click → Tutor → Ask Tutor,
// ⌘⇧A "Ask Tutor", or a shortcut you give it in Keymap) launches Tutor with the file and the
// selected lines; the running Tutor gets them (second-instance) and puts the code in the composer.
import { app } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type IdeContext = { file: string; rel: string; start: number; end: number; code: string; lang: string; selected: boolean }

const LANG: Record<string, string> = { py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", json: "json", yml: "yaml", yaml: "yaml", md: "markdown", sh: "bash", rs: "rust", go: "go", sql: "sql", css: "css", html: "html", toml: "toml", dockerfile: "dockerfile" }
const langOf = (f: string) => LANG[path.extname(f).slice(1).toLowerCase()] ?? (/dockerfile/i.test(path.basename(f)) ? "dockerfile" : "")

// argv has --tutor-ask-file=<file> --tutor-ask-lines=<selStart>,<selEnd>,<caret> --tutor-ask-project=<dir>.
// Named switches, because Chromium moves switches to the front and adds its own between arguments.
export async function ideHandoff(argv: string[]): Promise<IdeContext | null> {
  const opt = (name: string) => argv.find((a) => a.startsWith(`--tutor-ask-${name}=`))?.slice(`--tutor-ask-${name}=`.length)
  const file = opt("file")
  if (!file) return null
  const [s, e, caret] = (opt("lines") ?? "").split(",")
  const project = opt("project")
  if (!file || !fs.existsSync(file) || fs.statSync(file).size > 2_000_000) return null
  const lines = fs.readFileSync(file, "utf8").split("\n")
  let start = parseInt(s) || 0
  let end = parseInt(e) || 0
  const selected = start > 0 && end > start
  if (!selected) {
    // Nothing selected: the lines around the caret.
    const at = parseInt(caret) || start || 1
    start = Math.max(1, at - 12)
    end = Math.min(lines.length, at + 12)
  }
  end = Math.min(end, start + 300, lines.length)
  const rel = project && file.startsWith(project) ? path.relative(project, file) : path.basename(file)
  return { file, rel, start, end, code: lines.slice(start - 1, end).join("\n"), lang: langOf(file), selected }
}

// ---------- the IDE side ----------

const JB = path.join(os.homedir(), "Library/Application Support/JetBrains")
const IDE_DIR = /^(PyCharm|WebStorm|IntelliJIdea|IdeaIC|PhpStorm|GoLand|RustRover|CLion|DataSpell|Rider|RubyMine)(CE)?\d{4}\.\d/

// The app binary that "Ask Tutor" launches: the installed Tutor.app.
function tutorBinary(): string | null {
  const packaged = app.getAppPath().includes(".app/Contents/Resources/app")
  if (packaged) return process.execPath
  const installed = ["/Applications/Tutor.app/Contents/MacOS/Electron", path.join(os.homedir(), "Applications/Tutor.app/Contents/MacOS/Electron")]
  return installed.find((p) => fs.existsSync(p)) ?? null
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

function toolXml(bin: string): string {
  const params = `"--tutor-ask-file=$FilePath$" --tutor-ask-lines=$SelectionStartLine$,$SelectionEndLine$,$LineNumber$ "--tutor-ask-project=$ProjectFileDir$"`
  return `<toolSet name="Tutor">
  <tool name="Ask Tutor" description="Send the selection (or the lines around the caret) to Tutor" showInMainMenu="true" showInEditor="true" showInProject="false" showInSearchPopup="true" disabled="false" useConsole="false" showConsoleOnStdOut="false" showConsoleOnStdErr="false" synchronizeAfterRun="false">
    <exec>
      <option name="COMMAND" value="${esc(bin)}" />
      <option name="PARAMETERS" value="${esc(params)}" />
      <option name="WORKING_DIRECTORY" value="$ProjectFileDir$" />
    </exec>
  </tool>
</toolSet>
`
}

export type IdeActionStatus = { binary: string | null; ides: { name: string; installed: boolean }[] }

function ideDirs(): string[] {
  try {
    return fs.readdirSync(JB).filter((d) => IDE_DIR.test(d)).map((d) => path.join(JB, d))
  } catch {
    return []
  }
}

export function ideActionStatus(): IdeActionStatus {
  return { binary: tutorBinary(), ides: ideDirs().map((d) => ({ name: path.basename(d), installed: fs.existsSync(path.join(d, "tools", "Tutor.xml")) })) }
}

// Adds tools/Tutor.xml to every JetBrains IDE's settings folder (its own file: nothing of yours is edited).
// The IDE picks it up the next time it starts.
export function installIdeAction(): IdeActionStatus {
  const bin = tutorBinary()
  if (!bin) throw new Error("Install Tutor.app first (npm run app); the IDE action launches it.")
  for (const d of ideDirs()) {
    fs.mkdirSync(path.join(d, "tools"), { recursive: true })
    fs.writeFileSync(path.join(d, "tools", "Tutor.xml"), toolXml(bin))
  }
  return ideActionStatus()
}

// ---------- Tutor as an agent in the IDE's AI chat ----------
// JetBrains reads custom ACP agents from ~/.jetbrains/acp.json ("agent_servers"). Tutor adds itself
// there (keeping everything else in the file); the IDE then runs the bridge with Tutor.app in Node mode.

const ACP_JSON = path.join(os.homedir(), ".jetbrains", "acp.json")

function bridgePath(): string | null {
  const packaged = app.getAppPath().includes(".app/Contents/Resources/app")
  const candidates = [
    ...(packaged ? [path.join(app.getAppPath(), "dist-electron", "acp-bridge.cjs")] : []),
    "/Applications/Tutor.app/Contents/Resources/app/dist-electron/acp-bridge.cjs",
    path.join(os.homedir(), "Applications/Tutor.app/Contents/Resources/app/dist-electron/acp-bridge.cjs")
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

export type AcpAgentStatus = { installed: boolean; file: string; ready: boolean }

export function acpAgentStatus(): AcpAgentStatus {
  let installed = false
  try {
    installed = !!JSON.parse(fs.readFileSync(ACP_JSON, "utf8"))?.agent_servers?.Tutor
  } catch {}
  return { installed, file: ACP_JSON, ready: !!tutorBinary() && !!bridgePath() }
}

export function installAcpAgent(socket: string): AcpAgentStatus {
  const bin = tutorBinary()
  const bridge = bridgePath()
  if (!bin || !bridge) throw new Error("Install Tutor.app first (npm run app); the IDE runs it to reach Tutor.")
  let conf: { agent_servers?: Record<string, unknown>; [k: string]: unknown } = {}
  if (fs.existsSync(ACP_JSON)) {
    try {
      conf = JSON.parse(fs.readFileSync(ACP_JSON, "utf8"))
    } catch {
      throw new Error(`${ACP_JSON} isn't valid JSON, so Tutor won't touch it. Fix or remove it, then try again.`)
    }
  }
  conf.agent_servers = { ...(conf.agent_servers ?? {}), Tutor: { command: bin, args: [bridge, socket], env: { ELECTRON_RUN_AS_NODE: "1" } } }
  fs.mkdirSync(path.dirname(ACP_JSON), { recursive: true })
  fs.writeFileSync(ACP_JSON, JSON.stringify(conf, null, 2) + "\n")
  return acpAgentStatus()
}
