// The transcript: your messages, and the agent's turn as it happens: a plan checklist, then
// text, tool steps (click to see input and output; edits show +/− and open the diff) and quiz
// cards in the order they happened. Markdown with math; ```mermaid / ```svg draw as pictures.
import { createContext, Fragment, useContext, useMemo, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import type { Ask, AskAnswer, Block, Msg, PlanItem, Tool } from "../api"
import { highlight } from "../highlight"
import { AskCard } from "./Ask"
import { Diagram } from "./Diagram"
import { Stepper } from "./Lab"
import { ExerciseCard, ProjectCard } from "./Practice"
import { describeTool } from "../describe"
import * as I from "../icons"

// <learned> notes are for the profile, not for reading. Also hide a half-streamed "<lear…" at the end,
// and the markers around a recap (saved to the goal's notes).
export function visible(text: string): string {
  let t = text.replace(/<learned>[\s\S]*?(<\/learned>|$)/g, "").replace(/<!--\s*\/?(recap|note-add)\s*-->/g, "")
  const i = t.lastIndexOf("<")
  if (i >= 0 && "<learned>".startsWith(t.slice(i))) t = t.slice(0, i)
  return t.trimEnd()
}

// Whether the message is still streaming (diagrams wait for the block to finish).
const LiveCtx = createContext(false)

const REMARK = [remarkGfm, remarkMath]
const REHYPE = [[rehypeKatex, { throwOnError: false, strict: "ignore" }]] as never

// Markdown with math. `inline` drops the paragraph wrapper (quiz options, questions).
export function Md({ text, inline = true }: { text: string; inline?: boolean }) {
  return (
    <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={{ pre: CodeBlock, a: (p) => <a {...p} target="_blank" rel="noreferrer" />, ...(inline ? { p: ({ children }) => <Fragment>{children}</Fragment> } : {}) }}>
      {text}
    </Markdown>
  )
}

// Lets code blocks and tool rows deep in the markdown reach the app.
export const TurnCtx = createContext<{
  target: string | null
  busy: boolean
  apply: (code: string, lang?: string) => void
  showChange: (path: string) => void
  // A card whose turn already ended (you went elsewhere and it was stopped, or Tutor restarted):
  // answering it sends the answer to Tutor as a message, and the lesson carries on.
  answerLate: (ask: Ask, answer: AskAnswer) => void
  sendText: (text: string) => void // a message in this conversation, as if typed (e.g. "Check my project")
}>({ target: null, busy: false, apply: () => {}, showChange: () => {}, answerLate: () => {}, sendText: () => {} })

export function Message({ msg, live }: { msg: Msg; live: boolean }) {
  if (msg.role === "user")
    return (
      <div className="msg user">
        {!!msg.previews?.length && (
          <div className="thumbs">
            {msg.previews.map((p, i) => (
              <img key={i} src={p} alt="Screenshot sent" />
            ))}
          </div>
        )}
        {msg.text && <div className="bubble">{msg.text}</div>}
      </div>
    )
  const text = visible(msg.text)
  const tail = msg.flow?.[msg.flow.length - 1]
  // Still working but nothing new to show at the end (a tool is running, a card was just answered).
  const working = live && !msg.error && (!tail || tail.t === "tool" || (tail.t === "ask" && !!msg.asks?.find((a) => a.id === tail.id)?.answer))
  return (
    <LiveCtx.Provider value={live}>
    <div className={`msg bot ${live ? "live" : ""}`}>
      {msg.by && <div className="by">{msg.by}</div>}
      {!!msg.plan?.length && <PlanCard items={msg.plan} />}
      {msg.flow ? (
        <Flow msg={msg} live={live} />
      ) : (
        <>
          {msg.tools.length > 0 && (
            <div className="steps">
              {msg.tools.map((t, i) => (
                <ToolRow key={t.id ?? i} tool={t} live={live} />
              ))}
            </div>
          )}
          {text && (
            <div className="md tail">
              <Md text={text} inline={false} />
            </div>
          )}
        </>
      )}
      {(msg.flow ? working : live && !text && !msg.error) && (
        <div className="thinking">
          <i />
          <i />
          <i />
        </div>
      )}
      {msg.error && <div className="err">{msg.error}</div>}
      {msg.note && (msg.note.added || !msg.flow?.some((x) => x.t === "text" && OPEN.test(x.text))) && (
        <div className="learned saved-note">
          <I.Book size={12} /> {msg.note.added ? "What you missed was added to your note" : "Note saved to your notes"}
          <button className="linkish" onClick={() => window.dispatchEvent(new CustomEvent("tutor:open-note", { detail: { goalId: msg.note!.goalId, nodeId: msg.note!.nodeId } }))}>
            Read it
          </button>
        </div>
      )}
      {!!msg.learned?.length && (
        <div className="learned" title="Saved to your learner profile (Settings)">
          <I.Sparkle size={12} /> Noted: {msg.learned.join(" · ")}
        </div>
      )}
      {!!msg.notices.length && <div className="meta">{msg.notices.join("  ·  ")}</div>}
    </div>
    </LiveCtx.Provider>
  )
}

// Text, runs of tool steps, and cards, in order.
// A lesson's write-up (between <!-- recap --> markers) reads as one document, even when tool steps
// (rendering its concept map) happened midway; those steps show after it.
type DocPiece = { t: "doc"; text: string; done: boolean }
type Piece = Block | DocPiece
const OPEN = /<!--\s*recap\s*-->/
const CLOSE = /<!--\s*\/recap\s*-->/
function withDoc(flow: Block[]): Piece[] {
  const out: Piece[] = []
  const held: Block[] = []
  let doc: DocPiece | null = null
  for (const b of flow) {
    if (b.t !== "text") {
      if (doc && !doc.done) held.push(b)
      else out.push(b)
      continue
    }
    let text = b.text
    if (!doc) {
      const i = text.search(OPEN)
      if (i < 0) {
        out.push(b)
        continue
      }
      if (text.slice(0, i).trim()) out.push({ t: "text", text: text.slice(0, i) })
      doc = { t: "doc", text: "", done: false }
      out.push(doc)
      text = text.slice(i).replace(OPEN, "")
    }
    if (doc.done) {
      out.push({ t: "text", text })
      continue
    }
    const j = text.search(CLOSE)
    if (j < 0) {
      doc.text += text
      continue
    }
    doc.text += text.slice(0, j)
    doc.done = true
    out.push(...held.splice(0))
    const rest = text.slice(j).replace(CLOSE, "")
    if (rest.trim()) out.push({ t: "text", text: rest })
  }
  out.push(...held)
  return out
}

// The write-up as a document: saved-to-notes badge, open it in the reader, fold it away.
function LessonDoc({ doc, msg, live }: { doc: DocPiece; msg: Msg; live: boolean }) {
  const [open, setOpen] = useState(true)
  const note = msg.note
  return (
    <div className={`lesson-doc ${open ? "" : "folded"}`}>
      <div className="ld-bar">
        <I.Book size={13} />
        <span className="ld-kind">Lesson</span>
        {note ? (
          <span className="ld-saved" title={note.file}>
            <I.Check size={11} /> saved to your notes
          </span>
        ) : (
          live && !doc.done && <span className="ld-saving">writing…</span>
        )}
        <div className="grow" />
        {note && (
          <button className="linkish" onClick={() => window.dispatchEvent(new CustomEvent("tutor:open-note", { detail: { goalId: note.goalId, nodeId: note.nodeId } }))}>
            Open in reader
          </button>
        )}
        {doc.done && (
          <button className="linkish" onClick={() => setOpen(!open)}>
            {open ? "Fold" : "Unfold"}
          </button>
        )}
      </div>
      <div className="ld-body md" onClick={() => !open && setOpen(true)}>
        <Md text={visible(doc.text)} inline={false} />
      </div>
    </div>
  )
}

function Flow({ msg, live }: { msg: Msg; live: boolean }) {
  const flow = withDoc(msg.flow ?? [])
  // After the write-up, the quiz waits until they've read it: nothing scrolls them away mid-read.
  const [quizOpen, setQuizOpen] = useState(false)
  const docAt = flow.findIndex((b) => b.t === "doc")
  const firstAsk = docAt >= 0 ? flow.slice(docAt + 1).find((b): b is { t: "ask"; id: string } => b.t === "ask") : undefined
  const firstAskView = firstAsk && msg.asks?.find((a) => a.id === firstAsk.id)
  const holdQuiz = !quizOpen && docAt >= 0 && (flow[docAt] as DocPiece).done && !!firstAskView && !firstAskView.answer && !firstAskView.cancelled
  const out: React.ReactNode[] = []
  for (let k = 0; k < flow.length; k++) {
    const b = flow[k]
    if (b.t === "doc") {
      out.push(<LessonDoc key={k} doc={b} msg={msg} live={live} />)
      if (holdQuiz) {
        out.push(
          <div key="quiz-ready" className="quiz-ready">
            <div>
              <b>Quiz ready</b>
              <span>When you've read enough, start — number keys answer each card.</span>
            </div>
            <button
              className="btn primary"
              autoFocus
              onClick={() => setQuizOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  setQuizOpen(true)
                }
              }}
            >
              Start quiz <I.ArrowRight size={13} />
            </button>
          </div>
        )
        break
      }
      continue
    }
    if (b.t === "text") {
      const t = visible(b.text)
      if (t.trim())
        out.push(
          <div key={k} className={`md ${k === flow.length - 1 ? "tail" : ""}`}>
            <Md text={t} inline={false} />
          </div>
        )
    } else if (b.t === "ask") {
      const ask = msg.asks?.find((a) => a.id === b.id)
      if (ask) out.push(ask.kind === "exercise" ? <ExerciseCard key={k} ask={ask} live={live} /> : <AskCard key={k} ask={ask} live={live} />)
    } else if (b.t === "trace") {
      const tr = msg.traces?.find((x) => x.id === b.id)
      if (tr) out.push(<Stepper key={k} trace={tr} />)
    } else if (b.t === "project") {
      const pj = msg.projects?.find((x) => x.id === b.id)
      if (pj) out.push(<ProjectCard key={k} project={pj} />)
    } else {
      const run: number[] = []
      while (k < flow.length && flow[k].t === "tool") run.push((flow[k++] as { i: number }).i)
      k--
      out.push(
        <div key={k} className="steps">
          {run.map((i) => msg.tools[i] && <ToolRow key={msg.tools[i].id ?? i} tool={msg.tools[i]} live={live} />)}
        </div>
      )
    }
  }
  return <>{out}</>
}

function PlanCard({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === "completed").length
  return (
    <div className="plan">
      <div className="plan-head">
        Plan <span>{done}/{items.length}</span>
      </div>
      <ul>
        {items.map((it, i) => (
          <li key={i} className={it.status}>
            {it.status === "completed" ? <I.CircleCheck size={14} /> : it.status === "in_progress" ? <I.CircleHalf size={14} /> : <I.Circle size={14} />}
            <span>{it.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ToolRow({ tool, live }: { tool: Tool; live: boolean }) {
  const [open, setOpen] = useState(false)
  const { showChange } = useContext(TurnCtx)
  const { server, verb } = describeTool(tool.name)
  const state = tool.ok === false ? "bad" : tool.ok || !live ? "ok" : "run"
  const expandable = !!(tool.input || tool.result)
  return (
    <div className={`step ${state} ${open ? "open" : ""}`}>
      <button className="step-head" onClick={() => expandable && setOpen(!open)} aria-expanded={open} disabled={!expandable}>
        <span className="dot" />
        <span className="verb">{verb}</span>
        {tool.detail && <code className="target">{tool.detail}</code>}
        {server && <span className="via">{server}</span>}
        {tool.change && (
          <span
            className="delta"
            role="link"
            title="Show the diff"
            onClick={(e) => {
              e.stopPropagation()
              showChange(tool.change!.path)
            }}
          >
            <b className="plus">+{tool.change.added}</b> <b className="minus">−{tool.change.removed}</b>
          </span>
        )}
        {expandable && <I.ChevronRight size={12} />}
      </button>
      {open && (
        <div className="step-body">
          {tool.input && (
            <>
              <div className="lbl">Input</div>
              <pre>{tool.input}</pre>
            </>
          )}
          {tool.result && (
            <>
              <div className="lbl">{tool.ok === false ? "Error" : "Result"}</div>
              <pre>{tool.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function CodeBlock(props: React.ComponentProps<"pre">) {
  const child = (props.children as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined)?.props
  const lang = /language-([\w+-]+)/.exec(child?.className ?? "")?.[1]
  const code = String(child?.children ?? "").replace(/\n$/, "")
  const live = useContext(LiveCtx)
  if (lang === "mermaid" || (lang === "svg" && /^\s*<svg[\s>]/.test(code))) return <Diagram kind={lang} code={code} live={live} />
  return <Code code={code} lang={lang} />
}

export function Code({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const { target, apply, busy } = useContext(TurnCtx)
  const html = useMemo(() => highlight(code, lang), [code, lang])
  const applicable = target && !["bash", "sh", "shell", "zsh", "console", "text", "plaintext"].includes(lang ?? "")
  return (
    <div className="code">
      <div className="code-bar">
        <span>{lang ?? "code"}</span>
        <div className="code-actions">
          {applicable && (
            <button className="apply" disabled={busy} onClick={() => apply(code, lang)} title={`Put this change into the right file in ${target}`}>
              <I.Insert size={12} /> Apply in {target}
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard.writeText(code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <I.Check size={12} /> : <I.Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
