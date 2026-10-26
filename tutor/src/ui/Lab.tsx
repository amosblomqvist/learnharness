// Lab pieces in the transcript: a stepper through a traced Python run, and the output panel a
// predict card shows once the code has run. Stepper keys: ← → to step, Home/End for the ends.
import { useEffect, useMemo, useRef, useState } from "react"
import type { RunResult, TraceView } from "../api"
import { highlight } from "../highlight"

export function Stepper({ trace }: { trace: TraceView }) {
  // "call" steps repeat the next line's position; the stepper walks lines, returns and exceptions.
  const steps = useMemo(() => trace.steps.filter((s) => s.event !== "call" && !(s.event === "return" && s.stack.length === 1)), [trace])
  const [i, setI] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const s = steps[Math.min(i, steps.length - 1)]
  const prev = i > 0 ? steps[i - 1] : null
  const lines = useMemo(() => trace.code.replace(/\n$/, "").split("\n"), [trace.code])
  const html = useMemo(() => highlight(trace.code.replace(/\n$/, ""), "python").split("\n"), [trace.code])
  const go = (n: number) => setI(Math.max(0, Math.min(steps.length - 1, n)))

  useEffect(() => {
    box.current?.querySelector(".st-line.cur")?.scrollIntoView({ block: "nearest" })
  }, [i])

  if (!s) return <div className="stepper empty">Nothing ran{trace.error ? `: ${trace.error}` : "."}</div>
  // A variable whose value differs from the step before (same frame depth) is highlighted.
  const before = new Map((prev?.stack ?? []).flatMap((f, d) => f.locals.map(([k, v]) => [`${d}:${f.fn}:${k}`, v] as const)))
  const frames = [...s.stack].reverse() // innermost first
  return (
    <div
      className="stepper"
      ref={box}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") (e.preventDefault(), go(i + 1))
        else if (e.key === "ArrowLeft") (e.preventDefault(), go(i - 1))
        else if (e.key === "Home") go(0)
        else if (e.key === "End") go(steps.length - 1)
      }}
    >
      <div className="st-head">
        <span className="st-kind">Step through</span>
        {trace.title && <span className="st-title">{trace.title}</span>}
        <div className="grow" />
        <span className="st-count">
          {i + 1} / {steps.length}
          {trace.truncated ? "+" : ""}
        </span>
      </div>
      <div className="st-body">
        <div className="st-code">
          {lines.map((_, n) => (
            <div key={n} className={`st-line ${s.line === n + 1 ? "cur" : ""} ${s.line === n + 1 && s.event === "exception" ? "exc" : ""}`}>
              <span className="st-n">{n + 1}</span>
              <code dangerouslySetInnerHTML={{ __html: html[n] || " " }} />
              {s.line === n + 1 && s.event === "return" && <span className="st-ret">↩ returns {s.ret}</span>}
            </div>
          ))}
        </div>
        <div className="st-state">
          {frames.map((f, d) => (
            <div key={`${f.fn}-${d}`} className={`st-frame ${d === 0 ? "top" : ""}`}>
              <div className="st-fn">
                {f.fn === "<module>" ? "module" : `${f.fn}()`} <span>line {f.line}</span>
              </div>
              {f.locals.length ? (
                <table>
                  <tbody>
                    {f.locals.map(([k, v]) => {
                      const changed = before.get(`${s.stack.length - 1 - d}:${f.fn}:${k}`) !== v && !!prev
                      return (
                        <tr key={k} className={changed ? "changed" : ""}>
                          <td>{k}</td>
                          <td>{v}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="st-empty">no variables yet</div>
              )}
            </div>
          ))}
          <div className="st-out">
            <div className="st-lbl">Output</div>
            <pre>{s.out || " "}</pre>
          </div>
        </div>
      </div>
      <div className="st-ctl">
        <button onClick={() => go(0)} disabled={i === 0} title="First step (Home)">
          ⏮
        </button>
        <button onClick={() => go(i - 1)} disabled={i === 0} title="Back (←)">
          ◀
        </button>
        <input type="range" min={0} max={steps.length - 1} value={i} onChange={(e) => go(Number(e.target.value))} aria-label="Step" />
        <button onClick={() => go(i + 1)} disabled={i >= steps.length - 1} title="Next (→)">
          ▶
        </button>
        <button onClick={() => go(steps.length - 1)} disabled={i >= steps.length - 1} title="Last step (End)">
          ⏭
        </button>
      </div>
      {trace.error && i === steps.length - 1 && <div className="st-err">{trace.error}</div>}
    </div>
  )
}

// After a prediction: what you said, next to what actually came out.
export function RunCompare({ said, run, match }: { said: string; run: RunResult; match?: boolean }) {
  return (
    <div className={`runcmp ${match ? "match" : "diff"}`}>
      <div>
        <div className="st-lbl">You predicted</div>
        <pre>{said || "—"}</pre>
      </div>
      <div>
        <div className="st-lbl">
          It printed {run.timedOut ? "(stopped after 8 s)" : run.exitCode ? `(exit ${run.exitCode})` : ""}
        </div>
        <pre>
          {run.stdout || (run.stderr ? "" : "(nothing)")}
          {run.stderr && <span className="stderr">{run.stderr.trim().split("\n").slice(-4).join("\n")}</span>}
        </pre>
      </div>
    </div>
  )
}
