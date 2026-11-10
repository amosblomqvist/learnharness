# Development

For product setup, see [Getting started](getting-started.md). For runtime flows, see [Architecture](architecture.md). These guides follow [the repository source](README.md#about-these-docs).

## Setup

CI and release builds use **Node 26**. Use the lockfile and a compatible native build environment:

```sh
npm ci
npm run plugins:setup  # generate local SDKs and install locked source-plugin dependencies
npm run dev            # normally http://localhost:3000
npm run desktop:dev    # Next dev + Electron on localhost:3000
```

`plugins:setup` prepares each source package under `plugins/`: it generates its ignored `.sdk/` when needed, then runs `npm ci`. Run it after a fresh checkout and again after public API or plugin lockfile changes. Root typecheck/build includes plugin sources, so CI uses the same preparation. It does not build plugin bundles, install/enable plugins in your learning-data directory, or populate `core-plugins/`.

`npm run plugins:build-core` builds the four IDs in `core-plugins.json` and stages complete app-owned packages in generated `core-plugins/<id>/`. `dev` and `build` run it automatically; `desktop:dev`, `desktop:dist` and `dev:fresh` use those entry points. Core code loads directly from this directory; restart the server after source edits/rebuilding (there is no plugin hot reload). Do not use raw `next dev`/`next build` without first staging core packages. Fresh checkouts need `plugins:setup` before these commands.

`desktop:dev` waits for the development server to answer HTTP before opening its Electron window, including core-package staging and first-route compilation. Startup has a 30-second total budget; an unavailable server produces a terminal/log error and unsuccessful exit, while Next's development error pages remain visible normally.

For a community/developer plugin, build in its source directory and follow the [installation guide](plugin-authoring.md#package-and-installation). Generated `core-plugins/`, plugin `dist/`, `.sdk/` and `node_modules/` stay out of Git. UI Showcase remains a developer example, not a shipped core package. Never install a community package using a reserved core ID.

Core data lives in `<learning data>/core-plugin-data/<id>/`; community code/data remains `<learning data>/plugins/<id>/{dist,data}/`. All newly discovered plugins start disabled. Core code is never copied into the learning-data directory, and switching to this layout does not migrate old development data.

No key is needed to open the UI. Configure connections and the Strong/Cheap/Vision slots before model-driven use; there are no factory model selections. OpenRouter is supported, not mandatory.

```sh
npm run build          # stage core plugins, then Next production/standalone build
npm start              # serve the production build with Next
```

`npm run desktop:dist` is the local **signed macOS** packaging path, not a portable unsigned shortcut. Prerequisites and Windows/Linux instructions are in [Desktop builds and releases](desktop-release.md).

### Other devices on your network

`npm run dev`, `npm start`, and `desktop:dev` listen on `localhost` only. Browser-only mode has **no login**: anyone who can reach the port can read every chat and setting, change saved keys, and start agent turns. To open it from another device on a network you trust, pass a later host flag:

```sh
npm run dev -- -H 0.0.0.0     # then browse to http://<this machine's IP>:3000
```

The API accepts `localhost` and IP addresses as the host name. To use any other name (`mymac.local`, a reverse-proxy domain), list it in `LH_ALLOWED_HOSTS`. Browser writes must come from the same origin as the page.

## Configuration

Nonsecret settings are deltas in `<data root>/settings.json`; absent values resolve through `src/core/settings.ts` and `settings-resolution.ts`. Models and role overrides are settings, not environment variables. [Prompt overrides](../src/agent/prompts/README.md) live under `<data root>/prompts/` and require explicit enable switches.

| Variable | Purpose |
| --- | --- |
| `LH_DATA_DIR` | Mutable chats/jobs/graph/settings/prompts; default repo `data/`. |
| `LH_AUTH_FILE` | Keys/custom-endpoint binding; default repo-root `auth.json`, outside `data/`. |
| Provider API-key variables | Optional, selected-provider dependent; UI names are in `src/core/auth-keys.ts`. |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `OLLAMA_API_KEY` | Optional search adapters. Without a Settings pin, the first keyed engine wins: Tavily → Brave → Exa → Firecrawl → Ollama. A pinned engine requires its own key; no silent fallback. Ollama search is hosted at ollama.com, not a local model server. Page fetching is independent; research can fetch known URLs without a search key. |
| `DEEPGRAM_API_KEY` | Optional dictation token minting. |
| `CHROME_PATH` | Chrome/Chromium executable fallback for demo verification; Electron's browser helper is primary. No extra Chromium is downloaded. |
| `LH_ALLOWED_HOSTS` | Browser-only mode: extra host names the API accepts besides `localhost` and IP addresses. Comma-separated, case-insensitive, port ignored, no wildcards. |

Ordinary Next development can read `.env.local`. Real environment keys take precedence over saved keys. Saved auth is restrictive-permission plaintext, not an encrypted vault. Packaged Electron sets separate data/auth locations under `userData`; it does not use the repo development profile.

Provider-specific setup and limitations: [Claude Code](claude-code.md), [custom endpoints](custom-providers.md), [context/cost accounting](compaction-accounting.md).

### Subscription connections in web/dev

`npm run dev` and `npm start` support ChatGPT, GitHub Copilot, and Grok sign-in. `desktop:dev` uses those same dev-server connections; packaged desktop has a separate main-process credential owner/private transport. Subscription routes do not fall back to API-key billing.

Web/dev writes `chatgpt-credentials.json`, `github-copilot-credentials.json`, and `xai-credentials.json` **beside `LH_AUTH_FILE`**, in the repo by default—not under `data/` or a global Pi profile. Git/build exclusions cover these files and their write temporaries. Refresh serialization is process-local: use one server per credential directory.

ChatGPT's callback listener is `127.0.0.1` on the **server's machine**; complete sign-in in a browser there. Copilot/Grok use device codes. Allow the initiating browser's sign-in tab if blocked; Electron dev opens provider pages in the system browser. Connected browsers share server credentials, background-use consent, keys, and learning data.

This is **trusted local/shared development**, not multi-user hosting. The API's host-name and same-origin checks block DNS rebinding and cross-site writes from other websites, but they are not user authentication; nor are the short-lived, origin-bound, one-use browser-opening actions. Do not expose the server to untrusted users/public Internet without an independent access gate. Per-user isolation, remote ChatGPT callback routing, and credential import are not implemented.

## Safe local work

Use a disposable data root and a separate empty `{}` auth file:

```sh
LH_DATA_DIR=/absolute/path/to/scratch/data \
LH_AUTH_FILE=/absolute/path/to/scratch/auth.json \
npm run dev -- --port 3001
```

These variables isolate app records/saved keys, **not every external effect**. Ambient keys still win; subscription files follow the auth directory; Claude Code can use its native profile. File tools have broad read access under the server's user, subject to the [path guard](architecture.md#file-access-and-external-services). A scratch data root is not a filesystem or credential sandbox. Use synthetic fixtures/fake providers for automated reproduction and avoid personal files or ambient credentials.

Do not commit `.env.local`, credentials, or learning records. Do not copy a personal profile into a fixture. Avoid separate writers against live profiles; store initialization and maintenance scripts can mutate data or invoke model stages. Inspect scripts before using them. See [storage and compatibility](architecture.md#storage-and-notifications) before changing formats.

Read the relevant installed Next guide under `node_modules/next/dist/docs/` before framework-facing changes. The import restrictions live in `eslint.config.mjs`; they do not enforce every architectural convention. [Architecture's code map](architecture.md#code-boundaries) and [prompt composition](../src/agent/prompts/README.md) identify the main entry points. For plugins, start with the [authoring/capability map](plugin-authoring.md), [host source map and verification](plugin-architecture.md), [`examples/plugins/`](../examples/plugins/) templates and [`plugins/`](../plugins/) feature sources.

## Debugging

- `LH_PROVIDER_EVENTS=1` saves raw provider events under the selected data root. They may contain private lesson/provider content.
- `LH_BACKGROUND_CAPTURE=auditor` (or comma-separated roles, or `all`) captures background requests/results. Roles are `researcher`, `demoBuilder`, `extractor`, `auditor`, `visualMaker`, and `pdfReader`; foreground teaching/probing is excluded.

For example:

```sh
LH_BACKGROUND_CAPTURE=auditor npm run desktop:dev
```

The flag must reach the **Next server**; restart an existing server to change it. Captures are off by default and written to `<data root>/debug/background-captures/<role>-<run ID>.json`. Each file retains the last request and response/error/tool results, with prior conversation in that request and compact per-turn timings—not every request body.

`request.format: provider` means adapter-exposed outgoing payload after app transport restrictions; `context` means model-facing conversation, not HTTP wire (for example, CLI). Captures do not enable thinking or recover reasoning a provider did not return. Request options/auth headers are not recorded, recognized nested credential/header fields are redacted, and POSIX files are owner-only. They still contain private source/graph content, have **no automatic expiry**, and require review before sharing and manual deletion when no longer needed. Capture/serialization errors do not fail workers.

For frontend failures, inspect the actual UI, requests, console, and state. A static render alone does not establish that an interaction works.

## Checks

```sh
npm test               # node:test via tsx; injected engines, fixtures, fake transports
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint, including import restrictions
npm run build          # Next production build
```

The suite requires no paid models or real sign-in. Some tests use temporary files, native processes, or local fake endpoints: deterministic does not mean every test is pure or cannot bind a loopback port. Inspect focused-suite setup before running beside a live app.

[Golden fixtures](../tests/fixtures/golden-data/README.md) exercise saved records through production paths. Keep compatibility expectations with intentional format changes; do not hand-edit fixture content to make tests pass. [Standalone skill-reader tests](../tests/skills/README.md) run separately with Python and no app runtime.

Additional runtime gates have prerequisites:

| Check | Prerequisite / purpose |
| --- | --- |
| `node scripts/smoke-provider-runtime.mjs` | Fresh build; traced provider payload/runtime paths with fixtures. Also used during packaging. |
| `node scripts/smoke-web-subscriptions.mjs` | Build, no dev server running; isolated synthetic connection checks, external traffic blocked. Briefly changes/restores a source mtime to exercise reload. |
| `node scripts/build-plugin-types.mjs` | Builds the portable type-only plugin SDK under `dist/plugin-sdk`. |
| `node scripts/build-server.mjs` then `node scripts/smoke-server.mjs --isolated --browser` | Fresh build; assemble/verify a source-free standalone copy, installed plugin backends and browser UI. Add `--electron` for Electron's bundled Node; browser checks require local Chrome/Chromium. |
| Other `scripts/smoke-*.mjs` | Standalone/native renderers, image workers, demo helper, compression, file paths, opening. Read each script and the [release guide](desktop-release.md) before running. |

Run checks proportionate to the change. Offline gates prove exercised contracts, not live entitlements or model-authored lesson quality.
