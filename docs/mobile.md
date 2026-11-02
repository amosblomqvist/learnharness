# Phone app (iPhone home-screen app → Capacitor later)

Status: **Phase 4 done: lessons, the knowledge graph, practice, and the background helpers, your files and notes import on the phone.** The real LearnHarness app (same screens, same server code) runs entirely on the device as an installable web app. There is no PC and no server; your API keys and data stay on the phone.

## The plan (owner-approved)

Standalone, API keys only. Claude subscription logins need the `claude` CLI, which phones can't run. The app installs from Safari as a home-screen web app (free, no Mac, no expiry). Later the same code gets wrapped with Capacitor for native builds.

| # | Phase | Result |
|---|---|---|
| 0 | Proof run | **Done.** A lesson turn runs in the browser with on-device storage |
| 1 | Lessons on iPhone | **Done.** Real UI on the phone, phone layout polish, installable + offline, Cloudflare Pages hosting, backup/restore in the desktop data layout |
| 2 | Knowledge graph | **Done.** On-device extraction, graph home usable by touch (pinch, pan, tap a node, double-tap to re-frame) |
| 3 | Practice sets | **Done.** Practice sessions (topic or picked graph ideas) by touch; a shared reveal bug fixed; on-device saves made durable |
| 4 | Helpers, files & voice | **Done.** Researcher (Tavily + Jina Reader), visual maker, demos *with* their check, PDFs, notes import, "Your files" for the file tools; dictation via the iPhone keyboard |
| 5 | Native wrap | Capacitor Android APK; iOS with a Mac |

## Put it on your iPhone

**1. Host it (free, Cloudflare Pages).** Pick one route.

- **Connect the GitHub repo**, which redeploys on every push. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to Git**, pick your fork, and set:
  - Production branch: the branch to publish
  - Build command: `npm run mobile:dist`
  - Build output directory: `dist-mobile`
  - Environment variables: `NODE_VERSION` = `22`, and `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (skips the desktop Electron download during install)
- **Or upload from your computer:**

  ```bash
  npm ci
  ```

  ```bash
  npm run mobile:dist
  ```

  ```bash
  npx wrangler pages deploy dist-mobile --project-name learnharness
  ```

Cloudflare serves `index.html` for every unknown path, which the app's on-device routing needs. `dist-mobile/_headers` sets caching: the page and service worker always revalidate, and hashed chunks are immutable.

**2. Install.** Open `https://<project>.pages.dev` in **Safari**, then **Share → Add to Home Screen**. Open it from the home screen.

**3. Set up.** Tap **Set up your models**, add an API key (Anthropic, OpenRouter, OpenAI, Google, …), and pick the models. Then start a lesson. Optional extras:
- add a **Tavily** key (Settings → Providers → Search) to let the researcher search the web;
- add notes and PDFs in **Settings → Phone data → Your files** to let the teacher read them;
- use the iPhone keyboard's mic to dictate.

**4. Bring your desktop sessions (optional).**
1. On the computer, zip the desktop app's `data` folder:
   - macOS: `~/Library/Application Support/LearnHarness/data`
   - Windows: `%APPDATA%\LearnHarness\data`
   - Linux: `~/.config/LearnHarness/data`
2. Get the zip onto the phone (AirDrop, iCloud Drive, …).
3. In the app, go to **Settings → Phone data → Restore**.

## How it works

### On-device backend (Phase 0)

The desktop route handlers (`app/api/**/route.ts`) are plain `Request → Response` functions, and the stores (`src/store/*`) are synchronous `node:fs` code. The phone build reuses both unchanged:

- **`node:fs` → an in-memory file tree** (`src/browser/shims/vfs.ts`, `fs.ts`). It loads from IndexedDB at boot and writes back after every change (`src/browser/persist.ts`). Each change gets its own IndexedDB transaction straight away, committed at once, and pending writes are flushed when the app is hidden or closed, so a save survives closing the app right after it. On-device data keeps the desktop layout under `/lh/data` (`chats/*.json`, `graph/*.jsonl`, `settings.json`, …). Keys live in `/lh/data/auth.json`.
- **Other Node built-ins → shims** (`src/browser/shims/`): `path`, `os`, `url`, `crypto` (sync SHA-256/HMAC, byte-identical to Node), `Buffer`, and a `process` global. Desktop-only modules and native packages become stubs that throw only when called.
- **`/api/*` → an in-page router** (`src/browser/router.ts`) over every route module, using Next's precedence. `installApiFetch()` (`src/browser/backend.ts`) answers the page's same-origin `/api/*` fetches on the device. Provider calls go straight to the network via pi-ai, which sends Anthropic's browser-access header.
- **Prompts** (`src/agent/**/*.md`) are embedded in the bundle at `/lh/app/…`, where `config.ts`'s `ROOT` points.

### The app (Phase 1)

- **The desktop components, bundled as a single-page app** (`src/browser/app/`). `main.tsx` boots the backend and renders `app.tsx`, which provides the same providers as `app/layout.tsx` and the same pages as `app/**/page.tsx`. Each page's server-side reads (settings record, chat record) become `/api/*` fetches.
- **The Next.js surface the components use** (`useRouter().push`, `usePathname`, `<Link>`) resolves to a small history-API router (`navigation.tsx`). `EventSource` for `/api/events` is replaced by a fetch-based reader (`event-source.ts`), so it reaches the on-device backend.
- **CSS** is the same `app/globals.css`, compiled by Tailwind (PostCSS). Fonts come from Google Fonts and are cached for offline use.
- **Phone layout polish** (owner: "polish existing"). `phone.css` is scoped to `html.lh-phone`, which only the phone build sets:
  - the sidebar is a slide-over drawer, closed by default, that closes on navigation or a tap outside;
  - keyboard-only hints are hidden;
  - the Settings section list becomes a row above the content;
  - desktop-only settings are hidden: Keyboard, General/auto-update, subscription logins, Claude CLI;
  - inputs stay ≥16px so iOS doesn't zoom.

  Desktop changes for this are inert there:
  - an `lh-kbd-hint` class on the two dock hints;
  - `components/settings/extra-sections.ts`, through which the phone build registers **Phone data**.
- **Learner-file tools** (`read`/`ls`/`find`/`grep`) were switched off in Phase 1. Since Phase 4 they are back unchanged, searching the files you add (see "Your files" below).
- **Phone data** (`phone-data.tsx`, `src/browser/backup.ts`, `src/browser/zip.ts`):
  - shows storage use;
  - **Save a backup** zips the data folder in the desktop layout. It uses the share sheet on iOS, so you can choose **Save to Files**.
  - **Restore** accepts a backup or a zipped desktop `data` folder, however it was zipped (Finder litter is ignored). It **replaces** the phone's data after a confirmation and automatically downloads a backup of the current data first (owner decision).
  - API keys are never in a backup and survive a restore, matching the desktop, where keys live outside `data`.
  - The section links to this build's source code (AGPL-3.0 §13). The build takes the URL from `LH_SOURCE_URL`, else the git `origin` remote.
- **Offline and install:**
  - `manifest.webmanifest` and icons (`src/browser/static/`, full-bleed for iOS);
  - a service worker generated from `sw.template.js`, which pre-caches the app shell (2.9 MB minified) and caches other files on first use;
  - a new version takes over after the app is closed.
- **Interrupted turns:** iOS pauses a backgrounded web app, so a turn in flight can be cut off. The existing turn machinery already handles it. A dropped provider connection, or the app being killed mid-turn and reopened, leaves the session showing "Something went wrong: Connection error." with **Retry**, and Retry completes the turn (verified in the browser).

### Helpers, files and notes (Phase 4)

Four owner decisions shaped this phase, made after probing which services a web app may call (CORS):

| Service | From a phone web app |
|---|---|
| Tavily search | ✅ allowed |
| Brave search | ❌ blocked |
| Jina Reader | ✅ allowed |
| Arbitrary web pages | ❌ blocked |
| Deepgram token minting | ❌ blocked |

- **Research: Tavily + Jina.** On the phone, search uses Tavily (Brave is hidden in Settings). Every page, and every web PDF, is read through Jina Reader: the phone build sets `LH_WEB_READER=only` (`config.ts` `WEB_PAGES_VIA_READER`).
  - `web_fetch` goes straight to the reader.
  - `web_fetch_pdf` (a raw download) tells the researcher to use `web_fetch`.
  - Desktop is unchanged: it fetches pages directly and uses Jina only as a fallback.
- **Dictation: hidden.** The iPhone keyboard's own mic dictates into every field. The Dictate button and the Deepgram settings group are hidden in `phone.css`.
- **Your files: in Settings → Phone data.** Files you add are stored in the phone's virtual home folder (`/lh/home`, `src/browser/files.ts`), which is the folder the learner-file tools already search. So `read`/`ls`/`find`/`grep`, the `pdf` job and their prompt section work unchanged. The list shows each file with Remove, plus **Add files…**.
- **Backups include your files** in a `files/` folder beside `data/`. A restore replaces the added files only when the zip has a `files/` folder; a zipped desktop data folder has none, and leaves them alone.
- **Background helpers run in the page.** The sub-agents' engines (`headless.ts`) are swapped at build time for `src/browser/headless.ts`:
  - **demos** run in a hidden iframe sandboxed *without* same-origin access, so model-written code can't reach the app's storage or keys. An injected script reports console errors, uncaught errors and failed loads, then evaluates the probe. So the demo check works on the phone too.
  - **SVGs** are drawn onto a canvas and exported as PNG.
  - **PDF pages** are rendered by pdf.js on a canvas. Its worker ships as `/app/pdf.worker.js`, set up in `src/browser/pdfjs.ts`, and its standard fonts are copied to the URL `pdf-ops.ts` derives.
- **Images** (the `read` tool, visual maker, PDF reader): Photon in a worker thread is replaced by the browser's own decoder and a canvas (`src/browser/image.ts`), with the same keep / resize / re-encode contract. On iOS this also decodes HEIC photos.
- **Notes import** (graph toolbar → Import) works unchanged.
- **The drawer starts closed on every launch.** The desktop remembers an open sidebar; on a phone it would cover the page.

### Practice (Phase 3)

- **Practice sessions run unchanged on the phone.** The agent's `problem` and `conclude` tools drive the same problem card and "Your thinking" box as desktop. Starting points:
  - type a topic in Practice mode;
  - or tap **Pick nodes**, tick ideas in the Chains table, tap **Done**; the picked ideas ride the session's first message.
- **Bug fix in shared code** (`src/core/native-messages.ts` `problemInputForConclude`): when one reply concluded a problem *and* posed the next (the designed flow), the concluded card revealed the **next** problem's model solution. The search now starts before the conclude call within its own message. Desktop shares the fix, and there's a regression test in `tests/practice-record.test.ts`.
- **Storage durability fix** (`src/browser/persist.ts`): writes used to wait in a chain, one batch after another, so closing or reloading the app moments after a save could lose it (3 in 8 saves survived an instant reload in the test). Now every batch starts its own transaction immediately and commits (8 in 8). The smoke test checks this.

### The knowledge graph (Phase 2)

- **Extraction needs no phone-specific code.** It is model calls only: the extractor's `submit_findings` and the auditor's `submit_review`. The embedder was removed from the desktop app earlier. So the same pipeline runs in the page and writes the same ledgers (`/lh/data/graph/*.jsonl`).
  - It triggers as on desktop: automatically once enough of a session is uncovered, or from the session's coverage meter.
  - If iOS suspends the app mid-run, nothing is merged and the coverage ledger leaves those messages uncovered, so the next trigger redoes them.
- **Touch works through the existing canvas.** Pan and pinch are d3-zoom's touch support. A tap selects a node and opens its card (name, statement, source sessions).
- **Phone polish:**
  - the graph toolbar's Chains and Import buttons become icon-only, and the row stays inside its width cap, so it fits beside the sidebar button;
  - framing keeps clear of the toolbar and the composer through `--lh-fit-inset-*` CSS variables on the canvas, set in `phone.css`.
- **Desktop changes** (`components/graph-canvas.ts`, owner-approved):
  - **Double-tap or double-click on empty space re-frames the whole graph.** The camera is remembered between visits, so this is the way back after zooming away. On desktop, double-click previously did nothing.
  - **`fit()` frames the nodes where they are now**, not where they were when the data arrived; the layout simulation keeps moving them.
  - **`fitTransform` takes optional insets**, which default to none, so desktop framing is unchanged.
- **Notes import** reads file contents, not paths, so it also works on the phone (verified in Phase 4).

`src/browser/` is the phone build's composition root. A lint zone keeps every other layer from importing it.

## Commands

```bash
npm run mobile:build   # dev build → dist-mobile/ (source maps + meta.json)
```

```bash
npm run mobile:dist    # deploy build → dist-mobile/ (minified, no maps)
```

```bash
npm run mobile:smoke   # dev build + the end-to-end browser check below
```

`scripts/smoke-mobile.mjs` serves `dist-mobile/` with single-page-app fallback and drives the real app at iPhone size in headless Chromium. Anthropic is replaced by scripted streaming replies, so no key, network, or spend is involved. The checks, in order:
1. Configure a key and models; start a lesson from the home composer.
2. The agent's question appears; answer it and the reply streams in.
3. The provider request carried the bundled prompt, the tools (learner-file set included), the browser-access header, and the on-device key. Dictate is hidden.
4. Extraction runs on the device (scripted extractor and auditor) and the graph holds the ideas. The graph toolbar fits beside the sidebar button. After a pinch-zoom, a double-tap on empty space re-frames every node between the toolbar and the composer, and a tap on a node opens its card.
5. Practice: in Practice mode, pick the graph's ideas through the Chains table and start a session; the agent receives the picked ideas. Answer the problem: the verdict shows, the concluded card reveals that problem's own solution, and the next problem is posed.
6. Your files and helpers: add a note and a PDF in Phone data. The teacher reads the note. A research job (scripted Tavily + Jina) and a PDF job (pdf.js `pdf_info` plus a canvas-rendered page image) run in the background, and both briefs come back into the lesson. A notes file imported from the graph toolbar is extracted into the graph.
7. The drawer opens over the page and closes on navigation. Settings shows Tavily and hides Brave, Deepgram and the desktop-only sections.
8. Backup produces a desktop-layout zip without keys, with added files under `files/`.
9. Restore of a zipped desktop folder replaces the phone's sessions and keeps the key.
10. Everything survives a reload, and the app starts offline from the service worker.
11. A save survives reloading the app the instant it lands (4 of 4 fresh runs).
12. Nothing else left the page, and there were no page errors.

It passes on both the dev and the minified build.

Unit tests: `tests/browser-shims.test.ts` checks the shims against real Node. `tests/browser-backup.test.ts` covers the zip codec (including interop with `zip`/`unzip`), finding the data folder in a zip, restore keeping the keys, and added files in backups.

The browser engines in `src/browser/headless.ts` were also checked directly in Chromium during development:
- a broken demo's console error, uncaught error and failed image load were all caught;
- a working demo passed, and its probe returned a value;
- a demo trying to read the app's storage hit a SecurityError;
- an SVG rendered to PNG;
- a 2-page PDF rendered.

The demo and visual-maker *jobs* use these same engines through the same job runner as the research and PDF jobs the smoke test exercises.

## Known gaps after Phase 4

- **Not yet run on a real iPhone or against the live Anthropic API.** All browser verification is headless Chromium with scripted provider replies; this build environment reaches neither. Safari-specific behavior is the main risk: the share sheet, downloads from a home-screen app, IndexedDB persistence, and Safari before 17.4 (covered by small fallbacks).
- **On first open the graph is framed before its layout finishes settling**, so it can spread past the screen edges; double-tap re-frames it. The desktop app has the same behavior.
- **Node labels appear when zoomed in.** Desktop's hover glow has no touch equivalent; a tap shows the node's card instead.
- **The demo-builder and visual-maker jobs** haven't been run end to end with a scripted model; their engines were tested directly (above).
- **Jina Reader without an account is rate-limited**, so heavy research may hit its limits. It also sees the URLs the researcher reads.
- **Fonts load from Google on first launch**, then come from the cache.
- **Bundle:** about 4 MB of JS gzipped in total, split into lazily loaded chunks. The startup shell is 2.9 MB minified.
