# The probe→teach agent split & plan-movement semantics

> **Historical design record, not current implementation documentation.**
> The original decisions below may be superseded or unimplemented.
> See [Architecture](architecture.md) and [Development](development.md) for the
> shipped agent structure and current development guidance.

Shared understanding reached 2026-09-11 (user + master session). This is the
convergence record — the decided design, with reasoning. It is not a task
list; implementation waves are planned against it.

---

## 1. Two agents, one conversation

Probing and teaching are structurally so different that they get **separate
agents**: separate system prompts and separate tool sets, each fully
fleshed-out with a major focus on its own phase. The split extracts more
system-instruction alignment: neither agent carries the other phase's bulk
(neither needs the specifics — each gets only a brief summary of the other's
philosophy so they share a view of the whole process).

- **The prober** runs the probing phase: quiz + ask_user_question +
  `probe_done`. Its quiz is a *different tool* (different schema: **no
  `nodeId` field at all**) under the same name, so the model is never shown a
  field it must not use. No plan tools, no jobs, no demos.
- **The teacher** runs everything from planning onward: full tool set
  (teach quiz with nodeId, plan_init, jobs, demos). Constructed the moment the
  transcript carries a concluded `probe_done`: a non-failed/non-aborted
  assistant call followed by a matching successful tool result.
- **The swap happens between probing and planning** — the planning phase
  needs full knowledge of how teaching is done, so the teacher agent starts
  at planning.
- **They share the message history.** No fresh start: the history holds
  subtleties an assessment summary would lose. History tool parts are
  content, not live schemas — the teacher reads the prober's quiz calls as
  past conversation; the one foreign tool (`probe_done`) reads as a concluded
  past action, and even a hypothetical re-call degrades to a returned
  tool-error (the return-to-agent doctrine).
- **Invisible to the user**: same chat, same record, same UI. The agents are
  constructed per-request by the same composition root; "which agent" is a
  construction branch, not a handoff.

## 2. `probe_done` — the seam tool

The prober concludes explicitly:

- **Server-side tool.** Input: the learner assessment. Output: ok/error.
- **Refuses while a question is open** ("resolve the open question first") —
  same doctrine as nodeId validation.
- **Refuses a second conclusion** (idempotent: the probe concludes once).
  Conclusion requires a later `probe_done` result matching the call's ID
  and tool name. The calling generation must not have failed or aborted;
  the result must not be `isError` or explicitly contain `details.ok:false`.
  Clean acknowledgments without an explicit `ok:true` remain valid. Bare,
  unmatched, errored, or refused calls keep probing open; saved attempts
  are never deleted or replay-executed by this detection rule.
- The assessment is the tool call's input, so it streams to the learner live
  and is durable in the transcript by the tool result itself. A dedicated
  assessment card/viewer comes later (UI).
- **Assessment shape (v1, refine later): a list of dependency strands + a
  free-form read of the learner's edge on each.** The probe was already a
  binary search per strand the lesson depends on; the assessment formalizes
  exactly that. Optional overall summary.
- **Side effect: it queues the handoff.** When the prober's turn ends, the
  wake pipeline (the same machinery that delivers sub-agent results and
  abort steers) fires a server-side turn with a handoff steer — the teacher
  is constructed (probe_done has successfully concluded) and authors the plan.
  The learner experiences assessment → plan as one continuous flow. If the
  wake is lost (crash window), the next client message still constructs the
  teacher — the transcript is the source of truth.

## 3. `nodeId` semantics — position, not completion

The old contract read a *correct* answer on a tagged check as "node done."
That is the wrong signal and is **abolished**. The new contract:

> **`nodeId` on a quiz means: "this question is about this node."**
> Nothing else. It is a position signal, never a completion signal.

- **Current node = the node referenced by the most recent tagged quiz
  call** (the call, not the result — any state counts).
- **Visited = every node that appeared in an earlier tagged quiz call.**
  Sticky, monotonic. There is **no done ledger and no done bookkeeping of
  any kind** — everything is inferred from the session history. The stored
  tree carries structure only (the author-once protocol taken to its
  conclusion: `currentNodeId`/`doneNodeIds` are removed from the tree).
- **A node spans multiple turns and multiple checks naturally.** Several
  questions may tag the same node — the map stays put. The teacher moving to
  a new node *is* the teacher's judgment that the previous one is finished,
  regardless of individual check outcomes (a failed check followed by a
  re-teach and a move-on is still a visited node).
- **Failed checks move nothing.** Results no longer feed derivation at all.
- **Untagged checks no longer exist** (owner ruling 2026-09-26): `nodeId`
  is required on the teach quiz schema — an untagged call is rejected at the
  boundary and the model retries tagged. Off-map checks (quick comprehension
  checks that don't fit a node) route through ask_user_question. The map can
  never freeze from a lost tagging signal again.
- **No fallback current.** Before the first tagged check nothing is
  current. No derived-from-prereqs guess.
- Present-but-invalid ids are still rejected at the call boundary (existing
  validation, return-to-agent retry).
- Visualization: current node gets a special highlight; visited nodes
  render visible (not grayed); upcoming nodes gray out. "Where have we
  been, where are we."

## 4. Phases — explicit events, no occupancy derivation

The phase chain is **event-driven**:

**probe (prober)** — `probe_done` → **planning (teacher)** — the first
`nodeId`-tagged quiz call → **teach (teacher)**

- The broken derived-occupancy seam (phase-of-tree via `currentNodeId`
  nothing ever sets — the stuck-on-plan bug) is **replaced, not patched**.
- The verdict gate is DEAD (owner ruling 2026-09-26 — simplified away):
  presenting the plan ends the teacher's turn, and the learner's next
  message is a natural reply — a change request (revise, re-present, end
  the turn again) or the go-ahead. The plan→teach seam is **inferred**:
  the first quiz call tagged with a `nodeId` (a question ABOUT a plan
  node; probe quizzes carry no nodeId) is where teaching begins. The
  phase fold (`phaseAt3`) advances there, the teaching divider renders
  before that whole assistant block, and the live phase indicator may lag
  until the first node's question is posed (owner-accepted). Mid-lesson
  `plan_init` rewrites need no gate at all.
- The session picker phase derives from the transcript the same way.

## 5. No global-graph context in sessions (for now)

Both agents run **fully standalone** — no knowledge-graph injection into
either prompt. The graph-as-session-context idea (W8) is shelved until
there's a considered design for what it should actually feed. The global
knowledge graph remains what the extraction pipeline builds; nothing in
lesson prompts reads it.

## 6. The plan UI: persistent DAG window (direction)

The injected-blocks approach is superseded: the plan should live in a
**persistent DAG window** in the conversation view (like the background-
processes dock): always present, zoomed on the current node, auto-moving
as the lesson advances; click → full plan (the existing popup survives as
the expanded view). Exact layout/design is refined in the UI session.

The window is LIVE (landed 2026-09-11, one day after the design): bottom-left,
2:1 zoomed viewBox centered on the current node, clamped to the layout, click
opens the popup. The full plan block also still renders in the flow at plan
authoring (the presentation moment; the block sits immediately after the
`plan_init` call) as a second popup entry point. The neighborhood-block
machinery (frozen fragments) is retired — snapshots can't represent
live-derived movement.

## 7. Deferred / later waves (designed, not now)

- ~~**Accept-plan UI**~~ — landed 2026-09-11, then **removed 2026-09-26**
  (the verdict death): the seam is inferred from the first `nodeId`-tagged
  quiz call (see §4).
- **Assessment viewer** — the strand assessments displayed to the learner
  as a proper card (data already durable in the transcript; the plain v1
  probe-done card renders the assessment meanwhile).
- **Model / thinking control** — currently hardcoded per role in
  `config.ts` MODELS. The split gives natural `MODELS.prober` /
  `MODELS.teacher` entries; runtime control comes after.
- **Graph context, properly designed** — what the global graph should feed
  into sessions (§5).

## 8. No backwards compatibility — ever

Legacy sessions are not supported. At major pivots the testing data is
wiped and re-grown from new testing. No compat shims, no legacy marker
fallbacks, no migration of old trees. `probe_done` is the only teacher
construction key; sessions without it are prober sessions (dead legacy
data is garbage to be wiped, not accommodated).

---

## Diagnosis context (why this pivot)

The 2026-09-11 user testing round (Nietzsche + Lacan sessions, minimal-
effort GLM) exposed: (1) the teacher never tagged `nodeId` — every quiz in
both sessions was untagged, so nothing ever derived; (2) the phase system
structurally could not leave "plan" — `phaseOfTree` read `currentNodeId`,
which the author-once protocol never sets, so no session could reach
"teach"; (3) with result-derived "done," one passed check would have
falsely finished a node. Model-compliance issues (untagged checks,
free-text correctAnswer) are expected to shrink with higher thinking
budgets and runtime model control — but the *semantics* had to be right
first. Model mistakes are good test material: they exercise the
return-to-agent validation loops.
