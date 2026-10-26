// The model menu and the IDE menu in the header.
import { useEffect, useMemo, useRef, useState } from "react"
import type { IdeStatus, ModelOption } from "../api"
import * as I from "../icons"

export const PROVIDER_NAME: Record<ModelOption["provider"], string> = {
  "claude-plan": "Claude plan",
  "grok-plan": "Grok sub",
  anthropic: "Claude API",
  xai: "Grok API",
  openai: "OpenAI",
  ollama: "Local"
}

// Close a popover on outside click or Escape.
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", esc)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", esc)
    }
  }, [open])
  return { open, setOpen, ref }
}

export function ModelPicker(props: { models: ModelOption[]; current?: ModelOption; onOpen: () => void; onPick: (id: string) => void; openSignal?: number }) {
  const { models, current, onOpen, onPick, openSignal } = props
  const { open, setOpen, ref } = usePopover()
  useEffect(() => {
    if (openSignal) {
      onOpen()
      setOpen(true)
    }
  }, [openSignal])
  const groups = useMemo(() => {
    const g = new Map<string, ModelOption[]>()
    for (const m of models) g.set(m.group, [...(g.get(m.group) ?? []), m])
    return [...g.entries()]
  }, [models])

  return (
    <div className="picker" ref={ref}>
      <button
        className="chip model"
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
        aria-expanded={open}
      >
        <span className={`pdot p-${current?.provider ?? "none"}`} />
        <span className="name">{current?.label.split(" · ")[0] ?? "Choose model"}</span>
        <span className="prov">{current ? PROVIDER_NAME[current.provider] : ""}</span>
        <I.Chevron size={13} />
      </button>
      {open && (
        <div className="menu" role="listbox">
          {groups.map(([group, list]) => (
            <div key={group} className="group">
              <div className="glabel">{group}</div>
              {list.map((m) => {
                const [name, tag] = m.label.split(" · ")
                return (
                  <button
                    key={m.id}
                    role="option"
                    aria-selected={m.id === current?.id}
                    disabled={!m.ready}
                    className={m.id === current?.id ? "sel" : ""}
                    onClick={() => {
                      onPick(m.id)
                      setOpen(false)
                    }}
                  >
                    <span className={`pdot p-${m.provider}`} />
                    <span className="name">{name}</span>
                    <span className="tag">{m.note ?? tag ?? ""}</span>
                    {m.id === current?.id && <I.Check size={13} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const base = (p: string | null) => p?.split("/").filter(Boolean).pop() ?? ""

export function IdePicker({ status, onOpen, onPick }: { status: IdeStatus | null; onOpen: () => void; onPick: (choice: string) => void }) {
  const { open, setOpen, ref } = usePopover()
  const active = status?.active
  const label = active ? active.name : status?.choice === "off" ? "IDE off" : "No IDE"
  return (
    <div className="picker ide" ref={ref}>
      <button
        className={`chip ${active ? "set" : ""}`}
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
        title={active ? `${active.name} · ${active.project}` : "Connect PyCharm / WebStorm (their MCP server must be enabled)"}
        aria-expanded={open}
      >
        <span className={`pdot ${active ? "p-ide" : ""}`} />
        <span className="name">{label}</span>
        {active?.project && <span className="prov">{base(active.project)}</span>}
      </button>
      {open && (
        <div className="menu right" role="listbox">
          <div className="glabel">JetBrains IDE</div>
          {[{ id: "auto", name: "Automatic", sub: "The one you used last" }, ...(status?.list ?? []).map((i) => ({ id: i.id, name: i.name, sub: i.project ? base(i.project) : "no project open" })), { id: "off", name: "Off", sub: "Don't connect" }].map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={status?.choice === o.id}
              className={status?.choice === o.id ? "sel" : ""}
              onClick={() => {
                onPick(o.id)
                setOpen(false)
              }}
            >
              <span className="name">{o.name}</span>
              <span className="tag">{o.sub}</span>
              {status?.choice === o.id && <I.Check size={13} />}
            </button>
          ))}
          {!status?.list.length && <div className="menu-note">No IDE found. In PyCharm/WebStorm: Settings → Tools → MCP Server → Enable, with a project open.</div>}
        </div>
      )}
    </div>
  )
}
