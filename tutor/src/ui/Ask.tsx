// Learn lens cards. A quiz is graded: pick, submit, then see ✓/✗, the right answer and why
// (the answer key stays in the main process until you've answered). A question has no right
// answer: pick options, write "Other", or type a free reply. A predict card shows code: you say what
// it will print, then it runs and you see both. Keys: 1–9 pick, 0 "I don't know", ↵ submit.
import { useContext, useEffect, useRef, useState } from "react"
import { api, type Ask } from "../api"
import { fenceCode } from "../codeFence"
import { Code, Md, TurnCtx } from "./Message"
import { RunCompare } from "./Lab"
import * as I from "../icons"

export function AskCard({ ask, live }: { ask: Ask; live: boolean }) {
  const { answerLate, busy } = useContext(TurnCtx)
  // Waiting in a running turn, or left over from a turn that ended: both can still be answered.
  const late = !live && !ask.answer
  const waiting = (live && !ask.answer && !ask.cancelled) || (late && !busy)
  const quiz = ask.kind === "quiz"
  const predict = ask.kind === "predict"
  const free = !quiz && !ask.options.length
  const [picked, setPicked] = useState<number[]>([])
  const [dontKnow, setDontKnow] = useState(false)
  const [otherOn, setOtherOn] = useState(false)
  const [other, setOther] = useState("")
  const [text, setText] = useState("")
  const [note, setNote] = useState("")
  const [noteOpen, setNoteOpen] = useState(false)
  const [sure, setSure] = useState<boolean | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!waiting) return
    card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    ;(free ? textRef.current : card.current)?.focus({ preventScroll: true })
  }, [waiting])

  const pick = (i: number) => {
    if (!waiting) return
    setDontKnow(false)
    if (ask.multi) setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
    else {
      setPicked([i])
      setOtherOn(false)
    }
  }
  const ready = free ? !!text.trim() || (predict && dontKnow) : dontKnow || picked.length > 0 || (otherOn && !!other.trim())

  async function submit(override?: Partial<{ picked: number[]; dontKnow: boolean; other: string; text: string }>) {
    if (!waiting || sending) return
    const n = note.trim() || undefined
    const useDontKnow = override?.dontKnow ?? dontKnow
    const usePicked = override?.picked ?? picked
    const useOther = override?.other ?? other
    const useOtherOn = override?.other !== undefined ? !!override.other.trim() : otherOn
    const useText = override?.text ?? text
    const graded = (quiz || predict) && !useDontKnow
    const a = free
      ? { picked: [], text: useDontKnow ? undefined : useText.trim(), dontKnow: useDontKnow || undefined, note: n, sure: graded ? sure : undefined }
      : { picked: useDontKnow ? [] : usePicked, dontKnow: useDontKnow || undefined, other: useOtherOn && useOther.trim() ? useOther.trim() : undefined, note: n, sure: graded ? sure : undefined }
    const canSend = free ? !!a.text || (predict && !!a.dontKnow) : !!a.dontKnow || a.picked.length > 0 || !!a.other
    if (!canSend) return
    setSending(true)
    try {
      if (late) {
        answerLate(ask, a)
        return
      }
      const result = await api.answerAsk(ask.id, a)
      // Pending gone (turn ended or app restarted): send the answer as the next message.
      if (!result.ok) answerLate(ask, a)
    } catch {
      setSending(false)
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (!waiting || sending) return
    const typing = (e.target as HTMLElement).matches("input, textarea")
    if (e.key === "Enter" && !e.shiftKey && (!typing || (e.target as HTMLElement).tagName === "INPUT" || e.metaKey)) {
      e.preventDefault()
      return void submit()
    }
    if (typing) return
    const d = Number(e.key)
    // Single-choice: number key answers and sends in one press (reviews and quizzes stay brisk).
    if (e.key >= "1" && e.key <= "9" && d <= ask.options.length) {
      if (ask.multi) pick(d - 1)
      else {
        e.preventDefault()
        setDontKnow(false)
        setOtherOn(false)
        setPicked([d - 1])
        void submit({ picked: [d - 1], dontKnow: false })
      }
      return
    }
    if (e.key === "0" && (quiz || predict)) {
      e.preventDefault()
      setDontKnow(true)
      setPicked([])
      void submit({ picked: [], dontKnow: true })
    }
  }

  // After answering: what they picked, and for a quiz, which one was right.
  const a = ask.answer
  const g = ask.grade
  const chosen = a ? (a.dontKnow ? [] : a.picked) : picked
  const state = (i: number) => {
    if (!a) return chosen.includes(i) ? "sel" : ""
    if (g) return g.correctIdx.includes(i) ? "right" : chosen.includes(i) ? "wrong" : "dim"
    return chosen.includes(i) ? "sel" : "dim"
  }
  const verdict = g ? (a?.dontKnow ? "unknown" : g.correct ? "right" : "wrong") : predict && ask.run ? (ask.match ? "right" : "unknown") : null
  const said = a ? (a.dontKnow ? "(no idea)" : (a.text ?? [...a.picked.map((i) => ask.options[i]?.label ?? ""), ...(a.other ? [a.other] : [])].join("; "))) : ""

  return (
    <div ref={card} className={`ask ${quiz ? "quiz" : "question"} ${waiting ? "waiting" : ""} ${verdict ?? ""}`} tabIndex={waiting ? 0 : -1} onKeyDown={onKey}>
      <div className="ask-head">
        <span className="ask-kind">{quiz ? "Quiz" : predict ? "Predict, then run" : "Question"}</span>
        {verdict === "right" && (
          <span className="verdict right">
            <I.Check size={12} /> {predict ? "Exactly right" : "Correct"}
          </span>
        )}
        {predict && verdict === "unknown" && !a?.dontKnow && <span className="verdict unknown">Different: look closely</span>}
        {verdict === "wrong" && (
          <span className="verdict wrong">
            <I.X size={12} /> Not quite
          </span>
        )}
        {verdict === "unknown" && (!predict || a?.dontKnow) && <span className="verdict unknown">? Didn't know: that's the edge</span>}
        {ask.late && <span className="verdict late">Sent to Tutor</span>}
        {!a && !waiting && <span className="verdict off">{ask.cancelled ? "Stopped" : "Not answered"}</span>}
        {late && waiting && <span className="ask-hint">still open: answering sends it to Tutor</span>}
        {waiting && ask.multi && <span className="ask-hint">pick all that apply</span>}
      </div>
      <div className="ask-q">
        <Md text={fenceCode(ask.question)} inline={fenceCode(ask.question) === ask.question} />
      </div>
      {ask.details && (
        <div className="ask-details">
          <Md text={fenceCode(ask.details)} inline={false} />
        </div>
      )}
      {predict && ask.code && <Code code={ask.code} lang={ask.language === "typescript" ? "typescript" : ask.language === "javascript" ? "javascript" : "python"} />}

      {predict && a && ask.run ? (
        <RunCompare said={said} run={ask.run} match={ask.match} />
      ) : predict && a ? (
        <div className="ask-reply">{sending ? "Running it…" : said}</div>
      ) : free ? (
        a ? (
          <div className="ask-reply">{a.text}</div>
        ) : (
          <>
            <textarea ref={textRef} className={`ask-text ${predict ? "mono" : ""}`} rows={predict ? 3 : 2} disabled={!waiting} placeholder={predict ? "Write exactly what it will print…   ⌘↵ to run it" : "Your answer…   ⌘↵ to send"} value={text} onChange={(e) => setText(e.target.value)} />
            {predict && waiting && (
              <button className={`linkish idk-link ${dontKnow ? "on" : ""}`} onClick={() => setDontKnow(!dontKnow)}>
                {dontKnow ? "✓ No idea: run it and show me" : "No idea"}
              </button>
            )}
          </>
        )
      ) : (
        <ol className="ask-opts">
          {ask.options.map((o, i) => (
            <li key={i}>
              <button className={`opt ${state(i)}`} disabled={!waiting} onClick={() => pick(i)} aria-pressed={chosen.includes(i)}>
                <span className={`mark ${ask.multi ? "box" : ""}`}>{state(i) === "right" ? <I.Check size={11} /> : state(i) === "wrong" ? <I.X size={11} /> : i + 1}</span>
                <span className="opt-body">
                  <Md text={o.label} />
                  {o.description && (
                    <span className="opt-desc">
                      <Md text={o.description} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {quiz ? (
            <li>
              <button className={`opt idk ${(a ? a.dontKnow : dontKnow) ? "sel" : a ? "dim" : ""}`} disabled={!waiting} onClick={() => (setDontKnow(true), setPicked([]))}>
                <span className="mark">?</span>
                <span className="opt-body">I don't know</span>
              </button>
            </li>
          ) : (
            <li>
              {a ? (
                a.other && (
                  <div className="opt sel other-shown">
                    <span className="mark">…</span>
                    <span className="opt-body">Other: {a.other}</span>
                  </div>
                )
              ) : (
                <div className={`opt other ${otherOn ? "sel" : ""}`}>
                  <span className="mark">…</span>
                  <input
                    disabled={!waiting}
                    placeholder="Other…"
                    value={other}
                    onFocus={() => {
                      setOtherOn(true)
                      if (!ask.multi) setPicked([])
                    }}
                    onChange={(e) => setOther(e.target.value)}
                  />
                </div>
              )}
            </li>
          )}
        </ol>
      )}

      {a?.note && <div className="ask-note-shown">Your note: {a.note}</div>}
      {g && (
        <div className="ask-explain">
          <Md text={g.explanation} />
        </div>
      )}

      {waiting && (
        <div className="ask-foot">
          {noteOpen ? (
            <input className="ask-note" autoFocus placeholder="Note for Tutor (optional): what you were thinking" value={note} onChange={(e) => setNote(e.target.value)} />
          ) : (
            <button className="linkish" onClick={() => setNoteOpen(true)}>
              + note
            </button>
          )}
          {(quiz || predict) && !dontKnow && (
            <span className="sure" role="radiogroup" aria-label="How sure are you?">
              <button role="radio" aria-checked={sure === true} className={sure === true ? "on" : ""} onClick={() => setSure(sure === true ? undefined : true)} title="You'd bet on it">
                Sure
              </button>
              <button role="radio" aria-checked={sure === false} className={sure === false ? "on" : ""} onClick={() => setSure(sure === false ? undefined : false)} title="Half a guess">
                Guessing
              </button>
            </span>
          )}
          <div className="grow" />
          <span className="ask-keys">{free ? "" : ask.multi ? (quiz ? "1–9 · 0 · ↵" : "1–9 · ↵") : quiz ? "1–9 sends · 0" : "1–9 sends"}</span>
          <button className="btn primary" disabled={!ready || sending} onClick={() => void submit()}>
            {predict ? (sending ? "Running…" : "Run it") : quiz ? "Check" : "Send"}
          </button>
        </div>
      )}
    </div>
  )
}
