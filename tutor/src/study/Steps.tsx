// The practice steps of a lesson. Each has one action; the answer appears only after a real try.
// In a review session the same views run in "review" mode: the first answer is the grade.
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { HighlightStyle, indentOnInput, indentUnit, bracketMatching, syntaxHighlighting } from "@codemirror/language"
import { python } from "@codemirror/lang-python"
import { javascript } from "@codemirror/lang-javascript"
import { tags as t } from "@lezer/highlight"
import { highlight } from "../highlight"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { Diagram } from "../ui/Diagram"
import { checkConfig, type ConfigRun } from "./config"
import { normOut, type StepState } from "./store"
import { toCard, type World } from "./world"
import type { Machines, Step } from "./types"

// ---------- bridge ----------
type TestRun = { ok: boolean; tests: { name: string; ok: boolean; message?: string }[]; typeErrors: { file: string; line: number; message: string }[]; loadError?: string; stdout: string; timedOut: boolean }
type ShellRun = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; verify?: { ok: boolean; out: string } }
type RunResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type Bridge = {
  studyRun(r: { kind: "code"; lang: string; code: string; tests: string; types?: string }): Promise<TestRun>
  studyRun(r: { kind: "run"; lang: string; code: string; stdin?: string }): Promise<RunResult>
  studyRun(r: { kind: "shell"; files: Record<string, string>; setup?: string; script: string; verify?: string; vm?: boolean } & Machines): Promise<ShellRun>
  labStatus(): Promise<{ state: "no-lima" | "no-vm" | "stopped" | "running"; script: string }>
  labSetup(): Promise<number>
  onLabLog(cb: (line: string) => void): () => void
  labOpen(t: { files: Record<string, string>; setup?: string } & Machines): Promise<{ id: string; machines: string[] } | { error: string }>
  labCheck(id: string, verify?: string, peerVerify?: string): Promise<{ ok: boolean; out: string }>
  labClose(id: string): Promise<boolean>
  labShell(id: string, machine: string, cols: number, rows: number): Promise<string | null>
  labWrite(key: string, data: string): void
  labResize(key: string, cols: number, rows: number): void
  labKill(key: string): void
  onLabShell(cb: (ev: { key: string; data?: string; exit?: number }) => void): () => void
  openVisualizer(code?: string, edit?: boolean): Promise<{ ok: true } | { ok: false; error: string }>
  visualizerUrl(): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  studyShow(r: { kind: "show"; lang: string; code: string; expr: string }): Promise<{ ok: boolean; value?: unknown; error?: string }>
  studyProject(r: { action: "where"; folder: string }): Promise<{ dir: string; exists: boolean }>
  studyProject(r: { action: "open" | "finder"; folder: string; files: Record<string, string> }): Promise<{ dir: string; app: string }>
  studyProject(r: { action: "check"; folder: string; tests: Record<string, string>; local?: boolean }): Promise<TestRun>
}
const bridge = () => (window as unknown as { tutor: Bridge }).tutor

// The world card. A lesson may declare `show: expr -> kind`: after Run/Submit, the app evaluates
// the expression against your code and draws the place it returned — a wrong room is a wrong
// picture, which is the same fact the tests check. (see ../../src/study/world.ts)
const DOOR_ARROW: Record<string, string> = { north: "↑", south: "↓", east: "→", west: "←", up: "↥", down: "↧", in: "→", out: "←", left: "←", right: "→" }
export function WorldCard({ card, err, pending }: { card: World | null; err?: string; pending?: boolean }) {
  if (err) return <div className="s-world dimerr">The picture couldn't be drawn: {err}</div>
  if (!card) return <div className="s-world dim">Run to put Sam somewhere.</div>
  return (
    <div className="s-world">
      <div className="s-world-room">
        <div className="s-world-name">{card.room}</div>
        <div className="s-world-doors">
          {card.exits && card.exits.length > 0 ? (
            card.exits.map((d) => (
              <span key={d} className="s-world-door">
                <span className="arr">{DOOR_ARROW[d.toLowerCase()] ?? "◻"}</span>
                {d}
              </span>
            ))
          ) : (
            <span className="s-world-none">{card.exits ? "no doors" : "—"}</span>
          )}
        </div>
        <div className="s-world-floor">
          {card.items && card.items.length > 0 ? card.items.map((i) => <span key={i}>{i}</span>) : <span className="s-world-none">{card.items ? "nothing on the floor" : ""}</span>}
        </div>
      </div>
      <div className="s-world-bag">
        <svg className="s-world-bagicon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 5V4a3 3 0 0 1 6 0v1h2.5c.6 0 1 .4 1 1l-.7 7.2c-.1.6-.5.8-1 .8H3.2c-.5 0-.9-.2-1-.8L1.5 6c0-.6.4-1 1-1H5Zm1.5 0h3V4a1.5 1.5 0 0 0-3 0v1Z" fill="currentColor" />
        </svg>
        {card.bag && card.bag.length > 0 ? card.bag.map((i) => <span key={i} className="s-world-item">{i}</span>) : <span className="s-world-none">{card.bag ? "empty" : ""}</span>}
      </div>
      {card.said && <div className="s-world-said">“{card.said}”</div>}
    </div>
  )
}
// A TypeScript type error gets the other card: the clerk's form, the line and the reason it was
// returned. tsc's refusal is why bookkeeping is the game.
export function ClerkCard({ errors }: { errors: { file: string; line: number; message: string }[] }) {
  const forFile = (want: string) => errors.filter((e) => e.file === want)
  const main = forFile("solution.ts")
  const extra = errors.filter((e) => e.file !== "solution.ts" && e.file !== "types.check.ts")
  return (
    <div className="s-clerk">
      <div className="s-clerk-stamp">RETURNED</div>
      <div className="s-clerk-line">
        {main.map((e, i) => (
          <div key={i} className="s-clerk-item">
            <span className="s-clerk-ref">line {e.line}</span> {e.message.replace(/^TS\d+: /, "")}
          </div>
        ))}
        {extra.map((e, i) => (
          <div key={i} className="s-clerk-item is-hidden">
            <span className="s-clerk-ref">{e.file}</span> {e.message.replace(/^TS\d+: /, "")}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- the visualizer ----------
// A REPL transcript (>>> and ... lines plus their output) becomes the program it typed.
export function vizProgram(code: string): string {
  const lines = code.split("\n")
  if (!lines.some((l) => l.startsWith(">>>"))) return code
  return lines
    .filter((l) => l.startsWith(">>>") || l.startsWith("..."))
    .map((l) => l.slice(4))
    .join("\n")
}
// Code that is only definitions (most exercises) has nothing to step through yet: it opens in the
// visualizer's editor with a line that says where a call goes.
const onlyDefs = (code: string) =>
  code
    .split("\n")
    .filter((l) => l.trim() && !/^\s/.test(l))
    .every((l) => /^(def |async def |class |import |from |@|#|\)|\]|\})/.test(l))
export function visualize(code: string) {
  const prog = vizProgram(code)
  if (!onlyDefs(prog)) return void bridge().openVisualizer?.(prog)
  void bridge().openVisualizer?.(`${prog.trimEnd()}\n\n# Call it here to watch it run, then press "Visualize Execution".\n`, true)
}
// The first call an exercise's tests make, as an expression to print under the learner's
// definitions, so there is something to step through.
export function callFromTests(tests: string): string | null {
  const m = /^\s+assert\s+(?:not\s+)?(\w+\(.*?\))\s*(?:==|!=|is\b|in\b|>|<|$)/m.exec(tests) ?? /^\s+(?:\w+\s*=\s*)?(\w+\([^\n]*\))\s*$/m.exec(tests)
  return m ? m[1] : null
}

// Your code, plus a call to it when it's only definitions, so Run and Visualize have something to do.
export function withCall(code: string, tests: string): string {
  if (!onlyDefs(code)) return code
  const call = callFromTests(tests)
  return call ? `${code.trimEnd()}\n\nprint(${call})\n` : `${code.trimEnd()}\n\n# Call your code here to watch it run.\n`
}

// The visualizer inside the exercise: your code, stepped through, right under the editor.
let vizBase: string | null = null
export function VizFrame({ code, tests, run }: { code: string; tests: string; run: number }) {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (!run) return
    let live = true
    ;(async () => {
      if (!vizBase) {
        const r = await bridge().visualizerUrl()
        if (!r.ok) return live && setErr(r.error)
        vizBase = r.url
      }
      const prog = withCall(code, tests)
      const hash = `#embed=1&theme=dark&n=${run}&code=${encodeURIComponent(prog)}`
      if (!live) return
      setErr(null)
      // The same page just gets a new hash; the first time it loads.
      if (frame.current && src) frame.current.contentWindow?.location.replace(vizBase + hash)
      else setSrc(vizBase + hash)
    })()
    return () => {
      live = false
    }
  }, [run])
  if (err) return <p className="s-nudge">{err}</p>
  if (!src) return null
  return <iframe ref={frame} className="s-vizframe" src={src} title="Python visualizer" />
}

export function VizButton({ code, label = "Visualize", className = "s-btn" }: { code: string; label?: string; className?: string }) {
  return (
    <button className={`${className} s-viz`} title="Step through it in the Python visualizer, like pythontutor.com" onClick={() => visualize(code)}>
      {label}
    </button>
  )
}

// ---------- text ----------
export function Md({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ pre: Pre, a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
      {text}
    </Markdown>
  )
}
const PLAIN = new Set(["hcl", "terraform", "text", "txt", "plain", "output"])
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
export function Code({ code, lang }: { code: string; lang?: string }) {
  const html = useMemo(() => (!lang || PLAIN.has(lang) ? esc(code) : highlight(code, lang)), [code, lang])
  return (
    <pre className="s-code" data-lang={lang && !PLAIN.has(lang) ? lang : undefined}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
function Pre(props: React.ComponentProps<"pre">) {
  const child = (props.children as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined)?.props
  const lang = /language-([\w+-]+)/.exec(child?.className ?? "")?.[1]
  const code = String(child?.children ?? "").replace(/\n$/, "")
  // ```mermaid draws as a diagram (the same renderer the old lessons used).
  if (lang === "mermaid") return <Diagram kind="mermaid" code={code} live={false} />
  // Python examples open in the visualizer with one click.
  if (lang === "python" || lang === "py" || lang === "pycon")
    return (
      <div className="s-codewrap">
        <Code code={code} lang="python" />
        <VizButton code={code} label="▶ Visualize" className="s-vizchip" />
      </div>
    )
  return <Code code={code} lang={lang} />
}

// ---------- editor ----------
const theme = EditorView.theme(
  {
    "&": { fontSize: "13px", background: "var(--well)", borderRadius: "8px", border: "1px solid var(--rule)" },
    "&.cm-focused": { outline: "none", borderColor: "var(--accent-dim)" },
    ".cm-content": { fontFamily: "var(--mono)", padding: "10px 0", caretColor: "var(--ink)" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-gutters": { background: "transparent", border: "none", color: "var(--ink-4)" },
    ".cm-activeLine": { background: "rgba(255,255,255,0.025)" },
    ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-3)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "rgba(150,170,255,0.25) !important" },
    ".cm-cursor": { borderLeftColor: "var(--ink)" }
  },
  { dark: true }
)
const colors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c4a5f5" },
  { tag: [t.string, t.special(t.string)], color: "#a6d189" },
  { tag: [t.number, t.bool, t.null], color: "#ef9f76" },
  { tag: [t.comment], color: "#6c6f7e", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8caaee" },
  { tag: [t.typeName, t.className], color: "#81c8be" }
])

export function Editor({ value, onChange, lang, onRun, minLines = 4, fill }: { value: string; onChange: (v: string) => void; lang: string; onRun?: () => void; minLines?: number; fill?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const run = useRef(onRun)
  run.current = onRun
  const change = useRef(onChange)
  change.current = onChange
  useEffect(() => {
    const py = lang === "python"
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of(py ? "    " : "  "),
          EditorState.tabSize.of(py ? 4 : 2),
          keymap.of([{ key: "Mod-Enter", run: () => (run.current?.(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          ...(py ? [python()] : lang === "typescript" ? [javascript({ typescript: true })] : []),
          syntaxHighlighting(colors),
          theme,
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
          EditorView.updateListener.of((u) => u.docChanged && change.current(u.state.doc.toString()))
        ]
      })
    })
    view.current = v
    return () => v.destroy()
  }, [lang])
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])
  return <div className={`s-editor ${fill ? "fill" : ""}`} ref={host} style={fill ? undefined : { minHeight: `${minLines * 1.6 + 1.4}em` }} />
}

// ---------- steps ----------
export type StepProps = {
  step: Step
  st: StepState | undefined
  review?: boolean
  onResult: (ok: boolean, draft?: string) => void
  onShow: () => void
  // The lesson's `show:` fixture, for write steps that return a place.
  show?: { expr: string; kind: string }
}

const KIND_LABEL: Record<Step["kind"], string> = { quiz: "Question", predict: "Predict", card: "Recall", write: "Write", shell: "Terminal", term: "Live machine", config: "Config", project: "Project" }

export function StepView(p: StepProps) {
  const s = p.step
  return (
    <section className={`s-step s-step-${s.kind} ${p.st?.ok && !p.review ? "passed" : ""}`}>
      <div className="s-step-kind">
        {KIND_LABEL[s.kind]}
        {p.st?.ok && !p.review && <span className="s-tick">passed</span>}
      </div>
      {s.kind === "quiz" && <Quiz {...p} step={s} />}
      {s.kind === "predict" && <Predict {...p} step={s} />}
      {s.kind === "card" && <Card {...p} step={s} />}
      {s.kind === "write" && <Write {...p} step={s} />}
      {s.kind === "shell" && <Shell {...p} step={s} />}
      {s.kind === "term" && <Term {...p} step={s} />}
      {s.kind === "config" && <Config {...p} step={s} />}
      {s.kind === "project" && <Project {...p} step={s} />}
    </section>
  )
}

type P<K extends Step["kind"]> = Omit<StepProps, "step"> & { step: Extract<Step, { kind: K }> }

// Options in a shuffled but stable order (per question, and per day in reviews), so you learn the
// answer rather than its position.
function shuffled(n: number, seed: string): number[] {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const out = [...Array(n).keys()]
  for (let i = n - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    const j = h % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function Quiz({ step, st, review, onResult }: P<"quiz">) {
  const [picked, setPicked] = useState<number[]>([])
  const order = useMemo(() => shuffled(step.options.length, step.q + (review ? new Date().toDateString() : "")), [step, review])
  const right = step.options.findIndex((o) => o.right)
  const solved = picked.includes(right) || (!review && !!st?.ok && !picked.length)
  const over = review ? picked.length > 0 : solved
  const pick = (i: number) => {
    if (over || picked.includes(i)) return
    setPicked((x) => [...x, i])
    if (review) onResult(i === right)
    else if (i === right) onResult(true)
    else onResult(false)
  }
  return (
    <>
      <div className="s-q">
        <Md text={step.q} />
      </div>
      <div className="s-options">
        {order.map((i) => {
          const o = step.options[i]
          const cls = picked.includes(i) || (over && i === right) ? (i === right ? "right" : "wrong") : ""
          return (
            <button key={i} className={`s-option ${cls}`} onClick={() => pick(i)} disabled={over}>
              <Md text={o.text} />
            </button>
          )
        })}
      </div>
      {over && step.why && (
        <div className="s-why">
          <Md text={step.why} />
        </div>
      )}
      {!over && picked.length > 0 && <p className="s-nudge">Not that one. Try again.</p>}
    </>
  )
}

function Predict({ step, st, review, onResult, onShow }: P<"predict">) {
  const [guess, setGuess] = useState(st?.draft ?? "")
  const [state, setState] = useState<"open" | "wrong" | "right" | "shown">(!review && st?.ok ? (st.shown ? "shown" : "right") : "open")
  const done = state === "right" || state === "shown" || (review && state === "wrong")
  const check = () => {
    if (!guess.trim() || done) return
    const ok = normOut(guess) === normOut(step.answer)
    setState(ok ? "right" : "wrong")
    onResult(ok, guess)
  }
  return (
    <>
      <div className="s-q">
        <Md text={step.q} />
      </div>
      <Code code={step.code} lang={step.lang === "shell" ? "bash" : step.lang} />
      <textarea
        className="s-answer"
        value={guess}
        rows={Math.max(2, step.answer.split("\n").length)}
        placeholder="Type the output exactly"
        spellCheck={false}
        disabled={done}
        onChange={(e) => (setGuess(e.target.value), state === "wrong" && setState("open"))}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), check())}
      />
      {!done && (
        <div className="s-actions">
          <button className="s-btn" onClick={check} disabled={!guess.trim()}>
            Check <kbd>⌘↵</kbd>
          </button>
          {state === "wrong" && !review && (
            <button className="s-link" onClick={() => (onShow(), setState("shown"), onResult(true, guess))}>
              Show the answer
            </button>
          )}
        </div>
      )}
      {state === "wrong" && !review && <p className="s-nudge">Not what it prints. Trace it line by line and try again.</p>}
      {done && (
        <div className="s-why">
          {state !== "right" && (
            <>
              <div className="s-sub">It prints</div>
              <Code code={step.answer} lang="text" />
            </>
          )}
          {step.why && <Md text={step.why} />}
          {step.lang === "python" && (
            <div className="s-actions">
              <VizButton code={step.code} label="Step through it in the visualizer" className="s-link" />
            </div>
          )}
        </div>
      )}
    </>
  )
}

function Card({ step, st, review, onResult }: P<"card">) {
  const [shown, setShown] = useState(!review && !!st?.ok)
  const [graded, setGraded] = useState(!review && !!st?.ok)
  return (
    <>
      <div className="s-q">
        <Md text={step.q} />
      </div>
      {!shown ? (
        <div className="s-actions">
          <button className="s-btn" onClick={() => setShown(true)}>
            Show the answer
          </button>
        </div>
      ) : (
        <>
          <div className="s-why">
            <Md text={step.answer} />
          </div>
          {!graded && (
            <div className="s-actions">
              <button className="s-btn" onClick={() => (setGraded(true), onResult(true))}>
                I had it
              </button>
              <button className="s-link" onClick={() => (setGraded(true), onResult(false))}>
                I didn't
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// A failed run shows what to fix; the solution is offered after the first failed run.
function Write({ step, show, st, onResult, onShow }: P<"write">) {
  const [code, setCode] = useState(st?.draft ?? step.starter)
  const [run, setRun] = useState<TestRun | null>(null)
  const [ran, setRan] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState<"" | "submit" | "run">("")
  const [solution, setSolution] = useState(false)
  const [hint, setHint] = useState(false)
  const [viz, setViz] = useState(0)
  const [tab, setTab] = useState<"output" | "viz" | "input">("output")
  // The world card: what your function did to the place, updated on Run and Submit.
  const [card, setCard] = useState<World | null>(null)
  const [cardErr, setCardErr] = useState<string | undefined>(undefined)
  const pullCard = (src: string) => {
    if (!show) return
    bridge()
      .studyShow({ kind: "show", lang: step.lang, code: src, expr: show.expr })
      .then((r) => {
        setCardErr(r.ok ? undefined : r.error)
        setCard(r.ok ? toCard(show.kind, r.value) : null)
      })
      .catch((e) => setCardErr((e as Error).message))
  }
  // What input() reads when you press Run: one line per answer, typed before the run.
  const [stdin, setStdin] = useState("")
  const asks = /\binput\s*\(/.test(code)
  const py = step.lang === "python"
  // Submit runs the hidden tests; Run only runs your code and shows what it prints.
  const go = async () => {
    if (busy) return
    setBusy("submit")
    setTab("output")
    try {
      const r = await bridge().studyRun({ kind: "code", lang: step.lang, code, tests: step.tests, types: step.types })
      setRun(r)
      setRan(null)
      onResult(r.ok, code)
      void pullCard(code)
    } catch (e) {
      setRun({ ok: false, tests: [], typeErrors: [], loadError: (e as Error).message, stdout: "", timedOut: false })
    } finally {
      setBusy("")
    }
  }
  const just = async () => {
    if (busy) return
    setBusy("run")
    setTab("output")
    try {
      setRan(await bridge().studyRun({ kind: "run", lang: step.lang, code: step.lang === "python" ? withCall(code, step.tests) : code, stdin }))
      setRun(null)
      void pullCard(code)
    } catch (e) {
      setRan({ stdout: "", stderr: (e as Error).message, exitCode: 1, timedOut: false })
    } finally {
      setBusy("")
    }
  }
  return (
    <div className="s-ide">
      <div className="s-q s-task">
        <Md text={step.task} />
      </div>
      <Editor value={code} onChange={setCode} lang={step.lang} onRun={go} fill />
      <div className="s-idebar">
        <button className="s-btn s-submit" onClick={go} disabled={!!busy}>
          {busy === "submit" ? "Running…" : "Submit"} <kbd>⌘↵</kbd>
        </button>
        <button className="s-btn" onClick={just} disabled={!!busy} title="Run your code and show what it prints">
          {busy === "run" ? "Running…" : "Run"}
        </button>
        {py && (
          <button
            className="s-btn"
            title="Step through your code, line by line"
            onClick={() => (setViz((n) => n + 1), setTab("viz"))}
          >
            Visualize
          </button>
        )}
        {step.hint && !hint && !solution && (
          <button className="s-btn" onClick={() => setHint(true)}>
            Hint
          </button>
        )}
        {run && !run.ok && !solution && (
          <button className="s-btn" onClick={() => (setSolution(true), onShow())}>
            Solution
          </button>
        )}
        <button className="s-btn s-reset" title="Start again from the starter code" onClick={() => setCode(step.starter)} disabled={!!busy || code === step.starter}>
          Reset
        </button>
      </div>
      {show && <WorldCard card={card} err={cardErr} />
      }
      <div className={`s-console ${tab === "viz" ? "big" : ""}`}>
        <div className="s-contabs">
          <button className={tab === "output" ? "on" : ""} onClick={() => setTab("output")}>
            Output
          </button>
          {py && viz > 0 && (
            <button className={tab === "viz" ? "on" : ""} onClick={() => setTab("viz")}>
              Visualizer
            </button>
          )}
          {(asks || stdin) && (
            <button className={tab === "input" ? "on" : ""} onClick={() => setTab("input")}>
              Input{stdin ? ` (${stdin.split("\n").filter(Boolean).length})` : ""}
            </button>
          )}
        </div>
        <div className="s-conbody" hidden={tab !== "input"}>
          <p className="s-fine">Your code calls input(). Type the answers here, one per line, then press Run: each input() reads the next line.</p>
          <textarea className="s-answer" rows={5} value={stdin} spellCheck={false} placeholder={"go north\ntake key\nquit"} onChange={(e) => setStdin(e.target.value)} />
        </div>
        <div className="s-conbody" hidden={tab !== "output"}>
          {!run && !ran && !hint && !solution && <p className="s-fine">Press Run to see what your code prints, or Submit to check it.</p>}
          {ran && (
            <pre className={`s-out ${ran.exitCode ? "" : "dim"}`}>
              {ran.stdout}
              {ran.stderr && <span className="err">{ran.stderr}</span>}
              {ran.timedOut && <span className="err">{"\n"}It ran for too long and was stopped.</span>}
              {!ran.stdout && !ran.stderr && !ran.timedOut && "(it printed nothing)"}
            </pre>
          )}
          {run && <TestResults run={run} types={step.types} clerk={step.lang === "typescript"} />}
          {(hint || (run && !run.ok)) && step.hint && !solution && (
            <div className="s-hint">
              <Md text={step.hint} />
            </div>
          )}
          {solution && (
            <div className="s-why">
              <div className="s-sub">One solution (type it in yourself, then run it)</div>
              <Code code={step.solution} lang={step.lang} />
              {py && <VizButton code={step.solution} label="Step through the solution" className="s-link" />}
            </div>
          )}
        </div>
        {py && viz > 0 && (
          <div className="s-conbody viz" hidden={tab !== "viz"}>
            <VizFrame code={code} tests={step.tests} run={viz} />
          </div>
        )}
      </div>
    </div>
  )
}

// A project is built from a blank folder in your own editor; Check runs the hidden acceptance tests
// against that folder. The reference solution is offered only after a failed check.
function Project({ step, onResult, onShow }: P<"project">) {
  const [where, setWhere] = useState<{ dir: string; exists: boolean } | null>(null)
  const [run, setRun] = useState<TestRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const [hint, setHint] = useState(false)
  const [solution, setSolution] = useState(false)
  useEffect(() => {
    bridge().studyProject({ action: "where", folder: step.folder }).then(setWhere, () => {})
  }, [step.folder])
  const open = async (action: "open" | "finder") => {
    const r = await bridge().studyProject({ action, folder: step.folder, files: step.files })
    setWhere({ dir: r.dir, exists: true })
    setNote(`Opened in ${r.app}.`)
  }
  const check = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await bridge().studyProject({ action: "check", folder: step.folder, tests: step.tests, local: step.local })
      setRun(r)
      onResult(r.ok)
    } catch (e) {
      setRun({ ok: false, tests: [], typeErrors: [], loadError: (e as Error).message, stdout: "", timedOut: false })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="s-q s-spec">
        <Md text={step.task} />
      </div>
      <div className="s-projbox">
        <div className="s-sub">Your folder</div>
        <code className="s-projdir">{where?.dir ?? "…"}</code>
        <p className="s-fine">{where?.exists ? "It's there. Work in it with your own editor, then press Check." : "It doesn't exist yet: Open creates it with the starting files."}{step.local ? " This project runs with its own toolchain (uv and packages), outside Tutor's sandbox." : ""}</p>
        <div className="s-actions">
          <button className="s-btn" onClick={() => void open("open")}>
            Open in PyCharm
          </button>
          <button className="s-btn" onClick={() => void open("finder")}>
            Show in Finder
          </button>
          <button className="s-btn s-submit" onClick={check} disabled={busy}>
            {busy ? "Checking…" : "Check"}
          </button>
          {step.hint && !hint && (
            <button className="s-btn" onClick={() => setHint(true)}>
              Hint
            </button>
          )}
          {run && !run.ok && !solution && (
            <button className="s-link" onClick={() => (setSolution(true), onShow())}>
              Show the reference solution
            </button>
          )}
        </div>
        {note && <p className="s-fine">{note}</p>}
      </div>
      {run && <TestResults run={run} />}
      {hint && step.hint && (
        <div className="s-hint">
          <Md text={step.hint} />
        </div>
      )}
      {solution && (
        <div className="s-why">
          <div className="s-sub">One way to build it (read it, close it, then write your own)</div>
          {Object.entries(step.solution).map(([f, body]) => (
            <Fragment key={f}>
              <div className="s-sub">{f}</div>
              <Code code={body} lang={/\.py$/.test(f) ? "python" : /\.md$/.test(f) ? "markdown" : undefined} />
            </Fragment>
          ))}
        </div>
      )}
    </>
  )
}

// Errors in the hidden type checks point at code you can't see: say what that check expects instead.
function explainTypeError(e: TestRun["typeErrors"][number], types?: string): { title: string; detail: string } {
  if (e.file !== "types.check.ts" || !types) return { title: `Type error, line ${e.line}`, detail: e.message.replace(/^TS\d+: /, "") }
  const lines = types.split("\n")
  const code = (lines[e.line - 1] ?? "").trim()
  if (/TS2578/.test(e.message)) {
    const why = (lines[e.line - 1] ?? "").replace(/^\s*\/\/\s*@ts-expect-error:?\s*/, "")
    return { title: `Your types accept something they should reject${why ? `: ${why}` : ""}`, detail: (lines[e.line] ?? "").trim() }
  }
  return { title: "Your types reject something they should accept", detail: `${code}\n${e.message.replace(/^TS\d+: /, "")}` }
}

function TestResults({ run, types, clerk }: { run: TestRun; types?: string; clerk?: boolean }) {
  const passed = run.tests.filter((x) => x.ok).length
  // In TypeScript your code's own type errors come back as the clerk's form; a failure in the
  // hidden type checks ("types:") keeps its explained rendering.
  const mine = run.typeErrors.filter((e) => e.file === "solution.ts")
  const rest = run.typeErrors.filter((e) => e.file !== "solution.ts")
  return (
    <div className={`s-result ${run.ok ? "ok" : "bad"}`}>
      <div className="s-result-head">{run.ok ? "All tests pass" : run.loadError ? "It didn't run" : run.tests.length ? `${passed} of ${run.tests.length} tests pass` : "No tests ran"}</div>
      {run.loadError && <pre className="s-out">{run.loadError}</pre>}
      {!run.ok &&
        run.tests
          .filter((x) => !x.ok)
          .map((x, i) => (
            <div key={i} className="s-fail">
              <b>{x.name}</b>
              {x.message && <pre className="s-out">{x.message}</pre>}
            </div>
          ))}
      {clerk && mine.length > 0 && <ClerkCard errors={mine} />}
      {rest.map((e, i) => {
        const t = explainTypeError(e, types)
        return (
          <div key={i} className="s-fail">
            <b>{t.title}</b>
            <pre className="s-out">{t.detail}</pre>
          </div>
        )
      })}
      {run.stdout.trim() && <pre className="s-out dim">{run.stdout.trim()}</pre>}
    </div>
  )
}

function Files({ files }: { files: Record<string, string> }) {
  const names = Object.keys(files)
  if (!names.length) return null
  return (
    <details className="s-files">
      <summary>
        {names.length} file{names.length === 1 ? "" : "s"} in the folder: {names.slice(0, 4).join(", ")}
        {names.length > 4 ? ", …" : ""}
      </summary>
      {names.map((n) => (
        <Fragment key={n}>
          <div className="s-sub">{n}</div>
          <Code code={files[n]} lang="text" />
        </Fragment>
      ))}
    </details>
  )
}

// Server tasks run on the Linux lab. Until it's set up, the step offers to set it up.
function LabGate({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<"checking" | "missing" | "stopped" | "ready" | "installing" | "failed">("checking")
  const [log, setLog] = useState<string[]>([])
  const [script, setScript] = useState("")
  const check = () =>
    bridge()
      .labStatus()
      .then((s) => {
        setScript(s.script)
        setState(s.state === "running" ? "ready" : s.state === "stopped" ? "stopped" : "missing")
        if (s.state === "running" || s.state === "stopped") onReady()
      })
      .catch(() => setState("missing"))
  useEffect(() => {
    void check()
  }, [])
  const install = async () => {
    setState("installing")
    setLog([])
    const off = bridge().onLabLog((l) => setLog((x) => [...x.slice(-12), l]))
    const code = await bridge().labSetup()
    off()
    if (code === 0) void check()
    else setState("failed")
  }
  if (state === "ready" || state === "checking") return null
  if (state === "stopped") return <p className="s-fine">The first run starts the Linux lab's machine, which takes about half a minute.</p>
  return (
    <div className="s-lab">
      <p>
        This exercise runs as root on a real Ubuntu machine in Tutor's <b>Linux lab</b>, which isn't set up on this Mac yet. Setting it up downloads about 1.2 GB once (Lima, Ubuntu 24.04, a container image and a small VM image for the storage lessons) and takes about 15 minutes. The lab can't see your Mac's files.
      </p>
      {state !== "installing" ? (
        <div className="s-actions">
          <button className="s-btn" onClick={install}>
            {state === "failed" ? "Try again" : "Set up the Linux lab"}
          </button>
          <span className="s-fine">or in Terminal: bash "{script}"</span>
        </div>
      ) : (
        <pre className="s-out dim">{log.join("\n") || "Starting…"}</pre>
      )}
      {state === "failed" && <p className="s-nudge">Setup stopped. The last lines above say why; running it again continues where it left off.</p>}
    </div>
  )
}

function Shell({ step, st, onResult, onShow }: P<"shell">) {
  const [cmd, setCmd] = useState(st?.draft ?? "")
  const [run, setRun] = useState<(ShellRun & { ok: boolean }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [solution, setSolution] = useState(false)
  const [labOk, setLabOk] = useState(!step.vm)
  const go = async () => {
    if (busy || !cmd.trim() || !labOk) return
    setBusy(true)
    setRun(null)
    try {
      const r = await bridge().studyRun({ kind: "shell", files: step.files, setup: step.setup, script: cmd, verify: step.verify, vm: step.vm, peer: step.peer, peerSetup: step.peerSetup, peerVerify: step.peerVerify, fullvm: step.fullvm, disks: step.disks })
      const ok = !r.timedOut && (step.expect !== undefined ? normOut(r.stdout) === normOut(step.expect) : true) && (step.verify || step.peerVerify ? !!r.verify?.ok : true)
      setRun({ ...r, ok })
      onResult(ok, cmd)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="s-q">
        <Md text={step.task} />
      </div>
      {!step.secret && <Files files={step.files} />}
      {step.vm && <LabGate onReady={() => setLabOk(true)} />}
      <div className="s-term">
        <span className="s-prompt">{step.vm ? "root@lab:~#" : "$"}</span>
        <textarea
          value={cmd}
          rows={Math.max(1, cmd.split("\n").length)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="your command"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void go()
            }
          }}
        />
      </div>
      {busy && step.vm && <p className="s-fine">{step.fullvm ? "Booting a fresh Ubuntu VM (about half a minute) and running your commands…" : "Booting a fresh Ubuntu machine and running your commands…"}</p>}
      <p className="s-fine">
        {step.vm
          ? `Enter runs it, ⇧Enter adds a line. It runs as root on a fresh Ubuntu 24.04 ${step.fullvm ? `VM with its own kernel${step.disks?.length ? ` and blank disks (${step.disks.map((d, i) => `/dev/vd${"abcd"[i]} ${d}`).join(", ")})` : ""}` : "machine with real systemd, apt and networking"}${step.peer ? `, next to a second machine called ${step.peer}` : ""}. Every run starts from clean machines, so put all the commands for the task in one go.`
          : "Enter runs it, ⇧Enter adds a line. It runs in a throwaway folder with bash, macOS's built-in tools, and no network."}
        {step.secret && " Every run starts from the level's original folder, so explore freely; the level is solved when your command prints only the password."}
      </p>
      {run && (
        <div className={`s-result ${run.ok ? "ok" : "bad"}`}>
          <div className="s-result-head">{run.ok ? (step.secret ? "Password accepted" : "Done") : run.timedOut ? (step.vm ? "It ran out of time (something waiting for input, or a very slow command?)" : "It stopped after 8 seconds (waiting for input?)") : step.secret ? "That output isn't just the password" : "Not yet"}</div>
          {(run.stdout || run.stderr) && (
            <pre className="s-out">
              {run.stdout}
              {run.stderr && <span className="err">{run.stderr}</span>}
            </pre>
          )}
          {!run.ok && run.verify && !run.verify.ok && run.verify.out && <p className="s-nudge s-verify">{run.verify.out}</p>}
          {!run.ok && step.expect !== undefined && !run.timedOut && !step.secret && (
            <>
              <div className="s-sub">Expected output</div>
              <Code code={step.expect} lang="text" />
            </>
          )}
        </div>
      )}
      {run && !run.ok && (
        <div className="s-actions">
          {step.hint && !solution && (
            <div className="s-hint">
              <Md text={step.hint} />
            </div>
          )}
          {!solution && (!step.secret || (st?.tries ?? 0) >= 3) && (
            <button className="s-link" onClick={() => (setSolution(true), onShow())}>
              Show a solution
            </button>
          )}
        </div>
      )}
      {solution && (
        <div className="s-why">
          <div className="s-sub">One way</div>
          <Code code={step.solution} lang="bash" />
        </div>
      )}
    </>
  )
}

// A live shell in an xterm: keystrokes go to a root bash on a lab machine, output comes back.
function LiveShell({ id, machine, active }: { id: string; machine: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const [gen, setGen] = useState(0)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: { background: "#0b0c0e", foreground: "#e9e7e1", cursor: "#e9e7e1", selectionBackground: "rgba(157,176,255,0.3)", green: "#8fd5a6", brightGreen: "#a6e3b8", blue: "#9db0ff", brightBlue: "#b7c5ff" }
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    try {
      fit.fit()
    } catch {}
    let key: string | null = null
    let gone = false
    const early: { key: string; data?: string; exit?: number }[] = []
    const show = (ev: { key: string; data?: string; exit?: number }) => {
      if (ev.data !== undefined) term.write(ev.data)
      if (ev.exit !== undefined) {
        term.write("\r\n\x1b[2m[shell closed]\x1b[0m\r\n")
        setEnded(true)
      }
    }
    const off = bridge().onLabShell((ev) => (key === null ? early.push(ev) : ev.key === key && show(ev)))
    void bridge()
      .labShell(id, machine, term.cols, term.rows)
      .then((k) => {
        if (gone) return void (k && bridge().labKill(k))
        key = k ?? ""
        if (!k) term.write("Couldn't open a shell on this machine. Start over for a fresh one.\r\n")
        early.filter((ev) => ev.key === k).forEach(show)
      })
    const input = term.onData((d) => key && bridge().labWrite(key, d))
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetWidth) return
      try {
        fit.fit()
      } catch {}
      if (key) bridge().labResize(key, term.cols, term.rows)
    })
    ro.observe(host.current!)
    return () => {
      gone = true
      ro.disconnect()
      input.dispose()
      off()
      if (key) bridge().labKill(key)
      term.dispose()
      termRef.current = null
    }
  }, [id, machine, gen])
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, gen])
  return (
    <div className="s-xterm-wrap" hidden={!active}>
      <div className="s-xterm" ref={host} />
      {ended && (
        <button className="s-link s-reopen" onClick={() => (setEnded(false), setGen((g) => g + 1))}>
          Open a new shell on {machine}
        </button>
      )}
    </div>
  )
}

// A lab machine that stays up while this step is on screen. You work in a real root shell (on the
// peer too, when there is one); Check runs the step's verify against the state you left.
function Term({ step, st, onResult, onShow }: P<"term">) {
  const [labOk, setLabOk] = useState(false)
  const [want, setWant] = useState(!st?.ok)
  const [gen, setGen] = useState(0)
  const [m, setM] = useState<{ id: string; machines: string[] } | null>(null)
  const [err, setErr] = useState("")
  const [tab, setTab] = useState("lab")
  const [res, setRes] = useState<{ ok: boolean; out: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [solution, setSolution] = useState(false)
  useEffect(() => {
    if (!labOk || !want) return
    let id: string | null = null
    let gone = false
    setM(null)
    setErr("")
    setRes(null)
    setTab("lab")
    void bridge()
      .labOpen({ files: step.files, setup: step.setup, peer: step.peer, peerSetup: step.peerSetup, fullvm: step.fullvm, disks: step.disks })
      .then((r) => {
        if ("error" in r) return void (!gone && setErr(r.error))
        if (gone) return void bridge().labClose(r.id)
        id = r.id
        setM(r)
      })
    return () => {
      gone = true
      if (id) void bridge().labClose(id)
    }
  }, [labOk, want, gen])
  const check = async () => {
    if (!m || busy) return
    setBusy(true)
    try {
      const r = await bridge().labCheck(m.id, step.verify, step.peerVerify)
      setRes(r)
      onResult(r.ok)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="s-q">
        <Md text={step.task} />
      </div>
      <Files files={step.files} />
      <LabGate onReady={() => setLabOk(true)} />
      {labOk && !want && (
        <div className="s-actions">
          <button className="s-btn" onClick={() => setWant(true)}>
            Start a machine
          </button>
        </div>
      )}
      {labOk && want && (
        <>
          {m && m.machines.length > 1 && (
            <div className="s-tabs">
              {m.machines.map((x) => (
                <button key={x} className={x === tab ? "on" : ""} onClick={() => setTab(x)}>
                  root@{x}
                </button>
              ))}
            </div>
          )}
          <div className="s-machine">
            {m ? (
              m.machines.map((x) => <LiveShell key={`${m.id}-${x}`} id={m.id} machine={x} active={x === tab} />)
            ) : err ? (
              <p className="s-nudge">{err}</p>
            ) : (
              <p className="s-fine s-booting">
                {step.fullvm ? `Booting a fresh Ubuntu VM${step.disks?.length ? ` with ${step.disks.length === 1 ? "a blank disk" : `${step.disks.length} blank disks`}` : ""} (about half a minute)` : "Starting a fresh Ubuntu machine"}
                {step.peer ? ` and its neighbour, ${step.peer}` : ""}…
              </p>
            )}
          </div>
          <div className="s-actions">
            <button className="s-btn" onClick={check} disabled={!m || busy}>
              {busy ? "Checking…" : "Check"}
            </button>
            <button className="s-link" onClick={() => setGen((g) => g + 1)}>
              Start over on a fresh machine
            </button>
          </div>
          <p className="s-fine">A real Ubuntu 24.04 machine, root, yours until you leave this step. Nothing here touches your Mac.</p>
        </>
      )}
      {res && (
        <div className={`s-result ${res.ok ? "ok" : "bad"}`}>
          <div className="s-result-head">{res.ok ? "Done" : "Not yet"}</div>
          {!res.ok && res.out && <p className="s-nudge s-verify">{res.out}</p>}
        </div>
      )}
      {res && !res.ok && (
        <div className="s-actions">
          {step.hint && !solution && (
            <div className="s-hint">
              <Md text={step.hint} />
            </div>
          )}
          {!solution && (
            <button className="s-link" onClick={() => (setSolution(true), onShow())}>
              Show a solution
            </button>
          )}
        </div>
      )}
      {solution && (
        <div className="s-why">
          <div className="s-sub">One way</div>
          <Code code={step.solution} lang="bash" />
        </div>
      )}
    </>
  )
}

function Config({ step, st, onResult, onShow }: P<"config">) {
  const [src, setSrc] = useState(st?.draft ?? step.starter)
  const [res, setRes] = useState<ConfigRun | null>(null)
  const [solution, setSolution] = useState(false)
  const go = () => {
    const r = checkConfig(step.lang, src, step.checks)
    setRes(r)
    onResult(r.ok, src)
  }
  const label = { yaml: "YAML", hcl: "Terraform", json: "JSON", dockerfile: "Dockerfile" }[step.lang]
  return (
    <>
      <div className="s-q">
        <Md text={step.task} />
      </div>
      <Editor value={src} onChange={setSrc} lang={step.lang} onRun={go} minLines={Math.min(18, Math.max(6, step.starter.split("\n").length + 2))} />
      <div className="s-actions">
        <button className="s-btn" onClick={go}>
          Check the {label} <kbd>⌘↵</kbd>
        </button>
        {res && !res.ok && !solution && (
          <button className="s-link" onClick={() => (setSolution(true), onShow())}>
            Show a solution
          </button>
        )}
      </div>
      {res && (
        <div className={`s-result ${res.ok ? "ok" : "bad"}`}>
          <div className="s-result-head">{res.ok ? "Every check holds" : res.error ? "It doesn't parse" : `${res.results.filter((r) => r.ok).length} of ${res.results.length} checks hold`}</div>
          {res.error && <pre className="s-out">{res.error}</pre>}
          {!res.error && (
            <ul className="s-checks">
              {res.results.map((r, i) => (
                <li key={i} className={r.ok ? "ok" : "bad"}>
                  <span>{r.ok ? "✓" : "✗"}</span> {r.message}
                  {!r.ok && r.got && <em> (found {r.got})</em>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {res && !res.ok && step.hint && !solution && (
        <div className="s-hint">
          <Md text={step.hint} />
        </div>
      )}
      {solution && (
        <div className="s-why">
          <div className="s-sub">One solution</div>
          <Code code={step.solution} lang={step.lang === "hcl" ? "hcl" : step.lang} />
        </div>
      )}
    </>
  )
}
