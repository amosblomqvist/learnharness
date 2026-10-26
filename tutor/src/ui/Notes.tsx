// A goal's notes: the recaps saved after "Recap & quiz", in the map's order, to reread like a book.
// They're Markdown files in ~/TutorNotes/<goal>/ too, so Obsidian or PyCharm can open the same folder.
import { useEffect, useState } from "react"
import { api, type Goal, type NoteInfo, type NotesWhere } from "../api"
import { Md } from "./Message"
import * as I from "../icons"

// Links between note files only work in a file viewer; here they read as plain text.
const forReader = (md: string) => md.replace(/\[([^\]]+)\]\((?!https?:)[^)]*\)/g, "$1")

// Obsidian first when the notes are in a vault; Finder otherwise.
export function NotesReader({ goal, open, onOpen, onClose }: { goal: Goal; open: string; onOpen: (nodeId: string) => void; onClose: () => void }) {
  const [notes, setNotes] = useState<NoteInfo[] | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [where, setWhere] = useState<NotesWhere | null>(null)
  useEffect(() => {
    api.notesWhere().then(setWhere)
  }, [])
  const inVault = !!where?.obsidian && !!notes?.[0] && !!where.vault && notes[0].file.startsWith(where.vault)
  useEffect(() => {
    let live = true
    api.listNotes(goal.id).then((n) => live && setNotes(n))
    return () => {
      live = false
    }
  }, [goal.id, goal.updatedAt])
  const current = notes?.find((n) => n.nodeId === open) ?? notes?.[0] ?? null
  useEffect(() => {
    let live = true
    setText(null)
    if (current) api.readNote(goal.id, current.nodeId).then((t) => live && setText(t))
    return () => {
      live = false
    }
  }, [goal.id, current?.nodeId, current?.at])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [onClose])

  const stages: { title: string; items: NoteInfo[] }[] = []
  for (const n of notes ?? []) {
    const last = stages[stages.length - 1]
    if (last?.title === n.stageTitle) last.items.push(n)
    else stages.push({ title: n.stageTitle, items: [n] })
  }
  return (
    <div className="notes">
      <div className="notes-bar">
        <I.Book size={14} />
        <b>Notes</b>
        <span className="notes-sub">{notes ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : ""}</span>
        <div className="grow" />
        {inVault && (
          <button className="btn" onClick={() => api.openInObsidian(goal.id, current?.file)} title="Open this note in your Obsidian vault">
            <I.Book size={13} /> Open in Obsidian
          </button>
        )}
        <button className="btn" onClick={() => api.openNotes(goal.id, current?.file)} title="The Markdown files: open the folder in Obsidian, PyCharm or any editor">
          <I.Folder size={13} /> Show in Finder
        </button>
        <button className="icon" onClick={onClose} title="Close (Esc)">
          <I.X size={14} />
        </button>
      </div>
      {notes && !notes.length ? (
        <div className="notes-empty">
          <p>No notes yet. Every lesson (<b>Teach me this</b>, or <b>Recap &amp; quiz</b> after you've studied the sources) saves one here, with its own concept map.</p>
        </div>
      ) : (
        <div className="notes-body">
          <nav className="notes-toc">
            {stages.map((st) => (
              <div key={st.title}>
                <h4>{st.title}</h4>
                {st.items.map((n) => (
                  <button key={n.nodeId} className={n.nodeId === current?.nodeId ? "on" : ""} onClick={() => onOpen(n.nodeId)}>
                    {n.title}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <article className="notes-doc md">
            {current && text != null && (
              <>
                <Md text={forReader(text)} inline={false} />
                <p className="notes-meta">Saved {new Date(current.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p>
              </>
            )}
          </article>
        </div>
      )}
    </div>
  )
}
