// Courses, career paths and XP, in the shape of boot.dev: a career path is a fixed run of courses
// (a whole module, or some of its chapters), a course is chapters of lessons, and every passed
// step earns XP. XP is worked out from the progress already saved, so nothing extra is stored.
import type { Lesson, Module, Step } from "./types"

// ---------- career paths ----------
// A part is a module, or only some of its stages (chapters). A course is one or more parts.
export type Part = { module: string; stages?: string[] }
export type Course = { id: string; title: string; blurb: string; parts: Part[]; project?: boolean }
export type Career = { id: string; title: string; blurb: string; months: string; courses: Course[] }

const PY = (id: string, title: string, blurb: string, stages: string[]): Course => ({ id: `py-${id}`, title, blurb, parts: [{ module: "python", stages }] })
const QUEST: Course = { id: "quest", title: "Learn Python: Fantasy Quest", blurb: "A text RPG built one checked coding task at a time: variables, functions, strings, lists, dictionaries, errors, type hints, testing, classes, files and JSON, modules, tuples, iterators, generators, decorators, and a playable game, then a quiz.", parts: [{ module: "quest" }] }
const WORKSHOP: Course = { id: "workshop", title: "Fantasy Quest: The Workshop", blurb: "Real projects from a blank folder in your own editor, checked by hidden tests: tools, a game, data, a package, a web API.", parts: [{ module: "workshop" }], project: true }
const PY1 = PY("1", "Python I: the basics, explained", "The same ground as Fantasy Quest, with full write-ups: names and objects, control flow, functions, lists and dicts.", ["intro", "basics", "functions", "lists", "dicts"])
const PY2 = PY("2", "Python II: errors, files and iteration", "Exceptions, files and modules, iterators, generators and with-blocks.", ["errors", "iteration"])
const PY3 = PY("3", "Python III: classes and types", "Classes, dataclasses, decorators, protocols, match and type hints.", ["classes", "patterns", "types"])
const PY4 = PY("4", "Python IV: Python at work", "Packages, pytest, Ruff, logging, regex, dates, scripts, SQLite and HTTP.", ["tooling", "work"])
const PY5 = PY("5", "Python V: concurrency and async", "Threads, processes, pools, asyncio, timeouts and backpressure.", ["concurrency", "async"])
const LINUX: Course = { id: "linux", title: "Linux and the shell", blurb: "Files, pipes, scripts, permissions, processes and services.", parts: [{ module: "linux", stages: ["shell", "text", "system"] }] }
const WARGAME: Course = { id: "wargame", title: "Project: the shell wargame", blurb: "Dig 27 passwords out of prepared folders, Bandit style.", parts: [{ module: "wargame" }], project: true }
const GIT: Course = { id: "git", title: "Git", blurb: "Commits, branches, conflicts, undoing safely and pull requests.", parts: [{ module: "git" }] }
const NET: Course = {
  id: "net",
  title: "Networking",
  blurb: "Addresses, routes, DNS, ss and dig, SSH between machines, and backups over the network.",
  parts: [
    { module: "linux", stages: ["net"] },
    { module: "ops", stages: ["net"] }
  ]
}
const SERVER: Course = { id: "server", title: "Linux servers", blurb: "Real Ubuntu machines: systemd, the journal, nginx with TLS, firewalls and incidents.", parts: [{ module: "server" }] }
const SQL: Course = { id: "sql", title: "SQL", blurb: "Keys, joins, groups, windows, indexes, transactions and migrations.", parts: [{ module: "sql" }] }
const CONTAINERS: Course = { id: "containers", title: "Containers", blurb: "Namespaces, images, Dockerfiles, networking, volumes and Compose.", parts: [{ module: "containers" }] }
const OBSERVE: Course = { id: "observe", title: "Observability and hardening", blurb: "Metrics, central logs, load balancing, hardening and real disks.", parts: [{ module: "ops", stages: ["watch", "harden", "disks"] }] }
const K8S: Course = { id: "kubernetes", title: "Kubernetes", blurb: "Workloads, services, config, scheduling, traffic and least privilege.", parts: [{ module: "kubernetes" }] }
const DISTRIBUTED: Course = { id: "distributed", title: "Distributed systems", blurb: "Postgres and Redis under replication and failure, durable queues, overload controls, and regional failover with measured RTO and RPO.", parts: [{ module: "distributed" }] }
const CICD: Course = { id: "cicd", title: "CI/CD", blurb: "GitHub Actions pipelines: tests, caches, matrices, images, environments and safe deploys.", parts: [{ module: "cicd" }] }
const CLOUD: Course = { id: "cloud", title: "Cloud (AWS)", blurb: "IAM, VPCs, compute and storage choices, availability, observability and cost.", parts: [{ module: "cloud" }] }
const TERRAFORM: Course = { id: "terraform", title: "Terraform", blurb: "Infrastructure as code: plans, state, modules, tests and stacks.", parts: [{ module: "terraform" }] }
const SRE_READING: Course = { id: "sre-reading", title: "Reading: the originals", blurb: "Google's SRE book, the Amazon Builders' Library and friends, page by page.", parts: [{ module: "design-reading" }] }
const ARCH: Course = { id: "architecture", title: "Project: architecture", blurb: "Decide on purpose, write it down, and design a small system end to end.", parts: [{ module: "architecture" }], project: true }

// The SWE path is your own module list (Add a module, drag to reorder); the others are fixed runs.
export const CAREERS: Career[] = [
  {
    id: "sre",
    title: "Site Reliability Engineer",
    blurb: "Keep systems up: Linux, networks, observability, containers, Kubernetes and CI, with Python as the automation language throughout.",
    months: "about 12 months part-time",
    courses: [QUEST, WORKSHOP, PY1, LINUX, WARGAME, GIT, PY2, NET, SERVER, PY3, SQL, PY4, CONTAINERS, OBSERVE, K8S, DISTRIBUTED, CICD, PY5, SRE_READING]
  },
  {
    id: "cloud",
    title: "Cloud Engineer",
    blurb: "Build on AWS: Python, Linux and networking first, then containers, AWS, Terraform, Kubernetes and CI pipelines.",
    months: "about 12 months part-time",
    courses: [QUEST, WORKSHOP, PY1, LINUX, GIT, NET, PY2, SQL, PY3, CONTAINERS, CLOUD, TERRAFORM, PY4, K8S, DISTRIBUTED, CICD, PY5, ARCH]
  }
]
export const careerById = (id: string) => CAREERS.find((c) => c.id === id)

// The lessons a course covers, in order: part by part, chapter by chapter, then file order.
export function courseLessons(c: Course, mod: (id: string) => Module | undefined): Lesson[] {
  return c.parts.flatMap((p) => {
    const m = mod(p.module)
    if (!m) return []
    const stages = (p.stages ?? m.stages.map((s) => s.id)).filter((id) => m.stages.some((s) => s.id === id))
    return stages.flatMap((st) => m.lessons.filter((l) => l.stage === st))
  })
}

// A course's chapters: each part's stages, with their lessons.
export type Chapter = { key: string; module: Module; id: string; title: string; outcome: string; lessons: Lesson[] }
export function courseChapters(c: Course, mod: (id: string) => Module | undefined): Chapter[] {
  return c.parts.flatMap((p) => {
    const m = mod(p.module)
    if (!m) return []
    return m.stages
      .filter((s) => !p.stages || p.stages.includes(s.id))
      .map((s) => ({ key: `${m.id}/${s.id}`, module: m, id: s.id, title: s.title, outcome: s.outcome, lessons: m.lessons.filter((l) => l.stage === s.id) }))
      .filter((ch) => ch.lessons.length > 0)
  })
}

// A whole module as one course (what a module opened from the SWE path shows).
export const moduleCourse = (m: Module): Course => ({ id: m.id, title: m.title, blurb: m.blurb, parts: [{ module: m.id }] })

// ---------- XP ----------
// Every passed step earns XP by how much work it is; a step whose answer you looked at earns half.
// Finishing a lesson adds a bonus (a project, a big one), and so does every review and docs page.
export const STEP_XP: Record<Step["kind"], number> = { quiz: 10, predict: 15, card: 5, write: 30, shell: 30, term: 40, config: 30, project: 200 }
export const LESSON_BONUS = 10
export const PROJECT_BONUS = 100
export const READING_XP = 20
export const REVIEW_XP = { right: 5, wrong: 1 }
export const TYPED_XP = 25
export const DAILY_GOAL = 100

export const stepXp = (s: Step, shown?: boolean) => (shown ? Math.floor(STEP_XP[s.kind] / 2) : STEP_XP[s.kind])
// What a lesson is worth when every step is done without help.
export const lessonXp = (l: Lesson) => (l.steps.length ? l.steps.reduce((a, s) => a + STEP_XP[s.kind], 0) + LESSON_BONUS : READING_XP) + (l.project ? PROJECT_BONUS : 0)

// Levels get further apart: level n starts at 50·n·(n−1) XP (0, 100, 300, 600, 1000, …).
export const levelStart = (n: number) => 50 * n * (n - 1)
export function level(xp: number): { level: number; into: number; span: number } {
  let n = 1
  while (levelStart(n + 1) <= xp) n++
  return { level: n, into: xp - levelStart(n), span: levelStart(n + 1) - levelStart(n) }
}
// boot.dev-style ranks, every five levels.
const RANKS = ["Apprentice", "Scripter", "Builder", "Operator", "Engineer", "Senior", "Staff", "Principal"]
export const rank = (lvl: number) => RANKS[Math.min(RANKS.length - 1, Math.floor((lvl - 1) / 5))]
