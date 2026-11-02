# Phone build (iPhone home-screen app → Capacitor later)

Status: **Phase 0 done: the on-device backend works.** The real LearnHarness server code runs inside a web page, stores everything on the device, and runs a lesson turn against a model provider directly from the browser. There is no phone UI yet; Phase 0 ships a bare proof page.

## The plan (owner-approved)

Standalone: no PC, no server. The app runs in Safari as a home-screen web app (free, no Mac, no expiry). Later the same code gets wrapped with Capacitor for native builds. API keys only: Claude subscription logins need the `claude` CLI, which phones can't run.

| # | Phase | Result |
|---|---|---|
| 0 | Proof run | **Done.** A lesson turn runs in the browser with on-device storage |
| 1 | Lessons on iPhone | Phone layout of the session UI, installable web app, hosting (Cloudflare Pages), zip backup/restore in the desktop data layout (moves desktop sessions to the phone) |
| 2 | Knowledge graph | Extraction + touch graph view |
| 3 | Practice sets | |
| 4 | Helpers, files & voice | Researcher (Google CSE + Jina reader), visual maker, demos (no headless check), PDFs, notes import, dictation |
| 5 | Native wrap | Capacitor Android APK; iOS with a Mac |

## How it works

The desktop route handlers (`app/api/**/route.ts`) are plain `Request → Response` functions, and the stores (`src/store/*`) are synchronous `node:fs` code. The phone build reuses **both unchanged**:

- **`node:fs` → an in-memory file tree** (`src/browser/shims/vfs.ts`, `fs.ts`). It loads from IndexedDB at boot and writes back after every change (`src/browser/persist.ts`). On-device data keeps the desktop layout: `/lh/data/chats/*.json`, `/lh/data/graph/*.jsonl`, `/lh/data/auth.json`, …
- **Other Node built-ins → shims** (`src/browser/shims/`): `path` (POSIX), `os`, `url`, `crypto` (sync SHA-256/HMAC matching Node byte for byte), `Buffer`, and a `process` global. Desktop-only modules (`child_process`, `http`, native packages like resvg/canvas/puppeteer, MCP's HTTP server, Bedrock's HTTP/2) become stubs that throw only when called.
- **`/api/*` → an in-page router** (`src/browser/router.ts`). It matches Next's precedence (static > `[param]` > `[...catchAll]`) over every `app/api/**/route.ts`, enumerated at build time, and loads each route module on first use. `installApiFetch()` (`src/browser/backend.ts`) routes the page's same-origin `/api/*` fetches there. Everything else, including provider calls, goes to the network.
- **Prompts** (`src/agent/**/*.md`) are embedded in the bundle and seeded into the virtual tree at `/lh/app/…`, where `config.ts`'s `ROOT` points in this build.
- **Provider calls** go straight from the browser through pi-ai, which supports browsers and sends Anthropic's `anthropic-dangerous-direct-browser-access` header.

`src/browser/` is the phone build's composition root. A lint zone (`eslint.config.mjs`) keeps every other layer from importing it.

## Commands

```bash
npm run mobile:build   # → dist-mobile/ (static files; serve over HTTPS or localhost)
npm run mobile:smoke   # build + headless-Chromium proof (needs Playwright + Chromium)
```

`mobile:smoke` serves `dist-mobile/` and opens `/spike/index.html`. It replaces `api.anthropic.com` with a scripted streaming reply, so no key, network, or spend is involved. It then saves a key, picks a model, runs a turn, reloads, and asserts:
- the session, key and model survived the reload (IndexedDB);
- the provider request carried the bundled system prompt, the agent's tools, the browser-access header, and the on-device key;
- nothing else left the page, and there were no page errors.

Shim behavior against real Node is unit-tested in `tests/browser-shims.test.ts` (part of `npm test`).

### Trying the proof page on an iPhone

The page needs HTTPS (IndexedDB persistence and `crypto.randomUUID` require a secure context), so a plain LAN `http://` address won't work. One free option: run `npm run mobile:build`, upload the `dist-mobile/` folder with Cloudflare Pages' **direct upload**, and open `https://<project>.pages.dev/spike/index.html` in Safari.

## Known gaps after Phase 0

- **Not yet run on real iOS Safari or against the live Anthropic API.** The automated proof uses headless Chromium and a scripted provider reply (this build environment can't reach either). Small fallbacks cover `Response.json`, `AbortSignal.any` and `Promise.withResolvers` on Safari before 17.4.
- **When a turn starts, `POST /api/chat` acknowledges and the turn runs in the page.** iOS pauses a backgrounded web app, so a turn can stall if you switch apps. Phase 1 handles resume and retry.
- **The learner-file tools (`read`/`ls`/`find`/`grep`) still go to the agent**, but they see an empty virtual home directory. Phase 1 decides what replaces them.
- **Bundle size:** about 8 MB of JS unminified (about 1.5 MB gzipped), split into lazily loaded chunks. Not yet optimized.
