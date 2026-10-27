# Hard fork from upstream LearnHarness

This repo is a hard fork of `amosblomqvist/learnharness` at `3dc8847` (0.3.8). We no longer pull upstream changes. The fork's main feature, a persistent record of what the learner has shown they understand (see ADR-0002), goes against upstream's choice to store no learner state, and it touches core files (`src/core/contracts/graph.ts`, extraction, phases) where merges would conflict constantly. We judged the codebase a solid base (see `docs/research/teaching-premise-vs-implementation.md`) and chose to own it outright rather than keep it merge-compatible.

## Consequences

- Upstream fixes and features no longer arrive for free. Port them by hand, case by case.
- The fork must stop using upstream's release channel. `electron-builder.yml` points the auto-updater at `amosblomqvist/learnharness` releases, which would replace a fork build with upstream's. The app's name and bundle ID must also change, so the fork never shares settings or data with an installed upstream app.
- Upstream design docs in `docs/` remain background only. Where they conflict with an ADR, the ADR wins. Stale ones get marked as superseded.
- The license stays AGPL-3.0. That is fine for single-user local use. Hosting the fork for other people would require publishing its source.
