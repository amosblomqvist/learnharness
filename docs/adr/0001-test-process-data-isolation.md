# ADR 0001 — Test processes isolate their data dir automatically

Status: accepted · 2026-11-01 · owner-approved (systemic option)

## Problem

Test suites leak durable app records into the repo's real user-data
directory (`data/`): after ordinary `npm test` runs the app's session
picker filled with fixture sessions ("Fixture mixed queue", "Scratch
mixed queue", "Toggle bridge test", "getApiKey pin", "steer: idle/live/
reconcile") and `data/jobs/` accumulated job records pointing at
already-deleted chats. The real "Azure AI-200" session drowned in
fixtures.

Two contributing paths exist:

1. *No isolation*: suites that statically import the real stores
   (store/chats.ts) and never set `LH_DATA_DIR` nor clean up after
   themselves — `tests/tool-toggles-bridge.test.ts`,
   `tests/api-key-hook.test.ts`, the composer-steering block of
   `tests/jobs.test.ts`.
2. *Hoisting-defeated isolation*: suites that dutifully set
   `LH_DATA_DIR` and then dynamic-import the store composition —
   `tests/subscription-background.test.ts`,
   `tests/chatgpt-background.test.ts` — but statically import
   `src/agent/models.ts` beforehand. That chain transitively evaluates
   `config.ts`, so `PATHS` freezes to repo `data/` before the env write
   can matter (empirically confirmed: the later assignment changes
   nothing for already-resolved paths).

The repo's existing mitigations cannot hold the line at scale: the
"set the seam before any store import" discipline is a human rule
(close to 19 test files re-implement it independently), and the
"cleanup in finally/after" pattern is fragile — the steer block of
jobs.test.ts forgot it and leaked.

## Decision

Every test process gets a **unique temp data dir before any repo module
loads**, injected by the test runner itself:

- New `tests/preflight.mjs`: on load it creates an `mkdtemp` scratch
  dir and sets `LH_DATA_DIR = <scratch>/data` (plus a scratch
  `LH_AUTH_FILE` when unset), and registers an `exit` cleanup that
  removes the scratch dir. It unconditionally overwrites a pre-set
  `LH_DATA_DIR` — parallel test-file processes share the runner's
  environment, so honoring an inherited value would collapse the
  isolation the preflight exists to provide.
- The test script becomes
  `NODE_ENV=test tsx --test --import ./tests/preflight.mjs tests/*.test.ts tests/*.test.tsx`.
  Node's `--import` runs in every test-runner child process (isolation
  mode `process`, one process per file), which the straightforward
  property "each test file gets its own empty data dir" can lean on.
- Per-file `LH_DATA_DIR` assignments (chat-birth-stamp discipline
  files) remain valid: they run after the preflight, and modules not
  yet evaluated — config among them, when no freezing chain has
  executed — re-resolve the new value.
- `tests/data-dir-seam.test.ts` must now strip `LH_DATA_DIR` /
  `LH_AUTH_FILE` from the env it hands its substrate child process;
  the "unset = repo data/" fallback case requires a child that genuinely
  lacks the seam, which inheritance no longer guarantees.

## Consequences

Positive:

- Whole-class prevention: no test file can touch the real user data
  dir again, including future ones written under a deadline; the
  cleanup-pattern suites stop racing repo state; per-process uniqueness
  removes cross-file interference between run-in-parallel suites.
- A standing hardening side effect: unfiltered suites can no longer
  read repo-root `auth.json` (real credentials) through the store.
- Existing suites need no edits beyond the one data-dir-seam
  adjustment; deliberately-overriding suites keep their overrides.

Negative / accepted:

- Child processes spawned by suites now inherit a temp value rather
  than the unset state; the seam's unset-direction pin carries its own
  env-strip and future child-spawning suites must treat the env the
  same way (the preflight header documents the trap).
- The `--import` indirection is one more tier of test-runner
  machinery to reason about (e.g. running a single suite file without
  the npm script no longer reproduces the data-dir layout by
  accident).

## Alternatives considered

- *Per-file discipline repair (five files)*: minimal diff, convention
  harmonious — but ~14 more cleanup-pattern files sit one forgotten
  `finally` from repeating the failure, and two suites already proved
  the discipline silently defeats itself through static-import
  hoisting.
- *Lazy PATHS (config resolves at access time)*: makes import order
  irrelevant everywhere — but mutates a documented module-load-time
  contract (data-dir-seam pins it), displaces several module-eval
  constants (`SETTINGS_FILE`, `AUTH_FILE`, `LEDGER_FILES`, …) and
  every consumer of them; large blast radius for a problem the
  preflight bounds fully.
- *Cleanup-only / deleting leaked files*: treats the symptom; the
  next suite run recreates the debt.
