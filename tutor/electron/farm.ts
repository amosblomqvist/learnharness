// Opens the Root Access farm in its own window. The game is a separate Vite app
// (Desktop/root-access). With that folder on this Mac, Tutor uses its dev server, as before
// (saves live on that origin). Without it (a copy of Tutor on someone else's Mac), Tutor
// serves the built game it ships with (Resources/app/farm) on its own fixed port.
// Progress stays in that origin's localStorage. Closing this window does not quit Tutor.
import { app, BrowserWindow } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"

const PORT = 5188
const BUNDLED_PORT = 5189
let bundled: http.Server | null = null
let farmWin: BrowserWindow | null = null
let farmProc: ChildProcess | null = null
let farmOwned = false
let opening: Promise<{ ok: true } | { ok: false; error: string }> | null = null

function farmDir(): string {
  return process.env.TUTOR_FARM_DIR ?? path.join(app.getPath("home"), "Desktop", "root-access")
}

function probe(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(400)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

// Vite on this Mac listens on ::1, which the game tab already uses as localhost.
// 127.0.0.1 is a different origin (different save), so only use it when that's the one up.
async function liveFarmUrl(): Promise<string | null> {
  if (await probe("::1")) return `http://localhost:${PORT}/`
  if (await probe("127.0.0.1")) return `http://127.0.0.1:${PORT}/`
  return null
}

function isFarmUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && (u.port === String(PORT) || u.port === String(BUNDLED_PORT))
  } catch {
    return false
  }
}

function showFarm(url: string) {
  if (farmWin && !farmWin.isDestroyed()) {
    if (farmWin.webContents.getURL() !== url) void farmWin.loadURL(url)
    if (farmWin.isMinimized()) farmWin.restore()
    farmWin.show()
    farmWin.focus()
    return
  }
  farmWin = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: "Root Access",
    backgroundColor: "#14160f",
    show: true,
    webPreferences: {
      // window.tutor: practice and questions go to Tutor (farm-preload.ts, handled in main.ts).
      preload: path.join(__dirname, "farm-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Not a child of Tutor, and not the window whose close hides the app.
  farmWin.on("closed", () => (farmWin = null))
  farmWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  farmWin.webContents.on("will-navigate", (e, next) => {
    if (!isFarmUrl(next)) e.preventDefault()
  })
  void farmWin.loadURL(url)
}

async function startFarmDev(): Promise<string | null> {
  const dir = farmDir()
  if (!fs.existsSync(path.join(dir, "package.json"))) return null
  let log = ""
  const child = spawn("npm", ["run", "dev"], {
    cwd: dir,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  })
  farmProc = child
  farmOwned = true
  let spawnErr: Error | null = null
  child.on("error", (err) => {
    spawnErr = err
  })
  child.unref()
  const take = (buf: Buffer) => {
    log = (log + buf.toString()).slice(-600)
  }
  child.stdout?.on("data", take)
  child.stderr?.on("data", take)
  child.on("exit", () => {
    if (farmProc === child) farmProc = null
  })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const url = await liveFarmUrl()
    if (url) return url
    if (spawnErr) throw spawnErr
    if (child.exitCode !== null) {
      const why = log.trim().split("\n").pop()
      throw new Error(why ? `Farm dev server stopped: ${why}` : "Farm dev server stopped before it was ready.")
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return liveFarmUrl()
}

// The built game inside Tutor.app (copied there by scripts/package-mac.mjs).
function bundledDir(): string | null {
  const dir = path.join(app.getAppPath(), "farm")
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".whl": "application/octet-stream",
  ".tar": "application/x-tar"
}

// A static server on 127.0.0.1 only, with the cross-origin isolation headers the game needs
// (SharedArrayBuffer for its code worker).
function serveBundled(root: string): Promise<string> {
  if (bundled) return Promise.resolve(`http://127.0.0.1:${BUNDLED_PORT}/`)
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\/+$/, "/")
      let file = path.join(root, rel.endsWith("/") ? rel + "index.html" : rel)
      if (!file.startsWith(root + path.sep) && file !== root) {
        res.writeHead(403).end()
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html")
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-cache"
      })
      fs.createReadStream(file).pipe(res)
    })
    server.once("error", reject)
    server.listen(BUNDLED_PORT, "127.0.0.1", () => {
      bundled = server
      resolve(`http://127.0.0.1:${BUNDLED_PORT}/`)
    })
  })
}

async function openFarmInner(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let url = await liveFarmUrl()
    if (!url) {
      const own = fs.existsSync(path.join(farmDir(), "package.json"))
      const built = bundledDir()
      if (!own && built) url = await serveBundled(built)
      else if (!own) return { ok: false, error: "This copy of Tutor doesn't include the farm, and there's no Desktop/root-access folder." }
      else url = await startFarmDev()
    }
    if (!url) return { ok: false, error: "Farm server didn't start. In Terminal: cd Desktop/root-access && npm run dev" }
    showFarm(url)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't open the farm."
    return { ok: false, error: msg.slice(0, 220) }
  }
}

export function openFarm(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (opening) return opening
  opening = openFarmInner().finally(() => {
    opening = null
  })
  return opening
}

// Whether an IPC message came from the farm window (only it may report practice or ask).
export function isFarmSender(sender: Electron.WebContents): boolean {
  return !!farmWin && !farmWin.isDestroyed() && farmWin.webContents === sender && isFarmUrl(sender.getURL())
}

// Only the server Tutor started. A farm the user already had running is left alone.
export function stopOwnedFarm() {
  bundled?.close()
  bundled = null
  if (!farmOwned || !farmProc?.pid) return
  try {
    process.kill(-farmProc.pid, "SIGTERM")
  } catch {
    try {
      farmProc.kill("SIGTERM")
    } catch {
      /* already gone */
    }
  }
  farmOwned = false
  farmProc = null
}

