# ⚠️ ARCHIVED — superseded 2026-09-18. Read [`docs/architecture.md`](../architecture.md) instead.

[Archive index](README.md) · Historical notes below describe their own period, not today's runtime.

This is the pre-audit architecture spec (last maintained 2026-09-08). It was superseded after a full-code audit found it drifted from the as-built system; it is retained for history only — **do not trust it as a spec, do not update it**.

Known-stale in this copy: the single `contracts.ts` (now six domain files), the `everyNQuizAnswers` extraction trigger (now token coverage), hotspot + 1-hop graph context (now semantic top-K), sigma.js + forceAtlas2 rendering (now a hand-rolled Canvas 2D renderer + d3-force), Louvain clustering (now embedding-based agglomerative clustering), `MockLanguageModelV4` tests (now pi-ai's faux provider), the three-file store list (now five adapters), and "deliberately deferred" features that since shipped (dictation, notes import, embeddings, clusters, model settings). The current spec's decision-history appendix records each supersession.

---

# Learning Harness — Architecture

Status: **the canonical target-architecture spec** — describes the as-built system (post-pivot, refactor stages 1–5 complete). The pre-pivot v0 scaffold doc (pi-based, Fastify/Vite) lives in git history; product reasoning lives in [`docs/vision.md`](vision.md); file-by-file layout lives in the README.

**What this is.** A standalone Next.js learning app: the learner's knowledge accumulates into one persistent, cross-session knowledge graph, built from tutoring sessions in which a teacher agent authors a formal, visible dependency tree (the plan tree) and verifies understanding with structured questions. The graph is the home page; the session is the classroom; everything else serves those two.

**Design principles, in priority order:**

1. **Maximum control.** Every dependency edge is explicit and machine-checked. Nothing reaches sideways for convenience.
2. **Easy editability.** A worker can trace any behavior to one file. Layers are named by responsibility, not by framework accident.
3. **Zero technical debt.** The shape you see is the shape that runs. Deprecated paths are deleted, not parked.
4. **Crystal-clear architecture.** One contracts file, one composition root, one writer per store, one trigger seam. When a rule can be a lint rule, it is.

---

## 1. The layers

Dependency arrows point **down only**. Each layer may import the core barrel; nothing may skip a boundary for convenience.

```
┌──────────────────────────────────────────────────────────────┐
│ SHELL      app/            Next.js route handlers (transport) │
│            components/     session + home UI (render only)    │
├──────────────────────────────────────────────────────────────┤
│ SERVER     src/server      thin composition, zero business    │
│            logic: chat-handler (turn composition root),       │
│            turn-service (the turn seams), stores.ts           │
│            (THE composition root), route entry points         │
├──────────────────────────────────────────────────────────────┤
│ AGENT      src/agent       the teacher + sub-agents: LLM      │
│            loops, tool surfaces, prompts. Deps arrive via     │
│            factories/closures — never imported from below     │
├──────────────────────────────────────────────────────────────┤
│ CORE       src/core        pure domain: contracts.ts (THE     │
│            schema), ports.ts, plan-tree, question-core,       │
│            graph merger + derivation, graph-context,          │
│            phases, pending, math delims. No IO, ever          │
├──────────────────────────────────────────────────────────────┤
│ STORE      src/store       fs adapters: chats · graph        │
│            ledgers · jobs. The ONLY modules that touch       │
│            data/. They implement core ports; nothing          │
│            implements them                                   │
└──────────────────────────────────────────────────────────────┘
```

**The import law** (`eslint.config.mjs`, four machine-enforced zones — a violation fails lint, and each zone was verified to fire):

| Zone | May import | Rationale |
|---|---|---|
| `components/**` | `@/src/core` only (the barrel) | The UI renders domain data; it never runs domain logic or touches IO |
| `app/**` | `@/src/core` + `@/src/server` (the barrels) | Route handlers are transport; they delegate to server entry points |
| `src/core/**` | nothing below itself (never `agent`/`server`/`store`) | The core is pure; adapters implement its ports, never the reverse |
| `src/agent/**` | never `server`/`store` | The agent layer receives its dependencies (storage ports, wiring) via factories/closures from the server |

Two rules are documentation-only by design: `src/server/stores.ts` is the only server module allowed to import adapters (the ESLint plugin's `except` can't express "all but one" cleanly), and `src/core/graph.ts` + `graph-context.ts` stay out of the core barrel so the barrel remains browser-safe (their types are barrelled via `ports.ts`/`contracts.ts`).

---

## 2. Ports, adapters, and the composition roots

Storage is **per-entity semantic ports**, never one generic interface: `ChatStore`, `GraphStore`, `JobStore` (`src/core/ports.ts` — types only). The fs adapters (`src/store/{chats,graph,jobs}.ts`) implement them and contain persistence and nothing else.

- **`src/server/stores.ts` is THE composition root for storage**: it instantiates the adapters and hands the port objects to everything else (server modules, the job runner, the extraction pipeline, agent tools). It is the single place a storage decision (JSON vs SQLite, local vs remote) gets re-made.
- **`src/server/chat-handler.ts` is THE composition root for a turn**: it wires the stores, the job runner, the teacher tools, and the turn services into the SDK stream response. All logic lives behind the seams it calls.
- The agent layer is dependency-inverted throughout: `createJobRunner({ chatStore, jobStore, deliver })` (the `deliver` seam hands steers to the wake pipeline), `createExtractionPipeline({ chatStore, graphStore, extractor?, auditor? })`, `createTeacherTools({ chatId, chatStore, jobStore, spawn })`, `createTeacherAgent(model?, tools?, graphContext?)`. Tests inject the same ports production wires.

---

## 3. The knowledge graph — two channels, one writer

**The extraction pipeline is the sole graph writer.** Nothing else appends to `data/graph/*.jsonl` — not the teacher, not the server, not a migration script.

```
chat record ──▶ EXTRACTOR (LLM) ──▶ AUDITOR (LLM) ──▶ MERGER (core, deterministic) ──▶ ledgers
                 proposes            verifies            applies
```

**Tree-blind and post-hoc** (2026-09-02 redesign, docs/vision.md §1): the extractor reads ONLY the transcript — never the session's plan tree — and proposes free-form propositions (true statements with descriptions, misconception-free: a misconception is stated as its true correction), `follows`/`supports` edges, per-proposition understanding notes, and message-granular provenance. Every node is an objective, world-facing fact; the learner's relationship to it lives entirely in the event ledger.

**Division of trust** (the pipeline's core rule): the LLM stages supply only judgment — *what was learned*, *what follows/supports what*, *which proposition each quiz tested* (retroactively, against the whole transcript), and — the auditor's — *identity*: whether a proposition IS an existing graph node (link-or-create). Everything the model could silently mis-copy — event kinds (`correct` / `miss` / `dont-know`), timestamps, idempotency refs, notes, provenance points — is rebuilt deterministically by the merger from the transcript's tool parts. The extractor files verbatim evidence quotes; the auditor (which sees the extractor's output PLUS the current graph) drops anything unbacked, logs every drop, and stamps each surviving proposition with its identity verdict (`linkTo`). Conservative throughout: duplicates over wrong merges, drop over invent.

**Merger invariants** (`src/core/graph.ts`, `mergeFindings`): idempotent and incremental — identity comes from the auditor's `linkTo` verdict alone (validated against the ledger; never string matching), one mapping line per (chat, sourceId) as the verdict audit trail (which also makes re-merging the same chat idempotent), link-appends: a linked proposition appends a node line whose phrasings join the node's `aliases` and whose provenance unions (reads merge by id), edge dedupe by `(from, to, type)`-already-asserted-by-this-chat with message-granular provenance, event dedupe by chat-scoped ref (quiz toolCallId, `obs:<sourceId>` for understanding observations), and a sessions.jsonl checkpoint (`foldedAt`) marking which turns are processed. Failure anywhere before the merger checkpoints nothing; the next trigger re-runs.

**The trigger is a v1 placeholder, isolated in ONE seam.** `src/server/turn-service.ts` (`triggerExtraction`) counts answered quizzes not yet in the ledger (`pendingQuizAnswers`, core) and fires the pipeline async once a chat crosses `EXTRACTION.everyNQuizAnswers` (default 3, config.ts) — single-flight per chat. The pipeline is trigger-agnostic: when a better mechanism lands (session end, idle, explicit flush), only this seam changes.

**The read channel is pure derivation.** `GET /api/graph` reads the ledgers (`graphSnapshot`: merged edges, derived node states, session provenance) — the home view never triggers a write. At session start, `buildGraphContext` renders the derived graph into a compact markdown block appended to the teacher's instructions (whole graph while small; diagnostic hotspots + 1-hop neighborhood past 150 nodes) — this is what makes probing precise and personalization compound. `store events, derive state`: node states are always recomputed from the ledger, never stored.

---

## 4. The session (one chat turn)

`handleChatRequest` is framework-free (plain `Request`/`Response`) so tests drive it with a scripted mock model. The turn composes:

1. **`buildTeacherContext`** — the graph read channel (self-updating, failure-contained: a read error never takes the lesson down).
2. **`persistTurn`** — the canonical state write: client + agent messages persist on every finish, including aborts (the partial transcript is what makes resume-mid-question free).
3. **Job tools are server-executed, ack-and-steer** — `research`/`demo`/`visual` calls resolve immediately mid-turn with a fire-and-forget ack (the teacher keeps teaching); `spawn(job, input)` fires the background runner. On completion the runner builds a **steer message** (a user-role `UIMessage` with a text part — the model-facing channel — and a `data-subagent-artifact` part, which provider conversion drops) and hands it to the **wake pipeline** (`src/server/jobs.ts`: per-chat serialized queue on `globalThis`, waits for turn-free + no pending quiz, fires a server-side teacher turn via the chat-handler's `setTurnRunner` adapter, 409-retry, idempotent per jobId). Job status flips done/error only after the wake turn persists. The client adopts the wake turn through the existing `turnInFlight` machinery (busy shimmer + composer gate — same as returning mid-turn) and renders the steer as an artifact, never a bubble.
4. **`triggerExtraction`** — the graph write channel (§3).

Each service is a named, error-contained seam taking explicit deps; failures log one `[chat <id>]` line and never touch the response. Swapping any of them (e.g. the trigger) touches nothing else.

**The formal plan tree**: the teacher authors the session's dependency map with schema-validated tools (`plan_init` … `plan_mark_done`); the tree persists in the chat record and the tree panel renders from the latest plan tool output — one object, two faces. **Client-side question tools** (`quiz`, `ask_user_question`) have no server execute: the call streams to the browser, the learner answers in the dock, the client grades via `question-core` and returns the verdict with `addToolOutput`, which fires the continuation.

---

## 5. Observability (minimal, by decision)

Structured-logging frameworks are deferred; the baseline is one log line per event at the seams, correlation-tagged: `[chat <id>]` on turn services, `[extraction <id>]` on the pipeline (merge stats, audit drops), `[job <id>]` on runners, `[graph]` on server graph reads. When structured logging (pino-style JSON with `{chatId, jobId, toolCallId}`) lands, it goes behind these seams — no call sites change.

---

## 6. Testing

All deterministic, no network: models are injected (`MockLanguageModelV4`), storage is the same fs adapters production wires (tests own backup-and-clear of the ledgers they touch), and pure logic gets in-memory port implementations. Four strata: pure core units; server flows driven through `handleChatRequest` with scripted models; sub-agent loops (researcher, demo-builder, visual-maker, and the extraction pipeline end-to-end — audit drops, failure-checkpoints-nothing, single-flight); and render tests via React server-side rendering. Gates on every change: `tsc` clean, all tests, `eslint` clean, `next build` clean.

---

## 7. Deliberately deferred (links)

Fuzzy/embedding merge adjudication, calibration rubric, retroactive bootstrap of the POC sessions (vision §1 consolidation); dictation, not-a-chat presentation overhaul, gated progression, spaced repetition (vision §2/§4 roadmap). SQLite or other storage swaps are drop-in behind the ports (§2). The trigger mechanism beyond the v1 quiz threshold (§3). When any of these land, this doc changes with the commit that lands them — it describes the system, not an intention.
