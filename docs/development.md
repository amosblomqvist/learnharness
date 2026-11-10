# Development

For product setup, see [Getting started](getting-started.md). For runtime flows, see [Architecture](architecture.md). These guides follow [the repository source](README.md#about-these-docs).

## Setup

CI and release builds use **Node 26**. Use the lockfile and a compatible native build environment:

```sh
npm ci
npm run dev            # normally http://localhost:3000
npm run desktop:dev    # Next dev + Electron on localhost:3000
```

No key is needed to open the UI. Configure connections and the Strong/Cheap/Vision slots before model-driven use; there are no factory model selections. OpenRouter is supported, not mandatory.

```sh
npm run build          # Next production build, including standalone output
npm start              # serve the production build with Next
```

`npm run desktop:dist` is the local **signed macOS** packaging path, not a portable unsigned shortcut. Prerequisites and Windows/Linux instructions are in [Desktop builds and releases](desktop-release.md).

## Configuration

Nonsecret settings are deltas in `<data root>/settings.json`; absent values resolve through `src/core/settings.ts` and `settings-resolution.ts`. Models and role overrides are settings, not environment variables. [Prompt overrides](../src/agent/prompts/README.md) live under `<data root>/prompts/` and require explicit enable switches.

| Variable | Purpose |
| --- | --- |
| `LH_DATA_DIR` | Mutable chats/jobs/graph/settings/prompts; default repo `data/`. |
| `LH_AUTH_FILE` | Locates the key store: the encrypted `auth.enc.json` lives beside it; `auth.json` itself is only a plaintext hand-edit inbox. Default repo-root `auth.json`, outside `data/`. |
| `LH_AUTH_MASTER_KEY` | Optional base64 32-byte master key for the key store; overrides the OS credential store, which is then never touched. For tests, CI, headless Linux and scratch profiles. |
| Provider API-key variables | Optional, selected-provider dependent; UI names are in `src/core/auth-keys.ts`. |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `OLLAMA_API_KEY` | Optional search adapters. Without a Settings pin, the first keyed engine wins: Tavily → Brave → Exa → Firecrawl → Ollama. A pinned engine requires its own key; no silent fallback. Ollama search is hosted at ollama.com, not a local model server. Page fetching is independent; research can fetch known URLs without a search key. |
| `DEEPGRAM_API_KEY` | Optional dictation token minting. |
| `CHROME_PATH` | Chrome/Chromium executable fallback for demo verification; Electron's browser helper is primary. No extra Chromium is downloaded. |

Ordinary Next development can read `.env.local`. Real environment keys take precedence over saved keys. Saved keys are encrypted at rest ([below](#byok-key-storage-authencjson)); environment variables and `.env.local` stay plaintext. Packaged Electron sets separate data/auth locations under `userData`; it does not use the repo development profile.

### BYOK key storage (`auth.enc.json`)

Keys saved in Settings, including the custom-endpoint key and its binding, go through one store (`src/store/auth.ts`).

- **Where.** The encrypted file sits next to `LH_AUTH_FILE` with the same basename plus `.enc.json`, so `auth.json` → `auth.enc.json` (packaged: `userData/auth.enc.json`). It is `{ "version": 1, "alg": "aes-256-gcm", "entries": { VAR: { iv, tag, ct } } }`, base64 fields. Each value gets a fresh random 12-byte IV, and the env-var name is the GCM AAD, so entries cannot be swapped between names. Writes are atomic (temp + rename) at mode 0600. The learner file tools, build exclusions and payload checks treat it like `auth.json`.
- **Master key.** A random 32-byte key lives in the OS credential store through `@napi-rs/keyring`: service `LearnHarness`, account `auth-master-key`, base64 value (Windows Credential Manager, macOS Keychain, Linux Secret Service). It is created on the first write and cached in memory per process. `LH_AUTH_MASTER_KEY` (base64, 32 bytes) overrides it, and the keyring is then never touched. `LH_AUTH_KEYRING_ACCOUNT` overrides the account name (smoke tests only). Under `NODE_ENV=test` the native keyring is never loaded: the default backend is a process-local in-memory one, a test that shares a store across processes sets `LH_AUTH_MASTER_KEY`, and the store tests inject fakes.
- **No silent plaintext fallback.** With no key source, writes throw and `/api/keys` answers 500 with a readable message. Reads return `{}` and log one warning.
- **Hand-edit inbox.** A plaintext `auth.json` at `LH_AUTH_FILE` is still accepted: on the first store access and on every read, its entries are imported into the encrypted store (the plaintext value wins over an existing encrypted one, since a hand-edit is newer intent), then the file is overwritten with random bytes, fsynced and unlinked (a symlink is only unlinked, never its target). If no key source is available the plaintext file is left untouched, with a warning, so no key is ever deleted without being re-stored. The overwrite is best-effort: on SSDs, journaling or copy-on-write file systems and synced folders, older copies of the plaintext may survive.
- **Threat model.** This protects against file exfiltration: backups, cloud sync, copying the data directory, accidentally bundling or committing the file. It does **not** protect against malware running as the same OS user, which can ask the credential store for the master key just as the app does. Subscription sign-in credentials (`*-credentials.json`) are separate stores and are not covered.
- **Reset.** If the encrypted file exists but the master key is missing or wrong (a new OS account, a wiped keychain, a different `LH_AUTH_MASTER_KEY`), the store reads as empty and writes refuse rather than clobber entries it cannot decrypt. Delete `auth.enc.json` and re-enter your keys to reset.

Provider-specific setup and limitations: [Claude Code](claude-code.md), [custom endpoints](custom-providers.md), [context/cost accounting](compaction-accounting.md).

### Subscription connections in web/dev

`npm run dev` and `npm start` support ChatGPT, GitHub Copilot, and Grok sign-in. `desktop:dev` uses those same dev-server connections; packaged desktop has a separate main-process credential owner/private transport. Subscription routes do not fall back to API-key billing.

Web/dev writes `chatgpt-credentials.json`, `github-copilot-credentials.json`, and `xai-credentials.json` **beside `LH_AUTH_FILE`**, in the repo by default—not under `data/` or a global Pi profile. Git/build exclusions cover these files and their write temporaries. Refresh serialization is process-local: use one server per credential directory.

ChatGPT's callback listener is `127.0.0.1` on the **server's machine**; complete sign-in in a browser there. Copilot/Grok use device codes. Allow the initiating browser's sign-in tab if blocked; Electron dev opens provider pages in the system browser. Connected browsers share server credentials, background-use consent, keys, and learning data.

This is **trusted local/shared development**, not multi-user hosting. Same-origin JSON/custom-header checks and short-lived, origin-bound, one-use browser-opening actions are not user authentication or DNS-rebinding protection. Do not expose the server to untrusted users/public Internet without an independent access/host gate. Per-user isolation, remote ChatGPT callback routing, and credential import are not implemented.

## Safe local work

Use a disposable data root and a separate auth location (nothing needs to exist there yet):

```sh
LH_DATA_DIR=/absolute/path/to/scratch/data \
LH_AUTH_FILE=/absolute/path/to/scratch/auth.json \
npm run dev -- --port 3001
```

A scratch `LH_AUTH_FILE` gets its own `auth.enc.json` but, unless `LH_AUTH_MASTER_KEY` is also set, still uses the real OS credential store for its master key. These variables isolate app records/saved keys, **not every external effect**. Ambient keys still win; subscription files follow the auth directory; Claude Code can use its native profile. File tools have broad read access under the server's user, subject to the [path guard](architecture.md#file-access-and-external-services). A scratch data root is not a filesystem or credential sandbox. Use synthetic fixtures/fake providers for automated reproduction and avoid personal files or ambient credentials.

Do not commit `.env.local`, credentials, or learning records. Do not copy a personal profile into a fixture. Avoid separate writers against live profiles; store initialization and maintenance scripts can mutate data or invoke model stages. Inspect scripts before using them. See [storage and compatibility](architecture.md#storage-and-notifications) before changing formats.

Read the relevant installed Next guide under `node_modules/next/dist/docs/` before framework-facing changes. The import restrictions live in `eslint.config.mjs`; they do not enforce every architectural convention. [Architecture's code map](architecture.md#code-boundaries) and [prompt composition](../src/agent/prompts/README.md) identify the main entry points.

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
| Other `scripts/smoke-*.mjs` | Standalone/native renderers, image workers, demo helper, compression, file paths, opening. Read each script and the [release guide](desktop-release.md) before running. |

Run checks proportionate to the change. Offline gates prove exercised contracts, not live entitlements or model-authored lesson quality.
