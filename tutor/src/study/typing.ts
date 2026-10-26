// Typing practice on real docs. A passage is a list of blocks (paragraphs, headings, code); each
// block becomes a target string plus an "auto" mask for characters you don't type: indentation
// after a line break, REPL prompts and their output, and symbols a keyboard can't easily make.
// A wrong key doesn't move the cursor, so whatever you have typed is always right.

export type Block = { kind: "text" | "heading" | "code"; text: string }

// One entry per character (not per UTF-16 unit, so an emoji is one character too).
export type Target = { chars: string[]; auto: boolean[] }

// Typographic characters and their keyboard spelling. Written as \u escapes because several
// of them (non-breaking and zero-width spaces) are invisible in an editor.
const PLAIN: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", // curly single quotes
  "\u201c": '"', "\u201d": '"', "\u201e": '"', // curly double quotes
  "\u2010": "-", "\u2011": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-", // dashes, minus
  "\u2026": "...", // ellipsis
  "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u200b": "", // odd spaces
  "\u2190": "<-", "\u2192": "->", "\u21d2": "=>", // arrows
  "\u00d7": "x", "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2022": "*"
}
const plain = (s: string) => [...s].map((c) => PLAIN[c] ?? c).join("")
const typeable = (c: string) => c === "\n" || (c >= " " && c <= "~")

export function target(b: Block): Target {
  if (b.kind !== "code") {
    const chars = [...plain(b.text).replace(/\s+/g, " ").trim()]
    return { chars, auto: chars.map((c) => !typeable(c)) }
  }
  return codeTarget(b.text)
}

function codeTarget(code: string): Target {
  const lines = plain(code)
    .replace(/\t/g, "    ")
    .split("\n")
    .map((l) => l.trimEnd())
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  // An interactive session (Python's >>> or a shell's $): type the commands, skip the prompts
  // and the output.
  const repl = lines.some((l) => /^(>>>|\.\.\.|\$)( |$)/.test(l))
  const chars: string[] = []
  const auto: boolean[] = []
  const add = (s: string, skip: boolean) => {
    for (const c of s) {
      chars.push(c)
      auto.push(skip || !typeable(c))
    }
  }
  const isInput = (l: string) => (repl ? /^(>>>|\.\.\.|\$)( |$)/.test(l) : !!l.trim())
  lines.forEach((line, i) => {
    // Enter is typed after a line you typed; after output or a blank line it's free.
    if (i > 0) add("\n", !isInput(lines[i - 1]))
    const prompt = /^(>>> ?|\.\.\. ?|\$ )/.exec(line)?.[0] ?? ""
    if (repl && !prompt) return add(line, true)
    const indent = /^ */.exec(line.slice(prompt.length))![0]
    add(prompt + indent, true)
    add(line.slice(prompt.length + indent.length), false)
  })
  return { chars, auto }
}

// ---------- one block being typed ----------

export type Run = { t: Target; pos: number; keys: number; mistakes: number; wrong: boolean }

const skip = (t: Target, pos: number) => {
  while (pos < t.chars.length && t.auto[pos]) pos++
  return pos
}

export const start = (t: Target): Run => ({ t, pos: skip(t, 0), keys: 0, mistakes: 0, wrong: false })

export const finished = (r: Run) => r.pos >= r.t.chars.length

export function press(r: Run, key: string): Run {
  if (finished(r)) return r
  if (key === r.t.chars[r.pos]) return { ...r, pos: skip(r.t, r.pos + 1), keys: r.keys + 1, wrong: false }
  return { ...r, keys: r.keys + 1, mistakes: r.mistakes + 1, wrong: true }
}

// Characters you actually type (auto ones don't count toward speed).
export const typedChars = (t: Target) => t.auto.filter((a) => !a).length

// The usual typing-test measure: one word is five characters.
export const wpm = (chars: number, ms: number) => (ms > 0 ? chars / 5 / (ms / 60_000) : 0)
export const accuracy = (keys: number, mistakes: number) => (keys ? (100 * (keys - mistakes)) / keys : 100)
