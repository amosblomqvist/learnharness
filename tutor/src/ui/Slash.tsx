// Type "/" in the composer for commands, like Claude Code.
export type SlashCommand = { name: string; hint: string }

export const COMMANDS: SlashCommand[] = [
  { name: "new", hint: "New conversation" },
  { name: "history", hint: "Past conversations" },
  { name: "goal", hint: "New goal: a strategy map for something to build or master" },
  { name: "changes", hint: "Review file changes" },
  { name: "keep", hint: "Keep all changes" },
  { name: "undo", hint: "Undo all changes" },
  { name: "model", hint: "Choose a model" },
  { name: "tutor", hint: "Tutor mode: explain" },
  { name: "writer", hint: "Writer mode: write code" },
  { name: "learn", hint: "Lens: probe, plan, teach with quizzes" },
  { name: "explain", hint: "Lens: structure, flow, trade-offs" },
  { name: "paper", hint: "Lens: read a research paper" },
  { name: "infra", hint: "Lens: Docker, CI, cloud" },
  { name: "socratic", hint: "Lens: it asks, you reason" },
  { name: "review", hint: "Lens: senior code review" },
  { name: "snap", hint: "Capture the screen" },
  { name: "wide", hint: "Toggle the wide layout" },
  { name: "settings", hint: "Open settings" }
]

export function matchCommands(draft: string): SlashCommand[] {
  if (!draft.startsWith("/") || /\s/.test(draft)) return []
  const q = draft.slice(1).toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(q))
}

export function SlashMenu({ items, active, onPick }: { items: SlashCommand[]; active: number; onPick: (c: SlashCommand) => void }) {
  if (!items.length) return null
  return (
    <div className="slash" role="listbox">
      {items.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === active}
          className={i === active ? "on" : ""}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(c)
          }}
        >
          <code>/{c.name}</code>
          <span>{c.hint}</span>
        </button>
      ))}
    </div>
  )
}
