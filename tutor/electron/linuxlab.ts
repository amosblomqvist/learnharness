// Tutor's Linux lab: real Ubuntu for server exercises, while you stay on macOS.
// A small Lima VM (tutor-lab, set up by scripts/setup-linux-lab.sh) holds an Incus template
// container with a "clean" snapshot. Every run copies that snapshot into a fresh container
// (btrfs, so it's instant), boots it (real systemd, root, apt, networking), runs the step's
// setup, your commands and the check as root in /root, then deletes it. Nothing you do
// survives a run, and nothing touches your Mac: the VM has no access to its files.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ShellRun } from "./lab"

const VM = "tutor-lab"

function limactl(): string | null {
  const home = os.homedir()
  const cands = [path.join(home, ".local/bin/limactl"), path.join(home, ".local/opt/lima/bin/limactl"), "/opt/homebrew/bin/limactl", "/usr/local/bin/limactl"]
  return cands.find((c) => fs.existsSync(c)) ?? null
}

type Out = { stdout: string; stderr: string; code: number | null; timedOut: boolean }

function lima(args: string[], o: { stdin?: string; limitMs?: number } = {}): Promise<Out> {
  const bin = limactl()
  if (!bin) return Promise.resolve({ stdout: "", stderr: "limactl not found", code: 127, timedOut: false })
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, PATH: `${path.dirname(fs.realpathSync(bin))}:/usr/bin:/bin:/usr/sbin:/sbin` }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, o.limitMs ?? 60_000)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: String(err), code: 127, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    })
    child.stdin.end(o.stdin ?? "")
  })
}

export type LabStatus = { state: "no-lima" | "no-vm" | "stopped" | "running"; script: string }

// Where the setup script lives: next to the app code when packaged, in scripts/ when developing.
export function setupScript(): string {
  const appPath = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require("electron") as typeof import("electron")).app.getAppPath()
    } catch {
      return process.cwd()
    }
  })()
  const packaged = path.join(appPath, "setup-linux-lab.sh")
  return fs.existsSync(packaged) ? packaged : path.join(appPath, "scripts", "setup-linux-lab.sh")
}

export async function labStatus(): Promise<LabStatus> {
  const script = setupScript()
  if (!limactl()) return { state: "no-lima", script }
  const r = await lima(["list", "--format", "{{.Name}} {{.Status}}"], { limitMs: 15_000 })
  const line = r.stdout.split("\n").find((l) => l.startsWith(`${VM} `))
  if (!line) return { state: "no-vm", script }
  return { state: line.endsWith("Running") ? "running" : "stopped", script }
}

// Whether the lab has its disk machine (storage lessons need nested virtualization).
export async function hasDiskMachine(): Promise<boolean> {
  const r = await lima(["shell", "--workdir", "/", VM, "sudo", "incus", "snapshot", "list", "tutor-disk", "-f", "csv"], { limitMs: 30_000 })
  return r.code === 0 && /^clean,/m.test(r.stdout)
}

let starting: Promise<void> | null = null
let usedLab = false // so quitting can shut the VM down again
async function ensureRunning(): Promise<void> {
  usedLab = true
  const s = await labStatus()
  if (s.state === "running") return
  if (s.state !== "stopped") throw new Error(`The Linux lab isn't set up on this Mac yet. In Terminal, run: bash "${s.script}"`)
  starting ??= lima(["start", VM], { limitMs: 180_000 }).then((r) => {
    starting = null
    if (r.code !== 0) throw new Error(`The Linux lab VM didn't start: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`)
  })
  return starting
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

// The shell functions every lab script starts with. A script arrives on stdin, so every incus
// command gets </dev/null: incus reads YAML or input from a stdin that isn't a terminal, and would
// swallow the rest of the script. Streams come back base64-encoded between markers, so any bytes
// survive the trip.
const PRELUDE = `set -u
# If incusd is restarting, wait for it rather than failing the run.
incus admin waitready --timeout 60 </dev/null >/dev/null 2>&1 || true
fail() { echo "@@ERR $(printf '%s' "$1" | base64 -w0)"; exit 0; }
ip4() { incus exec "$1" -- sh -c "hostname -I | awk '{print \\$1}'" </dev/null 2>/dev/null; }
# booted <instance>: wait until systemd has finished starting up
booted() {
  for i in $(seq 1 160); do
    s=$(incus exec "$1" -- systemctl is-system-running </dev/null 2>/dev/null || true)
    case "$s" in running|degraded) return 0 ;; esac
    sleep 0.25
  done
}
# named <instance> <hostname>; rsyslog reads the hostname once at start, so it restarts
named() { incus exec "$1" -- sh -c 'hostname "$1"; echo "$1" > /etc/hostname; sed -i "/^127.0.1.1/d" /etc/hosts; echo "127.0.1.1 $1" >> /etc/hosts; systemctl try-restart rsyslog >/dev/null 2>&1' _ "$2" </dev/null; }
# mk <instance> <hostname>: a fresh copy of the template, booted, with the hostname lessons use
mk() {
  incus copy tutor-base/clean "$1" </dev/null >/dev/null 2>&1 || fail "Could not create a fresh machine (is the lab set up?)"
  incus start "$1" </dev/null >/dev/null 2>&1 || fail "The fresh machine did not start"
  booted "$1"
  named "$1" "$2"
}
# mkvm <instance> <hostname> [disk sizes...]: a fresh copy of the disk machine, a small VM with its
# own kernel, with a blank disk of each size attached on virtio (the first is /dev/vda). Its root
# disk is SCSI (/dev/sda): SCSI disks are probed in parallel, so blank disks on the same bus could
# swap names with it under load. virtio disks are named in the order they're attached, and the
# names are checked against the disks' serial numbers after boot all the same.
mkvm() {
  inst=$1; host=$2; shift 2
  incus copy tutor-disk/clean "$inst" -c limits.memory=768MiB </dev/null >/dev/null 2>&1 || fail "Could not create a fresh disk machine. It needs the lab's disk machine, which needs nested virtualization (a Mac with M3 or newer): run the lab setup again."
  n=0
  for size in "$@"; do
    n=$((n + 1))
    incus storage volume create default "$inst-d$n" --type=block size="$size" </dev/null >/dev/null 2>&1 || fail "Could not create a blank disk"
    incus config device add "$inst" "d$n" disk pool=default source="$inst-d$n" io.bus=virtio-blk </dev/null >/dev/null 2>&1 || fail "Could not attach a blank disk"
  done
  incus start "$inst" </dev/null >/dev/null 2>&1 || fail "The disk machine did not start"
  for i in $(seq 1 240); do incus exec "$inst" -- true </dev/null >/dev/null 2>&1 && break; sleep 0.5; done
  booted "$inst"
  incus list "$inst" -c s -f csv </dev/null 2>/dev/null | grep -q RUNNING || fail "The disk machine stopped while booting. The lab VM may be short of memory: close other live machines and try again."
  for k in $(seq 1 $n); do
    [ "$(incus exec "$inst" -- readlink -f "/dev/disk/by-id/virtio-incus_d$k" </dev/null 2>/dev/null)" = "/dev/vd$(echo abcd | cut -c$k)" ] || fail "The blank disks came up in an unexpected order. Run it again."
  done
  named "$inst" "$host"
}
# link <instance> <hostname> <instance> <hostname>: each machine reaches the other by name
link() {
  a=""; b=""
  for i in $(seq 1 80); do a=$(ip4 "$1"); b=$(ip4 "$3"); [ -n "$a" ] && [ -n "$b" ] && break; sleep 0.25; done
  [ -n "$a" ] && [ -n "$b" ] || fail "The machines didn't get network addresses"
  incus exec "$1" -- sh -c "echo '$b $4' >> /etc/hosts" </dev/null
  incus exec "$3" -- sh -c "echo '$a $2' >> /etc/hosts" </dev/null
}
# put <instance> <path under /root> <base64>
put() { printf '%s' "$3" | base64 -d | incus exec "$1" -- sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"' _ "/root/$2"; }
# xfer <from> <to>: what the first machine's setup left in /tmp/to-peer arrives in the other's /tmp/from-lab
xfer() {
  incus exec "$1" -- test -d /tmp/to-peer </dev/null 2>/dev/null || return 0
  incus exec "$1" -- tar -C /tmp/to-peer -cf - . </dev/null | incus exec "$2" -- sh -c 'mkdir -p /tmp/from-lab && tar -C /tmp/from-lab -xf -'
  incus exec "$1" -- rm -rf /tmp/to-peer </dev/null
}
# run <instance> <label> <base64 script> <seconds>: as root in /root, reported between markers
run() {
  t=$(mktemp)
  printf '%s' "$3" | base64 -d > "$t"
  incus file push "$t" "$1/tmp/.step.sh" </dev/null >/dev/null
  incus exec "$1" --cwd /root --env HOME=/root --env TERM=dumb --env DEBIAN_FRONTEND=noninteractive -- timeout --kill-after=2 "$4" bash /tmp/.step.sh </dev/null > "$t.out" 2> "$t.err"
  code=$?
  incus exec "$1" -- rm -f /tmp/.step.sh </dev/null
  echo "@@$2-OUT $(base64 -w0 < "$t.out")"
  echo "@@$2-ERR $(base64 -w0 < "$t.err")"
  echo "@@$2-CODE $code"
  rm -f "$t" "$t.out" "$t.err"
}
`

// What a lab exercise is made of. "peer" names a second machine on the same network (each can
// reach the other by hostname); the learner works on "lab", the peer is set up and checked too.
// "fullvm" makes "lab" a small VM with its own kernel instead of a container, and "disks" gives
// that VM blank disks of these sizes (like "2G"): /dev/vda, /dev/vdb…
export type LabTask = { files: Record<string, string>; setup?: string; peer?: string; peerSetup?: string; fullvm?: boolean; disks?: string[] }

const PEER_NAME = /^[a-z][a-z0-9-]{0,30}$/
const diskSizes = (t: LabTask) => (t.disks ?? []).filter((d) => /^\d{1,3}[MG]$/.test(d)).slice(0, 4).map((d) => `${d}iB`)
const isVm = (t: LabTask) => !!t.fullvm || diskSizes(t).length > 0

// Creating the machines and getting them ready: shared by one-shot runs and live machines.
function prepare(name: string, t: LabTask): string {
  const peer = t.peer && PEER_NAME.test(t.peer) ? t.peer : ""
  const files = Object.entries(t.files)
    .map(([f, body]) => `put "${name}-lab" ${JSON.stringify(f)} ${b64(body)}`)
    .join("\n")
  return [
    isVm(t) ? `mkvm "${name}-lab" lab ${diskSizes(t).join(" ")}` : `mk "${name}-lab" lab`,
    peer && `mk "${name}-peer" ${peer}`,
    peer && `link "${name}-lab" lab "${name}-peer" ${peer}`,
    files,
    t.setup?.trim() && `run "${name}-lab" SETUP ${b64(t.setup)} 120`,
    peer && `xfer "${name}-lab" "${name}-peer"`,
    peer && t.peerSetup?.trim() && `run "${name}-peer" PSETUP ${b64(t.peerSetup)} 120`
  ]
    .filter(Boolean)
    .join("\n")
}

// Deletes the machines and their disks, whichever of them exist.
const cleanup = (name: string) =>
  `cleanup() { for i in "${name}-lab" "${name}-peer"; do incus delete -f "$i" </dev/null >/dev/null 2>&1; done; for n in 1 2 3 4; do incus storage volume delete default "${name}-lab-d$n" </dev/null >/dev/null 2>&1; done; true; }`

type Fields = { field: (k: string) => string | undefined; text: (k: string) => string }
async function inVm(script: string, limitMs: number): Promise<Out & Fields> {
  const r = await lima(["shell", "--workdir", "/", VM, "sudo", "bash", "-s"], { stdin: script, limitMs })
  const field = (k: string) => {
    const m = new RegExp(`^@@${k} (.*)$`, "m").exec(r.stdout)
    return m ? m[1] : undefined
  }
  const text = (k: string) => {
    const v = field(k)
    return v ? Buffer.from(v, "base64").toString("utf8") : ""
  }
  return { ...r, field, text }
}

// A setup that failed is the lesson's fault, not yours: say so.
function setupFailure(r: Fields): string | null {
  const err = r.field("ERR")
  if (err !== undefined) return Buffer.from(err, "base64").toString("utf8")
  for (const k of ["SETUP", "PSETUP"]) {
    const c = r.field(`${k}-CODE`)
    if (c !== undefined && c !== "0") return `The exercise's setup failed: ${r.text(`${k}-ERR`) || r.text(`${k}-OUT`)}`
  }
  return null
}

function checks(r: Fields, peer: boolean): { ok: boolean; out: string } {
  // A check that wasn't run (no verify on that machine) doesn't count against you; one that ran
  // out of time says so.
  const one = (k: string) => {
    const code = r.field(`${k}-CODE`)
    if (code === undefined) return { ok: true, out: "" }
    const out = (r.text(`${k}-OUT`) + r.text(`${k}-ERR`)).trim()
    return { ok: code === "0", out: out || (code === "124" || code === "137" ? "The check ran out of time: the lab may be busy. Try again." : out) }
  }
  const lab = one("VERIFY")
  if (!peer || r.field("PVERIFY-CODE") === undefined) return lab
  const p = one("PVERIFY")
  return { ok: lab.ok && p.ok, out: [lab.ok ? "" : lab.out, p.ok ? "" : p.out].filter(Boolean).join("\n") }
}

let seq = 0
const fresh = (kind: "ex" | "tm") => `${kind}-${process.pid}-${Date.now().toString(36)}-${++seq}`

// The lab's own failures, not the learner's: incusd restarting (Ubuntu's Incus 6.0.0 can crash
// under concurrent operations) or a VM's agent dropping out mid-run. Such a run is retried once.
const LAB_FLAKE = /websocket: close 1006|VM agent isn't currently running|Monitor is disconnected|Failed to connect to the local daemon|connect: connection refused|unexpected EOF/i
const flaky = (r: ShellRun) => LAB_FLAKE.test(`${r.stderr}\n${r.verify?.out ?? ""}`)

// One exercise run: fresh machines, the setup, your commands, the check, then the machines are deleted.
export async function runServerTask(o: LabTask & { script: string; verify?: string; peerVerify?: string; limitSec?: number }): Promise<ShellRun> {
  const first = await runServerTaskOnce(o)
  return flaky(first) ? runServerTaskOnce(o) : first
}

async function runServerTaskOnce(o: LabTask & { script: string; verify?: string; peerVerify?: string; limitSec?: number }): Promise<ShellRun> {
  try {
    await ensureRunning()
  } catch (err) {
    return { stdout: "", stderr: (err as Error).message, exitCode: null, timedOut: false }
  }
  const limitSec = o.limitSec ?? 90
  const name = fresh("ex")
  const peer = !!o.peer && PEER_NAME.test(o.peer)
  const script = [
    PRELUDE,
    cleanup(name),
    "trap cleanup EXIT",
    prepare(name, o),
    `run "${name}-lab" MAIN ${b64(o.script)} ${limitSec}`,
    o.verify?.trim() && `run "${name}-lab" VERIFY ${b64(o.verify)} 60`,
    peer && o.peerVerify?.trim() && `run "${name}-peer" PVERIFY ${b64(o.peerVerify)} 60`
  ]
    .filter(Boolean)
    .join("\n")
  const r = await inVm(script, (limitSec + 360) * 1000)
  const bad = setupFailure(r)
  if (bad) return { stdout: "", stderr: bad, exitCode: null, timedOut: false }
  if (r.field("MAIN-CODE") === undefined) return { stdout: "", stderr: `The Linux lab didn't answer: ${(r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n")}`, exitCode: null, timedOut: r.timedOut }
  const code = Number(r.field("MAIN-CODE"))
  const res: ShellRun = { stdout: r.text("MAIN-OUT"), stderr: r.text("MAIN-ERR"), exitCode: code, timedOut: code === 124 || code === 137 }
  if (o.verify?.trim() || (peer && o.peerVerify?.trim())) res.verify = checks(r, peer)
  return res
}

// ---------- live machines ----------
// A live machine stays up while its step is on screen: you get a real root shell on it (and on
// its peer), and Check runs the step's verify against whatever state you left it in.
type Live = { name: string; peer: string; owner: number }
const live = new Map<string, Live>()

export async function openMachine(t: LabTask, owner: number): Promise<{ id: string; machines: string[] } | { error: string }> {
  try {
    await ensureRunning()
  } catch (err) {
    return { error: (err as Error).message }
  }
  await sweep()
  const name = fresh("tm")
  const peer = t.peer && PEER_NAME.test(t.peer) ? t.peer : ""
  const r = await inVm([PRELUDE, cleanup(name), "trap cleanup EXIT", prepare(name, t), "trap - EXIT", "echo @@READY"].join("\n"), 360_000)
  const bad = setupFailure(r)
  if (bad || !/^@@READY$/m.test(r.stdout)) {
    void inVm(`${cleanup(name)}\ncleanup`, 60_000)
    return { error: bad ?? `The Linux lab didn't answer: ${(r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n")}` }
  }
  live.set(name, { name, peer, owner })
  return { id: name, machines: peer ? ["lab", peer] : ["lab"] }
}

export async function checkMachine(id: string, verify?: string, peerVerify?: string): Promise<{ ok: boolean; out: string }> {
  const m = live.get(id)
  if (!m) return { ok: false, out: "This machine is gone. Start over to get a fresh one." }
  const script = [PRELUDE, verify?.trim() && `run "${id}-lab" VERIFY ${b64(verify)} 60`, m.peer && peerVerify?.trim() && `run "${id}-peer" PVERIFY ${b64(peerVerify)} 60`].filter(Boolean).join("\n")
  const r = await inVm(script, 150_000)
  if (r.field("VERIFY-CODE") === undefined && r.field("PVERIFY-CODE") === undefined) return { ok: false, out: `The Linux lab didn't answer: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n")}` }
  return checks(r, !!m.peer)
}

export function closeMachine(id: string): Promise<unknown> {
  if (!live.delete(id)) return Promise.resolve()
  killShells(id)
  return inVm(`${cleanup(id)}\ncleanup`, 60_000)
}

// Machines whose window went away.
export function closeOwnedBy(owner: number): void {
  for (const m of [...live.values()]) if (m.owner === owner) void closeMachine(m.name)
}

// On quit: delete every live machine, then stop the VM if Tutor used it, in a process that
// outlives the app. The VM keeps running when something else still has a shell in it (a check
// run, another tool): `limactl[ ]shell` matches those, but not this script's own command line.
export function closeAllMachines(): void {
  const names = [...live.keys()]
  live.clear()
  for (const k of [...shells.keys()]) shells.get(k)?.kill()
  shells.clear()
  const bin = limactl()
  if ((!names.length && !usedLab) || !bin) return
  const steps = [names.length ? `"$0" shell --workdir / ${VM} sudo bash -s` : "cat >/dev/null"]
  if (usedLab) steps.push(`pgrep -f 'limactl[ ]shell .*${VM}' >/dev/null || "$0" stop ${VM}`)
  const child = spawn("/bin/sh", ["-c", steps.join("\n"), bin], { detached: true, stdio: ["pipe", "ignore", "ignore"] })
  child.stdin.end(names.map((n) => `${cleanup(n)}\ncleanup`).join("\n"))
  child.unref()
}

// Live machines left behind by a Tutor that crashed or was killed: their process is gone.
let swept = false
async function sweep(): Promise<void> {
  if (swept) return
  swept = true
  const r = await lima(["shell", "--workdir", "/", VM, "sudo", "bash", "-c", "incus list -f csv -c n; incus storage volume list default -f csv -c n 2>/dev/null"], { limitMs: 30_000 })
  const runs = new Set(r.stdout.split("\n").map((l) => /^((?:tm|ex)-\d+-[a-z0-9]+-\d+)-/.exec(l.trim())?.[1]).filter((x): x is string => !!x))
  const dead = [...runs]
    .filter((n) => {
      const m = /^(?:tm|ex)-(\d+)-/.exec(n)
      if (!m || Number(m[1]) === process.pid) return false
      try {
        process.kill(Number(m[1]), 0)
        return false
      } catch {
        return true
      }
    })
  if (dead.length) await inVm(dead.map((n) => `${cleanup(n)}\ncleanup`).join("\n"), 120_000)
}

// ---------- shells on live machines ----------
type Pty = { write(d: string): void; resize(c: number, r: number): void; kill(): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void }
const shells = new Map<string, Pty & { id: string }>()
let shellSeq = 0

function ptyModule(): { spawn: (file: string, args: string[], o: object) => Pty } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as { spawn: (file: string, args: string[], o: object) => Pty }
  // npm skips node-pty's install script here, which is what marks its helper executable.
  try {
    const dir = path.dirname(require.resolve("node-pty/package.json"))
    for (const d of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = path.join(dir, d, "spawn-helper")
      if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755)
    }
  } catch {}
  return pty
}

export function openShell(id: string, machine: string, cols: number, rows: number, send: (ev: { key: string; data?: string; exit?: number }) => void): string | null {
  const m = live.get(id)
  const bin = limactl()
  if (!m || !bin) return null
  const inst = machine === "lab" ? `${id}-lab` : machine === m.peer ? `${id}-peer` : null
  if (!inst) return null
  const p = ptyModule().spawn(bin, ["shell", "--workdir", "/", VM, "sudo", "incus", "exec", inst, "--cwd", "/root", "--env", "HOME=/root", "--env", "TERM=xterm-256color", "-t", "--", "bash", "-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, PATH: `${path.dirname(fs.realpathSync(bin))}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "xterm-256color" }
  })
  const key = `sh${++shellSeq}`
  shells.set(key, Object.assign(p, { id }))
  p.onData((data) => send({ key, data }))
  p.onExit(({ exitCode }) => {
    shells.delete(key)
    send({ key, exit: exitCode })
  })
  return key
}

export const writeShell = (key: string, data: string) => shells.get(key)?.write(data)
export const resizeShell = (key: string, cols: number, rows: number) => {
  try {
    shells.get(key)?.resize(Math.max(20, cols), Math.max(5, rows))
  } catch {}
}
export function killShell(key: string): void {
  shells.get(key)?.kill()
  shells.delete(key)
}
function killShells(id: string): void {
  for (const [k, s] of shells) if (s.id === id) killShell(k)
}

// The in-app "Set up the Linux lab" button: runs the setup script, streaming its output.
export function runSetup(onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [setupScript()], { env: { ...process.env, PATH: `${path.join(os.homedir(), ".local/bin")}:/usr/bin:/bin:/usr/sbin:/sbin` } })
    const take = (d: Buffer) => d.toString().split(/\r|\n/).filter((l) => l.trim()).forEach(onLine)
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", (e) => (onLine(String(e)), resolve(1)))
  })
}
