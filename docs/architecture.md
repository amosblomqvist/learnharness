# Architecture

LearnHarness is a Next.js application with an Electron desktop host. The server owns agent runs, conversation records, background work, and filesystem persistence; the browser projects those records into a lesson/practice UI and knowledge graph.

This reference describes the [repository source](README.md#about-these-docs). See [Development](development.md) for commands and [the teaching theory](teaching-methodology.md) for pedagogical intent.

## Code boundaries

| Area | Responsibility / starting points |
| --- | --- |
| `app/` | Pages and HTTP transport; `api/chat/route.ts`, `api/chats/` |
| `components/` | Browser state and presentation; `session-core.ts`, `chat.tsx`, `graph-view.tsx` |
| `src/server/` | Composition, admission, liveness, HTTP-facing services; `chat-handler.ts`, `jobs.ts`, `stores.ts` |
| `src/agent/` | Agent construction, tools, provider streams, workers; `teacher-agent.ts`, `models.ts`, `tools.ts`, `subagents/` |
| `src/core/` | Contracts, record/view projections, domain algorithms; `input-events.ts`, `native-messages.ts`, `view.ts`, `graph.ts` |
| `src/store/` | Filesystem adapters for chats, jobs, graph, settings, and credentials |
| `electron/` | Desktop launch, navigation/permission guards, credential transport, browser helper, updater |

[`eslint.config.mjs`](../eslint.config.mjs) restricts shell imports into `src/` to the core/server barrels, prevents core imports from IO layers, and prevents agents importing server/store adapters. Dependencies arrive through injected contexts/ports. These rules are not a proof of pure core, one composition root, or one writer per store: some core modules are Node-bound and excluded from the browser barrel; server modules can import adapters. Scripts, Electron, and tests are outside these zones.

## Conversations and turns

A **conversation** is a durable `ChatRecord` with native `LhMessage[]`, settings, optional plan, and usage logs. Missing `kind` means teaching; `practice` selects the practitioner. An **engine** is the resolved Pi model, stream function, and thinking level. An application **turn** constructs a fresh native Pi `Agent` from saved history; it can make several model calls and execute tools. It is not an HTTP connection or a single generation.

```mermaid
flowchart LR
    INPUT[Browser input] --> POST[POST /api/chat]
    POST --> SAVE[Validate and save input]
    SAVE --> RUN[Server-owned Agent run]
    RECORD[ChatRecord] --> RUN
    RUN --> ENGINE[PiEngine]
    RUN --> TOOLS[Tools and background dispatch]
    RUN --> SETTLE[Save output and usage]
    SETTLE --> RECORD
    RUN --> STREAM[Replay and live event stream]
    STREAM --> VIEW[SessionModel → projectView → UI]
```

[`chat-handler.ts`](../src/server/chat-handler.ts) resolves readiness, waits for compaction, re-reads durable truth, and claims per-chat liveness. A competing turn gets **409**. Accepted input is saved before inference; subscription automatic inputs can instead remain staged until dispatch admission. The HTTP response acknowledges admission, while `GET /api/chats/:id/stream` carries replay/live events and a terminal state.

The stored record has two projections:

- [`toLlmMessages`](../src/core/native-messages.ts) strips app metadata, flattens model-facing markers, applies the active compaction cut, and repairs eligible interrupted tool pairs at the provider boundary.
- [`projectView`](../src/core/view.ts) derives UI messages, question/problem docks, and artifacts. It is not the stored format or provider wire.

Pi seeds the system prompt/tools at construction; that synthetic system message is not persisted. New turns therefore get current instructions. The app does not use the AI SDK's client-transcript replacement or `addToolOutput` loop.

Settlement persists new native messages, plan snapshots, and usage, including partial output on abort. Failed input writes refuse inference; failed reply writes are surfaced before the terminal and do not masquerade as successful empty turns. Cleanup releases liveness. A memory-only failure notice can inform reattaching views without fabricating saved transcript content.

### Streaming and recovery

[`pi/ui-stream.ts`](../src/server/pi/ui-stream.ts) emits native agent events. Partial-message updates replace a slot; they are not accumulated text deltas. Replay retains settled events and the latest in-flight updates, with coalesced live fan-out. Tool IDs are uniquified against history so persistence, answer routing, and provider context agree.

Disconnecting a browser detaches a view, not the agent. Explicit abort is separate. [`session-core.ts`](../components/session-core.ts) owns reattachment, bounded 409 recovery, and adoption of canonical state. One recovery attachment is allowed after premature EOF/read failure; repeated transport failure shows an error.

Question drafts survive optimistic unmount in memory. Uncertain submissions reconcile the saved record and running state before resending, scoped to the same question occurrence. Provider-response retry is explicit: it preserves failed attempts on disk while omitting the eligible failed tail from temporary model context. It is not mount-time replay or automatic retry of arbitrary failures.

### Side questions

Each explanation and its associated question share one durable side conversation in teaching and practice sessions. A quiet speech-bubble entry in message history or **Ask** on selected text opens that conversation in a movable floating window, with an optional side dock ([`side-thread.tsx`](../components/side-thread.tsx), [`use-side-thread.ts`](../components/use-side-thread.ts)). Closing only hides it; saved exchanges remain reopenable. The companion never silently changes conversations as the session advances; **Go to current step →** optionally opens that step's separate history, preserving docking and per-thread drafts. Older conversations remain usable and receive the latest visible lesson on each request. Pin/Unpin switches between floating and docked presentation. Both use the theme background: opaque when docked, 50% opaque with 18px backdrop blur when floating. The input uses the main composer's opaque card surface. All four edges and all four corners resize the floating panel; opposite edges stay anchored, with the default 416px width as the preferred minimum and smaller viewports taking precedence. Chosen dimensions survive conversation switches while floating; the dock keeps its existing width. The floating panel clears only the macOS traffic-light corner, sharing the native gutter dimensions and zoom truth; ordinary browser placement is unchanged. Learner messages are right-aligned bubbles capped at 70% width; helper replies remain unboxed. The inline microphone uses the existing recorder with an explicit side-draft destination: the shortcut follows side-composer focus, a recording keeps its starting destination, and closing finishes it into that saved draft. Three compact bars sample the recorder's existing RMS signal locally while recording; they do not animate in silence or rerender the main chat. Enter on side controls stays inside the companion, including while docked. Main dictation retains its separate input claim and main submission never waits for side recording. Selected passages retain their original native message and exact-text selector as canonical citation metadata, independently of the thread's segment head. **Cite** is separate: it inserts an atomic quotation chip into the last-focused main composer or thinking field, and expands that quotation when the input is sent to the model.

A side answer is **not an application turn**. [`server/side-chat.ts`](../src/server/side-chat.ts) owns one tool-less streamed call per conversation on the session's selected model, with model/key readiness checks but no main-turn liveness, so a check, active problem, or running main turn does not block it. The helper receives a text reconstruction of the learner-visible lesson as a quoted document, not internal tool traffic or a compaction summary ([`core/side-chat.ts`](../src/core/side-chat.ts)). Open checks and active problems omit answer keys, explanations and committed solutions; question options use the learner's deterministic shuffled order. The helper receives its own thread once, separately from the lesson. Its fixed side-only brevity fragment follows the shared voice/accuracy/formatting appendix, favoring the smallest useful answer—normally one or two short sentences—rather than a mini-lesson. Closing detaches the view; Stop keeps the partial reply. Accepted usage is recorded in `turns` under the side answer's id. Changes announce on `side-chats-changed`; routes live under `app/api/chats/[id]/side-chats/`.

`ChatRecord.sideChats` holds live UI history. At main-turn start and before each subsequent internal model call, the server gathers new raw exchanges from **all** conversations, including older steps, and appends attributed custom `side-question` entries without changing earlier native history. Internal updates use the SDK's next-turn preparation hook, with normal message lifecycle events after tool results. The first call and admission-recovery calls get fresh cargo through the SDK's initial steering poll. Neither path interrupts an active call or schedules an extra teacher response. They persist with that running turn, using its existing settlement/failure contract. Live replies contribute only their currently available text; a later request appends the remaining suffix and terminal status, never the already-recorded prefix. Non-prefix corrections are explicitly attributed as updated wording rather than silently replacing earlier text. Delivery watermarks live inside the same immutable native entries, so input and delivery commit atomically, survive restart and compaction, and a failed write cannot consume exchanges. An interrupted ephemeral run is reported once if its published partial has no surviving reply. Idle/parked dismissal still records current activity after native question results; sibling questions defer delivery until all results are adjacent. Main requests never wait for a helper, and helper settlement never writes main-context entries on its own. Native model projection renders updates as user-role reference, not tutor replies; the shared fragment explains provenance and continuations. Updates are available to teacher/practice context and compaction, but not treated as new learner submissions by extraction or continuation logic. Chat-record version 2 separates this contract from older applications; legacy development snapshot entries remain unchanged and seed the new delivery ledger.

## Teaching and practice

[`teacher-agent.ts`](../src/agent/teacher-agent.ts) and the [tool registry](../src/agent/tools.ts) compose different agents over the same teaching history:

| Agent | Interaction | Other tools |
| --- | --- | --- |
| Prober | `probe` or `recall`, `ask_user_question`, `probe_done` | Read-only files, research/PDF dispatch; gated graph readers |
| Teacher | `quiz` or `explain`, `ask_user_question`, `plan_init` | Read-only files, research/PDF/demo/visual dispatch; `show_image` |
| Practitioner | `problem`, `conclude` | Read-only files, research/PDF dispatch; gated graph readers |

Mechanic choices, settings toggles, and readiness affect availability. Practice side tools are composed separately from teaching toggles. Claude-family agents can receive `send_to_user`. Argument healing precedes semantic validation; invalid calls return errors the model can correct.

Question tools validate and execute server-side, returning a synthetic terminating placeholder. It stops a clean question pose, including mixed tool batches, but is not saved. The actual learner answer becomes the call's result later. The browser shuffles options and grades select questions; free recall exposes the committed answer for model judgment. Sibling pending questions are answered without inference until the last is resolved.

A matching successful `probe_done` result selects the teacher and queues a fresh-agent handoff. A bare/refused call does not. Planning begins at that seam; displayed teaching begins at the first node-tagged `quiz`/`explain`, not `plan_init`. The plan is a validated Mermaid DAG, replaceable through `plan_init`. Current/visited positions derive from tagged calls, not grades. Waiting for the learner's natural reply to the plan is prompt doctrine, not an acceptance transaction.

Practice uses the same turn/persistence/recovery path, not a separate problem-set service. [`tools/practice.ts`](../src/agent/tools/practice.ts) commits a statement and solution with `problem`; `conclude` records the outcome and reveals that solution. A turn-scoped gate enforces one active problem. The post-conclusion pause is doctrine, not a terminating `conclude` result. Next adds an explicit marker. Practice outcomes are session evidence, not graph mastery; ordinary practice settlement skips extraction.

[Prompt composition](../src/agent/prompts/README.md) and [tool-content display recovery](tool-content-recovery.md) have separate references.

## Background work

Research, PDF, demo, and visual tools persist jobs, acknowledge dispatch, and start independent workers through [`subagents/runner.ts`](../src/agent/subagents/runner.ts). Demos are checked using the browser helper; visuals use render-and-inspect loops. PDF/SVG rendering is native; demo execution uses Electron's browser service with system Chrome fallback.

Worker completion and session delivery are separate. The worker saves its outcome and pending-delivery metadata before queueing a marker. [`server/jobs.ts`](../src/server/jobs.ts) delivers by steering a live agent at a native boundary or waking an idle, eligible session. Pending questions, pause, consent, or admission races can hold delivery. Only computing workers are abortable.

A marker in the **saved conversation** acknowledges delivery—not HTTP acceptance or visibility in a stream. Reconciliation avoids replaying saved results; restart recovery restores known pending obligations and can respawn unfinished workers. Legacy terminal jobs without delivery metadata are not guessed into replay. Deleting a session discards its obligations.

This is single-process coordination over JSON files, not a transactional queue or exactly-once provider execution. In-memory composer steers do not have the same durability as job delivery.

### Learner-image snapshots

`show_image` displays a local raster picture; `visual` with an image path annotates it. Both use the file-access policy and shared processing: input bounds of 25 MiB, 16 megapixels, and 8192px per side; off-thread orientation/metadata cleanup; stored PNG/JPEG bounded to 1600px per side and below 1 MiB of base64.

[`learner-image.ts`](../src/agent/tools/learner-image.ts) stores processed bytes under SHA-256 identities in `ChatRecord.imageSnapshots`, deduplicated per session. Cards and annotation SVGs reference snapshots, so moving the original does not break saved results. Session-scoped image reads resolve references; SVG downloads embed their image. The annotator edits a placeholder href, not base64, and uses static native rendering. Ordinary visual SVGs retain their existing behavior. Offline regression tests exercise snapshot storage, display, and payload delivery, not model-driven annotation quality.

## Knowledge graph and imports

The graph records objective propositions and jointly-entailing reasoning chains, not learner understanding levels. Construction is post-hoc and independent of the lesson plan:

```mermaid
flowchart LR
    SOURCE[Teacher prose or imported notes] --> EXTRACT[Extractor]
    EXTRACT --> AUDIT[Identity auditor]
    AUDIT --> MERGE[Deterministic merge and simplification]
    MERGE --> LEDGERS[Graph and coverage ledgers]
    LEDGERS --> VIEW[Canvas and chains view]
```

[`coverage.ts`](../src/core/coverage.ts) fingerprints teacher prose, including successful `send_to_user` text, by actual message ID. Learner text, thinking, questions, other tool results, and markers do not count. Automatic extraction is gated by `graph.enabled` and an uncovered-token threshold (default **4096**, minimum **500**). Rendering is a separate switch. Manual extraction/import routes do not themselves check the automatic-extraction switch.

The pipeline batches oldest uncovered messages without splitting one message. Trigger and batch budgets are distinct: current app wiring does not inject the configurable trigger value as the batch budget. Each source's batches run serially; cross-source work can overlap under a background-LLM semaphore. A process-wide FIFO lock serializes audit through merge. These registries survive module entries through `globalThis`, not separate server processes.

The [extractor](../src/agent/subagents/extraction.ts) reads source text and proposes anchored propositions/chains. The auditor sees propositions and the current graph, not source passages or chains, and submits identity links. The deterministic merger resolves identities/endpoints, unions provenance, deduplicates arguments, simplifies redundant chains, and checkpoints coverage after graph writes. Failed stages leave material uncovered; completed chunks and usage survive later failure/abort. Ordered ledger operations are not an atomic multi-file transaction.

### Notes and source organization

`POST /api/graph/import` feeds text or locally converted PDF Markdown into the same pipeline, without chat-message anchors. The [import UI](../components/notes-import.tsx) queues one request per supported file, up to three in flight. Files are capped at 25 MiB; server aggregate file bytes per request are also capped at 25 MiB, with a 26 MiB multipart/proxy bound. PDF conversion has no OCR; skipped image-only pages and scanner caveats are reported.

Source identity hashes the original path/name; safe folder-relative paths can be supplied alongside matching filenames. Renaming or reorganizing a displayed source does not change its identity. Every explicit import processes the whole file, even unchanged text; retry is not exactly-once processing. Same-source overlap is refused as busy. Per-file outcomes distinguish completed, partial, failed, aborted, and busy; zero findings can still be a completed import.

`graph/source-organization.json` holds display overrides and folder placement, not original file contents. Folder imports reconstruct directories containing supported files. Organization is separate from session-sidebar placement. Both the chains browser and practice’s node picker hide practice-session source rows; this is a read projection, not deletion of conversations, graph contributions or placements. Folder selection excludes those hidden sources. Empty source names are muted in place, using full contents rather than search-filtered counts. Ordinary chains-view selection selects sources/folders, including descendants hidden by search; practice can select finer-grained graph material.

Deleting sources removes their graph contributions while preserving knowledge supported elsewhere. Deleting conversations too is an explicit, unchecked-by-default option. Extraction/live-work preflights prevent conflicting deletion; filesystem failures can leave reported partial progress. Source organization uses validated operation-based updates. These guarantees are not a transaction across all graph/session files.

### Read model and other writers

[`graphSnapshot`](../src/core/graph.ts) derives the presentation without starting extraction. Single-premise arguments draw direct arrows; joint premises produce geometry junctions, not extra stored propositions. Clusters derive from birth-source provenance, not embeddings, Louvain, or LLM naming. Layout/render settings are server-persisted; camera state is device-local.

Prober/practice graph tools require both graph and graph-tool switches; the teacher has no graph-reader registry. Explicit graph selections at session creation are a separate context path, not automatic semantic top-K injection.

Extraction is the construction writer, not the only mutation: source/session/node deletion, simplification, and position commits also write graph files. Deleting a proposition removes chains using it; preserving graph on session deletion retains provenance while removing extraction bookkeeping.

## Storage and notifications

[`config.ts`](../config.ts) anchors immutable prompt assets to the application root and mutable state to `LH_DATA_DIR` (default repo `data/`). Storage ports are semantic interfaces in [`ports.ts`](../src/core/ports.ts).

| Data | Files |
| --- | --- |
| Conversations, plans, usage, image snapshots, side questions | `chats/*.json` |
| Worker computation and delivery obligations | `jobs/*.json` |
| Propositions, chains, checkpoints, coverage | `graph/{nodes,chains,sessions,coverage}.jsonl` |
| Sources, organization, positions, render preferences | JSON maps under `graph/` |
| Preferences and prompt overrides | `settings.json`, `prompts/` |
| Keys and custom-endpoint binding | Separate `auth.json`, selected by `LH_AUTH_FILE` |

Adapters use synchronous filesystem operations. JSONL reads skip corrupt/invalid lines; graph derivation merges repeated assertions. Some replacements use temp-file rename, but ordinary whole-file writes are not database transactions. Same-event-loop serialization is not cross-process locking or crash atomicity. Use **one server owner per data/auth profile**.

Chats and graph-family files have separate version guards; absent stamps read as v1, and newer versions are refused. Positions are rebuildable and unstamped. Settings have their own version/sanitization policy. Format counters are not app versions. Golden fixtures exercise compatibility. Graph-store initialization removes retired ledgers, so importing stores is not a universally read-only inspection method.

`/api/chats/:id/stream` is a turn/view stream. `/api/events` is a separate window-level notification stream: an ephemeral, process-local signal to fetch canonical data. [`SERVER_EVENT_TYPES`](../src/core/events.ts) is the event vocabulary. Consumers debounce and refetch on reconnect; notifications have no durable replay. A live turn's terminal controls settlement adoption so a notification fetch does not overwrite partial state. Settlement signals the end of work, not proof of a successful disk write.

## Host and providers

Packaged Electron launches a private standalone Next child on loopback, sets data/auth paths, and loads a sandboxed renderer. Its navigation/permission and credential transport guards are desktop boundaries, not web multi-user authentication. [Desktop releases](desktop-release.md) covers tracing/packaging checks.

[`models.ts`](../src/agent/models.ts) composes Pi providers and app bridges. Strong/Cheap/Vision slots have no factory model pins. Sessions retain explicit choices; background roles resolve independently. Missing configuration/readiness refuses rather than silently choosing another provider.

API environment values override saved keys. Packaged subscription refresh credentials stay in Electron main; web/dev uses server-owned connection files. Subscription routes do not fall back to API billing. [Claude Code](claude-code.md) retains native CLI authentication/routing but bridges LearnHarness tools; [custom endpoints](custom-providers.md) bind authorization to URL/mode and resolve settings per operation. Neither route has inferred zero-dollar pricing. [Accounting](compaction-accounting.md) owns context/cache/cost semantics.

### File access and external services

Read-only file tools default to the server user's home, not a selected project or app data root. Walk exclusions reduce noise; they are not access authority. Session attachments carry local paths rather than uploads.

The **sensitive-path guard** refuses known private home locations, `.env` files, configured auth/subscription files, and recognized credential temporary files. It checks named/canonical paths and aliases; walks skip protected locations. It is path-based defense in depth, not a content scanner, sandbox, or allowed-folders setting. Other sensitive files and learning records can remain readable. See [`fs-shared.ts`](../src/agent/tools/fs-shared.ts).

File/PDF/visual images share image postprocessing. Search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama adapters; page fetching is independent and does not need a search key. Dictation mints short-lived tokens server-side and streams audio browser → Deepgram. These external effects are not isolated by a scratch data directory alone.

## Verification starting points

Tests use injected engines/ports, fake transports, and renderer seams. Start with `chat-flow`, `session-core`, `turn-recovery`, `job-delivery-recovery`, `extraction`, `notes-import-route`, `practice-flow`, `prompt-overrides`, and `golden-fixtures` under `tests/`. Fixture checks establish their exercised contracts, not live account entitlements, teaching quality, or cross-process durability. Commands and runtime prerequisites belong in [Development](development.md#checks).
