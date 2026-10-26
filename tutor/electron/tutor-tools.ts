// Tutor's own tools, defined once and handed to every engine:
//   learn:  quiz · ask_user_question (cards in the chat) · render_diagram (look before showing)
//   goal:   save_strategy (the goal's map) · mark_node (progress as lessons land)
//   video:  video_transcript (a link or a file becomes a timestamped transcript)
//   lab:    run_code · predict · trace_code · exercise (hidden tests on a card) · check_exercise
//   project: start_project · check_project · advance_project (real folders built in the IDE)
// The AI SDK gets them directly, Claude Code as an in-process MCP server, Grok Build over a
// token-guarded MCP server on 127.0.0.1 (which always serves all of them; the prompt says which to use).
import http from "node:http"
import crypto from "node:crypto"
import { z } from "zod"
import { tool as aiTool, type ToolSet } from "ai"
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { checkExercise, startExercise, waitForAnswer, type AskView, type TurnScope } from "./learn"
import { renderDiagram } from "./diagram"
import { addSource, markNode, saveStrategy, frontier, type StrategyInput } from "./goals"
import { readVideo, videoForModel } from "./video"
import { runCode, runExercise, runForModel, testRunForModel, traceCode } from "./lab"
import { advanceProject, checkProject, findProject, startProject, view as projectView } from "./projects"
import { recordReview } from "./reviews"

type Out = { text: string; png?: string }
type TutorTool = { name: string; group: ToolGroup; description: string; shape: z.ZodRawShape; run: (args: any, scope: TurnScope | null) => Promise<Out> }
export type ToolGroup = "learn" | "goal" | "video" | "lab" | "project" | "review"

// ---------- learn ----------

const option = z.object({
  label: z.string().describe("The option as shown. A bare claim: keep every option the same length and register, no reasoning in any of them."),
  value: z.string().optional().describe("Stable id for this option; correctAnswer refers to it. Defaults to the label."),
  description: z.string().optional().describe("Optional smaller line under the option.")
})

function shuffled<T>(xs: T[]): T[] {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const quiz: TutorTool = {
  name: "quiz",
  group: "learn",
  description:
    "Ask one GRADED multiple-choice question (it has a right answer) on a card in the chat and wait for the user's click. Returns what they picked, whether it was right, and any note they typed. Use it to find the edge of what they know before teaching, and to check each idea landed after teaching it. Write the correct option first, then turn it into each wrong option by stating what a specific misconception would claim, in the same shape and length. Put all reasoning in explanation, never in an option.",
  shape: {
    question: z.string().describe("One question per call."),
    details: z.string().optional().describe("Optional context shown under the question (code, a formula, the scenario). Code always goes in a fenced block with its language (```python), one statement per line, exactly as it would sit in a file."),
    options: z.array(option).min(2).describe("Two or more real options. Don't add an \"I don't know\" option: the card always has one."),
    multiSelect: z.boolean().optional().describe("True when more than one option is correct; graded as an exact set."),
    correctAnswer: z.union([z.string(), z.array(z.string())]).describe("The correct option's value (or label); an array of them for multiSelect."),
    explanation: z.string().describe("Why the right answer is right. Shown only after they answer, whatever they picked."),
    shuffle: z.boolean().optional().describe("Options are shuffled unless this is false (use false only when order matters, e.g. ordered numbers).")
  },
  run: async (q, scope) => {
    let opts = (q.options as z.infer<typeof option>[]).map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined, value: (o.value ?? o.label).trim() })).filter((o) => o.label)
    if (opts.length < 2) return { text: "quiz needs at least two options. Ask again." }
    if (q.shuffle !== false) opts = shuffled(opts)
    const want = (Array.isArray(q.correctAnswer) ? q.correctAnswer : [q.correctAnswer]).map((s: string) => s.trim().toLowerCase())
    const correctIdx = opts.map((o, i) => (want.includes(o.value.toLowerCase()) || want.includes(o.label.toLowerCase()) ? i : -1)).filter((i) => i >= 0)
    if (!correctIdx.length) return { text: `correctAnswer ${JSON.stringify(q.correctAnswer)} matches none of the options' values. Call quiz again with correctAnswer set to one option's value.` }
    const view: AskView = { id: crypto.randomUUID(), kind: "quiz", question: q.question.trim(), details: q.details?.trim() || undefined, options: opts.map(({ label, description }) => ({ label, description })), multi: !!q.multiSelect || correctIdx.length > 1 }
    return { text: await waitForAnswer(scope, view, correctIdx, q.explanation.trim()) }
  }
}

const ask: TutorTool = {
  name: "ask_user_question",
  group: "learn",
  description: "Ask the user one question that has NO right answer (their goal, a preference, which direction to go) on a card, and wait for their reply. For anything gradable, use quiz instead.",
  shape: {
    question: z.string().describe("One question per call."),
    details: z.string().optional().describe("Optional context shown under the question. Code always goes in a fenced block with its language (```python)."),
    options: z.array(option).optional().describe("Choices. The card always adds \"Other\" with a text box. Leave out for a free-text answer."),
    multiSelect: z.boolean().optional().describe("Let them pick several.")
  },
  run: async (q, scope) => {
    const options = ((q.options ?? []) as z.infer<typeof option>[]).map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined })).filter((o) => o.label)
    return { text: await waitForAnswer(scope, { id: crypto.randomUUID(), kind: "question", question: q.question.trim(), details: q.details?.trim() || undefined, options, multi: !!q.multiSelect }) }
  }
}

const render: TutorTool = {
  name: "render_diagram",
  group: "learn",
  description: "Render a Mermaid or SVG diagram to a PNG and look at it before putting it in your reply. Returns the picture, or the syntax error. Check arrows point the right way, every label is true, nothing is crammed; fix and render again until it's right.",
  shape: {
    kind: z.enum(["mermaid", "svg"]).describe("mermaid for structure and flow (graph, sequenceDiagram, stateDiagram-v2…); svg for geometry and plots."),
    source: z.string().describe("The full diagram source, exactly as you'll put it in the fenced block.")
  },
  run: async (r) => {
    const out = await renderDiagram(r.kind, r.source)
    if (!out.ok) return { text: `It didn't render: ${out.error}\nFix the source and call render_diagram again.` }
    return { text: `Rendered (${out.width}×${out.height}). This is exactly what the user will see. Look at it: is every arrow and label true, and is it uncluttered? If not, fix it and render again. When it's right, put the same source in a fenced \`\`\`${r.kind} block in your reply.`, png: out.png }
  }
}

// ---------- goals ----------

const resource = z.object({ title: z.string(), url: z.string().describe("http(s) link. For a video moment add ?t=<seconds> (YouTube) so it opens there.") })
const node = z.object({
  id: z.string().describe("Short stable slug, e.g. \"control-loop\". Keep ids the same when you revise the map, so progress stays attached."),
  title: z.string().describe("At most 6 words."),
  kind: z.enum(["truth", "concept", "skill", "project"]).describe("truth: an unconditional truth to accept at face value (the roots). concept: an idea derived from others. skill: something they'll be able to do. project: a hands-on build that proves a stage."),
  stage: z.string().describe("The id of the stage it belongs to."),
  summary: z.string().describe("One sentence: what it is, stated so it's true without caveats."),
  why: z.string().optional().describe("The problem that makes you need it: how they could have discovered it themselves."),
  requires: z.array(z.string()).optional().describe("Ids of the nodes it directly builds on."),
  check: z.string().optional().describe("How they'll show they have it: a question they can answer or a task they can do."),
  minutes: z.number().optional().describe("Rough focused minutes to learn it."),
  resources: z.array(resource).optional().describe("Best sources: official docs, a spec, a paper, a moment in a video they gave you."),
  status: z.enum(["todo", "learning", "solid", "known"]).optional().describe("\"known\" when the probe showed they already have it. Otherwise leave it out.")
})

const saveStrategyTool: TutorTool = {
  name: "save_strategy",
  group: "goal",
  description:
    "Save the goal's whole strategy: stages, and the dependency map of nodes (unconditional truths at the roots, each node listing what it requires, stages ending in a project). The user sees it immediately as an interactive map. Call it again with the whole revised strategy whenever it changes; keep node ids stable so progress stays attached. It's checked for missing ids and cycles; fix anything it reports and call again.",
  shape: {
    summary: z.string().describe("One or two sentences: where this strategy gets them."),
    approach: z.string().describe("The approach in 3-5 sentences: the order and why, given their level and goal."),
    stages: z.array(z.object({ id: z.string(), title: z.string().describe("At most 5 words."), outcome: z.string().describe("What they can do or build after this stage.") })).min(1),
    nodes: z.array(node).min(1)
  },
  run: async (s, scope) => {
    const goalId = scope?.goalId
    if (!goalId) return { text: "There's no goal open in this conversation, so there's nothing to save the strategy to. Suggest the user starts one from Goals." }
    const r = saveStrategy(goalId, s as StrategyInput)
    if (!r.ok) return { text: r.error }
    const st = r.goal.strategy!
    const next = frontier(st).slice(0, 4).map((n) => n.id)
    return { text: `Saved: ${st.nodes.length} nodes in ${st.stages.length} stages. The user sees the map now.${next.length ? ` Ready to start: ${next.join(", ")}.` : ""}` }
  }
}

const markNodeTool: TutorTool = {
  name: "mark_node",
  group: "goal",
  description: "Record progress on a node of the goal's map: \"solid\" once its checks landed, \"known\" if it turns out they already had it, \"learning\" while you're on it. Their map updates immediately. The result names what's ready next — after solid/known, end your turn with one short \"Next ready: <title>.\" line using that.",
  shape: {
    id: z.string().describe("The node id."),
    status: z.enum(["learning", "solid", "known", "todo"]),
    note: z.string().optional().describe("One line on what the check showed (kept on the node)."),
    waive: z.string().optional().describe("Only when the course requires a passed exercise for solid and one is genuinely impossible for this node: the reason.")
  },
  run: async (m, scope) => {
    const goalId = scope?.goalId
    if (!goalId) return { text: "This conversation isn't part of a goal, so there's no map to mark." }
    return { text: markNode(goalId, m.id, m.status, m.note, m.waive).text }
  }
}

// ---------- videos ----------

const videoTool: TutorTool = {
  name: "video_transcript",
  group: "video",
  description: "Read a video: a YouTube (or other) link, or a video file on this Mac. Returns its title, chapters and the transcript with [mm:ss] timestamps, a page at a time for long videos (call again with from to read on). Use it whenever the user gives you a video, then act on it: say what it covers and where, check its claims, teach or quiz from it, and link moments with ?t=<seconds>.",
  shape: {
    source: z.string().describe("The video link, or a file path on this Mac."),
    from: z.string().optional().describe("Read the transcript from this timestamp (e.g. \"1:02:30\"); leave out for the start.")
  },
  run: async ({ source, from }, scope) => {
    try {
      const v = await readVideo(source)
      const goalId = scope?.goalId
      if (goalId && !v.url.startsWith("file://")) addSource(goalId, { kind: "video", title: v.title, url: v.url, channel: v.channel, duration: v.duration })
      return { text: videoForModel(v, from) }
    } catch (err) {
      return { text: `Couldn't read that video: ${(err as Error).message}` }
    }
  }
}

// ---------- lab ----------

const language = z.enum(["python", "typescript", "javascript"]).describe("typescript runs on Node with its types stripped")

const runTool: TutorTool = {
  name: "run_code",
  group: "lab",
  description: "Run a short Python, TypeScript or JavaScript program in a sandbox (no network, no files outside a scratch folder, 8 s limit) and get its exact output. Use it before you state what code prints or does, and to check an answer key for a code question. Never claim output you haven't run.",
  shape: { language, code: z.string().describe("A complete program that prints what matters."), stdin: z.string().optional() },
  run: async ({ language, code, stdin }) => {
    try {
      return { text: runForModel(language, await runCode(language, code, stdin)) }
    } catch (err) {
      return { text: `Couldn't run it: ${(err as Error).message}` }
    }
  }
}

const predictTool: TutorTool = {
  name: "predict",
  group: "lab",
  description: "Show the user a short program and ask what it will print (PRIMM: predict, then run). They commit to a prediction on a card; only then does Tutor run the code and show their prediction next to the real output. Returns both. Best for exactly the ideas where a wrong mental model gives a confident wrong prediction. Keep programs short and make them print the thing that matters.",
  shape: {
    language,
    code: z.string().describe("A complete, short program that prints its result."),
    question: z.string().optional().describe("Defaults to \"What will this print?\""),
    options: z.array(option).optional().describe("Optional choices; leave out to let them type the output.")
  },
  run: async (p, scope) => {
    const options = ((p.options ?? []) as z.infer<typeof option>[]).map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined })).filter((o) => o.label)
    return { text: await waitForAnswer(scope, { id: crypto.randomUUID(), kind: "predict", question: p.question?.trim() || "What will this print?", options, multi: false, code: p.code, language: p.language }) }
  }
}

const traceTool: TutorTool = {
  name: "trace_code",
  group: "lab",
  description: "Run a short Python program under a tracer and show the user a stepper in the chat: every line with the call stack and each frame's variables (shared objects are marked #n, so aliasing is visible; generators show where they're paused). Use it when the idea is about what the machine does: frames, references, mutation, recursion, generators, closures. Returns a summary; point them to what to watch.",
  shape: { code: z.string().describe("A short Python program (under ~25 lines is best)."), title: z.string().optional().describe("What to watch, e.g. \"watch n survive between next() calls\".") },
  run: async ({ code, title }, scope) => {
    try {
      const t = await traceCode(code)
      if (scope?.textCards) scope.send({ type: "text", delta: `\n\n${traceAsText(t, title)}\n\n` })
      else scope?.send({ type: "trace", trace: { ...t, id: crypto.randomUUID(), code, title } })
      const lines = t.steps.filter((s) => s.event === "line").map((s) => s.line)
      return { text: `Traced ${t.steps.length} steps${t.truncated ? " (stopped at the step limit)" : ""}. The user now has a stepper they can scrub through. Lines in order: ${lines.slice(0, 60).join(" ")}${lines.length > 60 ? " …" : ""}.\nFinal output: ${JSON.stringify(t.stdout.slice(0, 500))}${t.error ? `\nIt raised: ${t.error}` : ""}` }
    } catch (err) {
      return { text: `Couldn't trace it: ${(err as Error).message}` }
    }
  }
}

// Where there's no stepper (the IDE's chat): the run as a compact table of lines and variables.
function traceAsText(t: Awaited<ReturnType<typeof traceCode>>, title?: string): string {
  const rows = t.steps
    .filter((s) => s.event === "line" || (s.event === "return" && s.stack.length > 1))
    .slice(0, 30)
    .map((s, i) => {
      const f = s.stack[s.stack.length - 1]
      const vars = f?.locals.map(([k, v]) => `${k}=${v}`).join(", ") ?? ""
      return `| ${i + 1} | ${s.line} | ${f ? (f.fn === "<module>" ? "module" : f.fn + "()") : ""} | ${(s.event === "return" ? `returns ${s.ret} · ` : "") + vars} |`.replace(/\n/g, " ")
    })
  return `**Step through**${title ? `: ${title}` : ""}\n\n| step | line | frame | variables |\n|---|---|---|---|\n${rows.join("\n")}${t.steps.length > 30 ? "\n\n_(first 30 steps)_" : ""}\n\nOutput: \`${t.stdout.trim().slice(0, 200)}\``
}

// ---------- practice: exercises and projects ----------

const exerciseTool: TutorTool = {
  name: "exercise",
  group: "lab",
  description:
    "Give the user a coding exercise on a card: a task, starter code in an editor, and HIDDEN tests they run with a button until they pass (TypeScript is also type-checked with tsc --strict). Hints unlock one at a time; the reference solution only if they ask after trying. Blocks until they finish or give up, then returns attempts, hints used, whether they passed on their own, and their final code. Before it's shown, your solution is run against your tests (it must pass) and the starter too (it must fail), so a broken exercise comes back to you to fix. Keep it small (2-10 minutes) and aimed at exactly one idea.",
  shape: {
    title: z.string().describe("Short, e.g. \"Group words by first letter\"."),
    kind: z.enum(["write", "fix", "types", "complete", "refactor"]).describe("write: implement from a spec. fix: starter has a bug, tests fail. types (TypeScript): make it type-check without changing runtime behaviour, typeTests say what must and mustn't compile. complete: fill in the missing part. refactor: tests already pass; improve the code as the task says, keeping them green."),
    task: z.string().describe("The task in markdown: what to do, with an example call and result. Don't reveal the approach."),
    language: z.enum(["python", "typescript", "javascript"]),
    starter: z.string().describe("Starter code in the editor: signatures and TODOs (write/complete), buggy code (fix), untyped or loosely typed code (types), working but messy code (refactor)."),
    tests: z.string().describe("Hidden tests. Python: a module doing `from solution import …` with plain `def test_…():` functions using assert (write `assert got == want` so failures show both). TypeScript/JavaScript: `import { test } from \"node:test\"`, `import assert from \"node:assert/strict\"`, `import { … } from \"./solution\"`, then test(\"name\", () => …). Name tests so a failure reads as a hint. Cover the edge cases the idea is about. For a pure types exercise this may be empty."),
    typeTests: z.string().optional().describe("TypeScript only: a file importing from \"./solution\" that must type-check under --strict; put `// @ts-expect-error` above lines that must NOT compile."),
    hints: z.array(z.string()).min(1).max(4).describe("Progressive hints, from a nudge to nearly the answer."),
    solution: z.string().describe("A clean reference solution. Only shown if they ask after trying; it's checked against your tests first."),
    nodeId: z.string().optional().describe("The goal node this practises, if it isn't the lesson's own node (e.g. in a review).")
  },
  run: async (e, scope) => {
    const refRun = await runExercise(e.language, e.solution, e.tests, e.typeTests)
    if (!refRun.ok) return { text: `Not shown: your reference solution fails your own tests, so the exercise is broken.\n${testRunForModel(refRun)}\nFix the tests or the solution and call exercise again.` }
    if (e.kind !== "refactor") {
      const starterRun = await runExercise(e.language, e.starter, e.tests, e.typeTests)
      if (starterRun.ok) return { text: "Not shown: the starter code already passes every test, so there's nothing to do. Make the tests check what the task asks for (or give a starter that doesn't solve it yet) and call exercise again." }
    }
    return { text: await startExercise(scope, { title: e.title, kind: e.kind, task: e.task, language: e.language, starter: e.starter, tests: e.tests, typeTests: e.typeTests, hints: e.hints, solution: e.solution, nodeId: e.nodeId }) }
  }
}

const checkExerciseTool: TutorTool = {
  name: "check_exercise",
  group: "lab",
  description: "Run code the user sent (in a text chat) against an exercise's hidden tests. Returns the results, and counts as their attempt.",
  shape: { id: z.string().describe("The exercise id from the exercise tool."), code: z.string().describe("Their full code, exactly as they sent it.") },
  run: async ({ id, code }) => ({ text: await checkExercise(id, code) })
}

const projectFile = z.object({ path: z.string().describe("Relative path, e.g. \"src/inventory/models.py\" or \"tests/test_models.py\"."), content: z.string() })
const milestone = z.object({
  title: z.string().describe("At most 6 words."),
  spec: z.string().describe("What to build in this milestone, in markdown: behaviour, inputs and outputs, constraints. Not how."),
  tests: z.array(projectFile).min(1).describe("This milestone's tests (tests/test_*.py for Python with plain assert functions; tests/*.test.ts for TypeScript using node:test). They're written into the project only when the milestone unlocks.")
})

const startProjectTool: TutorTool = {
  name: "start_project",
  group: "project",
  description:
    "Set up a hands-on project as a real folder the user opens in their IDE (PyCharm/WebStorm): scaffold files (config, empty modules with signatures, never the solution), a README with the first milestone's spec, and that milestone's failing tests. Later milestones stay hidden until the current one passes. The user builds it in the IDE and asks you to check it.",
  shape: {
    title: z.string(),
    language: z.enum(["python", "typescript"]),
    files: z.array(projectFile).describe("Scaffold: pyproject.toml (with pytest in a dev group) or package.json + tsconfig.json (strict), and module stubs with signatures and docstrings. No solutions."),
    milestones: z.array(milestone).min(1).max(8).describe("Three to six milestones, each a working slice, in order.")
  },
  run: async (p, scope) => {
    try {
      const proj = await startProject({ title: p.title, language: p.language, files: p.files, milestones: p.milestones, goalId: scope?.goalId, nodeId: scope?.nodeId })
      scope?.send({ type: "project", project: projectView(proj) })
      const setup = p.language === "python" ? "`uv sync` (or create a venv and install pytest)" : "`npm install`"
      return { text: `Created at ${proj.dir}. The user sees a project card with "Open in IDE" and "Check my project". Tell them: open it, run ${setup} once, read README.md, make the milestone 1 tests pass, then ask you to check it. Don't write the solution into the project.` }
    } catch (err) {
      return { text: `Couldn't create the project: ${(err as Error).message}` }
    }
  }
}

const checkProjectTool: TutorTool = {
  name: "check_project",
  group: "project",
  description: "Check the user's project: runs its tests (sandboxed, read-only; TypeScript also type-checked) and returns the results plus their code changes for you to review. Use it when they ask you to check their project.",
  shape: { id: z.string().optional().describe("Project id; leave out to use the project of this lesson, or the one open in their IDE, or the latest.") },
  run: async ({ id }, scope) => {
    const p = findProject({ id, goalId: scope?.goalId, nodeId: scope?.nodeId, workspace: scope?.workspace ?? undefined })
    if (!p) return { text: "There's no project yet. Start one with start_project." }
    const r = await checkProject(p)
    scope?.send({ type: "project", project: projectView(p) })
    return { text: r.text }
  }
}

const advanceProjectTool: TutorTool = {
  name: "advance_project",
  group: "project",
  description: "After check_project shows the current milestone passing and you've reviewed the code: record your review and unlock the next milestone (its spec goes into README.md and its tests into tests/).",
  shape: { id: z.string(), review: z.string().describe("One paragraph: what's good, what to fix, one idea to take away.") },
  run: async ({ id, review }, scope) => {
    const p = findProject({ id })
    if (!p) return { text: `No project ${id}.` }
    const r = advanceProject(p, review)
    scope?.send({ type: "project", project: projectView(r.project) })
    return { text: r.text }
  }
}

// ---------- reviews ----------

const reviewTool: TutorTool = {
  name: "record_review",
  group: "review",
  description: "Record how one due review went, which reschedules it (FSRS): again = wrong or \"I don't know\"; hard = right but guessing or muddled; good = right; easy = right, sure and clearly solid.",
  shape: {
    goalId: z.string(),
    nodeId: z.string(),
    rating: z.enum(["again", "hard", "good", "easy"]),
    sure: z.boolean().optional().describe("What they said on the card, if they said."),
    note: z.string().optional().describe("One line: what the answer showed.")
  },
  run: async (r) => ({ text: recordReview(r.goalId, r.nodeId, r.rating, r.sure, r.note).text })
}

// A lesson's cards wait for its write-up: models (Grok especially) like to open with a warm-up question.
const GATED = new Set(["quiz", "predict", "exercise", "ask_user_question"])
const gated = (t: TutorTool): TutorTool =>
  GATED.has(t.name)
    ? {
        ...t,
        run: async (a, scope) => {
          const why = scope?.gate?.()
          return why ? { text: why } : t.run(a, scope)
        }
      }
    : t
const ALL: TutorTool[] = [quiz, ask, render, saveStrategyTool, markNodeTool, videoTool, runTool, predictTool, traceTool, exerciseTool, checkExerciseTool, startProjectTool, checkProjectTool, advanceProjectTool, reviewTool].map(gated)
const pick = (groups: ToolGroup[]) => ALL.filter((t) => groups.includes(t.group))
// For demos and self-tests: call one tool the way an engine would.
export const runTutorTool = (name: string, args: unknown, scope: TurnScope | null) => ALL.find((t) => t.name === name)!.run(args, scope)

// ---------- per engine ----------

export type Engine = "claude-plan" | "grok-plan" | "api"
export const toolName = (engine: Engine, name: string) => (engine === "claude-plan" ? `mcp__tutor__${name}` : engine === "grok-plan" ? `tutor__${name}` : name)
export const isCardTool = (name: string) => /(^|__)(quiz|ask_user_question|predict|trace_code|exercise)$/.test(name)

const mcpContent = (o: Out) => [{ type: "text" as const, text: o.text }, ...(o.png ? [{ type: "image" as const, data: o.png, mimeType: "image/png" }] : [])]

// AI SDK (API keys and Ollama).
export function aiTutorTools(groups: ToolGroup[], scope: TurnScope): ToolSet {
  return Object.fromEntries(
    pick(groups).map((t) => [
      t.name,
      aiTool({
        description: t.description,
        inputSchema: z.object(t.shape),
        execute: (a: unknown) => t.run(a, scope),
        toModelOutput: ({ output }: { output: Out }) =>
          output.png ? { type: "content", value: [{ type: "text", text: output.text }, { type: "file", mediaType: "image/png", data: { type: "data", data: output.png } }] } : { type: "text", value: output.text }
      } as never)
    ])
  ) as ToolSet
}

// Claude Code: an in-process MCP server; calls may wait as long as you take to answer a card.
export function claudeTutorServer(groups: ToolGroup[], scope: TurnScope) {
  return createSdkMcpServer({
    name: "tutor",
    alwaysLoad: true,
    tools: pick(groups).map((t) => sdkTool(t.name, t.description, t.shape, async (a) => ({ content: mcpContent(await t.run(a, scope)) })))
  })
}
export const claudeTutorNames = (groups: ToolGroup[]) => pick(groups).map((t) => toolName("claude-plan", t.name))

// Grok Build: the same tools over streamable HTTP on 127.0.0.1, behind a random token. Each
// conversation has its own path (/mcp/<conversation>), so a tool call finds the turn it belongs to
// even with several conversations running at once.
const scopes = new Map<string, TurnScope>()
export function bindHttpScope(scope: TurnScope): void {
  scopes.set(scope.conv, scope)
}
export function releaseHttpScope(scope: TurnScope): void {
  if (scopes.get(scope.conv) === scope) scopes.delete(scope.conv)
}
let httpServer: { base: string; token: string } | null = null
export async function tutorHttpServer(conv: string): Promise<{ url: string; token: string }> {
  const s = await startHttp()
  return { url: `${s.base}/${encodeURIComponent(conv)}`, token: s.token }
}
async function startHttp(): Promise<{ base: string; token: string }> {
  if (httpServer) return httpServer
  const token = crypto.randomBytes(24).toString("hex")
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.method !== "POST") {
      res.writeHead(req.method === "POST" ? 401 : 405).end()
      return
    }
    const conv = decodeURIComponent((req.url ?? "").replace(/^\/mcp\/?/, "").split("?")[0])
    const mcp = new McpServer({ name: "tutor", version: "2.1.0" })
    for (const t of ALL) mcp.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (a: unknown) => ({ content: mcpContent(await t.run(a, scopes.get(conv) ?? null)) }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => {
      void transport.close()
      void mcp.close()
    })
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", async () => {
      try {
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
      } catch (err) {
        console.error("[tutor mcp]", err)
        if (!res.headersSent) res.writeHead(400).end()
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  srv.unref()
  httpServer = { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`, token }
  return httpServer
}
