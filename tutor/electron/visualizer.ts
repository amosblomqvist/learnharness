// Opens the Python visualizer in its own window: viz.py, a local copy of pythontutor.com that
// lives with the Python lessons (~/code-reading/python/viz.py). The first time, Tutor starts
// `python3 viz.py` on 127.0.0.1; it keeps running for quick reopening and stops when Tutor quits.
// A copy of Tutor without that folder uses the viz.py it ships with (scripts/package-mac.mjs).
// Closing this window does not quit Tutor. Given a program, it opens on that program and runs it:
// the code goes in the address's #code= part, as on pythontutor.com (with &mode=edit it opens in
// the editor instead, for code that still needs a call written under it).
import { app, BrowserWindow, screen } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { onPath } from "./lab"

const PORT = 5190
type Result = { ok: true } | { ok: false; error: string }
let vizWin: BrowserWindow | null = null
let vizProc: ChildProcess | null = null
let vizUrl: string | null = null
let opening: Promise<Result> | null = null

function vizScript(): { script: string; cwd: string } | null {
  const own = process.env.TUTOR_VIZ ?? path.join(app.getPath("home"), "code-reading", "python", "viz.py")
  // Programs run in the script's folder, so the lessons' relative paths work as in Terminal.
  if (fs.existsSync(own)) return { script: own, cwd: path.dirname(own) }
  const bundled = path.join(app.getAppPath(), "viz", "viz.py")
  return fs.existsSync(bundled) ? { script: bundled, cwd: app.getPath("home") } : null
}

// Starts viz.py and resolves with the address it prints once it's listening.
function startServer(): Promise<string> {
  const found = vizScript()
  if (!found) return Promise.reject(new Error("Couldn't find the visualizer. It should be at ~/code-reading/python/viz.py."))
  // /usr/bin/python3 is Xcode's stub (it can hang on a license prompt); prefer a real install.
  const python = onPath("python3", ["/usr/bin"]) ?? onPath("python3")
  if (!python) return Promise.reject(new Error("Python 3 isn't installed (python3 wasn't found)."))
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-u", found.script, String(PORT), "--no-browser"], { cwd: found.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    vizProc = child
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      reject(new Error("The visualizer didn't start within 15 seconds."))
      child.kill("SIGTERM")
    }, 15000)
    child.stdout.on("data", (b: Buffer) => {
      out = (out + b.toString()).slice(-2000)
      const m = /running at\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
    child.stderr.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-800)))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (vizProc === child) {
        vizProc = null
        vizUrl = null
      }
      const why = err.trim().split("\n").pop() || out.trim().split("\n").pop()
      reject(new Error(why ? `The visualizer stopped: ${why}` : `The visualizer stopped (exit code ${code}).`))
    })
  })
}

function showWindow(url: string, code?: string, edit = false) {
  const target = code === undefined ? url : `${url}#code=${encodeURIComponent(code)}${edit ? "&mode=edit" : ""}`
  if (vizWin && !vizWin.isDestroyed()) {
    if (code !== undefined || !vizWin.webContents.getURL().startsWith(url)) void vizWin.loadURL(target)
    if (vizWin.isMinimized()) vizWin.restore()
    vizWin.show()
    vizWin.focus()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  vizWin = new BrowserWindow({
    width: Math.min(1400, area.width - 60),
    height: Math.min(900, area.height - 40),
    minWidth: 720,
    minHeight: 480,
    title: "Python Visualizer",
    backgroundColor: "#ffffff",
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // Not a child of Tutor, and not the window whose close hides the app.
  vizWin.on("closed", () => (vizWin = null))
  vizWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  vizWin.webContents.on("will-navigate", (e, next) => {
    if (!next.startsWith(url)) e.preventDefault()
  })
  void vizWin.loadURL(target)
}

async function openInner(code?: string, edit?: boolean): Promise<Result> {
  try {
    if (!vizProc || vizProc.exitCode !== null || !vizUrl) vizUrl = await startServer()
    showWindow(vizUrl, code, edit)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't open the visualizer."
    return { ok: false, error: msg.slice(0, 300) }
  }
}

export function openVisualizer(code?: string, edit?: boolean): Promise<Result> {
  // A second click while the server starts shows the program from the latest click.
  if (opening) return code === undefined ? opening : opening.then((r) => (r.ok && vizUrl ? (showWindow(vizUrl, code, edit), r) : r))
  opening = openInner(code, edit).finally(() => {
    opening = null
  })
  return opening
}

// The server's address without opening a window, for the visualizer shown inside a lesson.
let starting: Promise<string> | null = null
export async function visualizerUrl(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    if (!vizProc || vizProc.exitCode !== null || !vizUrl) {
      starting ??= startServer().finally(() => (starting = null))
      vizUrl = await starting
    }
    return { ok: true, url: vizUrl }
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : "Couldn't start the visualizer.").slice(0, 300) }
  }
}

export function stopVisualizer() {
  if (!vizProc) return
  vizProc.kill("SIGTERM")
  vizProc = null
  vizUrl = null
}
