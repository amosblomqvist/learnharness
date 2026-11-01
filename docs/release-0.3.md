# First Release (0.3.0) — polish list + lock question

> **Historical planning notes (2026-10-06), not the current release checklist.**
> The original ideas and statuses below may be superseded or unimplemented.
> See [Desktop builds and releases](desktop-release.md) for the current release
> procedure, and [Architecture](architecture.md) / [Development](development.md)
> for the shipped system and development guidance.

Started 2026-10-06, owner brain-dump round. Priority 1 — everything else (assessment levels → docs/vision-assessment.md) comes after. Items are captured as spoken; design decisions inside them are **unruled** unless marked.

## Polish items (owner list, 2026-10-06)

1. **Graph rendering toggle — separate from the extraction pipeline.**
   Today's graph on/off switch toggles extraction. Wanted: two switches —
   one for the *pipeline* (named for what it does), one for *rendering*
   ("graph on/off" = the graph view renders or not). Data, chains model,
   extraction all keep working with rendering off.
   - Open: **what is the home view when graph rendering is off?** It must
     keep the import-notes button, the chains-view button, and the graph
     pipeline cost readout. Candidate raised and not rejected: the chains
     view (the chain table is already a complete non-graph presentation of
     propositions + chains). A "giant DAG" was raised and rejected. Unruled.
2. **Keyboard navigation for questions** — arrow buttons (next/previous
   question) are currently click-only; make them real keybinds, with VIM
   bindings (j/k or similar) as the goal. Maybe rebindable, maybe not — unruled.
3. **Session naming.** First-message-as-name is not clean (the first message
   is always long). Owner dislikes LLM-generated names. A naming popup after
   first send was considered — possibly annoying; unruled. (Fact: the top-bar
   title is already click-to-rename; whatever lands should agree with it.)
4. **Export sessions as markdown** — likely a right-click action on a session
   in the sidebar. (Fact: core/session-markdown.ts already renders whole
   sessions to markdown for extraction — the serialization exists.)
5. **Export the reasoning chains / graph** — format unruled (JSON is the
   obvious candidate: serve the graph snapshot). Placement unruled.
6. **Graph default settings refinement** — current defaults not ideal; minor.
7. **Compaction summary dialog** — covers the entire screen and doesn't look
   good; Esc prompts a dismiss question instead of just closing. Law stated:
   **Esc always acts on the current element on screen.**
8. **General keyboard audit** — everything must work from the keyboard; some
   minor things don't. Examples to be enumerated in the round.

## What does "released" change in development? (the lock question)

Position agreed 2026-10-06: releasing means **on-disk user data acquires
compatibility obligations** — after 0.3.0, persistent-schema changes are
migrations with tolerant reads, not free edits plus wipe-your-dev-data.
Nothing is frozen forever; the discipline changes.

Persistent surfaces (the obligation set):
- `data/chats/*.json` — ChatRecord: messages (pi-ai wire shapes: thinking
  blocks, toolCalls, usage), turns, kind, graphContext. The deepest lock —
  and coupled to the pi-ai library's serialization (a pi-ai bump becomes a
  migration event post-release).
- `data/graph/` — nodes.jsonl, chains.jsonl, coverage.jsonl, sources.json,
  sessions.jsonl (append-only ledgers), positions.json, render-settings.json.
- `data/settings.json` (models, toggles, compaction…), `auth.json` (BYOK keys).
- Client localStorage (camera, filters, zoom, kind filter).
- `data/jobs/` — treat as scratch/transient, no obligation.

Known gaps to close *before* release (proposals, unruled):
- **No schemaVersion anywhere.** Cheap now, load-bearing later: stamp
  ChatRecord, settings, and the ledgers with a version at write time;
  readers default missing → current. This is what makes later migrations
  painless.
- **Pin pi-ai/pi-agent-core exact versions** so record shapes move only
  deliberately.
- Release engineering outside code: signing/notarization await Apple
  Developer enrollment (DMG is unsigned today); no auto-updater (manual
  download acceptable for 0.3.0 if stated); packaged-app data location
  already correct (LH_DATA_DIR → userData).
