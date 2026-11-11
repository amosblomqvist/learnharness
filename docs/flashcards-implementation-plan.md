# Flashcards: native-first implementation

**Authorized:** Begin implementation. Keep it simple; no Anki export/import, dependencies, assets, conversion or compatibility work in v1. The earlier exhaustive draft is superseded.

## Small package, existing host services

Source lives in `plugins/flashcards/`, with its own build manifest/lockfile. Build a normal installable `flashcards` folder; do not install over the person's live plugin/data or change root application dependencies.

- **Local store:** one versioned JSON snapshot under `ctx.dataDirectory`, written by atomic replacement. It holds decks, proposition/cue collections, schedules, review history and generation progress. No database service, general repository framework or additional host API.
- **Library:** flat source-based default decks, optional custom memberships, search, cue edits/deletion and Archive. Shared memberships reference one proposition collection/schedule. Preserve at least one membership; deleting a deck never deletes cards or progress.
- **Generation:** use the actual host knowledge picker, read public graph propositions/immediate chains, include existing/deleted cues, and pack configurable ~4,000-token input chunks. Submit independent validated `ctx.workers` tasks through host admission. Follow the current cheap slot unless overridden. One active batch, no automatic model retries/replay. Successful chunks apply independently. Navigation does not cancel accepted work.
- **Review:** think → reveal → Again/Hard/Good/Easy. A small attributed FSRS-6 port, published parameters, 90% retention, learning 1m/10m and relearning 10m. Schedule propositions, weight cues by latest result, and keep the same cue through learning/relearning. Daily new limit initially 20 per deck; due work uncapped. Introduction counts in every current membership but only the studied/admitting deck controls admission.
- **Rendering/settings:** use `mountMarkdown`, host-controlled buttons/dialogs/pickers/settings and scoped cleanup. No private component imports, duplicate Markdown parser or plugin-local worker infrastructure.

## Practical safeguards, not another platform

Validate backend inputs; retain failed edit drafts. Grade only revealed, current review tickets; make accepted ratings and model-task dispatch idempotent. Keep cancellation/application markers with the same local snapshot. Reconcile accepted results after restart without making a new model call. Use explicit errors instead of silent context truncation, fallback models or data reset.

Use deterministic FSRS intervals initially (reference fuzz-off default). Local study days initially start at 04:00; intraday steps use actual elapsed minutes. Published equations remain reference-tested; local queue/calendar behavior is an adapter, not a claim of identical Anki scheduling.

## Infrastructure learning

This plugin is a reference consumer of the still-evolving API. Report concrete excessive plumbing, awkward workarounds or missing capabilities to the human instead of hiding them behind a custom framework.

Known limitation: the public graph reader exposes source titles/paths but not imported-source display-name overrides used by the host picker. Initial deck labels can use those public titles/basenames and remain editable. No private-store workaround.

## Verification and delivery

Run focused native tests for generation, persistence, scheduling, shared memberships, review, cancellation and recovery. Build the external package and exercise its UI in a disposable app/browser environment. Mock model transport; do not call paid providers or touch real learning data. Report observed results and remaining gaps honestly. No automatic installation, root-host edits, commit, push or release.
