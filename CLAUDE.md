# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The rules in AGENTS.md are binding. Read the installed Next guide in `workspace/node_modules/next/dist/docs/` before changing anything framework-facing, because this Next version differs from what you were trained on. Never guess a design or implementation decision: ask, get the plan approved, then implement.

Run the commands below from `workspace/`. Application paths in this guide are relative to that directory.

## What this is

LearnHarness is an agent harness for learning. A Next.js app (with an Electron desktop host) runs teaching and practice agents built on Pi (`@earendil-works/pi-agent-core` / `pi-ai`) and keeps a persistent knowledge graph. All state is plain files on disk. The long-form references are `docs/architecture.md`, `docs/development.md`, `docs/plugin-architecture.md` and `src/agent/prompts/README.md`. Keep them accurate when you change the behaviour they describe.

## Commands

CI uses **Node 26**. On a fresh checkout, and again after any change to the public plugin API or a plugin lockfile:

```sh
npm ci
npm run plugins:setup   # generates plugins/*/.sdk and runs npm ci in each source plugin
```

```sh
npm run dev            # stages core plugins, then next dev on localhost:3000
npm run desktop:dev    # dev server + Electron
npm run desktop:windows  # Windows launcher (same as "Launch LearnHarness.cmd")
npm run desktop:linux    # Linux launcher (same as "Launch LearnHarness.desktop")
npm run build          # stages core plugins, then next build
npm test               # node:test via tsx over tests/*.test.ts(x)
npm run typecheck      # tsc --noEmit (includes plugin sources)
npm run lint           # ESLint, including the architectural import restrictions
```

- **Single test:** `NODE_ENV=test npx tsx --test tests/chat-flow.test.ts`. The npm scripts use POSIX `VAR=x` syntax, so run them from Git Bash on Windows, not PowerShell or cmd.
- **Electron-native tests** (PDF/SVG rendering, browser service) need Electron's Node: `npx electron --import tsx --test tests/pdf-native-render.test.ts tests/svg-native-render.test.ts tests/browser-service.test.ts`
- CI runs `typecheck`, `test` and `lint`, then `build`, `node scripts/smoke-provider-runtime.mjs`, `node scripts/build-server.mjs` and `node scripts/smoke-server.mjs --electron`. Read any other `scripts/smoke-*.mjs` before running it.
- Don't run raw `next dev` or `next build`. The npm scripts stage `core-plugins/` first (`npm run plugins:build-core`), and core plugin code loads from there. Plugins don't hot-reload: rebuild and restart the server after editing plugin source.
- Tests need no paid models or real sign-in (they use injected engines, fake transports and fixtures), but some bind loopback ports or create temp files.

## Safe local runs

**Never write to the user's real profile** (`workspace/data/`, `workspace/auth.json` and its sibling credential files). Test or demo sessions left there show up as stray threads in the user's sidebar. Every test, smoke script and separate dev server you run must use a scratch `LH_DATA_DIR` and `LH_AUTH_FILE`. Opening the real app to look at how it behaves is allowed; starting a session in it is not, because that changes the user's learning progress. Afterwards, check that `workspace/data/chats` and `workspace/data/jobs` gained no files.

Point the server at a disposable data and auth profile so your personal data stays untouched:

```sh
LH_DATA_DIR=/abs/scratch/data LH_AUTH_FILE=/abs/scratch/auth.json npm run dev -- --port 3001
```

By default, mutable state lives in `workspace/data/` and keys in `workspace/auth.json`. Subscription credential files (`chatgpt-credentials.json` and others) sit next to `LH_AUTH_FILE`. Environment API keys override saved keys. Run **one server per data/auth profile**: storage is synchronous file IO with no cross-process locking. Debug flags: `LH_PROVIDER_EVENTS=1` and `LH_BACKGROUND_CAPTURE=<role>|all` (details in `docs/development.md#debugging`).

## Architecture

### Layers (enforced by `eslint.config.mjs`)

| Area | Role |
| --- | --- |
| `app/` | Pages and HTTP routes (`app/api/chat/route.ts`, `app/api/chats/…`) |
| `components/` | Browser state and UI. `session-core.ts` owns stream reattachment and recovery |
| `src/server/` | Composition root and HTTP-facing services: `chat-handler.ts` (turn admission), `jobs.ts` (background delivery), `stores.ts`, `plugins.ts` |
| `src/agent/` | Agent construction (`teacher-agent.ts`), tool registry (`tools.ts`, `tools/`), model and provider composition (`models.ts`), background workers (`subagents/`), prompts |
| `src/core/` | Contracts, domain algorithms and projections. Storage ports are in `ports.ts` |
| `src/store/` | Filesystem adapters (chats, jobs, graph, settings, auth) |
| `electron/` | Desktop shell, navigation and permission guards, credential transport, updater |
| `convex/` | Optional Labs cloud thread sync (off by default) |

Shell code imports `src/` only through the core and server barrels. Core must not import IO layers, and agents must not import server or store adapters. Dependencies come in through injected contexts and ports. `config.ts` anchors read-only assets to the workspace and mutable paths to `LH_DATA_DIR`.

### Turns

A conversation is a durable `ChatRecord` (`chats/*.json`) holding native `LhMessage[]`. `POST /api/chat` validates the input and **saves it before inference**. It then claims per-chat liveness (a competing turn gets 409) and builds a **fresh Pi `Agent` from saved history** each turn, so the system prompt and tools are never persisted. Events stream on `GET /api/chats/:id/stream` (replay plus live). Settlement saves the output and usage, including partial output on abort. The stored record has two projections, and neither one is the storage format:
- `toLlmMessages` (`src/core/native-messages.ts`) builds the model-facing context, including compaction cuts and interrupted-tool repair.
- `projectView` (`src/core/view.ts`) builds the UI view: messages, question and problem docks, artifacts.

`/api/events` is a separate, non-durable, window-level "go refetch" signal. Its event names are in `SERVER_EVENT_TYPES` (`src/core/events.ts`).

### Agents and phases

A teaching session starts with the **prober** (`probe`/`recall`, `probe_done`). A successful `probe_done` with a matching result hands off to the **teacher** (`plan_init` with a Mermaid DAG plan, then `quiz`/`explain`). A practice session uses the **practitioner** (`problem`, `conclude`). Question tools return a synthetic terminating placeholder. The learner's real answer becomes the tool result on a later turn. Side questions (`src/server/side-chat.ts`) are tool-less single calls, not application turns. They are fed back into the main context as `side-question` entries.

### Prompts

Prompts are composed from `src/agent/system-prompt.md` plus sorted, numbered fragments in `src/agent/prompts/{prober,teacher,practice,shared}/` (filenames must match `^\d+-[\w.-]+\.md$`). Practice gets only an **allowlisted** subset of `shared/`, so a new shared fragment does not reach practice automatically. User overrides live in `<data>/prompts/` and apply only when their settings switch is on. See `src/agent/prompts/README.md`.

### Background work

Research, PDF, demo and visual tools save a job (`jobs/*.json`), acknowledge the dispatch, and run workers through `src/agent/subagents/runner.ts`. Worker completion and delivery to the session are separate steps. A marker in the saved conversation is the delivery acknowledgment. All background model streams share one FIFO admission gate (`agent.workerRequestConcurrency`, default 8).

### Plugins

Trusted local plugins have no sandbox. The five core plugins are listed in `core-plugins.json`. Their source is in `plugins/<id>/` and the staged builds go to the generated, git-ignored `core-plugins/<id>/`. Community plugins live in `<data>/plugins/<id>/dist`. `instrumentation.ts` starts the plugin host (`src/server/plugins.ts`), and `scripts/plugin-loader.cjs` loads backends outside the Next bundle. Contracts are in `docs/plugin-*.md`, and templates are in `examples/plugins/`.

## Conventions worth knowing

- Chat and graph files carry version stamps, and newer versions are refused. Golden fixtures (`tests/fixtures/golden-data/`) exercise compatibility. Never hand-edit fixture content to make a test pass. Read `docs/architecture.md#storage-and-notifications` before changing a record format.
- There are no factory default models. Missing model or provider configuration must refuse, not silently fall back. Subscription routes never fall back to API-key billing.
- Read-only file tools are protected by a path-based sensitive-file guard (`src/agent/tools/fs-shared.ts`). Keep it working when you touch file access.
- Good starting tests for core flows: `chat-flow`, `session-core`, `turn-recovery`, `job-delivery-recovery`, `extraction`, `practice-flow`, `prompt-overrides`, `golden-fixtures`, `plugin-*`.
