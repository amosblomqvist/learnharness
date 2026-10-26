// Parses a module file. The format, in short:
//
//   # Module title            then header lines: id, blurb, why, stage: id | Title | outcome, rewrite: true
//   ## Lesson title           then header lines: id, stage, needs, minutes, goal, source: Title | url, project,
//                             show: expr -> kind (the world card: run the expression against the
//                             solution and draw what it returned)
//   (blank line, then the lesson's Markdown)
//   ::: quiz                  a step, up to a line that is just ":::"
//   q: question (Markdown, may run over several lines)
//   - wrong option
//   + right option
//   why: explanation
//   :::
//
// Step kinds and their fields: quiz (q, +/- options, why), predict lang= (q, code, answer, why),
// project folder= (task, file: path + fence for the starting files, test: name + fence for the hidden
// acceptance tests, solution: path + fence for each reference file, hint; "local" runs the tests
// with the project's own toolchain outside the sandbox),
// card (q, answer), write lang= (task, starter, tests, solution, hint, and any number of
// "wrong: why" (+ an optional "fail: runtime|types" line before the fence, saying HOW the wrong
// answer must fail; check:study enforces that) + fence: answers the tests must reject, checked by
// check:study, never shown), shell (task, file: path +
// fence, expect or verify, solution, hint; "git" flag; "vm" runs it on a lab machine, "peer=name"
// adds a second one with peersetup/peerverify, "fullvm" or "disks=2G,1G" make it a VM with blank
// disks), term (a live lab machine: task, file:, setup, verify, solution, scripted, hint; the same
// attributes), config lang= (task, starter, check: expr | message,
// solution, hint). A code field is a fenced block on the lines after "field:".
import type { Check, ConfigLang, Lang, Lesson, Module, Option, Step } from "./types"

const FIELDS = new Set(["q", "why", "answer", "task", "starter", "tests", "solution", "hint", "wrong", "fail", "test", "expect", "verify", "file", "check", "code", "setup", "types", "peersetup", "peerverify", "scripted"])
const isFence = (l: string) => /^\s*(```|~~~)/.test(l)

type Field = { key: string; arg: string; lines: string[]; fail?: string }

function splitFields(lines: string[], options: boolean): { fields: Field[]; options: Option[] } {
  const fields: Field[] = []
  const opts: Option[] = []
  let cur: Field | null = null
  let fence = false
  for (const l of lines) {
    if (!fence) {
      const m = /^([a-z]+):\s?(.*)$/.exec(l)
      if (m && FIELDS.has(m[1])) {
        // "fail: runtime|types" belongs to the wrong answer above it, not to itself: keep the
        // mark on that field so its code fence stays with the wrong answer. (see types.ts)
        if (m[1] === "fail" && fields[fields.length - 1]?.key === "wrong") {
          fields[fields.length - 1].fail = m[2]
          cur = fields[fields.length - 1]
          continue
        }
        cur = { key: m[1], arg: m[2], lines: [] }
        fields.push(cur)
        continue
      }
      if (options && /^[+-] /.test(l)) {
        opts.push({ text: l.slice(2).trim(), right: l[0] === "+" })
        cur = null
        continue
      }
    }
    if (isFence(l)) fence = !fence
    if (cur) cur.lines.push(l)
  }
  return { fields, options: opts }
}

// The text of a field: its inline part plus the lines after it. "field: |" (as in YAML) starts a
// block on the next lines, which may be indented: the common indentation is removed.
function text(f: Field | undefined): string {
  if (!f) return ""
  if (f.arg.trim() === "|") {
    const indent = Math.min(...f.lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length))
    return f.lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n").trim()
  }
  return [f.arg, ...f.lines].join("\n").trim()
}

// A code field: the inside of its fenced block (or the inline value).
function code(f: Field | undefined): string {
  if (!f) return ""
  const t = text(f)
  const m = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(t)
  return m ? m[2] : t
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/(\w+)(?:=(\S+))?/g)) out[m[1]] = m[2] ?? "true"
  return out
}

function step(head: string, body: string[], where: string): Step {
  const [kind, ...rest] = head.trim().split(/\s+/)
  const a = attrs(rest.join(" "))
  const { fields, options } = splitFields(body, kind === "quiz")
  const one = (k: string) => fields.find((f) => f.key === k)
  const need = (k: string) => {
    const f = one(k)
    if (!f) throw new Error(`${where}: ${kind} step needs "${k}:"`)
    return f
  }
  switch (kind) {
    case "quiz": {
      if (options.filter((o) => o.right).length !== 1) throw new Error(`${where}: a quiz needs exactly one "+" option`)
      if (options.length < 2) throw new Error(`${where}: a quiz needs two or more options`)
      return { kind, q: text(need("q")), options, why: text(one("why")) }
    }
    case "predict":
      return { kind, lang: (a.lang ?? "python") as Lang, q: text(one("q")) || "What does this print?", code: code(need("code")), answer: code(need("answer")), why: text(one("why")) }
    case "card":
      return { kind, q: text(need("q")), answer: text(need("answer")) }
    case "write": {
      // Wrong answers: "wrong: why" (+ an optional "fail: runtime|types" line before the fence,
      // kept on the field itself by splitFields) then the code fence. check:study demands that
      // failure mode, so it can never be rounded off into "the tests caught it".
      const wrongs: { why: string; code: string; fail?: "runtime" | "types" }[] = []
      for (const f of fields) {
        if (f.key !== "wrong") continue
        const mark = f.fail?.trim()
        if (mark !== undefined && mark !== "runtime" && mark !== "types") throw new Error(`${where}: fail: needs "runtime" or "types"`)
        if (mark === "types" && (a.lang ?? "python") !== "typescript") throw new Error(`${where}: fail: types only means something in write lang=typescript`)
        wrongs.push({ why: f.arg.trim(), code: code({ ...f, arg: "" }), fail: (mark || undefined) as "runtime" | "types" | undefined })
      }
      return {
        kind,
        lang: (a.lang ?? "python") as "python" | "typescript",
        task: text(need("task")),
        starter: code(one("starter")),
        tests: code(need("tests")),
        types: code(one("types")) || undefined,
        solution: code(need("solution")),
        hint: text(one("hint")),
        wrong: wrongs
      }
    }
    case "shell":
    case "term": {
      const files: Record<string, string> = {}
      // Text files end with a new line, like any file an editor saves.
      for (const f of fields.filter((x) => x.key === "file")) {
        const body = code({ ...f, arg: "" })
        files[f.arg.trim()] = body && !body.endsWith("\n") ? body + "\n" : body
      }
      if (a.peer !== undefined && !/^[a-z][a-z0-9-]{0,30}$/.test(a.peer)) throw new Error(`${where}: peer= needs a hostname like "backup"`)
      const peer = a.peer ? { peer: a.peer, peerSetup: code(one("peersetup")) || undefined, peerVerify: code(one("peerverify")) || undefined } : {}
      const disks = a.disks ? a.disks.split(",") : undefined
      if (disks?.some((d) => !/^\d{1,3}[MG]$/.test(d)) || (disks?.length ?? 0) > 4) throw new Error(`${where}: disks= takes up to four sizes like "2G,512M"`)
      const vm = a.fullvm === "true" || !!disks ? { fullvm: true, disks } : {}
      const base = { task: text(need("task")), files, setup: code(one("setup")) || undefined, solution: code(need("solution")), hint: text(one("hint")), ...peer, ...vm }
      if (kind === "term") return { kind, ...base, verify: code(need("verify")), scripted: code(one("scripted")) || undefined }
      const expect = one("expect")
      const verify = one("verify")
      if (!expect && !verify && !peer.peerVerify) throw new Error(`${where}: a shell step needs "expect:" or "verify:"`)
      return { kind, ...base, expect: expect ? code(expect) : undefined, verify: verify ? code(verify) : undefined, git: a.git === "true", secret: a.secret === "true", vm: a.vm === "true" || !!a.peer || !!base.fullvm }
    }
    case "project": {
      if (!a.folder || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(a.folder)) throw new Error(`${where}: a project step needs folder=name (lower case, dashes)`)
      const byPath = (key: string) => {
        const out: Record<string, string> = {}
        for (const f of fields.filter((x) => x.key === key)) {
          const p = f.arg.trim()
          if (!p || p.startsWith("/") || p.split("/").includes("..")) throw new Error(`${where}: ${key}: needs a relative path`)
          const body = code({ ...f, arg: "" })
          out[p] = body && !body.endsWith("\n") ? body + "\n" : body
        }
        return out
      }
      const tests = byPath("test")
      const solution = byPath("solution")
      if (!Object.keys(tests).length) throw new Error(`${where}: a project step needs at least one "test: test_x.py"`)
      if (!Object.keys(solution).length) throw new Error(`${where}: a project step needs its reference "solution: path" files`)
      return { kind, task: text(need("task")), folder: a.folder, files: byPath("file"), tests, solution, hint: text(one("hint")), local: a.local === "true" }
    }
    case "config": {
      const checks: Check[] = fields
        .filter((f) => f.key === "check")
        .map((f) => {
          const t = text(f)
          const i = t.lastIndexOf(" | ")
          if (i < 0) throw new Error(`${where}: check needs "expr | message": ${t}`)
          return { expr: t.slice(0, i).trim(), message: t.slice(i + 3).trim() }
        })
      if (!checks.length) throw new Error(`${where}: a config step needs checks`)
      return { kind, lang: (a.lang ?? "yaml") as ConfigLang, task: text(need("task")), starter: code(one("starter")), checks, solution: code(need("solution")), hint: text(one("hint")) }
    }
  }
  throw new Error(`${where}: unknown step kind "${kind}"`)
}

function headers(lines: string[]): { head: Record<string, string[]>; rest: string[] } {
  const head: Record<string, string[]> = {}
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^([a-z]+):\s*(.*)$/.exec(lines[i])
    if (!m) break
    ;(head[m[1]] ??= []).push(m[2].trim())
  }
  return { head, rest: lines.slice(i) }
}

export function parseModule(src: string, file = "module"): Module {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  // Split into the module header and the lessons at "## " lines outside fences.
  const chunks: string[][] = [[]]
  let fence = false
  for (const l of lines) {
    if (isFence(l)) fence = !fence
    if (!fence && l.startsWith("## ")) chunks.push([])
    chunks[chunks.length - 1].push(l)
  }
  const top = chunks[0]
  const titleLine = top.findIndex((l) => l.startsWith("# "))
  if (titleLine < 0) throw new Error(`${file}: no "# Title" line`)
  const { head } = headers(top.slice(titleLine + 1))
  const id = head.id?.[0]
  if (!id) throw new Error(`${file}: no id`)
  const stages = (head.stage ?? []).map((s) => {
    const [sid, title, outcome] = s.split("|").map((x) => x.trim())
    return { id: sid, title, outcome: outcome ?? "" }
  })
  const lessons: Lesson[] = chunks.slice(1).map((ch) => {
    const title = ch[0].slice(3).trim()
    const { head: h, rest } = headers(ch.slice(1))
    const lid = h.id?.[0]
    const where = `${file} › ${title}`
    if (!lid) throw new Error(`${where}: no id`)
    const body: string[] = []
    const steps: Step[] = []
    let inStep: { head: string; lines: string[] } | null = null
    let f = false
    for (const l of rest) {
      if (inStep) {
        if (!f && l.trim() === ":::") {
          steps.push(step(inStep.head, inStep.lines, `${where} step ${steps.length + 1}`))
          inStep = null
          continue
        }
        if (isFence(l)) f = !f
        inStep.lines.push(l)
        continue
      }
      if (isFence(l)) f = !f
      if (!f && l.startsWith("::: ")) {
        inStep = { head: l.slice(4), lines: [] }
        continue
      }
      body.push(l)
    }
    if (inStep) throw new Error(`${where}: step not closed with ":::"`)
    const stage = h.stage?.[0] ?? stages[0]?.id ?? ""
    if (!stages.some((s) => s.id === stage)) throw new Error(`${where}: unknown stage "${stage}"`)
    if ((h.show?.length ?? 0) > 1) throw new Error(`${where}: one show: line per lesson`)
    const sm = /^([\s\S]+) -> ([\w-]+)$/.exec((h.show?.[0] ?? "").trim())
    if (h.show?.[0] && !sm) throw new Error(`${where}: show needs "expr -> kind"`)
    return {
      id: lid,
      module: id,
      title,
      stage,
      needs: (h.needs?.[0] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      minutes: Number(h.minutes?.[0] ?? 15),
      goal: h.goal?.[0] ?? "",
      body: body.join("\n").trim(),
      steps,
      sources: (h.source ?? []).map((s) => {
        const i = s.lastIndexOf("|")
        return { title: s.slice(0, i).trim(), url: s.slice(i + 1).trim() }
      }),
      project: h.project?.[0] === "yes",
      show: sm ? { expr: sm[1].trim(), kind: sm[2] } : undefined
    }
  })
  const ids = new Set<string>()
  for (const l of lessons) {
    if (ids.has(l.id)) throw new Error(`${file}: duplicate lesson id ${l.id}`)
    ids.add(l.id)
  }
  for (const l of lessons) for (const n of l.needs) if (!ids.has(n) && !n.includes("/")) throw new Error(`${file} › ${l.title}: needs unknown lesson "${n}"`)
  return { id, title: top[titleLine].slice(2).trim(), blurb: head.blurb?.[0] ?? "", why: head.why?.[0] ?? "", stages, lessons, rewrite: head.rewrite?.[0] === "true" }
}
