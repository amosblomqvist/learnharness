// Type the docs before the tasks: the page a lesson cites, block by block. Progress is saved after
// each block, so a long page can take several sittings.
import { useEffect, useMemo, useRef, useState } from "react"
import { extract, type Passage } from "./docs"
import { docSource, GATE_WORDS, type Typed } from "./store"
import type { Lesson } from "./types"
import { accuracy, finished, press, start, target, typedChars, wpm, type Block, type Run } from "./typing"

type Bridge = { docsGet(url: string): Promise<{ ok: true; html: string } | { ok: false; error: string }> }
const bridge = () => (window as unknown as { tutor: Bridge }).tutor

// A pause longer than this (thinking, reading ahead, a coffee) doesn't count against your speed.
const IDLE_MS = 5000
const ENTER = String.fromCodePoint(0x23ce)
const empty: Typed = { block: 0, done: false, chars: 0, keys: 0, mistakes: 0, ms: 0 }

export function TypeThrough({ lesson, saved, onSave }: { lesson: Lesson; saved: Typed | undefined; onSave: (t: Typed) => void }) {
  const source = docSource(lesson)!
  const [page, setPage] = useState<Passage | { error: string } | null>(null)

  useEffect(() => {
    bridge()
      .docsGet(source.url)
      .then((r) => {
        if (!r.ok) return setPage({ error: r.error })
        const p = extract(r.html, source.url, lesson.steps.length ? GATE_WORDS : 0)
        setPage(p.blocks.length ? p : { error: "Couldn't find the text on that page." })
      })
      .catch((e: Error) => setPage({ error: e.message }))
  }, [source.url])

  const skip = (
    <button className="s-link" onClick={() => onSave({ ...(saved ?? empty), done: true, skipped: true })}>
      Skip typing for this lesson
    </button>
  )

  if (!page) return <p className="s-fine s-typing-head">Getting the page…</p>
  if ("error" in page)
    return (
      <section className="s-typing">
        <p className="s-warn">{page.error}</p>
        {skip}
      </section>
    )
  return <Typing page={page} source={source} saved={saved ?? empty} onSave={onSave} skip={skip} />
}

function Typing({ page, source, saved, onSave, skip }: { page: Passage; source: { title: string; url: string }; saved: Typed; onSave: (t: Typed) => void; skip: React.ReactNode }) {
  const i = Math.min(saved.block, page.blocks.length - 1)
  const block = page.blocks[i]
  const [run, setRun] = useState<Run>(() => start(target(block)))
  const [ms, setMs] = useState(0)
  const [focused, setFocused] = useState(true)
  const last = useRef<number | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // A new block: fresh run, cursor in view.
  useEffect(() => {
    setRun(start(target(block)))
    setMs(0)
    last.current = null
    box.current?.focus({ preventScroll: true })
    box.current?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [i, page])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return // leave shortcuts alone
    const key = e.key === "Enter" ? "\n" : e.key.length === 1 ? e.key : null
    if (e.key === "Tab" || key) e.preventDefault()
    if (!key) return

    const now = performance.now()
    const spent = last.current === null ? 0 : Math.min(now - last.current, IDLE_MS)
    last.current = now
    const next = press(run, key)
    setRun(next)
    setMs((m) => m + spent)

    if (finished(next)) {
      onSave({
        block: i + 1,
        done: i + 1 >= page.blocks.length,
        chars: saved.chars + typedChars(next.t),
        keys: saved.keys + next.keys,
        mistakes: saved.mistakes + next.mistakes,
        ms: saved.ms + ms + spent
      })
    }
  }

  // Remaining time, at your speed so far (or a beginner's 30 wpm before there is one).
  const left = useMemo(() => page.blocks.slice(i).reduce((a, b) => a + typedChars(target(b)), 0), [page, i])
  const speed = saved.ms > 0 ? wpm(saved.chars, saved.ms) : 30
  const minutes = Math.max(1, Math.round(left / 5 / speed))
  const live = wpm(run.t.auto.slice(0, run.pos).filter((a) => !a).length, ms)

  const pos = run.pos
  const chars = run.t.chars
  const cursor = chars[pos] === "\n" ? ENTER + "\n" : (chars[pos] ?? "")

  return (
    <section className="s-typing">
      <div className="s-typing-head">
        <div className="s-sub">Type it first</div>
        <a href={source.url} target="_blank" rel="noreferrer">
          {page.title}
        </a>
        <span className="s-fine">
          {" "}
          · part {i + 1} of {page.blocks.length} · about {minutes} min left
        </span>
      </div>

      {page.blocks.slice(Math.max(0, i - 2), i).map((b, k) => (
        <Plain key={k} block={b} className="s-typed" />
      ))}

      <div
        ref={box}
        tabIndex={0}
        className={`s-type s-type-${block.kind}`}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <span className="ok">{chars.slice(0, pos).join("")}</span>
        <span className={run.wrong ? "cur bad" : "cur"}>{cursor}</span>
        <span className="todo">{chars.slice(pos + 1).join("")}</span>
      </div>

      <p className="s-fine s-typing-stats">
        {focused ? (ms > 0 ? `${Math.round(live)} wpm · ${Math.round(accuracy(run.keys, run.mistakes))}% right` : "Start typing. Wrong keys don't move the cursor.") : "Click the text to keep typing."}
      </p>

      {page.blocks[i + 1] && <Plain block={page.blocks[i + 1]} className="s-upnext" />}
      {page.cut && <p className="s-fine">This is the first {GATE_WORDS} words or so of the section; the rest is on the page.</p>}
      <div className="s-typing-skip">{skip}</div>
    </section>
  )
}

function Plain({ block, className }: { block: Block; className: string }) {
  if (block.kind === "code") return <pre className={className}>{block.text.replace(/\n+$/, "")}</pre>
  if (block.kind === "heading") return <h3 className={className}>{block.text}</h3>
  return <p className={className}>{block.text}</p>
}
