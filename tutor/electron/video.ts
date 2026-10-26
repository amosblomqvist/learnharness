// Videos as sources: a YouTube (or any yt-dlp–supported) link, or a video file on this Mac,
// becomes a transcript with [mm:ss] timestamps the model can act on: map it onto a goal,
// teach from it, quiz on it, and link straight back to the moment in the video.
// Captions come from yt-dlp (installed, or run through uv's uvx without installing anything);
// a local file without captions is transcribed with whisper.cpp if it's installed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const MAX_CHARS = 400_000 // a whole long course; it's handed to the model in pages
const PAGE = 34_000 // ~9k tokens: stays inline in every engine

export type Video = { title: string; url: string; channel?: string; duration?: number; chapters: { start: number; title: string }[]; transcript: string; truncated: boolean }

const stamp = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`
}

async function which(cmd: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(":").concat(["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")])) {
    const p = path.join(dir, cmd)
    if (fs.existsSync(p)) return p
  }
  return null
}

type Cue = { start: number; text: string }

// YouTube's json3 captions: events with start times and text segments.
function parseJson3(raw: string): Cue[] {
  const j = JSON.parse(raw) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] }
  return (j.events ?? []).filter((e) => e.segs).map((e) => ({ start: (e.tStartMs ?? 0) / 1000, text: e.segs!.map((s) => s.utf8 ?? "").join("") }))
}

// WebVTT / SRT: "00:01:02.345 --> …" blocks. Auto-captions repeat lines as they roll; drop repeats.
function parseVtt(raw: string): Cue[] {
  const cues: Cue[] = []
  const blocks = raw.replace(/\r/g, "").split(/\n\n+/)
  let last = ""
  for (const b of blocks) {
    const m = /(\d+:)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->/.exec(b)
    if (!m) continue
    const start = (m[1] ? parseInt(m[1]) * 3600 : 0) + parseInt(m[2]) * 60 + parseInt(m[3])
    const lines = b.split("\n").slice(b.split("\n").findIndex((l) => l.includes("-->")) + 1)
    for (const l of lines) {
      const t = l.replace(/<[^>]+>/g, "").trim()
      if (t && t !== last) cues.push({ start, text: t })
      if (t) last = t
    }
  }
  return cues
}

// Paragraphs of ~45s, each starting with its timestamp.
function condense(cues: Cue[]): { text: string; truncated: boolean } {
  const out: string[] = []
  let cur: string[] = []
  let at = 0
  let len = 0
  for (const c of cues) {
    const t = c.text.replace(/\s+/g, " ").trim()
    if (!t || t === "[Music]") continue
    if (!cur.length) at = c.start
    cur.push(t)
    if ((c.start - at >= 45 && /[.?!]$/.test(t)) || c.start - at >= 70) {
      const para = `[${stamp(at)}] ${cur.join(" ")}`
      if (len + para.length > MAX_CHARS) return { text: out.join("\n") + `\n[transcript cut at ${stamp(at)}]`, truncated: true }
      out.push(para)
      len += para.length
      cur = []
    }
  }
  if (cur.length) out.push(`[${stamp(at)}] ${cur.join(" ")}`)
  return { text: out.join("\n"), truncated: false }
}

// yt-dlp itself if it's on this Mac, else through uvx (uv fetches and caches it the first time).
// YouTube wants a JavaScript runtime for some requests; Node is used when it's there.
async function ytdlp(): Promise<{ cmd: string; pre: string[] }> {
  const node = await which("node")
  const js = node ? ["--js-runtimes", `node:${node}`] : []
  const own = await which("yt-dlp")
  if (own) return { cmd: own, pre: js }
  const uvx = await which("uvx")
  if (uvx) return { cmd: uvx, pre: ["--from", "yt-dlp[default]", "yt-dlp", ...js] }
  throw new Error("Reading videos needs yt-dlp. Ask the user to run `brew install yt-dlp` once (or install uv), then try again.")
}

async function fromUrl(url: string): Promise<Video> {
  const y = await ytdlp()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-video-"))
  try {
    const { stdout } = await run(y.cmd, [...y.pre, "-J", "--no-playlist", "--skip-download", url], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
    const info = JSON.parse(stdout) as { title?: string; channel?: string; uploader?: string; duration?: number; webpage_url?: string; chapters?: { start_time: number; title: string }[]; language?: string; subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown> }
    // Prefer human captions, English if there is any, else the video's own language.
    const pick = (subs: Record<string, unknown> | undefined) => {
      const langs = Object.keys(subs ?? {}).filter((l) => l !== "live_chat")
      return langs.find((l) => l === "en") ?? langs.find((l) => l.startsWith("en")) ?? langs.find((l) => info.language && l.startsWith(info.language)) ?? langs.find((l) => l.endsWith("-orig")) ?? langs[0]
    }
    const human = pick(info.subtitles)
    const auto = pick(info.automatic_captions)
    const lang = human ?? auto
    if (!lang) throw new Error(`"${info.title ?? url}" has no captions to read, so it can't be used as a source yet.`)
    await run(y.cmd, [...y.pre, "--no-playlist", "--skip-download", human ? "--write-subs" : "--write-auto-subs", "--sub-langs", lang, "--sub-format", "json3/vtt/srt/best", "-o", path.join(tmp, "v.%(ext)s"), url], { timeout: 90_000 })
    const subFile = fs.readdirSync(tmp).find((f) => /\.(json3|vtt|srt)$/.test(f))
    if (!subFile) throw new Error("yt-dlp didn't return captions for this video.")
    const raw = fs.readFileSync(path.join(tmp, subFile), "utf8")
    const { text, truncated } = condense(subFile.endsWith(".json3") ? parseJson3(raw) : parseVtt(raw))
    return {
      title: info.title ?? url,
      url: info.webpage_url ?? url,
      channel: info.channel ?? info.uploader,
      duration: info.duration,
      chapters: (info.chapters ?? []).map((c) => ({ start: c.start_time, title: c.title })),
      transcript: text,
      truncated
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// A file on this Mac: captions next to it (same name .srt/.vtt), else whisper.cpp if it's installed.
async function fromFile(file: string): Promise<Video> {
  if (!fs.existsSync(file)) throw new Error(`There's no file at ${file}.`)
  const base = file.replace(/\.[^.]+$/, "")
  const side = [".srt", ".vtt", ".en.srt", ".en.vtt"].map((e) => base + e).find((p) => fs.existsSync(p))
  let cues: Cue[]
  if (side) cues = parseVtt(fs.readFileSync(side, "utf8"))
  else {
    const whisper = await which("whisper-cli")
    const ffmpeg = await which("ffmpeg")
    const model = [path.join(os.homedir(), ".tutor", "whisper", "ggml-large-v3-turbo.bin"), path.join(os.homedir(), ".tutor", "whisper", "ggml-base.en.bin")].find((p) => fs.existsSync(p))
    if (!whisper || !ffmpeg || !model)
      throw new Error("This video has no captions file next to it, and local transcription isn't set up. The user can put a .srt/.vtt with the same name next to it, or install it with `brew install whisper-cpp ffmpeg` and a model in ~/.tutor/whisper/ (Settings → Videos explains).")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-whisper-"))
    try {
      const wav = path.join(tmp, "a.wav")
      await run(ffmpeg, ["-y", "-i", file, "-ar", "16000", "-ac", "1", wav], { timeout: 10 * 60_000 })
      await run(whisper, ["-m", model, "-f", wav, "-osrt", "-of", path.join(tmp, "a")], { timeout: 60 * 60_000 })
      cues = parseVtt(fs.readFileSync(path.join(tmp, "a.srt"), "utf8"))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  const { text, truncated } = condense(cues)
  return { title: path.basename(file), url: `file://${file}`, chapters: [], transcript: text, truncated }
}

// yt-dlp's own "ERROR: …" line says more than "Command failed: <the whole command line>".
function reason(err: unknown): Error {
  const e = err as { stderr?: string; message?: string }
  const line = (e.stderr ?? "").split("\n").reverse().find((l) => l.startsWith("ERROR:"))
  return new Error(line ? line.replace(/^ERROR:\s*/, "") : (e.message ?? String(err)).split("\n")[0].slice(0, 300))
}

// Fetched videos stay in memory for the session, so paging through one doesn't re-download it.
const cache = new Map<string, Video>()

export async function readVideo(source: string): Promise<Video> {
  const hit = cache.get(source.trim())
  if (hit) return hit
  const v = await fetchVideo(source)
  cache.set(source.trim(), v)
  return v
}

async function fetchVideo(source: string): Promise<Video> {
  const s = source.trim().replace(/^file:\/\//, "")
  if (!/^https?:\/\//i.test(s)) return fromFile(s.replace(/^~(?=\/)/, os.homedir()))
  try {
    return await fromUrl(s)
  } catch (err) {
    if ((err as Error).message.startsWith("Reading videos needs") || /has no captions/.test((err as Error).message)) throw err
    // Networks blip and YouTube throttles; one more try before giving up.
    await new Promise((r) => setTimeout(r, 2500))
    return fromUrl(s).catch((e) => {
      throw reason(e)
    })
  }
}

const seconds = (t: string) => t.split(":").reduce((a, x) => a * 60 + (parseInt(x) || 0), 0)

// What the model gets back: the header and chapters, then one page of the transcript starting at
// `from` (a timestamp). Long talks come in several pages; the model asks for the next one.
export function videoForModel(v: Video, from?: string): string {
  const head = [`Video: ${v.title}`, v.channel ? `Channel: ${v.channel}` : "", v.duration ? `Length: ${stamp(v.duration)}` : "", `Link: ${v.url}`].filter(Boolean)
  if (v.chapters.length) head.push("Chapters:", ...v.chapters.map((c) => `  [${stamp(c.start)}] ${c.title}`))
  const link = /youtube\.com|youtu\.be/.test(v.url) ? `To link a moment, use ${v.url}${v.url.includes("?") ? "&" : "?"}t=<seconds> (e.g. [12:30](${v.url}${v.url.includes("?") ? "&" : "?"}t=750)).` : ""
  const paras = v.transcript.split("\n")
  const at = (p: string) => seconds(/^\[([\d:]+)\]/.exec(p)?.[1] ?? "0")
  let i = from ? paras.findIndex((p) => at(p) >= seconds(from)) : 0
  if (i < 0) return `${head.join("\n")}\n\nThe transcript ends before ${from}.`
  const page: string[] = []
  let len = 0
  for (; i < paras.length && len + paras[i].length < PAGE; i++) {
    page.push(paras[i])
    len += paras[i].length + 1
  }
  const more = i < paras.length ? `\n\n[Transcript continues at ${/^\[([\d:]+)\]/.exec(paras[i])?.[1]}. Call the video tool again with the same source and from: "${/^\[([\d:]+)\]/.exec(paras[i])?.[1]}" to read on; skim by chapters if you only need parts.]` : ""
  return `${from ? `(${v.title}, from ${from})` : `${head.join("\n")}\n${link}`}\n\nTranscript${from ? "" : " (first part)"}:\n${page.join("\n")}${more}`
}

export const isVideoUrl = (s: string) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch|live|shorts)|youtu\.be\/|vimeo\.com\/\d)/i.test(s.trim())
