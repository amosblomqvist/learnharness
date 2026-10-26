// Review what the agent changed, PR style: a file tree with +/− per file, and every file's diff
// stacked in collapsible sections. Click a line (or a file's +/−) to open it at that line in
// your JetBrains IDE. Keep / Undo per file or for everything.
// The same view is the resizable side pane (wide layout) and the foldable drawer (compact).
import { useEffect, useMemo, useRef, useState } from "react"
import { api, type ChangeView, type Hunk } from "../api"
import { highlight } from "../highlight"
import * as I from "../icons"

// The first line that actually changed, on the new side, to jump to in the IDE.
export function firstChangedLine(c: ChangeView): number {
  for (const h of c.hunks) {
    let n = h.newStart
    for (const l of h.lines) {
      if (l[0] === "+" || l[0] === "-") return Math.max(1, n)
      if (l[0] !== "\\") n++
    }
  }
  return 1
}

const LANG: Record<string, string> = { py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", zsh: "bash", sql: "sql", go: "go", rs: "rust", dockerfile: "dockerfile" }
const langOf = (p: string) => {
  const base = p.split("/").pop()!.toLowerCase()
  if (base === "dockerfile") return "dockerfile"
  return LANG[base.split(".").pop() ?? ""]
}

async function undo(ids?: string[]) {
  const r = await api.undoChanges(ids)
  if (r.conflicts.length && window.confirm(`${r.conflicts.join(", ")} changed after Tutor edited ${r.conflicts.length > 1 ? "them" : "it"}. Undo anyway and lose those later edits?`)) await api.undoChanges(ids, true)
}

function Totals({ changes }: { changes: ChangeView[] }) {
  const t = changes.reduce((a, c) => ({ added: a.added + c.added, removed: a.removed + c.removed }), { added: 0, removed: 0 })
  return (
    <span className="ch-sum">
      {changes.length} {changes.length === 1 ? "file" : "files"} <b className="plus">+{t.added}</b> <b className="minus">−{t.removed}</b>
    </span>
  )
}

function Actions() {
  return (
    <div className="ch-actions">
      <button className="btn sm" onClick={() => undo()} title="Put every file back the way it was">
        <I.Undo size={13} /> Undo all
      </button>
      <button className="btn sm primary" onClick={() => api.keepChanges()} title="Accept all changes">
        <I.Check size={13} /> Keep all
      </button>
    </div>
  )
}

// ---------- the body: tree + stacked file diffs ----------

export function ChangesBody({ changes, focus, withTree }: { changes: ChangeView[]; focus: string | null; withTree: boolean }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const sections = useRef(new Map<string, HTMLElement>())

  // Jump to a file when something asks for it (a click in the transcript or the tree).
  useEffect(() => {
    if (!focus) return
    setFolded((f) => ({ ...f, [focus]: false }))
    requestAnimationFrame(() => sections.current.get(focus)?.scrollIntoView({ block: "start", behavior: "smooth" }))
  }, [focus])

  if (!changes.length)
    return (
      <div className="ch-empty">
        <I.Diff size={22} />
        <p>No changes to review.</p>
        <p className="hint">When Tutor edits files (Writer mode, or Apply in IDE), each one shows up here with its diff, to keep or undo.</p>
      </div>
    )

  return (
    <div className={`ch-body ${withTree ? "with-tree" : ""}`}>
      {withTree && <FileTree changes={changes} onPick={(p) => requestAnimationFrame(() => (setFolded((f) => ({ ...f, [p]: false })), sections.current.get(p)?.scrollIntoView({ block: "start", behavior: "smooth" })))} />}
      <div className="ch-stack">
        {changes.map((c) => (
          <FileDiff
            key={c.id}
            change={c}
            folded={!!folded[c.path]}
            onFold={() => setFolded((f) => ({ ...f, [c.path]: !f[c.path] }))}
            refCb={(el) => (el ? sections.current.set(c.path, el) : sections.current.delete(c.path))}
          />
        ))}
      </div>
    </div>
  )
}

type Node = { name: string; path: string; dirs: Map<string, Node>; files: ChangeView[] }
function buildTree(changes: ChangeView[]): Node {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] }
  for (const c of changes) {
    const parts = c.rel.split("/")
    let n = root
    for (const part of parts.slice(0, -1)) {
      if (!n.dirs.has(part)) n.dirs.set(part, { name: part, path: n.path ? `${n.path}/${part}` : part, dirs: new Map(), files: [] })
      n = n.dirs.get(part)!
    }
    n.files.push(c)
  }
  // Collapse single-child folder chains: "app/services" instead of app › services.
  const squash = (n: Node): Node => {
    for (const [k, d] of n.dirs) n.dirs.set(k, squash(d))
    if (n.name && n.files.length === 0 && n.dirs.size === 1) {
      const [only] = n.dirs.values()
      return { ...only, name: `${n.name}/${only.name}` }
    }
    return n
  }
  return squash(root)
}

function FileTree({ changes, onPick }: { changes: ChangeView[]; onPick: (path: string) => void }) {
  const tree = useMemo(() => buildTree(changes), [changes])
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const render = (n: Node, depth: number): React.ReactNode => (
    <>
      {[...n.dirs.values()].map((d) => (
        <div key={d.path}>
          <button className="tree-row dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setClosed((c) => ({ ...c, [d.path]: !c[d.path] }))}>
            <span className={`tw ${closed[d.path] ? "" : "open"}`}>
              <I.ChevronRight size={11} />
            </span>
            <span className="tn">{d.name}</span>
          </button>
          {!closed[d.path] && render(d, depth + 1)}
        </div>
      ))}
      {n.files.map((f) => (
        <button key={f.id} className="tree-row file" style={{ paddingLeft: 22 + depth * 14 }} onClick={() => onPick(f.path)} title={f.rel}>
          <I.Code size={12} />
          <span className="tn">{f.rel.split("/").pop()}</span>
          <span className="counts">
            <b className="plus">+{f.added}</b> <b className="minus">−{f.removed}</b>
          </span>
        </button>
      ))}
    </>
  )
  return <nav className="ch-tree">{render(tree, 0)}</nav>
}

function FileDiff({ change: c, folded, onFold, refCb }: { change: ChangeView; folded: boolean; onFold: () => void; refCb: (el: HTMLElement | null) => void }) {
  const slash = c.rel.lastIndexOf("/")
  const open = (line: number) => api.openInIde(c.path, line)
  return (
    <section className={`fd ${folded ? "folded" : ""}`} ref={refCb}>
      <header className="fd-head">
        <button className="fd-fold" onClick={onFold} aria-expanded={!folded} title={folded ? "Show diff" : "Hide diff"}>
          <I.Chevron size={13} />
        </button>
        <button className="fd-name" onClick={() => open(firstChangedLine(c))} title={`Open ${c.rel} in the IDE`}>
          <I.Code size={13} />
          <span className="fname">{c.rel.slice(slash + 1)}</span>
          {slash > 0 && <span className="fdir">{c.rel.slice(0, slash)}</span>}
          {c.created && <span className="tag new">new</span>}
          {c.deleted && <span className="tag del">deleted</span>}
          <span className="counts">
            <b className="plus">+{c.added}</b> <b className="minus">−{c.removed}</b>
          </span>
        </button>
        <div className="fd-act">
          <button className="icon" title="Open in IDE" onClick={() => open(firstChangedLine(c))}>
            <I.Ide size={14} />
          </button>
          <button className="icon" title="Undo this file" onClick={() => undo([c.id])}>
            <I.Undo size={14} />
          </button>
          <button className="icon ok" title="Keep this file" onClick={() => api.keepChanges([c.id])}>
            <I.Check size={14} />
          </button>
        </div>
      </header>
      {!folded && <Hunks hunks={c.hunks} lang={langOf(c.rel)} onLine={open} />}
    </section>
  )
}

function Hunks({ hunks, lang, onLine }: { hunks: Hunk[]; lang?: string; onLine: (line: number) => void }) {
  return (
    <div className="fd-body">
      {hunks.map((h, i) => {
        let o = h.oldStart
        let n = h.newStart
        return (
          <div key={i} className="hunk">
            {i > 0 && <div className="hunk-gap">⋯</div>}
            {h.lines.map((l, j) => {
              const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === "\\" ? "note" : "ctx"
              if (kind === "note") return null
              const num = kind === "del" ? o : n
              const target = Math.max(1, n) // removed lines jump to where they used to be
              if (kind !== "add") o++
              if (kind !== "del") n++
              const code = l.slice(1)
              return (
                <div key={j} className={`dl ${kind}`} onClick={() => onLine(target)} title="Open at this line in the IDE">
                  <span className="ln">{num}</span>
                  <span className="sign">{kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: code ? (lang ? highlight(code, lang) : escapeHtml(code)) : " " }} />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// ---------- wide layout: the right-hand pane, resizable ----------

// reserve: pixels the rest of the window needs (sidebar + a readable chat column).
export function ChangesSide({ changes, focus, reserve }: { changes: ChangeView[]; focus: string | null; reserve: number }) {
  const [stored, setWidth] = useStoredNumber("tutor.changesWidth", 520)
  const [, redraw] = useState(0)
  useEffect(() => {
    const onResize = () => redraw((n) => n + 1)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const max = Math.max(320, window.innerWidth - reserve)
  const width = clamp(stored, 320, max)
  const drag = useDrag((dx) => setWidth((w) => clamp(Math.min(w, max) - dx, 320, max)))
  return (
    <aside className="changes side" style={{ width }} aria-label="Changes">
      <div className="resize-x" onMouseDown={drag} title="Drag to resize" />
      <div className="ch-head">
        <div className="ch-title">
          <I.Diff size={14} /> Changes {!!changes.length && <Totals changes={changes} />}
        </div>
        {!!changes.length && <Actions />}
      </div>
      <ChangesBody changes={changes} focus={focus} withTree={width >= 600} />
    </aside>
  )
}

// ---------- compact layout: a drawer under the chat that folds to one line ----------

export function ChangesDock({ changes, focus, open, setOpen }: { changes: ChangeView[]; focus: string | null; open: boolean; setOpen: (v: boolean) => void }) {
  const [height, setHeight] = useStoredNumber("tutor.dockHeight", 300)
  const drag = useDrag((_, dy) => setHeight((h) => clamp(h - dy, 140, Math.round(window.innerHeight * 0.75))), "y")
  if (!changes.length && !open) return null
  return (
    <section className={`changes dock ${open ? "open" : ""}`} aria-label="Changes">
      {open && <div className="resize-y" onMouseDown={drag} title="Drag to resize" />}
      <div className="dock-bar">
        <button className="dock-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`tw ${open ? "open" : ""}`}>
            <I.ChevronRight size={12} />
          </span>
          <I.Diff size={13} /> Changes {changes.length ? <Totals changes={changes} /> : <span className="ch-sum">none</span>}
        </button>
        {!!changes.length && <Actions />}
      </div>
      {open && (
        <div className="dock-body" style={{ height }}>
          <ChangesBody changes={changes} focus={focus} withTree={false} />
        </div>
      )}
    </section>
  )
}

// ---------- little helpers ----------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// Sizes are per-viewer conveniences, so localStorage is fine (and optional).
function useStoredNumber(key: string, initial: number): [number, (f: (n: number) => number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key))
      return n > 0 ? n : initial
    } catch {
      return initial
    }
  })
  const set = (f: (n: number) => number) =>
    setV((prev) => {
      const next = f(prev)
      try {
        localStorage.setItem(key, String(next))
      } catch {}
      return next
    })
  return [v, set]
}

function useDrag(onMove: (dx: number, dy: number) => void, axis: "x" | "y" = "x") {
  return (e: React.MouseEvent) => {
    e.preventDefault()
    let x = e.clientX
    let y = e.clientY
    const move = (ev: MouseEvent) => {
      onMove(ev.clientX - x, ev.clientY - y)
      x = ev.clientX
      y = ev.clientY
    }
    const up = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
      document.body.classList.remove("dragging", "dragging-y")
    }
    document.body.classList.add("dragging", ...(axis === "y" ? ["dragging-y"] : []))
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
  }
}
