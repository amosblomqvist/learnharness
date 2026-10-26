// The Learn lens runs the teaching method from github.com/amosblomqvist/learn: probe what you
// know with graded questions, plan a dependency map from unconditional truths, then teach it
// node by node, checking each one lands.
//
// The skill files stay in a folder you own (a clone of that repo, yours to edit); Tutor reads them
// fresh for every turn. This file also runs the cards the method asks questions with (quiz,
// ask_user_question, predict); the tools themselves are in tutor-tools.ts.
import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getSettings } from "./settings"
import { runCode, runExercise, runForModel, testRunForModel, type Language, type RunResult, type TestRun, type Trace } from "./lab"
import { recordPractice } from "./goals"
import type { ProjectView } from "./projects"

const run = promisify(execFile)
export const LEARN_REPO = "https://github.com/amosblomqvist/learn"

// ---------- the skill files ----------

export const defaultLearnPath = () => path.join(app.getPath("userData"), "learn")
export const learnPath = () => getSettings().learnPath || defaultLearnPath()

const FILES = { teach: "skills/teach/SKILL.md", visualize: "skills/visualize/SKILL.md", researcher: "agents/researcher.md" }
type SkillName = keyof typeof FILES
export type Skill = Record<SkillName, string>

const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, "").trim()

export function readSkill(): Skill | null {
  const dir = learnPath()
  const out = {} as Skill
  for (const [k, rel] of Object.entries(FILES) as [SkillName, string][]) {
    try {
      out[k] = stripFrontmatter(fs.readFileSync(path.join(dir, rel), "utf8"))
    } catch {
      out[k] = ""
    }
  }
  return out.teach ? out : null
}

export type LearnStatus = { path: string; installed: boolean; files: Record<SkillName, boolean>; commit: string | null; date: string | null; edited: boolean }

export async function learnStatus(): Promise<LearnStatus> {
  const dir = learnPath()
  const files = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, fs.existsSync(path.join(dir, rel))])) as Record<SkillName, boolean>
  let commit: string | null = null
  let date: string | null = null
  let edited = false
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      const log = (await run("git", ["-C", dir, "log", "-1", "--format=%h %cs"], { timeout: 5000 })).stdout.trim().split(" ")
      commit = log[0] ?? null
      date = log[1] ?? null
      edited = !!(await run("git", ["-C", dir, "status", "--porcelain"], { timeout: 5000 })).stdout.trim()
    } catch {}
  }
  return { path: dir, installed: files.teach, files, commit, date, edited }
}

// Clone it the first time, fast-forward it afterwards. Your own edits are never overwritten:
// if you changed a file that upstream also changed, git refuses and says so.
export async function installLearn(): Promise<LearnStatus> {
  const dir = learnPath()
  if (fs.existsSync(path.join(dir, ".git"))) await run("git", ["-C", dir, "pull", "--ff-only"], { timeout: 60_000 })
  else if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already has files that aren't a git clone. Point Tutor at it as-is, or empty it first.`)
  else {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    await run("git", ["clone", "--depth", "1", LEARN_REPO, dir], { timeout: 120_000 })
  }
  return learnStatus()
}

// ---------- questions on cards ----------

export type AskOption = { label: string; description?: string }
// predict: PRIMM's first two steps. You predict what the code does; only then does Tutor run it.
// exercise: write code against hidden tests in an editor on the card; Run shows which tests pass.
export type ExerciseKind = "write" | "fix" | "types" | "complete" | "refactor"
export type ExerciseView = { title: string; kind: ExerciseKind; language: Language; starter: string; hints: string[]; hasSolution: boolean; typeChecked: boolean }
export type AskView = { id: string; kind: "quiz" | "question" | "predict" | "exercise"; question: string; details?: string; options: AskOption[]; multi: boolean; code?: string; language?: Language; exercise?: ExerciseView }
export type AskAnswer = { picked: number[]; dontKnow?: boolean; other?: string; text?: string; note?: string; sure?: boolean; code?: string; hintsUsed?: number; gaveUp?: boolean; passed?: boolean }
export type AskGrade = { correct: boolean; correctIdx: number[]; explanation: string }
export type AskEvent =
  | { type: "ask"; ask: AskView }
  | { type: "ask-done"; id: string; answer?: AskAnswer; grade?: AskGrade; cancelled?: boolean; run?: RunResult; match?: boolean }
  | { type: "trace"; trace: TraceView }
  | { type: "project"; project: ProjectView }
export type TraceView = Trace & { id: string; code: string; title?: string }

// Every turn has a scope: its conversation (and goal/node), where its cards go, and the signal that
// stops it. Several turns can run at once (one per conversation), so cards remember their own scope:
// a question left open in one conversation keeps waiting while you work in another.
// textCards: the chat can't show cards (the IDE's AI chat): questions go out as text, and the
// answer comes back as the user's next message.
// gate: while it returns a message, quiz cards are refused with it (a lesson's write-up comes first).
export type TurnScope = { conv: string; goalId?: string; nodeId?: string; send: (e: AskEvent | { type: "text"; delta: string }) => void; signal: AbortSignal; textCards?: boolean; workspace?: string | null; gate?: () => string | null }

type Pending = { scope: TurnScope; view: AskView; correctIdx: number[]; explanation: string; resolve: (text: string) => void }
const pending = new Map<string, Pending>()

// The turn is over: close any of its cards that are still open.
export function endTurn(scope: TurnScope): void {
  for (const [id, p] of pending) {
    if (p.scope !== scope) continue
    pending.delete(id)
    scope.send({ type: "ask-done", id, cancelled: true })
    p.resolve("The question was cancelled because the turn stopped.")
  }
}

export function waitForAnswer(scope: TurnScope | null, view: AskView, correctIdx: number[] = [], explanation = ""): Promise<string> {
  if (!scope) return Promise.resolve("No one is at the window to answer right now. Ask in plain text instead.")
  if (scope.textCards) return Promise.resolve(asText(scope, view, correctIdx, explanation))
  return new Promise((resolve) => {
    pending.set(view.id, { scope, view, correctIdx, explanation, resolve })
    scope.send({ type: "ask", ask: view })
    scope.signal.addEventListener(
      "abort",
      () => {
        if (!pending.delete(view.id)) return
        scope.send({ type: "ask-done", id: view.id, cancelled: true })
        resolve("The question was cancelled because the user stopped the turn.")
      },
      { once: true }
    )
  })
}

const ref = (v: AskView, i: number) => `${i + 1}. ${v.options[i]?.label ?? "?"}`

// The window sends the answer here; the model gets it back as the tool's result.
export type AnswerResult = { ok: true; grade: AskGrade | null } | { ok: false }
export async function answerAsk(id: string, a: AskAnswer): Promise<AnswerResult> {
  const p = pending.get(id)
  if (!p) return { ok: false }
  pending.delete(id)
  const v = p.view
  if (v.kind === "predict") return answerPredict(p, a)
  if (v.kind === "exercise") return answerExercise(p, a)
  const note = a.note?.trim() ? `\nTheir note: ${a.note.trim()}` : ""
  const sure = a.sure === undefined ? "" : a.sure ? "\nThey said they were sure." : "\nThey said they were unsure."
  let text: string
  let grade: AskGrade | undefined
  if (v.kind === "quiz") {
    const picked = [...a.picked].sort()
    const correct = !a.dontKnow && picked.length === p.correctIdx.length && picked.every((x, i) => x === p.correctIdx[i])
    grade = { correct, correctIdx: p.correctIdx, explanation: p.explanation }
    const key = `Correct: ${p.correctIdx.map((i) => ref(v, i)).join(", ")}`
    text = a.dontKnow
      ? `The user chose "I don't know": they didn't guess, so this is a real gap to teach into, not a wrong answer.\n${key}`
      : `The user answered ${correct ? "correctly" : "incorrectly"}.\nPicked: ${picked.map((i) => ref(v, i)).join(", ") || "(nothing)"}\n${key}${sure}`
    text += `${note}\nExplanation they were shown: ${p.explanation}`
  } else if (a.text !== undefined) text = a.text.trim() ? `The user answered: ${a.text.trim()}` : "The user sent an empty answer."
  else {
    const parts = [...a.picked.sort().map((i) => ref(v, i)), ...(a.other?.trim() ? [`Other: ${a.other.trim()}`] : [])]
    text = `The user chose: ${parts.join("; ") || "(nothing)"}`
  }
  p.scope.send({ type: "ask-done", id, answer: a, grade })
  p.resolve(text + (v.kind === "question" ? note : ""))
  return { ok: true, grade: grade ?? null }
}

// A prediction is in: now run the code, show both side by side, and tell the model how it went.
async function answerPredict(p: Pending, a: AskAnswer): Promise<AnswerResult> {
  const v = p.view
  const said = a.dontKnow ? "(no idea)" : (a.text ?? a.picked.map((i) => v.options[i]?.label ?? "").join("; ")).trim()
  let run: RunResult
  try {
    run = await runCode(v.language ?? "python", v.code ?? "")
  } catch (err) {
    run = { stdout: "", stderr: (err as Error).message, exitCode: null, timedOut: false, ms: 0 }
  }
  const norm = (t: string) => t.replace(/\s+/g, " ").trim()
  const match = !a.dontKnow && !!said && norm(said) === norm(run.stdout)
  p.scope.send({ type: "ask-done", id: v.id, answer: a, run, match })
  const note = a.note?.trim() ? `\nTheir note: ${a.note.trim()}` : ""
  const sure = a.sure === undefined ? "" : a.sure ? " (they were sure)" : " (they were guessing)"
  p.resolve(
    `They predicted: ${a.dontKnow ? "they didn't know" : JSON.stringify(said)}${sure}.${note}\nThen it ran (they see both side by side):\n${runForModel(v.language ?? "python", run)}\n${match ? "Their prediction matches the output exactly." : "Compare the prediction with the real output yourself (formatting may differ); if the idea was wrong, find the exact belief that produced the wrong prediction and teach into it."}`
  )
  return { ok: true, grade: null }
}

// Where cards can't be shown: write the question into the chat, and tell the model to stop and
// wait for the reply (it keeps the answer key; the user never sees it until they've answered).
function asText(scope: TurnScope, v: AskView, correctIdx: number[], explanation: string): string {
  const opts = v.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ""}`).join("\n")
  const lang = v.language === "typescript" ? "ts" : v.language === "javascript" ? "js" : "python"
  const head = v.kind === "quiz" ? "**Quiz.**" : v.kind === "predict" ? "**Predict, then we run it.**" : "**Question.**"
  const how =
    v.kind === "quiz"
      ? `_Reply with the number${v.multi ? "s" : ""} (0 if you don't know; add "sure" or "guessing" if you like)._`
      : v.kind === "predict"
        ? "_Reply with exactly what you think it prints._"
        : v.options.length
          ? "_Reply with a number, or in your own words._"
          : "_Reply in your own words._"
  scope.send({ type: "text", delta: `\n\n${head} ${v.question}\n\n${v.details ? `${v.details}\n\n` : ""}${v.code ? `\`\`\`${lang}\n${v.code}\n\`\`\`\n\n` : ""}${opts ? `${opts}\n\n` : ""}${how}\n` })
  const shown = opts ? `\nExactly as they see it, numbered:\n${opts}` : ""
  const key = v.kind === "quiz" ? `\nThe answer key, by those numbers (don't reveal it before they answer): ${correctIdx.map((i) => `${i + 1}. ${v.options[i]?.label}`).join(", ")}.\nExplanation to give after: ${explanation}` : ""
  const after = v.kind === "quiz" ? "grade it against the numbers above, give the explanation, and carry on" : v.kind === "predict" ? "run the code with run_code, show their prediction next to the real output, and teach from the difference" : "carry on from their answer"
  return `The question is already in the chat, exactly as below. Don't repeat, reword or re-letter it: their answer will refer to these numbers.${shown}${key}\nEnd your turn now, with no more text. Their next message is their answer; then ${after}.`
}

// ---------- exercises ----------
// The tests, the reference solution and every attempt stay here in the main process; the card only
// ever gets test results (and the solution once you ask for it).

export type ExerciseDef = { title: string; kind: ExerciseKind; task: string; language: Language; starter: string; tests: string; typeTests?: string; hints: string[]; solution?: string; nodeId?: string }
type Exercise = ExerciseDef & { id: string; goalId?: string; runs: number; last?: TestRun; lastCode?: string; solutionShown: boolean; passedAt?: number; startedAt: number }
const exercises = new Map<string, Exercise>()

export function startExercise(scope: TurnScope | null, d: ExerciseDef): Promise<string> | string {
  const id = crypto.randomUUID()
  const typeChecked = d.language === "typescript"
  const ex: Exercise = { ...d, id, goalId: scope?.goalId, nodeId: d.nodeId ?? scope?.nodeId, runs: 0, solutionShown: false, startedAt: Date.now() }
  exercises.set(id, ex)
  if (scope?.textCards) {
    const lang = d.language === "typescript" ? "ts" : d.language === "javascript" ? "js" : "python"
    scope.send({ type: "text", delta: `\n\n**Exercise: ${d.title}**\n\n${d.task}\n\n\`\`\`${lang}\n${d.starter}\n\`\`\`\n\n_Write it in your editor, then paste your code here. I'll run it against the tests${typeChecked ? " and type-check it" : ""}._\n` })
    return `The exercise is in the chat (id ${id}). End your turn now with no more text. When they reply with code, call check_exercise with id "${id}" and their code, then react to the results: hint at the first failure (never paste the solution unless they ask to give up).`
  }
  const view: AskView = { id, kind: "exercise", question: d.task, options: [], multi: false, language: d.language, exercise: { title: d.title, kind: d.kind, language: d.language, starter: d.starter, hints: d.hints, hasSolution: !!d.solution?.trim(), typeChecked } }
  return waitForAnswer(scope, view)
}

// Run from the card (or check_exercise): attempts are counted, and a pass without the solution
// having been shown counts as practice for the node.
export async function runExerciseAttempt(id: string, code: string): Promise<TestRun | null> {
  const ex = exercises.get(id)
  if (!ex) return null
  const r = await runExercise(ex.language, code, ex.tests, ex.typeTests)
  ex.runs++
  ex.last = r
  ex.lastCode = code
  if (r.ok && !ex.passedAt) {
    ex.passedAt = Date.now()
    if (ex.goalId && ex.nodeId) recordPractice(ex.goalId, ex.nodeId, !ex.solutionShown)
  }
  return r
}

// Self-test only: an honest-looking pass (the solution isn't marked as shown).
export const peekSolution = (id: string) => exercises.get(id)?.solution ?? null

export function exerciseSolution(id: string): string | null {
  const ex = exercises.get(id)
  if (!ex?.solution) return null
  ex.solutionShown = true
  return ex.solution
}

export async function checkExercise(id: string, code: string): Promise<string> {
  const ex = exercises.get(id)
  if (!ex) return `There's no exercise ${id} (exercises are forgotten when Tutor restarts). Give a new one.`
  const r = (await runExerciseAttempt(id, code))!
  return `${summary(ex)}\n${testRunForModel(r)}\n${r.ok ? REVIEW : "Hint at the first failure without giving the answer away; they'll send another attempt."}`
}

const REVIEW = "Now review their code like a senior colleague would, briefly: one thing done well and one concrete improvement (quote the line). Then continue the lesson."

function summary(ex: Exercise): string {
  const mins = Math.max(1, Math.round((Date.now() - ex.startedAt) / 60_000))
  return `Exercise "${ex.title}" (${ex.kind}, ${ex.language}): ${ex.runs} run${ex.runs === 1 ? "" : "s"} in about ${mins} min${ex.solutionShown ? "; they opened the reference solution" : ""}.`
}

function answerExercise(p: Pending, a: AskAnswer): AnswerResult {
  const ex = exercises.get(p.view.id)
  const code = a.code ?? ex?.lastCode ?? ""
  p.scope.send({ type: "ask-done", id: p.view.id, answer: a })
  const hints = ex ? ` Hints used: ${a.hintsUsed ?? 0} of ${ex.hints.length}.` : ""
  const head = ex ? summary(ex) + hints : "Exercise finished."
  const lang = ex?.language === "python" ? "python" : "ts"
  const outcome = ex?.passedAt
    ? ex.solutionShown
      ? "They passed after opening the solution, so it doesn't count as practice for the node. Check they understand it: ask them to explain one key line, or give a small variation."
      : "They passed on their own."
    : a.gaveUp
      ? "They gave up before passing. Don't just move on: find the exact gap from their code and the failures, teach into it, then give a smaller exercise on the same idea."
      : "They stopped before passing."
  const results = ex?.last ? `\nLast run:\n${testRunForModel(ex.last)}` : "\nThey never ran the tests."
  p.resolve(`${head}\n${outcome}${results}\nTheir final code:\n\`\`\`${lang}\n${code.slice(0, 6000)}\n\`\`\`${ex?.passedAt && !ex.solutionShown ? `\n${REVIEW}` : ""}`)
  return { ok: true, grade: null }
}
