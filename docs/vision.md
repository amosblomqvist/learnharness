# Learning Harness — Vision & Plans

> **Historical design record, not current implementation documentation.**
> The original decisions and plans below may be superseded or unimplemented.
> See [Architecture](architecture.md) and [Development](development.md) for the
> shipped system and current development guidance.

Living document. Started 2026-08-22, capturing the current vision and all agreed decisions. Amend as things evolve.

Master frame: the three-part learning model and the extensibility/plugin direction live in [`vision-extensibility.md`](vision-extensibility.md) (2026-10-02).

Prior art: `knowledge graph design.md` in the Obsidian vault (2025-08-20 ideation) — was canonical for the epistemic model; the 2026-09-02 node-theory + construction redesign in §1 amends it further (no misconception nodes, `follows`/`supports`, no taught events, message-granular provenance). This document records what today's decisions **amend** in it, and adds the session-experience and presentation layers the original doc deferred.

---

## 1. The knowledge graph — the centerpiece

Everything the learner learns accumulates into one persistent, cross-domain graph. It is the home page of the app and the heart of the system: structure builds out visibly over time, and the data supports frontier expansion, what-next queries, repairs, unlock-value (per the original design doc).

**Node theory + construction redesigned 2026-09-02** — the subsections below from "What the graph is" through "Understanding is derived" are the current philosophy, superseding both the original design doc's epistemic model in part and the 2026-08-22 live-emission construction decision (see the amendments table).

### Critical requirement: frequent updates

The graph updates **continuously, not per-session**. A learner who answers a few questions and leaves without "finishing" a session must still see something new on the home page. Partial sessions deposit value. The background extraction pipeline's checkpoint mechanism satisfies this (fold on home/idle, never the same turns twice) — not live emission.

### What the graph is — node theory (DECIDED 2026-09-02)

The global graph is an **objective world-model of the domains the learner has encountered**: the facts, their structure (what follows from / is supported by what), and — inferred from that structure plus the event ledger — the state of the learner's understanding. Nothing learner- or session-relative is ever stored **in** the graph; understanding is **inferred, never encoded**.

- **Every node is a true proposition.** Worded objectively, in minimal form as it exists w.r.t. its context. Truth is context-relative and that is fine: "Gravity is a force" and "Gravity is not a force" coexist as nodes — each true in its context (classical mechanics vs. GR), with **the surrounding subgraph as the context**. No context field, no pedantic self-containment of facts.
- **Node schema:** `name` — a very short label for the node, a compact handle like a glossary headword (“Will to power”, “Divine command theory”): what the graph shows at a glance. Presentational only — not unique, not an identity key, never precise. Set at creation; a re-encounter never changes it. `statement` — the proposition at full precision (the identity anchor; shown in the detail card). `aliases` — the verbatim phrasings sessions used (merge keys + audit trail). There is **no `kind`** and **no `description`** (2026-09-08 amendment: with real data, full-sentence canvas labels proved unworkable — ten-line labels, illegible overprint. The label is the name; the precision lives one interaction away in the statement).
- **Misconceptions are not a node category.** A myth enters the graph as its true correction ("The 10%-of-brain claim is a myth"); the learner's holding of the wrong idea lives entirely in the event ledger. Wrongness is about the learner, and the learner lives in the ledger.

### Edges (DECIDED 2026-09-02)

Two kinds, no scalars, no encoded strength — prerequisiteness is a spectrum, and we deliberately refuse to formalize the spectrum:

- **`follows`** — `A → B`: B is *derivable* from A (A is a premise of B). If C follows from both A and B, both `A → C` and `B → C` exist; joint requirements are just sibling edges.
- **`supports`** — `A → B`: A *grounds or justifies* B without entailing it.

Strength/depth of dependencies is **derived at read time** from topology (chains, corroboration), never stored — this is the input the future understanding model consumes.

### Provenance — message granularity (DECIDED 2026-09-02)

Every node records every **(chat, message) point** where it came up; every edge records every message that asserted it. Deep-linkable to the exact transcript points — the derivation audit trail is a first-class feature, not a byproduct.

### Construction: free-form extraction, fully decoupled from sessions (DECIDED 2026-09-02 — supersedes live emission)

*Coverage settled 2026-09-15 — see `vision-extraction-coverage.md`: the message is the unit of coverage (a covered-fingerprint ledger per chat), runs are token-budgeted batches of the oldest uncovered messages, and the trigger is uncovered tokens ≥ a chunk budget (replacing everyNQuizAnswers — quiz-less sessions extract too).*

**Second amendment, reversing the 2026-08-22 live-emission decision.** The session's plan tree is the teacher's scaffolding for the session experience (§2); the global graph does not depend on it — structurally or otherwise. What the teacher formalizes is session-relative; the graph must not inherit those choices. (The original design doc's post-hoc stance was right after all.)

Three stages, one pipeline — the sole graph writer:

- **Extractor (LLM) — single-source scope.** Sees ONLY the source text — a session transcript (tree-blind, with message ids) or raw notes (the front door's second prompt, above). Reports freely, with verbatim evidence: propositions from anywhere in the session (one reasoning step each; prose counts as much as anything the teacher formalized), edges as the transcript articulates them, message-granular provenance, retroactive quiz attribution, and per proposition an **understanding level** — how strongly the learner accepted/understood it in this session, a CLOSED named-word scale (`solid` / `shaky` / `accepted` / `resisted` / `not yet engaged`; 2026-09-08: schema-enforced — exactly one word, no numbers, no justifications, which are dropped rather than stored). The levels are data for the future state model; their treatment is TBD.
- **Auditor (LLM) — the global-graph scope.** Sees the extractor's output AND the existing graph. Two jobs: the faithfulness net (every candidate verified against verbatim evidence — unchanged), and the **identity judgment**: link each proposition to an existing node (recording the session's phrasing as an alias) or create it new. Conservative: duplicates over wrong merges.
- **Merger (deterministic).** Append-only ledger writes; quiz event kinds/refs rebuilt mechanically from quiz tool parts. Every judgment is an LLM's; everything mechanical stays code.

**Event ledger (amended):** quiz outcomes are rebuilt deterministically from quiz tool parts (correct / miss / don't-know, plus the learner's note). **There is no `taught` event** — no marking-things-done. The extractor's per-proposition understanding levels join the ledger as session-scoped observations (one closed-scale word per node per session). Identity is no longer exact-string matching — it is the auditor's judgment, with aliases as the phrasing record.

### The format-agnostic front door — notes imports (DECIDED 2026-09-13)

The same three-stage pipeline (extractor → auditor → merger) runs over **raw
personal notes in arbitrary formats** — an Obsidian vault, plain markdown,
anything textual. The extractor is format-blind by construction (it always
saw rendered text, never ChatRecord JSON), so the notes path needs only a
second extractor prompt (general-purpose extraction; the understanding word
judges the **author's** grasp from their own commentary) and a source
abstraction: each imported file becomes a `NotesSource` record (deterministic
id from the path hash — re-imports are idempotent), playing the `chatId` role
in mappings, checkpoints, and observation events.

Decided edges:

- **No session shaping.** Notes are never bent into teacher/learner
  transcripts; quiz outcomes inside notes surface only via the extractor's
  understanding observations (the deterministic quiz-event rebuild is a
  session-pipeline feature — it needs structured quiz tool parts).
- **Static provenance.** Imported nodes show the file path in the sessions
  list as a static entry — never a link. Understanding-assessment levels
  apply to personal notes as to sessions.
- **Same single-flight registry and observability** as session runs: live
  status, usage accounting per stage, true abort. One pipeline instance,
  two front doors (quiz-triggered sessions; POST /api/graph/import).

### Understanding is derived (amended 2026-09-02)

Known vs. understood, event ledger as source of truth, derived state recomputed on read — carried over from the design doc in spirit. The state model itself is now an explicit design discussion: **node states should be session-independent and computed from the depth and strength of dependencies** (the `follows`/`supports` topology) plus quiz events and understanding notes. That redesign is pending ideation; the transitional five-class derivation (taught / known / missed / don't-know / candidate) was **removed** (2026-09-08) — the graph view renders state-neutral nodes until the state model is designed. The anchored calibration rubric stays parked until real data.

### Clusters — regions of the world model (DECIDED 2026-09-13, ideation)

When the graph fills up, the canvas needs a readable at-a-glance structure: **clusters** — objective regions of the world model (domains like "Lacanian psychoanalysis" or "photosynthesis"), discovered by **community detection** on the `follows`/`supports` edges. A community = nodes linked to each other far more than to the rest (modularity). Everything about them is **entirely inferred from the graph data** — the extraction/audit pipeline never knows clusters exist.

- **Algorithm: Louvain (modularity maximization), seeded for determinism.** In-stack via graphology's ecosystem, near-linear, scales far beyond our sizes. Determinism gives reproducibility (same graph → same clusters); the seed/graphology choice also keeps the upgrade path open: Louvain's dendrogram contains **hierarchy** — "math ⊃ differential calculus ⊃ chain rule" is one level down — deliberately NOT built now (multi-scale clusters stay parked). Dismissed: Leiden (better resolution guarantees, no JS port), Infomap (heuristic-strong, heavier, weaker JS support), Girvan–Newman (O(n³)), label propagation (unstable), spectral (needs k handed in).
- **Structure, not layout.** Clusters are a pure function of the *edges*, never of the visual layout. The force-directed layout already places structurally-close nodes together, so cluster hulls will look contiguous — but cluster identity must not inherit the layout's seed dependence and drift.
- **Derived, cached, auto-updated.** Clusters recompute when the ledger changes, cached against a graph version stamp — same doctrine as states and strengths: derived never stored, nothing hand-maintained.
- **Size-gated meaning.** Only communities ≥ ~3 nodes render as clusters (threshold tunable on real data) — a visible blob always means "a real domain"; lone nodes and tiny communities stay plain.
- **Naming: one cheap LLM call per new/changed cluster** — a single call (no agent loop) with the members' names + statements, producing a short domain label. Never part of extraction; a separate, cached seam.
- **Labeling persistence — the core-survival rule.** Each labeling record (append-only, like everything we persist) stores the label AND the member set it was produced with (the **core**). A recomputed community **keeps** its label while ≥ half its members are from that core; when under half are, it **relabels** with all current nodes (a new record is appended — old records stay as history: an audit trail of how the domains were named over time). Single successor: on splits/merges the strongest-overlap community inherits, the others get fresh labelings; a core with no ≥50% successor simply has no living heir. Cluster color keys to the labeling record — color survives exactly as long as the label does.
- **Rendering: glow blobs behind everything.** A dashed boundary encloses the cluster's hull; the fill is blurred, low-opacity, and sits *behind* the whole graph (edges and nodes float above it, so the blur naturally fogs the inter-cluster space). Per-cluster stable hue. **Cluster labels are inverse-gated** against the existing camera-ratio span: zoomed out = **domain view** (cluster labels on, node labels off), zoomed in = **proposition view** (node labels on, cluster labels faded) — one symmetric transition between the two views of one canvas.
- **Boundary geometry: computed at draw time, never stored** — a pure function of the member positions. This is the constraint that keeps future physics/moving nodes (likely not implemented soon) from invalidating anything: convex hull + padding + rounded corners is cheap per-frame; organic metaball hulls are the same family. Secondary until then.
- **Inter-cluster edges stay visible.** Bridges between domains are meaningful (Nietzsche's will-to-power *follows* Schopenhauer's will) — one of the most informative reads of the clustered view, not clutter.
- **Honest risk: sparsity.** Community detection wants density contrast, and the current real graph is thin — the 2k-node synthetic benchmark (open question 1) is the *primary* validation of clustering quality, not just of layout/render speed.

### Rendering (DECIDED — research report 2026-08-22)

**Render settings (2026-09-13):** four basic controls in the graph view — node size, edge width, arrowhead length, and **the zoom-level control** (the label-visibility threshold; 1× = fit zoom) — persisted per browser. The zoom control is deliberately THE single zoom knob: cluster labels gate inversely on it over the same fade span (implemented: node labels fade out over the span as cluster labels fade in — they never coexist). Settings changes rebuild only the renderer: layout positions and the camera never move. (Edge-length / spacing controls deliberately parked until a cluster-aware spacing design exists.)

- **Library: sigma.js v3 + graphology + graphology-layout-forceatlas2.** ~40 KB gzipped all-in — half of vis-network, a third of cytoscape, far below react-force-graph (~250 KB deps) and cosmos.gl (luma.gl stack).
- **Layout: synchronous run-then-freeze.** `forceAtlas2.assign(graph, { iterations: 100, settings: inferSettings(graph) })` runs once, writes x/y, and no animation loop ever starts — near-zero idle CPU (sigma only redraws on camera/graph events). <150 ms at hundreds of nodes; at ~2k enable `barnesHutOptimize`, then the bundled Web Worker, then server-cached positions — in that order, only if latency bites.
- **Labels at zoom:** sigma's `labelRenderedSizeThreshold` replicates Obsidian's "text fade threshold" exactly.
- **Pan/zoom** built in; hover/click events (`enterNode`, `clickNode`) free. Typed edges: `EdgeArrowProgram` and/or two edge colors for `follows` vs `supports`.
- **React integration:** thin ~40-line `useEffect` wrapper (sigma is imperative; `@react-sigma/core` exists but is optional).
- **Obsidian internals (confirmed by research):** PixiJS **WebGL** renderer (canvas fallback), custom d3-force-style simulation (its four force sliders map 1:1 onto d3-force primitives), zoom-gated label fade, alpha-decay settling. Our chosen stack reproduces that feel with a documented, maintained library.
- Rejected: vis-network / cytoscape.js (Canvas 2D, 3× bundle, editing features we don't need), react-force-graph-2d (best freeze API but heaviest dep tree; its strength is *animated* simulation, which we explicitly don't want), cosmos.gl (GPU forces — overkill below ~10k nodes).
- Pre-implementation validation (cheap): 2k-node synthetic benchmark to confirm layout time + render smoothness before committing.
- Physics is for **placement only** — no dragging, no sliders, no editing interactions. Pan + zoom only.

### The graph as session context (DECIDED 2026-08-22)

*Selection problem V1 settled 2026-09-14 — see `vision-context-injection.md`: semantic-closeness top-K under a per-session token budget, delivered as a steer. The structural-neighborhood and diagnostic-hotspot strategies below stay parked.*

Every session starts with the learner's knowledge graph as base context for the teacher. This is what makes probing *precise* — probe questions can target subtleties and nuances at the boundary of what the learner actually holds, instead of re-discovering it from scratch each session. Personalization compounds across sessions.

**The selection problem (open):** the whole graph may eventually be too much context, and pedagogical relevance ≠ semantic closeness. What matters for a new topic: (a) its **structural neighborhood** — the `follows`-edge subtree the topic stands on, regardless of surface similarity; (b) **diagnostic hotspots** — nodes the ledger marks as shaky / misunderstood / misconceived, anywhere in the graph (a live misconception — events showing the learner holds a node wrong — is always relevant context); (c) the frontier strip near the topic. Candidate strategies, to tune on real data: whole graph while it's small; k-hop structural neighborhood around the topic's nodes; ledger-informed slices (weak/misconceived/floating first); a cheap routing pass that picks subtrees given the session topic.

### Home page

The graph view replaces the current placeholder. v1: all nodes from all sessions, pan/zoom, labels at zoom, state-neutral nodes (see "Understanding is derived"), and — once implemented — cluster glow-blobs with dashed hulls behind the graph, domain↔proposition as the two zoom-gated views (see "Clusters"). Clicking a node → the exact (session, message) points where it came up (message-granular provenance, deep-linked). Everything richer (frontier glow, rot map, blast radius) comes after the state model exists.

---

## 2. The session experience — not a generic chat

Goal: a learning session must look and feel structurally different from a ChatGPT/Claude conversation. The differentiator is making the session's **dependency tree a formal, visible, agent-editable object** rather than a throwaway mermaid sketch.

### The formal plan tree (DECIDED)

- The agent authors the tree via **structured tools** — `add_node`, `add_edge`, `reparent`, `remove_node`, `set_current`, … — schema-validated, with stable node identity across edits. Mermaid text as the source of truth was rejected: edits would be text surgery and identity would drift.
- The agent may edit the tree mid-session at its own initiative (detour when the learner asks something worth exploring, go deeper, prune) — that power is explicit.
- The tree is **session scaffolding only**: the global graph is built by free-form post-hoc extraction that is deliberately tree-blind (§1, construction). Nothing structural rides from the tree into the graph.
- **"Where we are"** is tracked as structured state (a `set_current` tool), not inferred from the transcript.
- **Mermaid survives only for ad-hoc lesson diagrams** (flows, cycles, comparisons) that are not the plan tree — and the teacher is explicitly **encouraged to diagram freely in explanations**; diagrams are first-class teaching output, not decoration. Its rendering quality must improve (integrated display, working zoom/pan — current code-block-ish rendering is unacceptable), but it's now a peripheral concern.

### Two phases, clearly separated (DECIDED)

- **Probe** and **teach** are the two real phases; planning is not a phase, just a moment (maybe a small indicator).
- The agent signals the probe→teach transition with a structured marker → **visible divider in the transcript**.
- **Probe-phase questions auto-open** (as now — they are the substance of probing).
- **Teaching-phase check questions start collapsed** behind a "Check your understanding" reveal button. Rationale: a question popping up mid-lesson pressures the learner to answer immediately; the learner should read the teaching first and open the check when ready.

### Interactive demos — teacher-authored artifacts (DECIDED direction)

The most general and capable demo runtime is the one we already ship: **the web platform itself.**

- **One format: a self-contained single-file HTML/JS document**, produced by a `demo` tool (client-side, like quiz/ask) and rendered inline in the transcript in a **sandboxed iframe** (`sandbox="allow-scripts"`, no same-origin → no access to app storage/cookies/DOM). Vanilla JS + Canvas 2D + SVG covers the overwhelming majority of teaching demos (function plots, simulations, animations, parameter sweeps); CDN imports allowed for heavier lifting (generality wins — it's the learner's own machine and the teacher wrote the code).
- **The contract matters more than the tech:** (a) a tiny auto-injected bridge script — ResizeObserver → postMessage → parent sizes the iframe; (b) `window.onerror` capture posted to the parent → error chip on the demo → learner (or auto-flow) sends the error back to the teacher, which fixes and re-issues the demo. The fix loop is where Artifacts-quality emerges. (c) Re-calling the tool = a new version of the artifact.
- **Persistence is free:** the HTML lives in the message's tool part, so demos re-render on session reload.
- **Python: deferred.** Pyodide (WASM CPython; numpy works; matplotlib renders static figures) is the only no-server path — heavy (10–20 MB lazy download) and poor at interactivity (static-image-oriented re-rendering). Revisit when a session genuinely wants numpy-grade computation. **Server-side Python: rejected** (sandbox infrastructure, portability).
- The system prompt should push demos the way it pushes diagrams: *if the concept is dynamic — a parameter to sweep, a process to animate, a distribution to sample — build the instrument, don't describe it.*

### Notes, thinking out loud, and dictation (DECIDED direction; build later)

The note field is not an auxiliary input — it's the channel where the learner **reasons out loud**. The lesson should evolve from it: the teacher is prompted to elicit yapping ("talk me through your reasoning"), to reference the learner's own words later, and notes feed the graph as diagnostic events (per the design doc: notes are calibration gold). Notes get more prominent treatment in the UI.

**Dictation is a requirement, not a luxury** — yapping means talking, not typing. What it requires on the web:
1. **Capture:** `getUserMedia` + AudioWorklet → 16 kHz linear16 PCM (browser-native; replaces the pi extension's sox/`rec`).
2. **Transport + transcription:** the pi `dictate` extension's proven recipe ports directly — Deepgram streaming (`nova-3`, `smart_format`, `punctuate`, `endpointing=300`), per-utterance finals. Architecture: a server route mints a **short-lived Deepgram token**, the browser connects to Deepgram's WSS directly (API key never touches the client). On-device whisper (transformers.js/WebGPU) is the private/offline alternative — deferred unless Deepgram disappoints.
3. **UX:** mic button in the composer blob; live level meter (AnalyserNode — the pi extension's responsive visuals rebuilt for web); transcript lands in the textarea/field, editable before send; Escape cancels; **a finished dictation is never lost** (carried over from the pi extension's hard-won UX lessons).

### It is not a chat — the presentation principle (direction, 2026-08-22 — LOW PRIORITY)

A session is functionally a conversation — the learner talks, reasons, and steers constantly; that two-way flow is *how it works best*. But it must never be **presented** as a chat. Forget the chat interface entirely. The resolution of this paradox:

**Asymmetry of artifact.** In a chat, both parties produce the same object (messages) in the same lane — that's what makes it *look* like a chat. In a lesson, the two parties produce fundamentally different kinds of things:

- **The teacher writes the document.** Prose, sections, diagrams, demos, checks — the teacher's output is structural; it becomes the lesson artifact itself. The teacher doesn't "send messages"; it *writes the lesson*. (The whiteboard.)
- **The learner writes in the margins.** Responses, questions, reasoning, yaps — contributory, anchored to points in the document. (The floor / the voice.) *(Amended below: intact interjection cards in the spine; margins become a view, not storage.)*

Two different instruments, not two identical keyboards. Consequences:

- **Bubbles die.** Teacher text renders as document typography (headings, prose, full-width blocks). Learner text renders as annotation blocks (bordered note cards, anchored quotes) — never right-aligned bubbles.
- **The unit is the block, not the message.** Sections, paragraphs, diagrams, demos, checks, Q&A boxes, margin notes.
- **Chronology yields to structure.** *(Amended below: one chronological spine; structure enters via typed blocks and the link overlay, not relocation.)*
- **Q&A becomes document furniture.** A learner question renders as a quoted card with the teacher's answer as prose beneath — a textbook "reader question" box, not a turn pair.
- **The composer becomes a response field.** Same floating blob, reframed: its output lands as an annotation anchored to the current position, not as the next bubble in a stream.
- What stays: turn-taking underneath — the LLM still sees a conversation. This is a **presentation-layer** change, not an interaction-model change.

References: textbook marginalia, Hypothesis/Genius annotations, Observable notebooks (a document of live cells), the whiteboard-and-floor seminar. Vocabulary matters: they're **sessions/lessons**, never "chats."

### Refinement: the spine and the interjection (2026-08-22, after feedback)

The margin model above has two real flaws, spotted in review: (a) **placement** — when a learner sends one big yap with questions about many different things, routing fragments to the right anchors needs an unreliable split-and-route step; (b) **receipt & chronology** — scattering the learner's block across margins means they hit send and *nothing visibly happens*, and the when/what of their own contribution is lost. Also: session value is mostly **in the moment** — past sessions are rarely revised — so optimizing for the re-readable artifact was misprioritized (and HTML export is deprioritized).

The evolved model keeps the chat-killing (asymmetry) and drops the relocation:

- **One chronological spine.** Everything renders in time order at the frontier. The learner's block stays **intact, visible, and timestamped** — always.
- **The learner block is an "interjection" card, not a bubble.** A distinct block species: full-width, tinted, left rule, `You · 3:41 PM` kicker (mic badge when dictated). Never right-aligned, never a bubble. Chat-ness dies by **type asymmetry and document typography**, not by relocating the learner's words.
- **The teacher's reply is woven document content.** A multi-question yap gets a **Q&A interlude**: the teacher quotes each fragment and answers in prose beneath it (LLMs are natively great at quote-then-answer — contextuality without moving the learner's text). The send moment pays off structurally: tree may visibly update (detour nodes), then the interlude writes itself.
- **Anchoring survives as a link overlay, never a relocation.** When a question clearly refers to an earlier passage, a deep link is attached (and a backlink on the passage: "questioned here ↩"). The margin/panel can later *show* "questions attached to this node" as a computed **view** — a lens, not storage. No scattering; chronology intact; the revision aid is preserved as a byproduct.

### Structural identity — how a session differs from a chat (ideation, 2026-08-22)

A chat has two bubble types, amnesia per message, and no state. What the medium lets us do instead — strongest candidates first:

1. **The transcript becomes the lesson document.** Not a flat message list — a document **sectioned by tree node**, written live: each section headed by its node, collapsible, the current section highlighted. The artifact produced is a generated textbook chapter, not a chat log. Navigating the tree navigates the document. *(The biggest single break from chat-shaped UX.)*
2. **Gated progression.** Checks are gates, not chat: demonstrating understanding is what advances the tree — nodes visibly complete, next ones unlock, and at forks **the learner chooses the branch** ("two ways from here — pick"). ChatGPT never gates anything.
3. **Typed blocks with distinct visual grammar.** Teach / check / demo / diagram / learner-reasoning / Q&A — six block types with six looks, vs. chat's two bubbles.
4. **Session state always visible.** A thin persistent strip: current node, phase, what's been established so far this session, the current node's prerequisites. The anti-amnesia surface.
5. **Sessions open with retrieval.** A 60-second recall card drawn from the event ledger ("last time, on X…") before anything new — spaced-repetition seed; every session starts with retrieval practice, not a blank box.
6. **The session compiles to a durable artifact.** A re-readable lesson page (sections, your notes, your results, your demos) — graph nodes eventually link back to the section that taught them. Chat logs are write-only; this is a personal textbook that grows.
7. **Tree edits are visible events.** When the teacher restructures mid-session (detour, deepen, prune), the change shows — the map evolving in view reinforces that this is a journey, not a thread.

Explicitly avoided: gamification (XP, streaks, confetti). The structure is epistemic, not Skinnerian.

### Persistent tree view (DECIDED)

- **Right-side collapsible panel** in the session UI: the whole tree, at all times, with clear visual separation between nodes and states (done / current / next / upcoming), collapsible to a thin strip.
- This panel and the agent's tools share the same underlying data — the tree is one object with two faces (agent edits it, UI renders it).

---

## 2.5 Sub-agent architecture (DECIDED 2026-08-22)

The teacher's context window and attention are precious — it has the lesson to run and the plan-tree tools to wield. **Mechanical, token-expensive, and time-expensive work is outsourced to background sub-agents.** Rules of the house:

- **Async, always.** Sub-agents run in the background, never blocking the lesson. The UI shows live **activity indicators** — what each running agent is doing right now (current tool call + arguments), not its full session. Headless workers with a status feed.
- **Sub-agents verify; they never one-shot.** This is the asymmetry that makes outsourcing worth it:
  - **Demo-builder** — builds interactive demos (the artifacts of §2) and **tests that the code actually runs** (headless execution) before anything reaches the session. No demo is one-shotted live.
  - **Visual-maker** (SVG and other precise visuals) — renders, **looks at the result**, and iterates until correct. Direct port of the vault POC's `svg-maker` agent (`.pi/agents/svg-maker.md`: `write_svg` / `edit_svg` / `render_svg` + the one rule that matters — verify by looking).
  - **Mermaid needs no sub-agent** — the teacher writes mermaid inline; LLMs are good at it and its failure mode is visible at a glance.
- **Researcher (fact verification)** — a tool the teacher calls to check facts and information. Another agent loop with just `web_search` + `web_fetch`. Direct port of two proven pieces: the pi `web-search` / `web-fetch` extensions (`~/.pi/agent/extensions/`) and the researcher system prompt (`~/.pi/agent/extensions/interactive-subagents/agents/researcher.md`: break into facets → varied-angle searches → fetch the top primary sources → synthesize a standalone, sourced brief).
- **Implementation shape (Next.js):** server-side background agent loops, status events streamed to the client for the indicators; results return to the teacher as tool outputs (artifact + summary), keeping raw search/render churn out of the teacher's context.

---

## 3. Presentation layer (noted, not yet scheduled)

**Current math authoring contract (2026-10-12):** standard `$...$` inline and `$$...$$` on separate lines for display. This supersedes the currency-only dollar rule below; correctly formed backslash-delimited content remains readable. Existing JSON-escape restoration also recognizes the new delimiters, with its recovery rules unchanged. Additional examples, math validation, over-escaping repairs, and transport redesign are deferred. The original W3 decisions below are historical.

- **LaTeX delimiters: switch to the ChatGPT convention.** Inline math `\(...\)`, display math `\[...\]`. The single `$` is retired from math duty and reserved for currency (ending the dollar-sign hazard for good, on both teacher output and eventually user input). Technical path: preprocess `\(...\)`/`\[...\]` → remark-math-compatible form (or a dedicated micromark extension), plus a system-prompt update. The old `$`/`$$` contract dies with this change.
- **Line breaks bug:** lesson text loses single line breaks (markdown semantics collapse them — likely fix: `remark-breaks`, or prompt-level blank-line discipline; verify and fix).
- **Lesson-content formatting:** richer, more structured presentation of teaching blocks (headings, callouts, worked examples) — direction noted, specifics TBD.
- **PARKED (long-term):** a rudimentary LaTeX editor / live preview in the composer so the learner can send formatted math.

---

## 4. Roadmap (dependency-ordered)

1. **Plan-tree tools + session state** — structured tools, tree persisted in the chat store, `set_current` tracking. (Everything else depends on this.) **✅ Wave 1 (W1): 8 DAG-validated tools, prompt fragment, live-verified (plan_init + set_current in a real session).**
2. **Bare-bones global graph + home view** — live emission from tree tools into a graph store, naive-union merge, home page renders it with the chosen lightweight renderer. *This is the "see something appear even from a partial session" milestone.* **✅ Wave 2 (W4): JSONL ledgers, idempotent emission, sigma.js + forceAtlas2 home view, foldStaleChats catch-up. Live-verified.**
3. **Phase separation** — probe/teach marker, transcript divider, collapsed teach-phase checks. **✅ Wave 2 (W5): phaseAt from first plan_init, "Teaching · N nodes" divider, invitation bar + reveal. Live-verified.**
4. **Right-panel tree view** — persistent, current-position highlight. **✅ Wave 3 (W7): topo order, done/current/next/upcoming, progress header, collapse-to-rail persisted. Live-verified.**
5. **Background consolidation → free-form extraction pipeline** — merge adjudication, calibration, prose-only edges. **◐ Wave 3 (W8, lite) shipped exact/alias-match merge + graph-as-context injection. Superseded direction (2026-09-02): the pipeline becomes free-form post-hoc extraction (extractor session-only → auditor with global-graph identity judgment → deterministic merger), tree-blind, message-granular provenance, no taught events, per-proposition understanding notes. Minimal implementation of the §1 philosophy next.**
6. **Demo capability** — the `demo` artifact contract (sandboxed iframe, error-fix loop) + the **demo-builder sub-agent** that tests code before delivery (§2.5). High value; slots in any time after step 1. **✅ Wave 2 (W6): demo + visual tools, verifying builders (headless Chrome), sandboxed demo card, SVG card. Live-verified (visual needs a vision-capable LH_VISUAL_MODEL).**
6b. **Researcher tool** — fact verification for the teacher (§2.5); cheap port of proven pi pieces. **✅ Wave 1 (W2): async job protocol, live activity card, sourced brief, teacher continuation. Live-verified.**
7. **Presentation fixes** — LaTeX delimiters, line breaks, mermaid integration. **✅ Wave 1 (W3): \(…\)/\[…\] contract ($ literal forever), remark-breaks, dark mermaid + styled streamdown chrome. Live-verified.**
8. **Structural-identity candidates** (from §2 ideation, pending selection): sectioned lesson-document transcript, gated progression, typed blocks, session-state strip.
9. **Later:** dictation (Deepgram token-mint + AudioWorklet capture), frontier expansion + what-next queries (new territory / repairs / conversions), spaced repetition on the event ledger, practice exercises, Electron.

---

## 5. Open questions

1. ~~Graph rendering library + layout architecture~~ — **decided 2026-08-22: sigma.js + forceatlas2, run-then-freeze** (see §1). Remaining: run the 2k-node synthetic benchmark before implementation.
2. ~~Overlapping topics across sessions~~ — resolved by the 2026-09-02 model: identity is the auditor's judgment (link-or-create, aliases as phrasings); duplicates are acceptable-and-correctable, wrong merges are not.
3. ~~Probe questions when no tree exists yet~~ — resolved by free-form extraction: quiz attribution is retroactive against the whole transcript (extractor judgment, auditor-verified), with no dependence on the tree at all.
4. Home-graph v1 interactions beyond pan/zoom (node click → session list? — presumed cheap yes).
5. Grain mismatch frequency (`subsumes`-style relations) — per original doc, measured by data, not pre-solved.
6. Aggregation semantics for understanding (min / mean / two-level) — fit on real data, per original doc.
7. Cluster visual details — boundary aesthetic (convex vs. organic hull), label placement/typography, palette — decide during visual testing with real blobs (§1 Clusters; theory DECIDED 2026-09-13).
8. Cluster size threshold (~3) — tune on the synthetic benchmark + real data (§1 Clusters).

---

## Amendments to the vault design doc (2025-08-20) — summary

| Original | Now |
|---|---|
| Teacher never modified; graph built post-hoc | Post-hoc again (2026-09-02): free-form extraction, fully decoupled from the session's formalism — the 2026-08-22 live-emission reversal is itself reversed |
| Misconception nodes as first-class structure | No node `kind`: every node is a true proposition; misconceptions enter as true corrections, wrongness lives in the event ledger |
| `requires` edges | `follows` / `supports` — derivability vs. grounding; strength derived at read time, never stored |
| `taught` events (marking things done) | Dropped; the extractor records per-proposition understanding notes (named-word scale) as session-scoped observations instead |
| Understanding scale standardized (2026-09-08) | The note becomes a closed five-word scale (`solid`/`shaky`/`accepted`/`resisted`/`not yet engaged`), enforced by the extraction schema — no numbers, no prose; agent justifications are dropped |
| Chat-granular node/edge provenance | Message-granular (chat, message) provenance on nodes and edges — the exact derivation points |
| `name` + `statement` on nodes | `statement` (minimal proposition, the rendering label) + `description` (required elaboration) + `aliases` (verbatim phrasings) |
| `statement` + `description` (2026-09-02) | `name` (very short label, the rendering handle) + `statement` (full precision, identity anchor, detail card); `description` dropped — full-sentence canvas labels cluttered the graph (2026-09-08, seeing real extracted data) |
| Updates per completed session | Continuous; partial sessions deposit value |
| Mermaid DAG as the plan artifact | Structured tools as source of truth; mermaid only for ad-hoc diagrams |
| UI deferred, "not important" | UI exists (Next.js, v3.4); the graph view is the app's home page |
| pi as core dependency | pi removed; harness is standalone Next.js + Vercel AI SDK |
