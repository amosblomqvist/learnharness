# Long-term retention (spaced repetition)

LearnHarness schedules review of extracted propositions with the
[FSRS-4.5](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)
memory model, so material comes back when the model predicts you are about to
forget it — not only when you ask for it ([issue #33](https://github.com/amosblomqvist/learnharness/issues/33)).
See [Architecture](architecture.md) for runtime boundaries and
[the teaching theory](teaching-methodology.md) for the pedagogical context:
retention work happens in practice sessions; the knowledge graph stays an
objective record of propositions and chains, never a mastery store.

## The model

- [`src/core/fsrs.ts`](../src/core/fsrs.ts) — a dependency-free FSRS-4.5
  scheduler. It carries the 17 published default weights (overridable per
  call), the power forgetting curve `R(t, S) = (1 + FACTOR·t/S)^DECAY` with
  `DECAY = -0.5` and `FACTOR = 19/81` (so recall is predicted to be exactly
  90% one *stability* after the last review), the difficulty/stability update
  formulas, and the classic state machine: **New → Learning → Review**, with
  **Relearning** after a lapse. Ratings are Again(1)/Hard(2)/Good(3)/Easy(4).
- [`src/core/retention.ts`](../src/core/retention.ts) — the ledger-side core:
  the persisted entry shape, the due derivation, and the conclude→rating
  mapping. Pure functions throughout; nothing in `src/core` does IO.

Two integration conventions sit on top of the published model and are
deliberate, documented choices: the Learning/Relearning *step intervals*
(1/5/10 minutes, mirroring common FSRS deployments — FSRS-4.5 itself fixes
only the memory-state updates), and the absence of FSRS-5's separate
same-day formula: every rating flows through the one formula set with
retrievability computed from real elapsed time, so a same-session repeat
sees R ≈ 1 and barely moves stability.

## The data file

`graph/reviews.json` (under the data root) is a single JSON map:
`propositionId → { state, difficulty, stability, reps, lapses, lastReviewAt,
dueAt, updatedInSession }`. It follows the graph-family conventions: the
`format.json` stamp versions it with its siblings, writes are
temp-file-and-rename, and reads are tolerant (absent or corrupt = nothing
scheduled yet; invalid entries are skipped). The adapter is
[`src/store/reviews.ts`](../src/store/reviews.ts), behind the `ReviewStore`
port ([`src/core/ports.ts`](../src/core/ports.ts)); there is no per-review
event log — the current state is stored, and a proposition absent from the
map is simply *not scheduled* (never practiced).

## How reviews happen

1. **Capture.** A practice session created with explicit graph picks
   (including every "Review due material" session) feeds each cleanly
   concluded problem into the ledger for the *session's picked* propositions
   the problem targeted: `solved → Good`, `solvedWithHints → Hard`,
   `movedOn`/`surrendered → Again`. Dismissals schedule nothing. Untagged
   problems and pickless sessions schedule nothing. Capture runs inside the
   conclude tool's hook ([`src/server/retention.ts`](../src/server/retention.ts));
   its failures are logged and never break the practice session. This is
   also how the ledger is *seeded*: practicing material with picks is what
   first schedules it.
2. **Due surfacing.** `GET /api/graph/reviews` reports the due count and
   list (most overdue first, capped at 64): a proposition is due when its
   retrievability has decayed below 0.9 **or** its `dueAt` has passed.
   Entries for propositions no longer in the graph are ignored.
3. **Review sessions.** The home screen shows a **Review due material (N)**
   affordance while anything is due. One tap creates an ordinary practice
   session whose explicit graph selection is the due set — the same
   picked-practice path as the node picker, not a new session kind — with
   *Review my due material* as the opening message.

## Limitations

- Parameters are the published defaults; there is no per-user optimization
  or settings surface yet.
- Teaching-session quizzes do **not** feed the ledger: quiz outcomes anchor
  to a message (via the coverage ledger) rather than to propositions, and
  mapping correctness+confidence to ratings reliably is an unsolved
  anchoring problem — left as a follow-up rather than hacked in.
- The due count is polled at home-mount time; there are no notifications or
  a scheduler heatmap.
- Reviews are ordinary practice sessions: the practitioner decides how to
  exercise the due material, and FSRS never overrides the teaching method.
