# Plugin examples and source reading map

Use the [authoring guide](plugin-authoring.md) for workflow and lifecycle rules and the
[API reference](plugin-api/README.md) for public signatures. This page maps those APIs
to working source, not a second API specification. Read each project's README before
building or exercising it: plugins are trusted local code, not sandboxed extensions.

## Choose a starting point

| Start here | Role | What to learn |
| --- | --- | --- |
| [Hello plugin](../examples/plugins/hello-plugin/README.md) | Minimal starter; no build | Frontend activation, a view, explicit action placements, a host button/dialog and per-mount cleanup |
| [UI Showcase](../plugins/ui-showcase/README.md) | Runnable Community developer gallery | All 15 public UI methods, controlled values, family-local Reset and overlay ownership |
| [Flashcards](../plugins/flashcards/README.md) | Core source reference | A complete feature: knowledge/document input, durable worker outcomes, plugin-owned storage, tree, review surfaces and settings |
| [Coding questions](../plugins/coding-questions/README.md) | Core source reference | Teaching questions and repeated practice submissions, controlled editors, processing observations and saved-result rendering |
| [Drawing Pad](../plugins/drawing-pad/README.md) | Core source reference | Session-context actions, shortcuts, surfaces, learner-submission image attachment and acknowledgment-aware draft consumption |
| [Rich code blocks](../plugins/rich-code-blocks/README.md) | Core source reference | Conditional fence renderers, additive instructions, settings synchronization, local assets and bounded rendering |

Hello is the smallest place to begin. The official source projects are the primary
substantial examples; read a route below for the extension point you need rather than
copying a whole feature. UI Showcase is a developer gallery, **not** a shipped Core
plugin. The [focused recipes](#focused-recipes-for-gaps) fill remaining gaps instead
of replacing these primary examples.

## Core references are not Community packages

The four IDs **`flashcards`**, **`coding-questions`**, **`drawing-pad`** and
**`rich-code-blocks`** are reserved for app-shipped Core plugins, even when a Core
package is disabled, broken or missing. Their sources are included for study and
adaptation, not installation as Community duplicates. Enable the app-supplied features
in **Settings → Core plugins**. App updates supply Core code; writable records live
under `<learning data>/core-plugin-data/<id>/`, separate from that code.

A Community fork needs its **own manifest ID and matching folder name**. Also review
contribution/type identifiers, native tool names and code-fence names: changing a
plugin ID alone does not resolve every collision. In particular, do not assume a fork
can register `coding_question` / `coding_problem` or `smiles` / `abc` / `tikz` alongside
the originals. Follow the relevant public contract's ownership/admission rules.
Always use `ctx.directory` for code and `ctx.dataDirectory` for writable records;
do not infer one from the other.

UI Showcase uses the ordinary Community workflow in its README. Hello and the focused
recipes contain ready-to-load `dist/` files. Nothing in this reference is installed,
enabled or run automatically.

## Source layout and prerequisites

The downloaded authoring kit preserves the repository layout:

```text
<kit-root>/
  types/                          # shared, type-only SDK
  docs/                           # guide, API reference and this map
  examples/plugins/
    hello-plugin/
    managed-agent/
    teaching-extension/
  plugins/
    flashcards/
    coding-questions/
    drawing-pad/
    rich-code-blocks/
    ui-showcase/
```

Each `plugins/<id>/` project is exported **byte-for-byte from its canonical source
files**, including `src/`, `scripts/`, `tests/`, licenses/notices, manifests,
`package.json`, lockfile and TypeScript configuration where present. Generated or
local `node_modules/`, `.sdk/`, `dist/` and `data/` are excluded. The shared SDK stays
at kit-root `types/`; it is not duplicated into each project. Keep this layout intact
so README/source links work both in the repository and the extracted kit. Do not
install the whole kit as a plugin.

### TypeScript projects

For Coding questions, Drawing Pad, Rich code blocks and UI Showcase, copy the extracted
kit's `types/` **contents** into that project's `.sdk/` **before npm dependency setup**.
From the project's `plugins/<id>/` directory in the extracted kit:

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

These projects use the local `learnharness-plugin-api` package through `file:.sdk`.
The declarations are type-only, never a runtime host import. Set up the project's
development dependencies and the SDK's declared peers/types separately;
the source export does not supply a toolchain or installed dependencies. Consult
`types/package.json` for the matching peers rather than choosing arbitrary Pi versions.
A copied SDK by itself is not sufficient for typechecking without those prerequisites.

`npm run sdk` is **checkout-only**: it invokes
`../../scripts/build-plugin-types.mjs` from a LearnHarness source checkout with its
dependencies. That host generator is not supplied in the downloaded kit; use the
copy step above there. Flashcards is JavaScript and does not need `.sdk/` at all.

### Build separately from installation and tests

Once dependencies are available, every official source project has the build-only
command, run in its own directory:

```sh
npm run build
```

Its script writes directly to that project's `dist/`, bundles runtime dependencies
and copies required assets/notices. Build cleanup refuses symlinked `dist/` and
misplaced `dist/data/` and preserves sibling `data/`. It does not start/build the host,
install/enable a plugin, call a model or update Core code. For a newly identified
Community fork or UI Showcase, follow the [Community installation guide](plugin-authoring.md#package-and-installation);
do not install the four reserved-ID references.

## Reading routes

### Flashcards: a complete frontend/backend feature

Start with the [README](../plugins/flashcards/README.md) for generation, deck membership,
review/practice distinctions and the data lifecycle.

1. [`src/main.js`](../plugins/flashcards/src/main.js): view/action/settings
   registrations, controlled host widgets, explicit graph/file confirmation,
   `ctx.documents.toMarkdown` and frontend/backend calls.
2. [`src/library-tree.js`](../plugins/flashcards/src/library-tree.js): logical items
   versus tree occurrences, selection, stable rich content and local editing state.
   Then [`src/review.js`](../plugins/flashcards/src/review.js) for surface/content
   lifetime separation and keyboard-aware review controls.
3. [`src/backend.cjs`](../plugins/flashcards/src/backend.cjs): public learning reads,
   worker registration/start/subscribe/wait, validation, cancellation and durable
   outcome application. [`src/file-generation.cjs`](../plugins/flashcards/src/file-generation.cjs)
   and [`src/generation-prompts.cjs`](../plugins/flashcards/src/generation-prompts.cjs)
   separate chunking/protocol mechanics from model instructions.
4. [`src/store.cjs`](../plugins/flashcards/src/store.cjs) for plugin-owned persistence;
   [`src/scheduler.cjs`](../plugins/flashcards/src/scheduler.cjs),
   [`src/statistics.cjs`](../plugins/flashcards/src/statistics.cjs),
   [`src/dashboard.js`](../plugins/flashcards/src/dashboard.js) and
   [`src/practice-queue.js`](../plugins/flashcards/src/practice-queue.js) for product
   algorithms and presentation. Those algorithms are example policy, not host APIs.
5. [`tests/`](../plugins/flashcards/tests/) and
   [`scripts/build.mjs`](../plugins/flashcards/scripts/build.mjs): mocked host seams,
   domain regressions and packaging.

Generation can incur configured-model cost when explicitly confirmed. Reviewing,
manual writing and extra practice do not make model calls. Do not start generation
merely to inspect these sources.

### Coding questions: native teaching and practice contracts

Read the [README](../plugins/coding-questions/README.md),
[question contract](plugin-question-contract.md) and [problem contract](plugin-problem-contract.md).

1. [`src/contract.ts`](../plugins/coding-questions/src/contract.ts): separate
   teaching/practice definitions, payload schemas and model-facing execution policy.
2. [`src/backend.ts`](../plugins/coding-questions/src/backend.ts): `gradeAnswer`
   and `processSubmission` registrations. Follow into
   [`src/runner.ts`](../plugins/coding-questions/src/runner.ts) for literal program
   arguments, working directories, output caps, cancellation and cleanup.
3. [`src/main.ts`](../plugins/coding-questions/src/main.ts) and
   [`src/editor.ts`](../plugins/coding-questions/src/editor.ts): renderer registration,
   controlled editor values, readiness and editing-key integration.
   [`src/diagnostics.ts`](../plugins/coding-questions/src/diagnostics.ts) provides
   advisory syntax feedback, not a submission gate.
4. [`src/question-view.ts`](../plugins/coding-questions/src/question-view.ts),
   [`src/result-view.ts`](../plugins/coding-questions/src/result-view.ts),
   [`src/solution-view.ts`](../plugins/coding-questions/src/solution-view.ts) and
   [`src/disclosure.ts`](../plugins/coding-questions/src/disclosure.ts): saved prompts,
   output badges, teaching solutions and bounded mount cleanup.
5. [`tests/`](../plugins/coding-questions/tests/) and
   [`scripts/build.mjs`](../plugins/coding-questions/scripts/build.mjs): real local
   process tests, isolated browser fixture, bundles and dependency-license collection.

**Code execution is not sandboxed.** Learner and teacher test programs run with user
permissions and inherited environment. Timeouts and temporary directories are not
security isolation. Passing tests are observations, not automatic correctness or
practice conclusion; the host's native lifecycle remains authoritative.

### Drawing Pad: contextual actions and learner input preparation

Read the [README](../plugins/drawing-pad/README.md),
[view context](plugin-view-context.md) and [session-extension contract](plugin-session-extension-contract.md).

1. [`src/main.ts`](../plugins/drawing-pad/src/main.ts): contextual actions and scoped
   shortcuts, captured native surface target, settings and submission interception.
2. [`src/reference.ts`](../plugins/drawing-pad/src/reference.ts) and
   [`src/poses.ts`](../plugins/drawing-pad/src/poses.ts): respect host-selected input,
   reveal/availability and accepted-pose occurrences rather than reconstructing them.
3. [`src/state.ts`](../plugins/drawing-pad/src/state.ts) and
   [`src/submission.ts`](../plugins/drawing-pad/src/submission.ts): captured revisions,
   acknowledgment-aware consumption and additive native image attachment.
4. [`src/sheet.ts`](../plugins/drawing-pad/src/sheet.ts),
   [`src/strokes.ts`](../plugins/drawing-pad/src/strokes.ts) and
   [`src/geometry.ts`](../plugins/drawing-pad/src/geometry.ts): plugin-owned drawing,
   gestures, camera and bounded export geometry. Then
   [`src/capture.ts`](../plugins/drawing-pad/src/capture.ts) and
   [`src/fonts.ts`](../plugins/drawing-pad/src/fonts.ts) for cancellation-aware capture.
5. [`src/backend.ts`](../plugins/drawing-pad/src/backend.ts),
   [`src/settings.ts`](../plugins/drawing-pad/src/settings.ts),
   [`tests/`](../plugins/drawing-pad/tests/) and
   [`scripts/build.mjs`](../plugins/drawing-pad/scripts/build.mjs): preferences,
   public learning reads, validation, fixtures and notices.

Drawing state is per-window memory, not a durable editable answer store. The host
still owns submission acceptance, image processing and model image-capability rules.

### Rich code blocks: conditional rendering and bundled assets

Read the [README](../plugins/rich-code-blocks/README.md) for notation examples, limits,
transparent appearance and the distinction between static drawing and simulation.

1. [`src/main.ts`](../plugins/rich-code-blocks/src/main.ts) and
   [`src/backend.ts`](../plugins/rich-code-blocks/src/backend.ts): conditional
   `registerCodeBlock`, additive instructions, accepted settings and reconnect reads.
2. [`src/contract.ts`](../plugins/rich-code-blocks/src/contract.ts): family choices,
   validated settings, prompts and input/output/cache limits.
3. [`src/render.ts`](../plugins/rich-code-blocks/src/render.ts),
   [`src/tex-runner.ts`](../plugins/rich-code-blocks/src/tex-runner.ts) and
   [`src/tex-worker.ts`](../plugins/rich-code-blocks/src/tex-worker.ts): lazy assets,
   serial browser Worker jobs, cancellation and volatile cache lifetimes.
4. [`src/svg.ts`](../plugins/rich-code-blocks/src/svg.ts) and
   [`src/appearance.ts`](../plugins/rich-code-blocks/src/appearance.ts): rebuild vetted
   static SVG, constrain references and apply theme-aware paint without trusting raw HTML.
5. [`scripts/build.mjs`](../plugins/rich-code-blocks/scripts/build.mjs),
   [`THIRD-PARTY.md`](../plugins/rich-code-blocks/THIRD-PARTY.md),
   [`licenses/`](../plugins/rich-code-blocks/licenses/) and
   [`tests/`](../plugins/rich-code-blocks/tests/): local engine assets, upstream
   adaptations, licensing and real-library browser fixtures.

Rendering makes no model request. TeX Worker bounds and SVG sanitization are local
feature safeguards, not a sandbox for arbitrary plugin JavaScript.

### UI Showcase: all 15 UI methods

The [README gallery map](../plugins/ui-showcase/README.md#gallery-map) groups all methods
into 12 families. Start in [`src/gallery.ts`](../plugins/ui-showcase/src/gallery.ts):

| Area | Methods |
| --- | --- |
| Pickers | `mountModelPicker`, `mountThinkingPicker`, `mountKnowledgePicker` |
| Writing | `mountComposer`, `mountDictation`, `mountStandardComposer` |
| Controls/content | `mountButton`, `mountBadge`, `mountSettingsRows`, `mountMarkdown`, `mountTree`, `mountWorkerResult` |
| Overlays | `openMenu`, `openDialog`, `openSurface` |

Then read [`src/main.ts`](../plugins/ui-showcase/src/main.ts) for capability checks and
placements, [`src/tree.ts`](../plugins/ui-showcase/src/tree.ts) for occurrence-local
state and drafts, [`src/surfaces.ts`](../plugins/ui-showcase/src/surfaces.ts) for
page-body/native-target and nested ownership, and
[`src/dom.ts`](../plugins/ui-showcase/src/dom.ts) for scoped cleanup. Compare
[`tests/fixture.ts`](../plugins/ui-showcase/tests/fixture.ts) with
[`tests/native.mjs`](../plugins/ui-showcase/tests/native.mjs) to distinguish simulated
callbacks from actual host UI checks.

The gallery's Send/Stop controls simulate work locally. **Dictation is real when
explicitly started**, may send audio to the configured speech provider and can incur
cost. The knowledge picker is the actual host control: explicit source-management
actions affect real sources, even though gallery selection stays local. Use synthetic
data; do not start dictation to inspect the gallery.

## Focused recipes for gaps

These small no-build examples are secondary recipes for mechanisms not demonstrated
as directly by the primary sources:

- [Managed Agent](../examples/plugins/managed-agent/README.md): persistent interactive
  conversations through `ctx.agents`, pending input tools, request IDs, subscription
  and navigation-independent backend work. Read
  [`dist/backend.cjs`](../examples/plugins/managed-agent/dist/backend.cjs) with
  [`dist/main.js`](../examples/plugins/managed-agent/dist/main.js) for the controlled
  composer and frontend/backend bridge. This is not a feature-scale gallery.
- [Teaching Extension](../examples/plugins/teaching-extension/README.md): additive
  native tools through `registerTools`, a tool renderer, simple fence and
  `createBackgroundTool` dispatch/result delivery. Read
  [`dist/backend.cjs`](../examples/plugins/teaching-extension/dist/backend.cjs) and
  [`dist/main.js`](../examples/plugins/teaching-extension/dist/main.js). It is a focused
  existing-agent recipe, not a replacement for Flashcards, coding practice or custom
  learner-input contracts.

Explicitly running their agents/workers may incur configured-provider costs. Reading,
copying or enabling examples is not permission to make model requests. For APIs not
covered by a route, use the API reference and the guide instead of inventing example
behavior.

## What the checks do—and do not—supply

| Project | Plugin-only checks after prerequisite setup | Extra environment / boundary |
| --- | --- | --- |
| Flashcards | `npm run build`; `npm test` with its additional DOM-test prerequisite | `linkedom` is used by tests but not declared locally; the checkout supplies it. Native harness needs `puppeteer-core`, Chrome, Electron Node and a matching standalone host/digest. |
| Coding questions | `npm run typecheck`, `npm test`, `npm run build`; `npm run test:browser` with Chrome | Unit tests launch real local Node processes. Browser host/Markdown are mocked. Native teaching harness needs a matching standalone host, Chrome and checkout macOS Electron; it is not a practice-turn check. |
| Drawing Pad | `npm run typecheck`, `npm test`, `npm run build` | `test:browser` imports private checkout host components/assets and dependencies; the exported kit alone cannot run it. No `test:native` script. |
| Rich code blocks | `npm run typecheck`, `npm test`, `npm run build`; `npm run test:browser` with Chrome | Browser fixture uses built bundles and real rendering libraries with a mocked host. No `test:native` script. |
| UI Showcase | `npm run typecheck`, `npm test`, `npm run build` | Native harness needs a matching standalone host/digest, readiness flag, Chrome and Electron Node; unit UI recorders do not establish real native layout/focus. |

The source export preserves tests for study; it does **not** promise all tests are
standalone. Read the project's README and harness for environment variables and
platform assumptions. The Flashcards and Coding questions native harnesses install
Community-ID fixtures, which are not admitted unchanged by a Core-packaged host with
reserved IDs; do not use them as installation instructions or portable Core smokes.
Host-only integration tests and private host modules are not exported with these
projects. Native packaged-host checks require an independently supplied matching host,
not just the public declaration SDK or a built plugin.

Use disposable profiles, synthetic records and loopback fixtures. Plugin checks are
not real-provider, hardware, full Electron-window, installer, cross-platform or human
functional acceptance. No dependency installation, host launch, provider request or
verification run is implied by this map.
