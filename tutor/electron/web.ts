// A page reader for the API-key models. Search itself comes from Brave's MCP server (mcp.ts).
// (The "Claude · my plan" route uses Claude Code's own WebFetch instead.)
import { tool, type ToolSet } from "ai"
import { z } from "zod"
import dns from "node:dns/promises"
import net from "node:net"

const MAX_PAGE = 24_000

// Don't let a web page steer the reader into your own machine or home network.
export async function isPublic(url: URL): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol)) return false
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return false
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!addrs.length) return false
  return addrs.every((a) => {
    if (net.isIPv4(a)) {
      const [x, y] = a.split(".").map(Number)
      return !(x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127))
    }
    const l = a.toLowerCase()
    return !(l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l === "::")
  })
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ""
  const main = /<(main|article)[\s>][\s\S]*<\/\1>/i.exec(html)?.[0] ?? html
  const text = main
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim()
  return { title, text }
}

export function webTools(): ToolSet {
  const tools: ToolSet = {
    fetch_url: tool({
      description:
        "Read a web page (docs, blog post, GitHub README, arXiv abstract/HTML paper) as plain text. For arXiv papers prefer https://arxiv.org/html/<id> which has the full text. PDFs aren't supported yet.",
      inputSchema: z.object({ url: z.string().url(), from: z.number().int().min(0).default(0).describe("Character offset to continue a long page") }),
      execute: async ({ url, from }) => {
        let u = new URL(url)
        if (u.hostname === "arxiv.org" && u.pathname.startsWith("/pdf/")) u = new URL(`https://arxiv.org/html/${u.pathname.slice(5).replace(/\.pdf$/, "")}`)
        if (!(await isPublic(u))) throw new Error("Only public http(s) pages can be read.")
        const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Tutor/0.2 (+https://github.com)", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } })
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`)
        const type = res.headers.get("content-type") ?? ""
        if (type.includes("pdf")) throw new Error("That's a PDF; PDFs aren't supported yet. For arXiv use the /html/ version.")
        const raw = (await res.text()).slice(0, 3_000_000)
        const { title, text } = type.includes("html") ? htmlToText(raw) : { title: "", text: raw }
        const chunk = text.slice(from, from + MAX_PAGE)
        const more = from + MAX_PAGE < text.length ? `\n\n[… ${text.length - from - MAX_PAGE} more characters; call again with from=${from + MAX_PAGE}]` : ""
        return `${title ? `# ${title}\n` : ""}${res.url}\n\n${chunk}${more}`
      }
    })
  }
  return tools
}
