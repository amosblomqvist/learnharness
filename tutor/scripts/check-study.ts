// Checks every premade module: it parses, links resolve, and every exercise really works.
//   predict  the code prints exactly the answer
//   write    the solution passes the tests, the starter and every "wrong:" answer don't; a wrong
//            answer marked fail: "runtime"|/types must fail exactly that way (the tests catch it
//            vs. tsc refuses it); a lesson's show: fixture is run against the solution and must
//            fit the card
//   shell    the solution passes, doing nothing doesn't
//   term     the same, on a fresh lab machine (with "scripted" when the solution is interactive)
//   config   the solution passes every check, the starter doesn't
//   project  the reference files pass the hidden tests in a fresh folder, the starting files don't
//            ("local" projects need their own toolchain and are skipped)
// Run: node scripts/check-study.mjs [module-id or module-id/lesson-id ...]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseModule } from "../src/study/parse"
import { toCard } from "../src/study/world"
import { checkConfig } from "../src/study/config"
import { runCode, runExercise, runFolderTests, runShell, runShow } from "../electron/lab"
import { hasDiskMachine, labStatus, runServerTask } from "../electron/linuxlab"
import type { Module } from "../src/study/types"

const norm = (t: string) =>
  t
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .join("\n")
    .trim()

// Disk-machine runs boot real VMs inside the lab: one at a time (memory, and Incus 6.0.0's races).
let vmSlots = 1
const waiting: (() => void)[] = []
async function oneVm<T>(f: () => Promise<T>): Promise<T> {
  if (vmSlots === 0) await new Promise<void>((r) => waiting.push(r))
  else vmSlots--
  try {
    return await f()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else vmSlots++
  }
}
const serverTask = (o: Parameters<typeof runServerTask>[0]) => (o.fullvm ? oneVm(() => runServerTask(o)) : runServerTask(o))

async function main() {
  const dir = path.join(process.cwd(), "src/study/content")
  const only = process.argv.slice(2)
  const mods: Module[] = []
  let bad = 0
  const fail = (where: string, msg: string) => {
    bad++
    console.log(`✗ ${where}\n    ${msg.split("\n").join("\n    ")}`)
  }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    try {
      mods.push(parseModule(fs.readFileSync(path.join(dir, f), "utf8"), f))
    } catch (e) {
      fail(f, (e as Error).message)
    }
  }
  const all = new Map(mods.map((m) => [m.id, m]))
  // Server tasks need the Linux lab (scripts/setup-linux-lab.sh). Without it they're skipped, loudly.
  const lab = (await labStatus()).state
  const labUp = lab === "running" || lab === "stopped"
  const disksUp = labUp && (await hasDiskMachine())
  let skipped = 0
  let steps = 0
  let lessons = 0
  let minutes = 0
  for (const m of mods) {
    if (only.length && !only.some((o) => o === m.id || o.startsWith(`${m.id}/`))) continue
    for (const l of m.lessons) {
      if (only.length && !only.includes(m.id) && !only.includes(`${m.id}/${l.id}`)) continue
      lessons++
      minutes += l.minutes
      for (const n of l.needs.filter((x) => x.includes("/"))) {
        const [mid, lid] = n.split("/")
        if (!all.get(mid)?.lessons.some((x) => x.id === lid)) fail(`${m.id}/${l.id}`, `needs ${n}, which doesn't exist`)
      }
      if (!l.body.trim()) fail(`${m.id}/${l.id}`, "no lesson text")
      // The world card: the fixture must run against the reference solution and fit the card.
      if (l.show) {
        const where = `${m.id}/${l.id} show`
        const ws = [...l.steps].reverse().find((x) => x.kind === "write")
        if (!ws) fail(where, "show needs a write step whose solution the fixture can run against")
        else {
          const r = await runShow(ws.lang, ws.solution, l.show.expr)
          const card = r.ok ? toCard(l.show.kind, r.value) : null
          if (!r.ok) fail(where, `the fixture doesn't run: ${r.error}`)
          else if (!card) fail(where, `the fixture's value doesn't fit the "${l.show.kind}" card: ${JSON.stringify(r.value)}`)
        }
      }
      const jobs = l.steps.map(async (s, i) => {
        const where = `${m.id}/${l.id} step ${i + 1} (${s.kind})`
        steps++
        try {
          if (s.kind === "predict") {
            const r = s.lang === "shell" ? await runShell({ files: {}, script: s.code }) : await runCode(s.lang, s.code)
            const out = r.stdout + (s.lang === "shell" ? "" : "")
            if (norm(out) !== norm(s.answer)) fail(where, `prints:\n${out.trim() || "(nothing)"}${r.stderr ? `\nstderr: ${r.stderr.trim()}` : ""}\nbut the answer says:\n${s.answer}`)
          } else if (s.kind === "write") {
            const good = await runExercise(s.lang, s.solution, s.tests, s.types)
            if (!good.ok) fail(where, `the solution fails: ${good.loadError ?? ""}${good.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.message}`).join("\n")}${good.typeErrors.map((e) => `type error line ${e.line}: ${e.message}`).join("\n")}`)
            const start = await runExercise(s.lang, s.starter, s.tests, s.types)
            if (start.ok) fail(where, "the starter already passes")
            for (const w of s.wrong ?? []) {
              const bad = await runExercise(s.lang, w.code, s.tests, s.types)
              if (bad.ok) fail(where, `a wrong answer passes (${w.why || "no reason given"}):\n${w.code}`)
              else if (w.fail === "runtime" && bad.typeErrors.length)
                fail(where, `a wrong answer marked fail: runtime is refused by tsc before the tests can speak: ${bad.typeErrors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}\n${w.code}`)
              else if (w.fail === "types") {
                if (!bad.typeErrors.length) fail(where, `a wrong answer marked fail: types passes tsc; its failure is only the tests\n${w.code}`)
                else {
                  const testsPassed = bad.loadError === undefined && bad.tests.length > 0 && bad.tests.every((t) => t.ok)
                  if (!testsPassed) fail(where, `a wrong answer marked fail: types must pass the tests and fail only tsc\n${w.code}`)
                }
              }
            }
          } else if (s.kind === "project") {
            // A local project needs its own toolchain: checked only with TUTOR_CHECK_LOCAL=1, after
            // `uv sync` in a copy of the reference solution.
            if (s.local && !process.env.TUTOR_CHECK_LOCAL) {
              skipped++
              return
            }
            const folder = (files: Record<string, string>) => {
              const d = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-project-"))
              for (const [rel, body] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true })
                fs.writeFileSync(path.join(d, rel), body)
              }
              return d
            }
            const good = folder({ ...s.files, ...s.solution })
            const start = folder(s.files)
            try {
              if (s.local) {
                const sync = spawnSync("uv", ["sync"], { cwd: good, encoding: "utf8", timeout: 300_000 })
                if (sync.status !== 0) fail(where, `uv sync failed in the reference solution:\n${(sync.stderr || sync.stdout).slice(-1500)}`)
              }
              const g = await runFolderTests(good, s.tests, s.local)
              if (!g.ok) fail(where, `the reference solution fails: ${g.loadError ?? ""}${g.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.message}`).join("\n")}`)
              const b = s.local ? { ok: false } : await runFolderTests(start, s.tests)
              if (b.ok) fail(where, "the starting files already pass")
            } finally {
              fs.rmSync(good, { recursive: true, force: true })
              fs.rmSync(start, { recursive: true, force: true })
            }
          } else if (s.kind === "shell") {
            const check = (r: Awaited<ReturnType<typeof runShell>>) => !r.timedOut && (s.expect === undefined || norm(r.stdout) === norm(s.expect)) && (!(s.verify || s.peerVerify) || !!r.verify?.ok)
            if ((s.vm && !labUp) || (s.fullvm && !disksUp)) {
              skipped++
              return
            }
            const exec = s.vm ? serverTask : runShell
            const task = { files: s.files, setup: s.setup, verify: s.verify, peer: s.peer, peerSetup: s.peerSetup, peerVerify: s.peerVerify, fullvm: s.fullvm, disks: s.disks }
            const good = await exec({ ...task, script: s.solution })
            if (!check(good)) fail(where, `the solution fails:\nstdout: ${good.stdout.trim()}\nstderr: ${good.stderr.trim()}${good.verify ? `\nverify: ${good.verify.out}` : ""}${s.expect !== undefined ? `\nexpected: ${s.expect}` : ""}`)
            const none = await exec({ ...task, script: "true" })
            if (check(none)) fail(where, "doing nothing passes")
          } else if (s.kind === "term") {
            // A live machine's Check is its verify against what you did: the same as a run of the
            // scripted solution (or the solution) on a fresh machine.
            if (!labUp || (s.fullvm && !disksUp)) {
              skipped++
              return
            }
            const task = { files: s.files, setup: s.setup, verify: s.verify, peer: s.peer, peerSetup: s.peerSetup, peerVerify: s.peerVerify, fullvm: s.fullvm, disks: s.disks }
            const good = await serverTask({ ...task, script: s.scripted ?? s.solution })
            if (!good.verify?.ok) fail(where, `the solution fails:\nstdout: ${good.stdout.trim()}\nstderr: ${good.stderr.trim()}${good.verify ? `\nverify: ${good.verify.out}` : ""}`)
            const none = await serverTask({ ...task, script: "true" })
            if (none.verify?.ok) fail(where, "doing nothing passes")
          } else if (s.kind === "config") {
            const good = checkConfig(s.lang, s.solution, s.checks)
            if (!good.ok) fail(where, `the solution fails: ${good.error ?? good.results.filter((r) => !r.ok).map((r) => `${r.message} (found ${r.got})`).join("; ")}`)
            const start = checkConfig(s.lang, s.starter, s.checks)
            if (start.ok) fail(where, "the starter already passes")
          }
        } catch (e) {
          fail(where, (e as Error).stack ?? String(e))
        }
      })
      // Lab runs are heavier (each boots a machine): at most a few at a time.
      await Promise.all(jobs)
    }
  }
  if (skipped) console.log(`\n${skipped} server task${skipped === 1 ? "" : "s"} skipped: the Linux lab${labUp ? "'s disk machine" : ""} isn't set up (bash scripts/setup-linux-lab.sh).`)
  console.log(`\n${mods.length} modules, ${lessons} lessons, ${steps} steps, ~${Math.round(minutes / 60)} h of lessons. ${bad ? `${bad} problem${bad === 1 ? "" : "s"}.` : "All good."}`)
  process.exit(bad ? 1 : 0)
}
void main()
