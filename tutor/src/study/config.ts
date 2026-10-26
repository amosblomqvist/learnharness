// Config files you write in lessons (Kubernetes YAML, Terraform HCL, IAM JSON, Dockerfiles), parsed
// locally and checked against the step's rules. The parsers cover what the lessons use, and report
// errors with a line number the way the real tools would.
import type { Check, ConfigLang } from "./types"

export class ConfigError extends Error {
  constructor(
    message: string,
    public line?: number
  ) {
    super(line ? `line ${line}: ${message}` : message)
  }
}

// ---------- YAML ----------
type YLine = { n: number; indent: number; text: string }

function stripComment(s: string): string {
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q && s[i - 1] !== "\\") q = null
    } else if (c === '"' || c === "'") q = c
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s.trimEnd()
}

function scalar(raw: string, n: number): unknown {
  const s = raw.trim()
  if (s === "" || s === "~" || s === "null") return null
  if (s === "true") return true
  if (s === "false") return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s.startsWith('"')) {
    if (!/"$/.test(s) || s.length < 2) throw new ConfigError("a quoted string isn't closed", n)
    return JSON.parse(s)
  }
  if (s.startsWith("'")) {
    if (!/'$/.test(s) || s.length < 2) throw new ConfigError("a quoted string isn't closed", n)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith("[") || s.startsWith("{")) return flow(s, n)
  if (/^[&*!]/.test(s)) throw new ConfigError("anchors, aliases and tags aren't used in these lessons", n)
  return s
}

// Flow style: [a, b] and {k: v}, nested.
function flow(s: string, n: number): unknown {
  let i = 0
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  const item = (stop: string): unknown => {
    ws()
    if (s[i] === "[") {
      i++
      const out: unknown[] = []
      ws()
      if (s[i] === "]") return i++, out
      for (;;) {
        out.push(item(",]"))
        ws()
        if (s[i] === ",") i++
        else if (s[i] === "]") return i++, out
        else throw new ConfigError("a [list] isn't closed", n)
      }
    }
    if (s[i] === "{") {
      i++
      const out: Record<string, unknown> = {}
      ws()
      if (s[i] === "}") return i++, out
      for (;;) {
        ws()
        let k = ""
        while (i < s.length && s[i] !== ":" && s[i] !== "}") k += s[i++]
        if (s[i] !== ":") throw new ConfigError("a {map} entry needs key: value", n)
        i++
        out[String(scalar(k, n))] = item(",}")
        ws()
        if (s[i] === ",") i++
        else if (s[i] === "}") return i++, out
        else throw new ConfigError("a {map} isn't closed", n)
      }
    }
    let t = ""
    let q: string | null = null
    while (i < s.length && (q || !stop.includes(s[i]))) {
      if (q && s[i] === q) q = null
      else if (!q && (s[i] === '"' || s[i] === "'")) q = s[i]
      t += s[i++]
    }
    return scalar(t, n)
  }
  const v = item("")
  ws()
  if (i < s.length) throw new ConfigError(`unexpected "${s.slice(i)}"`, n)
  return v
}

// "key: rest" outside quotes; null if the line isn't a mapping entry.
function keyOf(text: string): { key: string; rest: string } | null {
  let q: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === q) q = null
    } else if ((c === '"' || c === "'") && i === 0) q = c
    else if (c === ":" && (i === text.length - 1 || text[i + 1] === " ")) {
      const k = text.slice(0, i).trim()
      return { key: k.startsWith('"') || k.startsWith("'") ? String(scalar(k, 0)) : k, rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

export function parseYaml(src: string): unknown[] {
  const raw = src.replace(/\r\n/g, "\n").split("\n")
  const docs: unknown[] = []
  let cur: YLine[] = []
  const flush = () => {
    if (cur.length) docs.push(parseDoc(cur, raw))
    cur = []
  }
  raw.forEach((l, idx) => {
    if (/^---\s*$/.test(l)) return flush()
    if (/^\t/.test(l) || /^ *\t/.test(l)) throw new ConfigError("YAML doesn't allow tabs for indentation; use spaces", idx + 1)
    const t = stripComment(l)
    if (!t.trim()) return
    cur.push({ n: idx + 1, indent: t.length - t.trimStart().length, text: t.trim() })
  })
  flush()
  return docs
}

function parseDoc(lines: YLine[], raw: string[]): unknown {
  let i = 0
  const isItem = (l: YLine) => l.text === "-" || l.text.startsWith("- ")

  const node = (ind: number): unknown => {
    const l = lines[i]
    if (isItem(l)) return seq(l.indent)
    if (keyOf(l.text)) return map(l.indent)
    i++
    return scalar(l.text, l.n)
  }

  const blockScalar = (style: string, keyLine: YLine, parentInd: number): string => {
    const out: string[] = []
    let r = keyLine.n // raw index of the next line
    let base = -1
    while (r < raw.length) {
      const line = raw[r]
      if (line.trim() === "") {
        out.push("")
        r++
        continue
      }
      const ind = line.length - line.trimStart().length
      if (ind <= parentInd) break
      if (base < 0) base = ind
      out.push(line.slice(base))
      r++
    }
    while (i < lines.length && lines[i].n <= r) i++
    while (out.length && out[out.length - 1] === "") out.pop()
    const keep = !style.includes("-")
    const body = style.startsWith(">") ? out.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ") : out.join("\n")
    return body + (keep && out.length ? "\n" : "")
  }

  const value = (rest: string, l: YLine, ind: number): unknown => {
    if (/^[|>][-+]?$/.test(rest)) {
      i++
      return blockScalar(rest, l, ind)
    }
    i++
    if (rest !== "") return scalar(rest, l.n)
    const next = lines[i]
    if (!next) return null
    if (next.indent > ind) return node(next.indent)
    if (next.indent === ind && isItem(next)) return seq(ind)
    return null
  }

  const map = (ind: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    while (i < lines.length) {
      const l = lines[i]
      if (l.indent < ind) break
      if (l.indent > ind) throw new ConfigError("this line is indented more than the lines around it", l.n)
      if (isItem(l)) break
      const kv = keyOf(l.text)
      if (!kv) throw new ConfigError(`expected "key: value", found "${l.text}"`, l.n)
      if (kv.key in out) throw new ConfigError(`"${kv.key}" appears twice in the same map`, l.n)
      out[kv.key] = value(kv.rest, l, ind)
    }
    return out
  }

  const seq = (ind: number): unknown[] => {
    const out: unknown[] = []
    while (i < lines.length) {
      const l = lines[i]
      if (l.indent < ind) break
      if (l.indent > ind) throw new ConfigError("this line is indented more than the list item above it", l.n)
      if (!isItem(l)) break
      const rest = l.text === "-" ? "" : l.text.slice(2)
      if (rest.trim() === "") {
        i++
        const next = lines[i]
        out.push(next && next.indent > ind ? node(next.indent) : null)
        continue
      }
      const inner = ind + l.text.indexOf(rest)
      if (keyOf(rest)) {
        // "- key: v": the item is a map whose keys line up with "key".
        lines[i] = { n: l.n, indent: inner, text: rest.trim() }
        out.push(map(inner))
      } else if (isItem({ ...l, text: rest })) {
        lines[i] = { n: l.n, indent: inner, text: rest.trim() }
        out.push(seq(inner))
      } else {
        i++
        out.push(scalar(rest, l.n))
      }
    }
    return out
  }

  const first = lines[0]
  if (first.indent !== 0) throw new ConfigError("the first line shouldn't be indented", first.n)
  const v = node(0)
  if (i < lines.length) throw new ConfigError(`unexpected line "${lines[i].text}" (check its indentation)`, lines[i].n)
  return v
}

// ---------- HCL (Terraform) ----------
// Values: strings, numbers, bools, null, lists, objects. Anything else (a reference such as
// aws_s3_bucket.logs.id, a function call, a condition) is kept as { expr: "its text" }.
type Tok = { t: "id" | "str" | "num" | "p" | "nl" | "heredoc"; v: string; n: number; s?: number; e?: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let n = 1
  while (i < src.length) {
    const c = src[i]
    const s0 = i
    const before = out.length
    step()
    // Where each token sits in the source, so an expression can be quoted back as written.
    if (out.length > before) Object.assign(out[out.length - 1], { s: s0, e: i })
  }
  return out
  function step() {
    const c = src[i]
    if (c === "\n") {
      out.push({ t: "nl", v: "\n", n })
      n++
      i++
    } else if (/\s/.test(c)) i++
    else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      if (end < 0) throw new ConfigError("a /* comment */ isn't closed", n)
      n += src.slice(i, end).split("\n").length - 1
      i = end + 2
    } else if (c === '"') {
      let j = i + 1
      let depth = 0
      let s = ""
      while (j < src.length) {
        if (src[j] === "\\") {
          s += src[j] + src[j + 1]
          j += 2
          continue
        }
        if (src[j] === "$" && src[j + 1] === "{") depth++
        else if (src[j] === "}" && depth) depth--
        else if (src[j] === '"' && !depth) break
        else if (src[j] === "\n") throw new ConfigError("a string isn't closed before the end of the line", n)
        s += src[j++]
      }
      if (j >= src.length) throw new ConfigError("a string isn't closed", n)
      out.push({ t: "str", v: s.replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n"), n })
      i = j + 1
    } else if (c === "<" && src[i + 1] === "<") {
      const m = /^<<(-?)(\w+)\n/.exec(src.slice(i))
      if (!m) throw new ConfigError("a heredoc needs <<EOF and a new line", n)
      const startN = n
      const rest = src.slice(i + m[0].length)
      const end = new RegExp(`^\\s*${m[2]}\\s*$`, "m").exec(rest)
      if (!end) throw new ConfigError(`the heredoc isn't closed with ${m[2]}`, n)
      const body = rest.slice(0, end.index)
      n += body.split("\n").length
      out.push({ t: "heredoc", v: body, n: startN })
      i += m[0].length + end.index + end[0].length
    } else if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!
      out.push({ t: "num", v: m[0], n })
      i += m[0].length
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w-]*(\.[\w*-]+|\[[^\]]*\])*/.exec(src.slice(i))!
      out.push({ t: "id", v: m[0], n })
      i += m[0].length
    } else {
      const two = src.slice(i, i + 2)
      if (["==", "!=", ">=", "<=", "&&", "||", "=>", "..."].includes(two) || src.slice(i, i + 3) === "...") {
        const v = src.slice(i, i + 3) === "..." ? "..." : two
        out.push({ t: "p", v, n })
        i += v.length
      } else {
        out.push({ t: "p", v: c, n })
        i++
      }
    }
  }
}

export function parseHcl(raw: string): Record<string, unknown> {
  const src = raw.replace(/\r\n/g, "\n")
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const skipNl = () => {
    while (peek()?.t === "nl") i++
  }
  const expect = (v: string) => {
    const t = toks[i]
    if (!t || t.v !== v) throw new ConfigError(`expected "${v}"${t ? ` but found "${t.v.trim() || "a new line"}"` : " before the end of the file"}`, t?.n ?? toks[toks.length - 1]?.n)
    i++
  }

  // An expression ends at a new line, "," or a closing bracket at depth 0.
  const expr = (): unknown => {
    skipNl()
    const t = peek()
    if (!t) throw new ConfigError("a value is missing at the end of the file")
    const start = i
    const simple = (v: unknown) => {
      i++
      const nx = peek()
      if (!nx || nx.t === "nl" || [",", "}", "]", ")"].includes(nx.v)) return { done: true, v }
      i = start
      return { done: false, v: null }
    }
    if (t.t === "str") {
      const r = simple(t.v)
      if (r.done) return r.v
    } else if (t.t === "heredoc") {
      const r = simple(t.v)
      if (r.done) return r.v
    } else if (t.t === "num") {
      const r = simple(Number(t.v))
      if (r.done) return r.v
    } else if (t.t === "id" && ["true", "false", "null"].includes(t.v)) {
      const r = simple(t.v === "null" ? null : t.v === "true")
      if (r.done) return r.v
    } else if (t.v === "[" ) {
      i++
      const out: unknown[] = []
      for (;;) {
        skipNl()
        if (peek()?.v === "]") {
          i++
          break
        }
        out.push(expr())
        skipNl()
        if (peek()?.v === ",") i++
        else if (peek()?.v === "]") {
          i++
          break
        } else throw new ConfigError("a [list] needs commas between items and a closing ]", peek()?.n)
      }
      const nx = peek()
      if (!nx || nx.t === "nl" || [",", "}", "]", ")"].includes(nx.v)) return out
      i = start
    } else if (t.v === "{") {
      i++
      const out: Record<string, unknown> = {}
      for (;;) {
        skipNl()
        if (peek()?.v === "}") {
          i++
          break
        }
        const k = toks[i++]
        if (!k || (k.t !== "id" && k.t !== "str")) throw new ConfigError("an object needs key = value pairs", k?.n)
        if (peek()?.v !== "=" && peek()?.v !== ":") throw new ConfigError(`expected "=" after "${k.v}"`, k.n)
        i++
        out[k.v] = expr()
        if (peek()?.v === ",") i++
      }
      const nx = peek()
      if (!nx || nx.t === "nl" || [",", "}", "]", ")"].includes(nx.v)) return out
      i = start
    }
    // Anything else: keep the text up to the end of the expression.
    let depth = 0
    const first = i
    while (i < toks.length) {
      const x = toks[i]
      if (depth === 0 && (x.t === "nl" || [",", "}", "]", ")"].includes(x.v))) break
      if (["(", "[", "{"].includes(x.v)) depth++
      if ([")", "]", "}"].includes(x.v)) depth--
      i++
    }
    const text = i > first ? src.slice(toks[first].s, toks[i - 1].e).replace(/\s+/g, " ").trim() : ""
    if (!text) throw new ConfigError("a value is missing", t.n)
    if (/(^|[^=!<>])=([^=>]|$)/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')) && !/[({[]/.test(text)) throw new ConfigError("put each attribute on its own line", t.n)
    return { expr: text.trim() }
  }

  const body = (closing: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const counts: Record<string, number> = {}
    for (;;) {
      skipNl()
      const t = peek()
      if (!t) {
        if (closing) throw new ConfigError("a block isn't closed with }", toks[toks.length - 1]?.n)
        return out
      }
      if (t.v === "}") {
        if (!closing) throw new ConfigError('there is a "}" with no block to close', t.n)
        i++
        return out
      }
      if (t.t !== "id") throw new ConfigError(`expected an attribute or a block, found "${t.v}"`, t.n)
      i++
      if (peek()?.v === "=") {
        i++
        if (t.v in out) throw new ConfigError(`"${t.v}" is set twice`, t.n)
        out[t.v] = expr()
        const nx = peek()
        if (nx && nx.t !== "nl" && nx.v !== "}") throw new ConfigError(`put each attribute on its own line (after "${t.v}")`, nx.n)
        continue
      }
      const labels: string[] = []
      while (peek() && (peek().t === "str" || peek().t === "id") && peek().v !== "{") labels.push(toks[i++].v)
      if (peek()?.v !== "{") throw new ConfigError(`"${t.v}" needs "=" (an attribute) or "{" (a block)`, t.n)
      i++
      const inner = body(true)
      if (!labels.length) {
        counts[t.v] = (counts[t.v] ?? 0) + 1
        if (counts[t.v] === 1) out[t.v] = inner
        else if (counts[t.v] === 2) out[t.v] = [out[t.v], inner]
        else (out[t.v] as unknown[]).push(inner)
      } else {
        let at = (out[t.v] ??= {}) as Record<string, unknown>
        for (const lab of labels.slice(0, -1)) at = (at[lab] ??= {}) as Record<string, unknown>
        const last = labels[labels.length - 1]
        if (last in at) throw new ConfigError(`${t.v} ${labels.map((x) => `"${x}"`).join(" ")} is declared twice`, t.n)
        at[last] = inner
      }
    }
  }
  return body(false)
}

// ---------- Dockerfile ----------
// { FROM: [...args], RUN: [...], …, ops: [...], seq: "FROM x\nRUN y\n…" }
export function parseDockerfile(src: string): Record<string, unknown> {
  const out: Record<string, string[] | string> = {}
  const ops: string[] = []
  const seq: string[] = []
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  for (let k = 0; k < lines.length; k++) {
    let l = lines[k]
    const n = k + 1
    if (!l.trim() || l.trim().startsWith("#")) continue
    while (/\\\s*$/.test(l) && k + 1 < lines.length) l = l.replace(/\\\s*$/, " ") + lines[++k].trim()
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(l)
    if (!m) throw new ConfigError(`"${l.trim()}" isn't an instruction (FROM, RUN, COPY, …)`, n)
    const op = m[1].toUpperCase()
    const known = ["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL"]
    if (!known.includes(op)) throw new ConfigError(`unknown instruction ${op}`, n)
    const args = m[2].trim().replace(/\s+/g, " ")
    ;((out[op] ??= []) as string[]).push(args)
    ops.push(op)
    seq.push(`${op} ${args}`)
  }
  if (ops[0] !== "FROM" && ops[0] !== "ARG") throw new ConfigError("a Dockerfile starts with FROM")
  return { ...out, ops, seq: seq.join("\n") }
}

export function parseConfig(lang: ConfigLang, src: string): unknown {
  if (lang === "yaml") {
    const docs = parseYaml(src)
    if (!docs.length) throw new ConfigError("the file is empty")
    return docs
  }
  if (lang === "hcl") return parseHcl(src)
  if (lang === "dockerfile") return parseDockerfile(src)
  try {
    return JSON.parse(src)
  } catch (e) {
    const m = /position (\d+)/.exec((e as Error).message)
    const line = m ? src.slice(0, Number(m[1])).split("\n").length : undefined
    throw new ConfigError((e as Error).message.replace(/^JSON\.parse: /, "").replace(/ in JSON at position \d+.*$/, ""), line)
  }
}

// ---------- checks ----------
// <path> exists | missing | = v | != v | == <path> | ~ /re/ | !~ /re/ | has v | count n | >= n …
// A path is dot-separated: name, name[0], name[-1], name[*], name[key=value], "quoted.key".
// For YAML, a path starting with [ looks across all documents; otherwise it reads the first one.

function splitPath(p: string): string[] {
  const out: string[] = []
  let cur = ""
  let q = false
  let br = 0
  for (const c of p) {
    if (c === '"') q = !q
    if (!q && c === "[") br++
    if (!q && c === "]") br--
    if (c === "." && !q && !br) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.filter((s) => s !== "")
}

const lit = (s: string): unknown => {
  const t = s.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (t === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^".*"$/.test(t) || /^\[.*\]$/.test(t) || /^\{.*\}$/.test(t)) {
    try {
      return JSON.parse(t)
    } catch {}
  }
  return t
}

// Every value the path reaches ([*] fans out); undefined where a step is missing.
function resolve(root: unknown, path: string, lang: ConfigLang): unknown[] {
  let vals: unknown[] = [lang === "yaml" && !path.startsWith("[") ? (root as unknown[])[0] : root]
  for (const seg of splitPath(path)) {
    const m = /^("([^"]*)"|[^[]*)((?:\[[^\]]*\])*)$/.exec(seg)
    if (!m) throw new Error(`bad path segment ${seg}`)
    const name = m[2] ?? m[1]
    const sels = [...(m[3] ?? "").matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])
    const next: unknown[] = []
    for (const v0 of vals) {
      let cur: unknown[] = [name ? (v0 && typeof v0 === "object" ? (v0 as Record<string, unknown>)[name] : undefined) : v0]
      for (const sel of sels) {
        const out: unknown[] = []
        for (const c of cur) {
          // A single block where a list was expected reads as a list of one (HCL blocks, YAML).
          const arr = Array.isArray(c) ? c : c === undefined ? [] : [c]
          if (sel === "*") out.push(...(arr.length ? arr : [undefined]))
          else if (/^-?\d+$/.test(sel)) {
            const k = Number(sel)
            out.push(arr[k < 0 ? arr.length + k : k])
          } else {
            const eq = sel.indexOf("=")
            const key = sel.slice(0, eq)
            const want = lit(sel.slice(eq + 1))
            out.push(arr.find((x) => x && typeof x === "object" && (x as Record<string, unknown>)[key] === want))
          }
        }
        cur = out
      }
      next.push(...cur)
    }
    vals = next
  }
  return vals
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const show = (v: unknown) => (v === undefined ? "nothing" : typeof v === "string" ? `"${v}"` : JSON.stringify(v))

export type CheckResult = { ok: boolean; message: string; got?: string }

export function runCheck(root: unknown, c: Check, lang: ConfigLang): CheckResult {
  const m = /^(\S+)\s+(exists|missing|count|has|!=|==|=|!~|~|>=|<=|>|<)\s*(.*)$/.exec(c.expr.trim())
  if (!m) throw new Error(`bad check: ${c.expr}`)
  const [, path, op, arg] = m
  const vals = resolve(root, path, lang)
  const each = (fn: (v: unknown) => boolean) => vals.length > 0 && vals.every(fn)
  let ok: boolean
  switch (op) {
    case "exists":
      ok = each((v) => v !== undefined)
      break
    case "missing":
      ok = vals.every((v) => v === undefined)
      break
    case "=":
      ok = each((v) => same(v, lit(arg)))
      break
    case "!=":
      ok = each((v) => v !== undefined && !same(v, lit(arg)))
      break
    case "==": {
      const other = resolve(root, arg.trim(), lang)
      ok = vals.length > 0 && vals[0] !== undefined && vals.every((v) => other.some((o) => same(v, o)))
      break
    }
    case "~":
    case "!~": {
      const rm = /^\/(.*)\/([a-z]*)$/.exec(arg.trim())
      if (!rm) throw new Error(`bad regex in check: ${c.expr}`)
      const re = new RegExp(rm[1], rm[2])
      const str = (v: unknown) => (v && typeof v === "object" && "expr" in (v as object) ? String((v as { expr: string }).expr) : typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v ?? ""))
      ok = op === "~" ? each((v) => v !== undefined && re.test(str(v))) : vals.every((v) => v === undefined || !re.test(str(v)))
      break
    }
    case "has": {
      const want = lit(arg)
      ok = each((v) => (Array.isArray(v) ? v.some((x) => same(x, want)) : typeof v === "string" && v.includes(String(want))))
      break
    }
    case "count": {
      const n = Number(arg)
      ok = each((v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : -1) === n)
      break
    }
    default: {
      const n = Number(arg)
      const num = (v: unknown) => (typeof v === "number" ? v : NaN)
      ok = each((v) => (op === ">=" ? num(v) >= n : op === "<=" ? num(v) <= n : op === ">" ? num(v) > n : num(v) < n))
    }
  }
  return { ok, message: c.message, got: ok ? undefined : vals.length > 1 ? vals.map(show).join(", ") : show(vals[0]) }
}

export type ConfigRun = { ok: boolean; error?: string; results: CheckResult[] }

export function checkConfig(lang: ConfigLang, src: string, checks: Check[]): ConfigRun {
  let root: unknown
  try {
    root = parseConfig(lang, src)
  } catch (e) {
    return { ok: false, error: (e as Error).message, results: [] }
  }
  const results = checks.map((c) => runCheck(root, c, lang))
  return { ok: results.every((r) => r.ok), results }
}
