# Build Plan v1 — from vision to system

> **Historical build plan, not a current implementation or execution runbook.**
> The original waves and checkboxes below may be superseded or unimplemented.
> See [Architecture](architecture.md) and [Development](development.md) for the
> shipped system and current development guidance.

Execution plan for `docs/vision.md`. Section references (§) point into that document. Not exact — a dependency-ordered wave structure with verification gates. Written 2026-08-22.

## Execution model

- **Workers (GLM 5.3) implement everything.** Each task brief carries: exact file ownership, contracts to code against, acceptance criteria, and the standing instruction — *when anything is undecided or ambiguous, ask the orchestrator (me) via your ask tool; never guess details.*
- **Orchestrator (me) owns:** the shared contracts file (Wave 0 — everything depends on it; mistakes here poison all downstream work), all browser verification (only I have the browser tool), gate reviews, and escalations.
- **Escalation to the user:** only when a genuinely new implementation/design decision appears that we haven't discussed, with meaningful, expensive-to-revert consequences. Otherwise I decide and note it.
- **Parallelism by file ownership.** Workers in the same wave get disjoint file lists. Touching a file outside your list requires asking me first. Each worker leaves gates green: `npx tsc --noEmit`, `npm test`, `npm run build`. Small scoped commits; I review at gates.
- **Prompt architecture:** the teacher system prompt becomes composed fragments (`src/agent/prompts/*.md`) so parallel workers add prompt sections without editing the same file.

## Wave 0 — contracts (me, before any worker spawns)

`src/core/contracts.ts` + store formats: `PlanTree`/`PlanNode`/`PlanEdge` types and tool I/O schemas (vision §2 plan tree); `GraphNode`/`GraphEdge`/`LedgerEvent` types (§1, one substrate); quiz/ask tool inputs gain optional `nodeId` (outcomes tag nodes); chat persistence gains a `tree` field; `data/graph/` store format; part-renderer extension points for future artifact types; the async-job protocol (below).

**Async sub-agent protocol (decided here):** a sub-agent tool call creates a server-side job; the tool part in the chat stays `input-available` with a `jobId` while running (non-blocking — the lesson continues). On completion the server rewrites the part to `output-available` with the result and the client (polling only while jobs are active) picks it up; the existing `sendAutomaticallyWhen` continuation fires and the teacher receives the result as a normal tool output. The same part doubles as the activity-indicator data source.

## Wave 1 — three parallel workers

- **W1 · Plan-tree tools** (§2 "formal plan tree"): `src/core/plan-tree.ts` (pure validated ops: add_node, add_edge, reparent, remove, set_current), agent tool surface, `tree` persistence in the chat store, prompt fragment for tree authoring, unit tests.
- **W2 · Sub-agent infrastructure + researcher** (§2.5): server-side async job runner (agent loop with restricted tool set, status events, job store), the async protocol from Wave 0, server ports of `web_search`/`web_fetch`, the researcher prompt port, teacher's `research` tool, minimal activity indicator UI + client polling, tests with a fake model.
- **W3 · Presentation fixes** (§3): LaTeX delimiter switch to `\(...\)` / `\[...\]` (preprocessing + prompt fragment; `$` becomes currency-only), verify + fix the line-break bug (likely `remark-breaks`), proper mermaid rendering component (integrated, pan/zoom sane), tests.

**Gate 1 (me, browser):** existing sessions load clean; a live session authors a tree (verify JSON); new math delimiters render and `$` stays currency; mermaid renders properly; a research job runs async with a live indicator and the teacher receives the result via continuation. Gates green.

**GATE 1 RESULTS (2026-08-22, PASSED):** old sessions clean, zero console errors. Live chain-rule session authored a 4-node tree via plan_init + plan_set_current, persisted in the chat record. \(…\) KaTeX rendered throughout the live lesson. Mermaid: valid diagram renders dark-themed with pan/zoom chrome; a model syntax error degraded gracefully into W3's dark fallback (prompt fix shipped: label-quoting rule). Research job ran 88s with live `web_search:`/`web_fetch:` activity lines; sourced brief landed. **Found+fixed:** setMessages never fires sendAutomaticallyWhen (SDK only checks inside addToolOutput) — syncFromServer now triggers the continuation, plus a mount-continuation effect for reloads. Bonus root cause (W3): missing streamdown `@source` Tailwind directive had left ALL streamdown chrome unstyled.

## Wave 2 — three parallel workers

- **W4 · Graph store + home view** (§1): `src/core/graph.ts` (model + naive-union emission from session trees + tagged quiz outcomes), `data/graph/` store, emission on chat completion, `GET /api/graph`, `components/graph-view.tsx` (sigma.js + forceatlas2 run-then-freeze, state colors, labels at zoom, pan/zoom — per the rendering decision), home page integration, 2k-node synthetic benchmark script, tests.
- **W5 · Phases & question reveal** (§2 "two phases"): probe→teach structured marker + transcript divider, teach-phase checks start collapsed behind a reveal button (QuestionDock variant), probe keeps auto-open. *Warning in brief: chat.tsx scroll/hysteresis state machine is load-bearing — minimal diffs.*
- **W6 · Demo artifacts + builder/visual workers** (§2 demos + §2.5): `demo` artifact tool part → sandboxed iframe renderer (resize bridge, error chip, fix loop), demo-builder sub-agent that headlessly tests the code before delivery, visual-maker sub-agent (port of vault `svg-maker`: write/edit/render + verify-by-looking), SVG block renderer, tests.

**Gate 2 (me, browser):** full journey — new topic: probe auto-opens, tree builds, teach checks collapsed + reveal works; home shows the graph with settled layout; a demo artifact renders sandboxed and an SVG arrives correct; all scroll behaviors regression-checked. Gates green.

**GATE 2 RESULTS (2026-08-22, PASSED):** full live journey (chain rule, teacher = GLM 5.3 via `LH_MODEL`). Probe auto-opened → miss → teacher adapted → `plan_init` → "Teaching · 4 nodes" divider → teach checks collapsed behind the "Check your understanding › Open" invitation (screenshot-verified), reveal on click, no auto-expand at bottom. Demo: builder wrote + headless-tested 16 KB HTML; sandboxed iframe rendered (opaque origin confirmed), resize bridge worked (1111px). Graph: home shows the 4-node chain via sigma/forceAtlas2; `/api/graph` states 3 taught / 1 candidate; ledgers captured probe-miss / check-correct / check-incorrect / taught with idempotency refs; `foldStaleChats` back-filled the 3 pre-tree sessions correctly (all their quizzes = probe events). Visual: first attempt FAILED gracefully (GLM 5.3 is text-only — "No endpoints found that support image input"); failure card + honest teacher continuation verified; fixed by pinning `LH_VISUAL_MODEL=anthropic/claude-sonnet-4.5` in .env.local; maker then verified standalone (write → render → look, one clean round). Gates behaved: composer blocked during pending quiz AND pending job; job continuation intact. Not browser-verified: sigma node-click overlay (synthetic pointer events don't reach sigma's captor; unit-covered, data verified via API).

## Wave 3 — two parallel workers

- **W7 · Right-panel tree view** (§2 "persistent tree view"): collapsible right panel, node states (done / current / next / upcoming), current-position highlight, collapse-to-strip; integrates with the session layout without disturbing the dock.
- **W8 · Consolidation-lite + graph-as-context** (§1): graph context injection into the teacher system prompt at session start (whole graph while small + diagnostic hotspots — selection strategies per §1, simplest first), calibration rubric applied to events, naive merge improvements (exact/alias matching; full embed+adjudication merge stays deferred unless trivial), tests.

**Gate 3 (me, browser):** tree panel behaviors; new session on a previously-touched topic visibly personalizes probing (inspect the injected context); full regression sweep; final gates.

**GATE 3 RESULTS (2026-08-22, PASSED):** tree panel renders 4 nodes in topo order with "3/4" progress + current-node summary; collapse-to-rail persists via localStorage across reload and re-expands. Personalization verified live: a fresh "teach me the product rule" session opened with "Welcome back! I see we've done the chain rule together — composition as function machines, rates multiplying through gears, and the formula" — the teacher reading the injected graph — then probed at the foundation. Home graph + regression sweep clean. Follow-up observed: GLM teacher occasionally emits a quiz whose correctAnswer matches no option value (question-core logs + degrades gracefully) — schema/prompt hardening candidate.

## Deferred (recorded, not in this plan)

Dictation (§2), not-a-chat presentation overhaul + structural-identity items (§2, LOW PRIORITY), DB migration (JSON stores suffice now), retroactive bootstrap of the ~15 vault POC sessions (awaits the full extraction/consolidation pipeline), spaced repetition, practice exercises, Electron, Pyodide.

## Definition of done (every wave)

tsc clean · all tests pass · build clean · browser gate observations recorded · commits scoped · vision.md roadmap checkboxes updated · memory updated.
