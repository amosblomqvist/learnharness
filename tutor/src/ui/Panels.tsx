// Past conversations (sidebar in wide layout, a panel in narrow), Settings, and the empty state.
import { useEffect, useState } from "react"
import { api, type ConversationSummary, type IdeStatus, type KeyName, type LearnStatus, type Mode, type NotesWhere, type Settings } from "../api"
import * as I from "../icons"

function ago(t: number): string {
  const s = (Date.now() - t) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}

// refresh: bump to reload the list (after a turn saves a conversation).
// hideGoals: goal conversations live under their goal, not in Chats.
export function HistoryList(props: { currentId: string; onOpen: (id: string) => void; onNew: () => void; refresh: number; sidebar?: boolean; hideGoals?: boolean; live?: Record<string, "running" | "waiting"> }) {
  const { currentId, onOpen, onNew, refresh, sidebar, hideGoals, live } = props
  const [list, setList] = useState<ConversationSummary[] | null>(null)
  const [q, setQ] = useState("")
  useEffect(() => {
    api.listConversations().then(setList)
  }, [refresh])
  const shown = (list ?? []).filter((c) => (!hideGoals || !c.goalId) && (!q || c.title.toLowerCase().includes(q.toLowerCase())))
  return (
    <div className={sidebar ? "sidebar-body" : "panel history"}>
      <div className="hist-top">
        {sidebar ? (
          <button className="new-chat" onClick={onNew}>
            <I.Plus size={14} /> New conversation <kbd>⌘N</kbd>
          </button>
        ) : null}
        <label className="search">
          <I.Search size={14} />
          <input autoFocus={!sidebar} placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {!sidebar && (
          <button className="btn" onClick={onNew}>
            <I.Plus size={13} /> New
          </button>
        )}
      </div>
      {list && !list.length && <p className="hint pad">Nothing yet. Conversations are saved here automatically after each answer.</p>}
      <ul className="hist">
        {shown.map((c) => (
          <li key={c.id} className={c.id === currentId ? "cur" : ""}>
            <button className="hist-open" onClick={() => onOpen(c.id)}>
              <span className={`mdot m-${c.mode}`} />
              <span className="ht">
                {live?.[c.id] && <span className={`live-dot ${live[c.id]}`} title={live[c.id] === "waiting" ? "A question is waiting for you" : "Working…"} />}
                {c.title}
              </span>
              <span className="hm">
                {ago(c.updatedAt)} · {Math.ceil(c.count / 2)} {c.count > 2 ? "turns" : "turn"}
              </span>
            </button>
            <button
              className="icon del"
              title="Delete this conversation"
              onClick={async () => {
                if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return
                await api.deleteConversation(c.id)
                setList((l) => (l ?? []).filter((x) => x.id !== c.id))
              }}
            >
              <I.Trash size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Empty({ mode, learn, onPick, disabled, ide, starters }: { mode: Mode; learn: boolean; onPick: (prompt: string) => void; disabled: boolean; ide: string | null; starters: { icon: () => React.ReactNode; title: string; sub: string; prompt: string }[] }) {
  return (
    <div className="empty">
      <h1>{learn ? "What do you want to understand?" : mode === "tutor" ? "What are we looking at?" : "What should I build?"}</h1>
      <p className="sub">
        {learn
          ? "It finds the edge of what you already know with a few quick questions, shows you a plan built from things you can take as given, then teaches it piece by piece and checks each one lands."
          : mode === "tutor"
          ? `Snap your screen${ide ? ` or ask about what's open in ${ide}` : " or open a project"}. It explains the structure and the reasons, not just the syntax.`
          : ide
            ? `It writes complete code straight into ${ide}. Every edit lands in Changes to keep or undo.`
            : "It writes complete code and, with a project open, edits the files directly."}
      </p>
      <div className="starters">
        {starters.map((s) => (
          <button key={s.title} className="starter" onClick={() => onPick(s.prompt)} disabled={disabled}>
            <span className="si">{s.icon()}</span>
            <span className="st">{s.title}</span>
            <span className="ss">{s.sub}</span>
          </button>
        ))}
      </div>
      <div className="keys">
        <span>
          <kbd>⌘⇧\</kbd> snap & ask
        </span>
        <span>
          <kbd>/</kbd> commands
        </span>
        <span>
          <kbd>⌘⇧W</kbd> wide layout
        </span>
      </div>
    </div>
  )
}

// "Ask Tutor" inside PyCharm / WebStorm: an External Tool that hands the selection to Tutor.
function IdeActionCard() {
  const [st, setSt] = useState<{ binary: string | null; ides: { name: string; installed: boolean }[] } | null>(null)
  const [agent, setAgent] = useState<{ installed: boolean; file: string; ready: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.ideActionStatus().then(setSt)
    api.ideAgentStatus().then(setAgent)
  }, [])
  const all = !!st?.ides.length && st.ides.every((i) => i.installed)
  return (
    <section className="card">
      <h3>Tutor in the IDE's AI chat</h3>
      <p className="hint">
        Talk to Tutor right inside PyCharm or WebStorm: AI Chat → pick <i>Tutor</i> from the agents. The IDE hands it your open file and selection; modes Learn, Explain and Writer are in its mode picker. Quizzes come as text there (answer in your next message). Every IDE chat also shows up here in Chats. Tutor adds itself to <code>~/.jetbrains/acp.json</code> and leaves any other agents in that file alone.
      </p>
      <div className="learn-files">{agent?.installed ? <span className="ok">✓ Added. Restart the IDE if Tutor isn't in its agent list yet.</span> : <span className="where">Not added yet.</span>}</div>
      <div className="row-btns">
        <button
          className="btn"
          disabled={!agent?.ready}
          onClick={async () => {
            setErr(null)
            try {
              setAgent(await api.installIdeAgent())
            } catch (e) {
              setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
            }
          }}
        >
          {agent?.installed ? "Add again" : "Add Tutor to the AI chat"}
        </button>
      </div>
      <h3 className="sub-h">Ask Tutor from the IDE</h3>
      <p className="hint">
        Select code in PyCharm or WebStorm and send it here with the question box ready. After adding it, restart the IDE, then: right-click → <i>Tutor → Ask Tutor</i>, or ⌘⇧A "Ask Tutor". Give it a shortcut in the IDE's Settings → Keymap (search "Ask Tutor"). With nothing selected it sends the lines around the caret.
      </p>
      {st && (
        <div className="learn-files">
          {st.ides.map((i) => (
            <span key={i.name} className={i.installed ? "ok" : ""}>
              {i.installed ? "✓" : "○"} {i.name.replace(/(\d{4}\.\d)$/, " $1")}
            </span>
          ))}
          {!st.ides.length && <span className="where">No JetBrains IDE settings found on this Mac.</span>}
        </div>
      )}
      {err && <div className="err inline">{err}</div>}
      <div className="row-btns">
        <button
          className="btn"
          disabled={!st?.ides.length || !st.binary}
          onClick={async () => {
            setErr(null)
            try {
              setSt(await api.installIdeAction())
            } catch (e) {
              setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
            }
          }}
        >
          {all ? "Add again" : "Add to my IDEs"}
        </button>
      </div>
    </section>
  )
}

// Where recaps are saved: your Obsidian vault when there is one, or any folder.
function NotesCard() {
  const [w, setW] = useState<NotesWhere | null>(null)
  useEffect(() => {
    api.notesWhere().then(setW)
  }, [])
  return (
    <section className="card">
      <h3>Notes</h3>
      <p className="hint">
        Every lesson and recap is saved as a Markdown note with its own concept map, one folder per goal, in the map's order.
        {w?.vault ? " This folder is inside your Obsidian vault, so the notes show up there with their diagrams, links and tags." : w?.obsidian ? " Pick a folder inside your Obsidian vault to read them there." : " Any Markdown app can open them (Obsidian, PyCharm)."}
      </p>
      <div className="learn-path" title={w?.root}>
        <I.Folder size={13} /> <span>{w ? `${w.root}\u200e` : "…"}</span>
      </div>
      <div className="row-btns">
        <button className="btn" onClick={async () => setW(await api.pickNotesFolder())}>
          Use another folder…
        </button>
        <button className="btn" onClick={async () => setW(await api.resetNotesFolder())} title="Your Obsidian vault if you have one, otherwise ~/TutorNotes">
          Default
        </button>
      </div>
      <p className="hint">Goals keep the folder their first recap went to.</p>
    </section>
  )
}

// The Learn lens's skill folder: a clone of github.com/amosblomqvist/learn that you can edit.
function TeachingCard() {
  const [st, setSt] = useState<LearnStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.learnStatus().then(setSt)
  }, [])
  const act = async (fn: () => Promise<LearnStatus>) => {
    setBusy(true)
    setErr(null)
    try {
      setSt(await fn())
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
    } finally {
      setBusy(false)
    }
  }
  const f = st?.files
  return (
    <section className="card">
      <h3>Teaching method</h3>
      <p className="hint">
        The <b>Learn</b> lens teaches with the skill in this folder, from{" "}
        <a href="https://github.com/amosblomqvist/learn" target="_blank" rel="noreferrer">
          amosblomqvist/learn
        </a>
        : probe what you know, plan from things you can take as given, teach node by node with quizzes. Edit <code>skills/teach/SKILL.md</code> to change how it teaches; it's read fresh for every answer.
      </p>
      <div className="learn-path" title={st?.path}>
        <I.Folder size={13} /> <span>{st ? `${st.path}\u200e` : "…"}</span>
      </div>
      {st && (
        <div className="learn-files">
          {st.installed ? (
            <>
              <span className={f?.teach ? "ok" : "no"}>{f?.teach ? "✓" : "✗"} teach</span>
              <span className={f?.visualize ? "ok" : "no"}>{f?.visualize ? "✓" : "✗"} visualize</span>
              <span className={f?.researcher ? "ok" : "no"}>{f?.researcher ? "✓" : "✗"} researcher</span>
              {st.commit && (
                <span className="where">
                  {st.commit} · {st.date}
                  {st.edited ? " · your edits" : ""}
                </span>
              )}
            </>
          ) : (
            <span className="where">Not downloaded yet (it's fetched the first time you use Learn).</span>
          )}
        </div>
      )}
      {err && <div className="err inline">{err}</div>}
      <div className="row-btns">
        <button className="btn" disabled={busy} onClick={() => act(api.installLearn)}>
          {busy ? "Working…" : st?.installed ? "Update from GitHub" : "Download"}
        </button>
        {st?.installed && (
          <button className="btn" onClick={() => api.openLearnFolder()}>
            Open folder
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => act(api.pickLearnFolder)}>
          Use another folder…
        </button>
      </div>
    </section>
  )
}

export function SettingsPanel(props: {
  settings: Settings
  keys: Record<KeyName, boolean>
  ide: IdeStatus | null
  onKeys: (k: Record<KeyName, boolean>) => void
  onSave: (p: Partial<Settings>) => Promise<boolean>
  flash: string | null
  setFlash: (s: string | null) => void
}) {
  const { settings, keys, ide, onKeys, onSave, flash, setFlash } = props
  const [form, setForm] = useState(settings)
  const [profile, setProfile] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState<Record<KeyName, string>>({ anthropic: "", xai: "", openai: "", brave: "" })
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v })
  useEffect(() => {
    api.getProfile().then(setProfile)
  }, [])

  const KEYS: [KeyName, string, string][] = [
    ["anthropic", "Anthropic", "console.anthropic.com"],
    ["xai", "xAI · Grok API", "console.x.ai"],
    ["openai", "OpenAI", "platform.openai.com"],
    ["brave", "Brave Search", "api-dashboard.search.brave.com"]
  ]

  return (
    <div className="panel settings">
      <section className="card">
        <h3>Subscriptions</h3>
        <p className="hint">
          No keys needed. <b>Claude plan</b> uses your Claude Code login (<code>claude auth login</code>). <b>Grok sub</b> uses Grok Build with your SuperGrok / X Premium+ login (<code>grok login</code>).
        </p>
        <label className="field">
          <span>Claude Code CLI</span>
          <input value={form.claudePath} onChange={(e) => set("claudePath", e.target.value)} />
        </label>
        <label className="field">
          <span>Grok Build CLI</span>
          <input value={form.grokPath} onChange={(e) => set("grokPath", e.target.value)} />
        </label>
      </section>
      <TeachingCard />
      <NotesCard />
      <section className="card">
        <h3>API keys</h3>
        <p className="hint">Optional, pay-per-use. Encrypted with your macOS Keychain. Brave turns on web search.</p>
        {KEYS.map(([k, label, where]) => (
          <div key={k} className="keyrow">
            <div className="kl">
              <span className={`pdot p-${k}`} />
              <b>{label}</b>
              {keys[k] ? <span className="pill ok">saved</span> : <span className="where">{where}</span>}
            </div>
            <div className="kin">
              <input type="password" autoComplete="off" spellCheck={false} placeholder={keys[k] ? "Paste to replace" : "Paste key"} value={keyDraft[k]} onChange={(e) => setKeyDraft({ ...keyDraft, [k]: e.target.value })} />
              <button
                className="btn"
                disabled={!keyDraft[k] && !keys[k]}
                onClick={async () => {
                  onKeys(await api.setKey(k, keyDraft[k]))
                  setKeyDraft({ ...keyDraft, [k]: "" })
                }}
              >
                {keyDraft[k] || !keys[k] ? "Save" : "Remove"}
              </button>
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <h3>JetBrains IDE</h3>
        <p className="hint">
          Found automatically. In PyCharm / WebStorm: Settings → Tools → MCP Server → <i>Enable MCP Server</i>, with a project open. Tutor mode can look around the IDE; Writer mode and "Apply in IDE" edit files there, and every edit shows up in Changes. It never gets the IDE's terminal or database tools.
        </p>
        <div className="ide-list">
          {(ide?.list ?? []).map((i) => (
            <div key={i.id} className="ide-row">
              <span className={`pdot ${i.project ? "p-ide" : ""}`} />
              <b>{i.name}</b>
              <span className="where">{i.project ?? "no project open"}</span>
              {ide?.active?.id === i.id && <span className="pill ok">in use</span>}
            </div>
          ))}
          {!ide?.list.length && <div className="where">No JetBrains IDE with its MCP server running right now.</div>}
        </div>
      </section>
      <IdeActionCard />
      <section className="card">
        <h3>About me</h3>
        <p className="hint">Sent with every question so answers start at your level.</p>
        <textarea rows={3} value={form.aboutMe} onChange={(e) => set("aboutMe", e.target.value)} />
      </section>
      <section className="card">
        <h3>Learner profile</h3>
        <p className="hint">What Tutor has picked up about what you know and what trips you up. It adds to this as you go; edit or delete anything.</p>
        <textarea className="mono" rows={6} value={profile ?? ""} placeholder="Empty so far." onChange={(e) => setProfile(e.target.value)} />
      </section>
      <section className="card">
        <h3>More MCP servers</h3>
        <p className="hint">Anything else with the usual Claude/Cursor format. The IDE and Brave are added for you. Tutor mode leaves out tools that change things.</p>
        <textarea className="mono" rows={5} spellCheck={false} value={form.mcpJson} onChange={(e) => set("mcpJson", e.target.value)} />
      </section>
      <section className="card">
        <h3>Local</h3>
        <label className="field">
          <span>Ollama URL</span>
          <input value={form.ollamaUrl} onChange={(e) => set("ollamaUrl", e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.hideFromScreenShare} onChange={(e) => set("hideFromScreenShare", e.target.checked)} />
          <span>Hide this window from screen sharing and recordings</span>
        </label>
      </section>
      <div className="save-row">
        {flash && (
          <span className={flash === "Saved" ? "pill ok" : "err inline"} onClick={() => setFlash(null)}>
            {flash}
          </span>
        )}
        <button
          className="btn primary"
          onClick={async () => {
            const ok = await onSave({ aboutMe: form.aboutMe, mcpJson: form.mcpJson, ollamaUrl: form.ollamaUrl, claudePath: form.claudePath, grokPath: form.grokPath, hideFromScreenShare: form.hideFromScreenShare })
            if (profile !== null) await api.setProfile(profile)
            if (ok) setFlash("Saved")
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  )
}
