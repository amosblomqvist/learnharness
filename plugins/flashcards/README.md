# Flashcards

A self-contained native LearnHarness plugin: generate fact-recall cues from your graph, organize them in flat decks, and review them with FSRS-6. **No Anki integration.** No runtime npm dependencies, private app imports, core graph writes or provider credentials in the package.

## Build and test

From this folder:

```sh
npm ci
npm test
npm run build
```

The installable folder is `dist/flashcards/`. Copy that entire folder into your LearnHarness plugins directory **without replacing an existing plugin's `data/`**, then enable Flashcards in Settings → Plugins. This repository does not automatically install or enable it. Requires the app build exposing `mountKnowledgePicker`, `mountMarkdown` and `ctx.workers` (the version string alone does not establish those capabilities).

## Use

Open Flashcards from the sidebar or graph action. Select propositions in the real host knowledge picker, run preflight, then confirm generation. It uses the current cheap model slot unless you set a plugin-specific override; calls can incur cost. Graph selection is manual; there are no automatic generation triggers. Each successful chunk adds useful missing cues without replacing existing cards or resetting schedules. Navigation does not cancel work. Failed/interrupted targets require an explicit new generation attempt.

First-generation cards join a deck named after their original source. Initial names use public chat titles or notes-file basenames; host imported-source rename overrides are not yet exposed by the learning reader. Rename collections locally, create custom decks and change memberships without changing core sources. One proposition can occur in multiple decks while keeping one collection, schedule and history. Keep at least one membership. To delete its sole deck, choose another destination; deletion never removes cards or progress.

Review all, a deck, or selected propositions. Think, reveal, then self-rate Again/Hard/Good/Easy. Review is local and makes no model calls. Ready learning/relearning comes first, then due reviews, then new propositions. New allowance defaults to 20 per deck/day; due reviews are uncapped. A first rating counts in every containing deck; only the admitting/studied deck controls admission. Whole-library review finds an eligible deck without creating a separate global allowance.

Settings control desired retention (initially 90%), learning steps (1m 10m), relearning steps (10m), local study-day start (04:00), input chunk budget (approximately 4,000 tokens), and generation model/thinking overrides. FSRS-6 uses published parameters and deterministic intervals (no fuzz or optimizer). Learning repetitions use the same cue; normal review weights cue selection by its latest self-rating. The schedule is proposition-level, intentionally not identical to card-level Anki scheduling.

Questions/answers use the host's real Markdown rendering, including code, tables, math and Mermaid. Edit cards without resetting progress. Deleting a cue removes it from future review and keeps a tombstone/history; generation sees it as an example not to restore. If its graph proposition disappears, its collection is archived and excluded from review; the same ID returning makes it active again. Source deletion does not reorganize surviving cards.

## Data and lifecycle

Plugin-owned state is `data/flashcards.json`: a versioned JSON snapshot, atomically replaced after local mutations. It contains decks, cues, schedules, review records and generation progress. Host-owned task records remain under `data/tasks/`; the plugin does not overwrite them. Disable/update preserves data. A corrupt/unsupported store is an error, never silently reset.

Accepted review ratings and worker chunks are applied once. Cancel closes the batch's application gate before cancelling outstanding tasks; previously applied chunks remain. Restart reconciles durable worker outcomes without replaying unfinished model work. A failed save is visibly separate from successful model generation; retry saving does not make another model call. Deck deletion waits until generation finishes or is cancelled to avoid stale destinations.

The initial store is deliberately small and simple: one backend process owns writes. Simultaneously running independent app-server processes against the same plugin data directory is not supported. If dataset size makes rewriting the snapshot expensive, measure that concrete case before introducing more storage machinery.

## Verification

47 focused tests pass for storage, generation, cancellation/recovery, review, memberships, scheduler fixtures and frontend lifecycle. The built external package was also exercised in a disposable packaged host running Electron's bundled Node with headless Chrome: actual knowledge selection → one loopback-model worker → accepted cards → hidden answer/reveal with host math/code/table/Mermaid rendering → rating → navigation and disable/re-enable persistence. No real provider/account or learner data was used. Real-model cue quality and a native Electron-window/manual UX trial remain unverified.

## License

AGPL-3.0-only, matching LearnHarness. The dependency-free FSRS subset is selectively adapted from MIT-licensed `ts-fsrs@5.2.3`; see `FSRS-LICENSE.txt`.
