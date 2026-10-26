// Docs pages for typing practice: the human-written page a lesson cites (Python docs, the
// TypeScript Handbook, man pages, the Rust Book…). Fetched on first use and kept in
// userData/docs, so a page you've opened once works offline. The window does the parsing.
import { app, ipcMain, net } from "electron"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isPublic } from "./web"

const MAX_BYTES = 5_000_000

const dir = () => path.join(app.getPath("userData"), "docs")
// One file per page; the #section is picked out by the window, so it isn't part of the name.
const cacheFile = (url: URL) => path.join(dir(), crypto.createHash("sha1").update(url.origin + url.pathname + url.search).digest("hex") + ".html")

type DocResult = { ok: true; html: string } | { ok: false; error: string }

async function getDoc(raw: string): Promise<DocResult> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "Not a web address." }
  }
  if (url.protocol !== "https:") return { ok: false, error: "Only https pages are fetched." }

  const file = cacheFile(url)
  if (fs.existsSync(file)) return { ok: true, html: fs.readFileSync(file, "utf8") }

  try {
    const res = await fetchPublic(url)
    if ("error" in res) return { ok: false, error: res.error }
    const html = await res.text()
    if (html.length > MAX_BYTES) return { ok: false, error: "The page is too large." }
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(file, html)
    return { ok: true, html }
  } catch (e) {
    return { ok: false, error: `Couldn't load the page: ${(e as Error).message}` }
  }
}

// Fetch with Chromium's network stack, like a browser: it copes with broken IPv6 and system
// proxies, where Node's fetch can time out (gnu.org did). Redirects are followed by hand, so every
// hop is checked to be a public address and a page can't send the request into your network.
async function fetchPublic(start: URL): Promise<Response | { error: string }> {
  let url = start
  for (let hop = 0; hop < 5; hop++) {
    if (!(await isPublic(url))) return { error: "That address isn't a public web page." }
    const res = await net.fetch(url.href, { headers: { "User-Agent": "Tutor (study app)" }, redirect: "manual", signal: AbortSignal.timeout(20_000) })
    const to = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && to) {
      url = new URL(to, url)
      if (url.protocol !== "https:") return { error: "The page redirected away from https." }
      continue
    }
    return res.ok ? res : { error: `The site answered ${res.status}.` }
  }
  return { error: "Too many redirects." }
}

export function registerDocs(): void {
  ipcMain.handle("docs:get", (_e, url: string) => getDoc(String(url)))
}
