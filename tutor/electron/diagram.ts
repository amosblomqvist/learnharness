// Draws a Mermaid or SVG diagram to a PNG in a hidden window, with the same renderer and theme
// the chat uses (render.html), so what the model checks is what you'll see.
import { BrowserWindow } from "electron"
import path from "node:path"

const MAX = 1400
let win: BrowserWindow | null = null
let ready: Promise<void> | null = null
let queue: Promise<unknown> = Promise.resolve()

function page(): Promise<void> {
  if (win && !win.isDestroyed() && ready) return ready
  win = new BrowserWindow({ show: false, width: 760, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (e) => e.preventDefault())
  win.on("closed", () => {
    win = null
    ready = null
  })
  const dev = process.env.TUTOR_DEV_URL
  ready = dev ? win.loadURL(new URL("render.html", dev).toString()) : win.loadFile(path.join(__dirname, "../dist/render.html"))
  return ready
}

export type Rendered = { ok: true; png: string; width: number; height: number } | { ok: false; error: string }

async function draw(kind: "mermaid" | "svg", source: string): Promise<Rendered> {
  await page()
  const w = win!
  const r = (await w.webContents.executeJavaScript(`window.renderDiagram(${JSON.stringify(kind)}, ${JSON.stringify(source)})`)) as { ok: boolean; error?: string; width?: number; height?: number }
  if (!r.ok) return { ok: false, error: r.error ?? "unknown error" }
  const width = Math.min(MAX, Math.ceil(r.width ?? 0))
  const height = Math.min(MAX, Math.ceil(r.height ?? 0))
  if (!width || !height) return { ok: false, error: "The diagram rendered empty." }
  const [cw, ch] = w.getContentSize()
  if (cw < width || ch < height) w.setContentSize(Math.max(cw, width), Math.max(ch, height))
  await new Promise((res) => setTimeout(res, 150))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width, height })
  return { ok: true, png: img.toPNG().toString("base64"), width, height }
}

// One at a time: they share the window.
export function renderDiagram(kind: "mermaid" | "svg", source: string): Promise<Rendered> {
  const next = queue.then(() => draw(kind, source)).catch((err: Error) => ({ ok: false as const, error: err.message }))
  queue = next
  return next
}

export function closeDiagrams(): void {
  win?.destroy()
}
