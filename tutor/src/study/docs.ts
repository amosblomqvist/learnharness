// Turns a docs page into blocks to type: the page's main text (or the #section a lesson links to),
// as paragraphs, headings and code. Parsing happens here in the window with DOMParser, which
// never runs the page's scripts. The main process only fetches and caches (electron/docs.ts).
import type { Block } from "./typing"

// Where each docs site keeps its text, most specific first. Anything else falls back to main/article.
const ROOTS = [
  ".td-content", // kubernetes.io
  "#main-col-body", // AWS docs
  ".main-page-content, .reference-layout__body", // MDN
  "div.body[role=main]", // Python docs (Sphinx)
  "article.prose", // Docker docs
  "#main.book, .book", // Pro Git (git-scm.com)
  ".paperBody", // martinfowler.com
  "#maia-main .content", // Google SRE book
  "main article",
  "main",
  "article",
  "[role=main]",
  "body"
]

// Page furniture that isn't part of the text.
const JUNK = [
  "script", "style", "noscript", "template", "svg", "img", "picture", "video", "iframe", "form", "button", "input",
  "nav", "aside", "header", "footer", "table",
  "[aria-hidden=true]", "[hidden]", "[data-pagefind-ignore]",
  ".headerlink", ".top-link", ".nav-panel", ".toc", "#toc", "[class*=feedback]", "[class*=popup]", "[class*=breadcrumb]",
  ".language-id", ".playground-link", ".meta-line", ".popover", ".error", ".error-behind", // TypeScript Handbook code
  ".boring" // Rust Book: lines hidden in its examples
].join(",")

// Man page sites put the whole page in <pre>, hard-wrapped: those are prose, not code.
const MAN_HOSTS = ["man7.org", "manpages.debian.org", "manpages.ubuntu.com", "man.openbsd.org"]

export type Passage = { title: string; blocks: Block[]; words: number; cut: boolean }

const words = (b: Block) => b.text.split(/\s+/).filter(Boolean).length

/** maxWords: stop after this many words, at a block boundary (0 = the whole thing). */
export function extract(html: string, pageUrl: string, maxWords = 0): Passage {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const url = new URL(pageUrl)
  const man = MAN_HOSTS.includes(url.hostname)

  const root = section(doc, decodeURIComponent(url.hash.slice(1))) ?? ROOTS.map((s) => doc.querySelector(s)).find((el) => el && el.textContent!.trim().length > 200) ?? doc.body
  root.querySelectorAll(JUNK).forEach((el) => el.remove())

  const all: Block[] = []
  collect(root, all, man)

  const blocks: Block[] = []
  let count = 0
  for (const b of all) {
    if (maxWords && count >= maxWords) break
    blocks.push(b)
    count += words(b)
  }
  // A heading that opens what you type is the most specific title (some sites' first h1 is the
  // site's name); otherwise the page's.
  const opening = blocks[0]?.kind === "heading" ? blocks[0].text : null
  const title = (opening ?? doc.querySelector("h1")?.textContent ?? doc.title).trim().replace(/\s*\u00b6$/, "")
  return { title, blocks, words: count, cut: blocks.length < all.length }
}

// The part of the page a #fragment points to: a section element, or a heading and everything
// after it up to the next heading of the same or a higher level.
function section(doc: Document, id: string): Element | null {
  if (!id) return null
  const el = doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
  if (!el) return null
  let heading = el.closest("h1, h2, h3, h4, h5, h6")
  // An empty anchor right before a heading (common in man pages and GNU manuals).
  if (!heading && !el.textContent?.trim() && isHeading(el.nextElementSibling)) heading = el.nextElementSibling
  if (!heading) return el
  // A heading that opens its own <section> or <div>: take that box, and the boxes after it
  // that hold its subsections (MDN keeps those as siblings, not children).
  const parent = heading.parentElement
  const start = parent && parent.firstElementChild === heading && /^(SECTION|DIV)$/.test(parent.tagName) ? parent : heading
  const level = Number(heading.tagName[1])
  const box = doc.createElement("div")
  for (let n: Element | null = start; n; n = n.nextElementSibling) {
    if (n !== start && (levelOf(n) ?? 9) <= level) break
    box.append(n.cloneNode(true))
  }
  return box
}

const isHeading = (el: Element | null) => !!el && /^H[1-6]$/.test(el.tagName)

// The heading level an element starts with: its own, or that of the heading it opens with.
function levelOf(el: Element): number | null {
  if (isHeading(el)) return Number(el.tagName[1])
  const first = el.firstElementChild
  return first && isHeading(first) && /^(SECTION|DIV)$/.test(el.tagName) ? Number(first.tagName[1]) : null
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim()

function collect(el: Element, out: Block[], man: boolean): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName
    if (isHeading(child)) {
      const text = clean(child.textContent ?? "").replace(/\s*\u00b6$/, "")
      if (text) out.push({ kind: "heading", text })
    } else if (tag === "PRE") {
      if (man) out.push(...manProse(child.textContent ?? ""))
      else {
        const text = codeText(child)
        if (text.trim()) out.push({ kind: "code", text })
      }
    } else if (tag === "P" || tag === "DT" || (["LI", "DD", "DIV", "BLOCKQUOTE"].includes(tag) && !hasBlocks(child) && !child.querySelector("h1, h2, h3, h4, h5, h6"))) {
      // A list item or a box with only inline text in it is one paragraph.
      const text = clean(child.textContent ?? "")
      if (text) out.push({ kind: "text", text })
    } else {
      collect(child, out, man)
    }
  }
}

const hasBlocks = (el: Element) => !!el.querySelector("p, pre, ul, ol, dl, div")

// Code shown one element per line (the TypeScript Handbook, Kubernetes) is joined line by line.
function codeText(pre: Element): string {
  const lines = pre.querySelectorAll(".line")
  // Some sites' lines already end with a newline; don't double it.
  return lines.length ? Array.from(lines, (l) => (l.textContent ?? "").replace(/\n$/, "")).join("\n") : (pre.textContent ?? "")
}

// A man page section: paragraphs separated by blank lines, each hard-wrapped and indented.
function manProse(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map(clean)
    .filter(Boolean)
    .map((t) => ({ kind: "text" as const, text: t }))
}
