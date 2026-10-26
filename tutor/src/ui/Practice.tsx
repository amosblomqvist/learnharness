// Practice in the transcript. An exercise card is a small editor with hidden tests: ⌘↵ runs them,
// hints open one at a time, the reference solution only after you've tried. A project card is a
// real folder you build in your IDE, milestone by milestone.
import { useContext, useEffect, useRef, useState } from "react"
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { HighlightStyle, indentOnInput, indentUnit, bracketMatching, syntaxHighlighting } from "@codemirror/language"
import { python } from "@codemirror/lang-python"
import { javascript } from "@codemirror/lang-javascript"
import { tags as t } from "@lezer/highlight"
import { api, type Ask, type AskAnswer, type ProjectView, type TestRun } from "../api"
import { Md, TurnCtx } from "./Message"
import * as I from "../icons"

const KIND: Record<string, string> = { write: "Write it", fix: "Fix the bug", types: "Make it type-check", complete: "Complete it", refactor: "Refactor, tests stay green" }

const theme = EditorView.theme(
  {
    "&": { fontSize: "12.5px", background: "rgba(0,0,0,0.28)", borderRadius: "9px", border: "1px solid var(--line-2)" },
    "&.cm-focused": { outline: "none", borderColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
    ".cm-content": { fontFamily: "var(--mono)", padding: "8px 0", caretColor: "#fff" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
    ".cm-gutters": { background: "transparent", border: "none", color: "var(--ink-3)" },
    ".cm-activeLine": { background: "rgba(255,255,255,0.035)" },
    ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-2)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "color-mix(in srgb, var(--accent) 30%, transparent) !important" },
    ".cm-cursor": { borderLeftColor: "#fff" }
  },
  { dark: true }
)
const colors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c7a0ff" },
  { tag: [t.string, t.special(t.string)], color: "#9fd58a" },
  { tag: [t.number, t.bool, t.null], color: "#f2b872" },
  { tag: [t.comment], color: "#6d6b66", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8ec7ff" },
  { tag: [t.typeName, t.className], color: "#7fd6cc" },
  { tag: [t.definition(t.variableName)], color: "#eeede8" }
])

function Editor({ value, onChange, language, readOnly, onRun }: { value: string; onChange?: (v: string) => void; language: string; readOnly?: boolean; onRun?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const run = useRef(onRun)
  run.current = onRun
  useEffect(() => {
    const view = new EditorView({
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
          indentUnit.of(language === "python" ? "    " : "  "),
          EditorState.tabSize.of(language === "python" ? 4 : 2),
          keymap.of([{ key: "Mod-Enter", run: () => (run.current?.(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          language === "python" ? python() : javascript({ typescript: language === "typescript" }),
          syntaxHighlighting(colors),
          theme,
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => u.docChanged && onChange?.(u.state.doc.toString()))
        ]
      })
    })
    viewRef.current = view
    return () => view.destroy()
  }, [])
  // Replace the text from outside (e.g. "Reset to starter").
  useEffect(() => {
    const v = viewRef.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])
  return <div className="cm-host" ref={host} />
}

function Results({ run }: { run: TestRun }) {
  const passed = run.tests.filter((x) => x.ok).length
  return (
    <div className={`ex-results ${run.ok ? "ok" : "bad"}`}>
      <div className="ex-r-head">
        {run.ok ? <I.Check size={13} /> : <I.X size={13} />}
        {run.loadError ? "It didn't run" : run.tests.length ? `${passed} of ${run.tests.length} tests pass` : "No runtime tests"}
        {!!run.typeErrors.length && <span> · {run.typeErrors.length} type error{run.typeErrors.length === 1 ? "" : "s"}</span>}
        <span className="ex-r-ms">{run.ms ? `${run.ms} ms` : ""}</span>
      </div>
      {run.loadError && <pre className="ex-err">{run.loadError}</pre>}
      {!!run.tests.length && (
        <ul className="ex-tests">
          {run.tests.map((x, i) => (
            <li key={i} className={x.ok ? "ok" : "bad"}>
              <span className="mk">{x.ok ? "✓" : "✗"}</span>
              <span className="nm">{x.name}</span>
              {!x.ok && x.message && <pre>{x.message}</pre>}
            </li>
          ))}
        </ul>
      )}
      {!!run.typeErrors.length && (
        <ul className="ex-tests">
          {run.typeErrors.map((e, i) => (
            <li key={i} className="bad">
              <span className="mk">✗</span>
              <span className="nm">
                {e.file}:{e.line}
              </span>
              <pre>{e.message}</pre>
            </li>
          ))}
        </ul>
      )}
      {run.stdout.trim() && (
        <details className="ex-out">
          <summary>Printed output</summary>
          <pre>{run.stdout.trim()}</pre>
        </details>
      )}
    </div>
  )
}

export function ExerciseCard({ ask, live }: { ask: Ask; live: boolean }) {
  const { answerLate, busy } = useContext(TurnCtx)
  const ex = ask.exercise!
  const late = !live && !ask.answer
  const open = (live && !ask.answer && !ask.cancelled) || (late && !busy)
  const [code, setCode] = useState(ask.answer?.code ?? ex.starter)
  const [run, setRun] = useState<TestRun | null>(null)
  const [running, setRunning] = useState(false)
  const [runs, setRuns] = useState(0)
  const [hints, setHints] = useState(0)
  const [solution, setSolution] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const passed = !!run?.ok

  async function doRun() {
    if (running || !open) return
    setRunning(true)
    try {
      const r = await api.runExercise(ask.id, code)
      if (r === null) setExpired(true)
      else {
        setRun(r)
        setRuns((n) => n + 1)
      }
    } finally {
      setRunning(false)
    }
  }
  async function finish(gaveUp: boolean) {
    const a: AskAnswer = { picked: [], code, hintsUsed: hints, gaveUp: gaveUp || undefined, passed }
    if (late) return answerLate(ask, a)
    const result = await api.answerAsk(ask.id, a)
    if (!result.ok) answerLate(ask, a)
  }
  async function showSolution() {
    const s = await api.exerciseSolution(ask.id)
    if (s === null) setExpired(true)
    else setSolution(s)
  }

  const a = ask.answer
  const canSolve = ex.hasSolution && (runs >= 2 || hints >= ex.hints.length)
  return (
    <div className={`ask exercise ${open && !a ? "waiting" : ""} ${a?.passed ? "right" : ""}`}>
      <div className="ex-head">
        <span className="ask-kind">Exercise · {KIND[ex.kind] ?? ex.kind}</span>
        <span className="ex-lang">
          {ex.language}
          {ex.typeChecked ? " · tsc --strict" : ""}
        </span>
      </div>
      <div className="ex-title">{ex.title}</div>
      <div className="md ex-task">
        <Md text={ask.question} inline={false} />
      </div>
      {a ? (
        <>
          <Editor value={a.code ?? ""} language={ex.language} readOnly />
          <div className="ex-summary">{a.passed ? "Passed" : a.gaveUp ? "Gave up, and that's fine: Tutor takes it from here." : "Finished without passing"}{a.hintsUsed ? ` · ${a.hintsUsed} hint${a.hintsUsed === 1 ? "" : "s"}` : ""}</div>
        </>
      ) : ask.cancelled && !late ? (
        <div className="ex-summary">This exercise was closed when the turn stopped.</div>
      ) : (
        <>
          <Editor value={code} onChange={setCode} language={ex.language} onRun={doRun} />
          {run && <Results run={run} />}
          {expired && <div className="ex-summary">This exercise is from before Tutor restarted, so its tests are gone. Ask for a new one.</div>}
          {ex.hints.slice(0, hints).map((h, i) => (
            <div key={i} className="ex-hint">
              <b>Hint {i + 1}.</b> <Md text={h} inline />
            </div>
          ))}
          {solution !== null && (
            <div className="ex-solution">
              <div className="st-lbl">Reference solution</div>
              <Editor value={solution} language={ex.language} readOnly />
            </div>
          )}
          <div className="ex-bar">
            <button className="btn primary" disabled={!open || running || expired} onClick={doRun} title="Run the hidden tests (⌘↵)">
              {running ? "Running…" : "Run tests"} <kbd>⌘↵</kbd>
            </button>
            {hints < ex.hints.length && (
              <button className="btn" disabled={!open} onClick={() => setHints((h) => h + 1)}>
                Hint {hints + 1}/{ex.hints.length}
              </button>
            )}
            {canSolve && solution === null && (
              <button className="btn" disabled={!open} onClick={showSolution} title="Opening it means this exercise won't count as practice">
                Show solution
              </button>
            )}
            <button className="btn linkish" disabled={!open || code === ex.starter} onClick={() => setCode(ex.starter)}>
              Reset
            </button>
            <div className="grow" />
            {passed ? (
              <button className="btn primary" disabled={!open} onClick={() => finish(false)}>
                Done <I.ArrowRight size={13} />
              </button>
            ) : (
              <button className="btn" disabled={!open || (!runs && !hints)} onClick={() => finish(true)} title="Hand it back to Tutor with what you have">
                I'm stuck
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function ProjectCard({ project }: { project: ProjectView }) {
  const { busy, sendText } = useContext(TurnCtx)
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const home = project.dir.replace(/^\/Users\/[^/]+/, "~")
  const done = project.milestones.filter((m) => m.state === "done").length
  return (
    <div className="ask project">
      <div className="ex-head">
        <span className="ask-kind">Project · {project.language}</span>
        <span className="ex-lang">{project.done ? "complete" : `milestone ${project.current + 1} of ${project.milestones.length}`}</span>
      </div>
      <div className="ex-title">{project.title}</div>
      <div className="pj-dir">{home}</div>
      <ol className="pj-ms">
        {project.milestones.map((m, i) => (
          <li key={i} className={m.state}>
            <span className="mk">{m.state === "done" ? "✓" : m.state === "open" ? "●" : "○"}</span>
            {m.state === "locked" ? <span className="locked">Milestone {i + 1}, unlocks next</span> : m.title}
          </li>
        ))}
      </ol>
      {project.lastRun && !project.done && (
        <div className={`pj-last ${project.lastRun.ok ? "ok" : "bad"}`}>
          Last check: {project.lastRun.passed}/{project.lastRun.total} tests{project.lastRun.typeErrors ? ` · ${project.lastRun.typeErrors} type errors` : ""}
        </div>
      )}
      <div className="ex-bar">
        <button
          className="btn primary"
          disabled={opening}
          onClick={async () => {
            setOpening(true)
            try {
              setOpened(await api.openProject(project.id))
            } finally {
              setOpening(false)
            }
          }}
        >
          Open in {project.language === "python" ? "PyCharm" : "WebStorm"}
        </button>
        <button className="btn" disabled={busy} onClick={() => sendText(`Check my project "${project.title}".`)}>
          Check my project
        </button>
        <div className="grow" />
        <span className="pj-n">
          {done}/{project.milestones.length} done
        </span>
      </div>
      {opened && <div className="ex-summary">Opened in {opened}.</div>}
    </div>
  )
}
