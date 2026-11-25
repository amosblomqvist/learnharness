# Plugin implementation history

Archived implementation plans and checkpoint evidence from the plugin feature branch.
These excerpts preserve **verification-time** wording, counts and limits; references to
“uncommitted”, paused product work or release authority are historical, not current state.
They are not the public contract or a current release-readiness verdict. Temporary `/tmp/`
evidence may no longer exist. Link destinations in excerpts are recorded as text rather
than maintained navigation. Use the [current host map](../plugin-architecture.md) and
[authoring guide](../plugin-authoring.md) for current behavior.


## Host implementation checkpoints

Source: `docs/plugin-architecture.md` before documentation cleanup.

## Implementation increments and validation

1. Package/runtime host, activation, management state, native external module loading.
2. Frontend activation, custom view/settings/action surfaces and operation bridge.
3. Thin learning-data readers, catalog/inference and usage attribution.
4. Plugin-local managed agents and navigation/restart interaction recovery.
5. Off-network example plugins/testing, packaged external-plugin proof.
6. Authoring docs/types, template and coding-agent skill.
7. Additive native agent contributions and shared renderer surfaces.
8. Validated result tasks, native background-tool adapter and durable delivery/recovery.
9. Host view shell, explicit action placements, controlled UI helpers, dedicated plugin
   settings pages and shared collapsed result presentation.
10. Shared host worker-request admission and standalone worker activity integration.
11. Knowledge-picker control reusing the existing host Chains/source-organization UI.
12. App-wide shared dialog/menu/popup/view-scope foundation and full-window modal plugin
    picker integration.
13. Static host Markdown mount, built-ins only and without auxiliary controls.
14. Bounded native plugin questions and owner-scoped question/editor presentation.
15. Native submission interception, explicit learner images and session-body surfaces —
    implemented and verified on `feature/plugin-architecture`, not released, at the
    separate 3,869-test checkpoint below.
16. Approved UI presentation polish and origin-sensitive knowledge-picker policy —
    **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**,
    at the separate 3,908-test checkpoint below.
17. Host plugin-question keyboard defaults, compact Thinking and navigation/canonical-read
    recovery — **implemented and verified, uncommitted on `feature/plugin-architecture`,
    not released**, at the separate 3,965-test checkpoint. The 3,925-test native-parity and
    3,908-test UI-polish checkpoints remain separate historical evidence.
18. Shared native tree presentation foundation and controlled plugin `mountTree` —
    **implemented and verified, uncommitted on `feature/plugin-architecture` above
    `bdd0666`, not released or installed**, at the separate
    4,021-test / 568-suite checkpoint (historical destination: `plugin-tree-contract.md#verification-checkpoint--2026-11-04`).
    No native controller/business-logic or product-plugin migration is included.
19. Generalized page-body `openSurface(surface, { signal })`, compatible with explicit
    native targets — **implemented and verified, uncommitted above `8dd7409`**.
    See session-extension contract section 12 (historical destination: `plugin-session-extension-contract.md#12-generalized-page-body-surfaces--implemented-and-verified`).
    No new method, native submission scope, install or release is added.
20. Human-approved generic plugin-question `gradeAnswer`, persisted generic outcome and
    pose-frozen v2 grading requirement — approved contract described above; no final
    runtime/build/packaging/release verification is claimed by the earlier checkpoints.

Validation includes focused lifecycle/storage/interaction tests, existing teaching/practice
regressions, typecheck/lint, production build and a packaged-server smoke with disposable
learner/auth directories. No actual user records or provider accounts are needed for these
checks. Full flashcards are the reference future consumer; generation cadence, review
algorithm, source/deletion policy, prompts and other product behavior require their own
approved specification.

### UI implementation note — 2026-11-01

This increment documents the approved host-shell/explicit-placement API, controlled
widgets and composer preset, exclusive explicit-destination dictation, dedicated settings
pages for enabled plugins with schema/custom mounts, and research/PDF-style collapsed result
default with a reusable rich-body result helper and explicit collapsed/card/plain
renderer presentation control. The hello-plugin, managed-agent and
teaching-extension examples now consume these public APIs. This scope does not add
automatic sidebar chrome, core settings writes, a general UI schema, or a new worker
execution model. Existing installed example copies are not overwritten.

### Question defaults and navigation recovery — implemented and verified

**Implemented and verified, uncommitted on `feature/plugin-architecture`, not released.**
Scope: host Enter-submit/Shift+Enter-newline for plugin editors and host Thinking,
optional explicit editor overrides, reserved Mod+Enter Submit, the native footer hint
and Submit answer label, the human-selected 40px Thinking minimum across variants,
and truthful canonical-sync presentation/reconnection. No grading, saved-data, blank/
whitespace filtering, public API shape or `ctx.ui` change is included. The prior
3,925-test native-parity and 3,908-test UI-polish checkpoints remain unchanged historical
evidence, not retroactive proof of this delta. The corresponding normative record is the
native-default and reconnection contract checkpoint (historical destination: `plugin-question-contract.md#14-native-default-and-reconnection-checkpoint--2026-11-03`),
separate from historical section 13 card-placement evidence.

The pre-fix development reproduction failed on **10/10 pending prediction/check mount
returns despite all 162 GETs returning 200**. StrictMode cleanup invalidated a read,
reconnect could join a dead ownerless task, and a permanent identity ref prevented a
replacement read. Recovery now uses **connection-generation task ownership** and a
**stable-identity effect reconnect read**, retaining stale-read/exact-identity fences,
StrictMode and the existing Cache Components-off configuration. Unknown/failed canonical
status keeps readable saved content and genuine Retry, not false Unavailable/recovery
Dismiss. Final independent P2 findings concerning current transcript and async initial
publication were closed by restoring original draft-ownership guards while preserving
canonical editor-admission and Submit gates. No confirmed P1/P2 findings remain.

Final verification passed:

- **3,965 host tests / 564 suites**, with **zero failures, cancellations or skips**;
  typecheck, lint, fresh isolated production build and strict external SDK checks.
- **62 focused card/frontend tests** and **39 core/lifecycle tests**, plus an earlier
  **90-test session-core run**. These are separate focused runs, not additive totals.
- Privacy audit: **96 NFT manifests / 277,497 entries, zero private-root hits**, with
  **410 production source files byte-identical**.
- Final full native submission proof plus production/development navigation proof:
  **20 healthy returns/mounts, ten per mode**, with no healthy-return Retry/error/false
  Unavailable/Dismiss. Held GETs correctly retained Preparing. Ordinary production
  navigation had also been healthy before the fix; this final evidence is distinct
  from that eight-cycle/held-GET baseline.
- Trusted code-editor Enter submitted a prediction; trusted Thinking Enter submitted a
  teach check. Shift+Enter inserted newlines in both. Exact code and canonical/model
  answer, reading-thinking and answer-thinking channels were preserved, and a fresh
  backend disable exercised genuine recovery dismissal rather than a false sync fallback.
- Native empty Thinking measured **40px at 16px text**; three lines grew to **76px**,
  with **192px maximum**. The containing frame grew **109.39 → 145.39px**.
- No page errors, external requests, navigation-triggered model calls or microphone
  attempts in the exercised flows. The native pre-curation payload remained immutable:
  **5,535 runtime files** and **all 130 plugin files** were byte-identical.
- Product checks passed **five unit/catalog tests** plus the real Chrome component-browser
  scenario; these do not broaden the host API or grading contract.

Final full-native evidence: `/private/tmp/lh-coding-native-7HLV1v`. Navigation evidence
run identifiers: production **nav-oE0g2v**, development **nav-aHcEYr**.

Composition guards were exercised synthetically, not with actual OS IME. React Activity
lifecycle reproduction remains fixture-only, not a claim that this Next app enables
Cache Components/Activity (Cache Components is false). These results do not establish
actual microphone recording, paid-provider quality/entitlement, signed-installer or
real-profile installation behavior. No commit, push or release is implied.

### UI-polish status — 2026-11-03

**Implemented and verified, uncommitted on `feature/plugin-architecture`, not released.**
This checkpoint covers self-contained 11px selectors, the standard composer's text-only
frame/external lower controls, bare standalone composer, configured-reading-size gallery
explanations/compact Settings headings, preserved button palettes, synchronous slider
handling, plugin worker headers/tooltips/disclosure, headerless accessible plugin dialogs,
full-body surfaces with dimmed/opaque backgrounds, and the origin-sensitive picker.
The final modal-origin route-binding P2 fix was reviewed clean. Separately held question
fixes are not included or approved by this checkpoint. Historical records below are unchanged.

Final gates passed:

- **3,908 root tests / 564 suites, zero failures**, including the final scrubbed rerun;
  whole-project TypeScript, lint and diff checks.
- **17 showcase tests**, strict showcase SDK types and showcase build.
- A fresh isolated **Next 16.4.3 production build** and `build-server` curation, plus a
  strict external consumer of the curated SDK with **`skipLibCheck: false`**.
- Privacy audit: **96 NFT manifests / 277,329 entries, zero private-root hits**; all
  **410 production files byte-identical** between the verified source and payload.
- Expanded native packaged **Electron-Node server / Chrome** proof passed, recording
  **223 requests / 217 responses**, nine screenshots, zero off-origin or forbidden
  generation requests, microphone requests, WebSockets or page errors. The only provider
  endpoint used was catalog **`GET /v1/models`**, not inference. Settings, graph and host
  source remained unchanged. One cancelled **`GET /api/graph/sources`** was narrowly
  explained; absent favicon `404` and unconfigured dictation-token `503` responses are
  recorded expected fixture conditions, not unexpected success or a clean-console claim.

Actual browser proofs included:

- A continuous trusted slider drag **52 → 44 → 36 → 26 → 16**, using the same enabled
  node with **zero disabled mutations**; 11px model UI, configured reading tokens,
  compact headings and the control row outside the text frame.
- All **12** terminal worker-status/presentation combinations, including actual accessible
  hover-tooltips, icon/label-only headers, collapsed chevrons and native failure X.
- Headerless accessible dialog/surface names, floating muted X remaining fixed while
  content scrolls, full body bounds and outer-edge scrollbars. Dimmed background measured
  **alpha 0.8 / blur 8px**, versus opaque **alpha 1 / no blur**.
- **11 picker origin/geometry cases**, sidebar interaction, retained controlled selection,
  route expiry and source-surface DOM/draft/exact-owner retention. Actual hit-testing put
  the picker above the source; trusted Tab, Shift+Tab and Find did not act in covered
  source fields, the native composer or session Find. DOM/owner retention is not a claim
  that every cross-region source becomes DOM `inert`; existing modal/session-surface
  inert policies remain unchanged.
- Nested surfaces, menus, dialogs and Settings retained content/state, obeyed one-Escape
  ownership and eligible focus return, and cleaned up on navigation or plugin disable.

Evidence: `/private/tmp/lh-ui-showcase-native-ssfmL3/result.json` and its nine screenshots.
Verified host digest: `e5ae5cf654326c8c9615d60e70ad753f92cefd09855c5921549034c36193867c`.
The **18,421-byte** built/installed showcase frontend matched digest
`d8140d04fbb174c97450b50cde1408528e236a94f1c12fb22b130c27c90c3daa`.

Reverse programmatic ordering (a newer surface above an already-open main-pane picker)
has **host integration-regression proof only**, not a visible browser user flow; no hidden
production control was invented. Windows/Linux window-controls checks simulate CSS
geometry, not physical OS chrome. These checks do not establish actual microphone/IME,
paid-provider, signed-installer, real-profile installation, full Electron-window or
Windows/Linux runtime behavior. The prior wheel-over-native-prose follow-up remains
unresolved. No commit, push or release is recorded or authorized by this verification.

### Native session-extension verification checkpoint — 2026-11-02

The native submission/image/surface increment passed **3,869 tests / 564 suites**, with
**zero failures or skips**, whole-project TypeScript, ESLint (**zero errors**, only the
existing `tests/source-name-ui` head warning) and diff checks. A fresh isolated Next
production build and standalone assembly passed. A physical external strict SDK consumer
passed with **`skipLibCheck: false`**. Privacy tracing checked **96 NFT manifests / 277,077
entries** with **zero private-root hits**; all **410 production source files** were
byte-identical, with **zero missing or mismatched files**. This increment is implemented
and verified on `feature/plugin-architecture`, not released. A subsequent fresh run again
passed the full **3,869 tests**, plus **47 flashcards tests**; these test results do not
broaden the host extension contract or establish product/release readiness. The human
separately authorized committing all changes and preparing the branch for a human-performed
push; no agent push or release is authorized. Historical **3,778-test question** and
**3,681-test Markdown** evidence below is preserved separately.

The final packaged **Electron-Node server and Chrome** scenario passed **23 assertion
groups**, with **zero page errors**, **zero blocked external requests** and **zero
unexpected HTTP responses**. Actual new-API proofs included:

- Genuine Canvas image bytes persisted and decoded from the provider's `image_url`, not
  metadata-only attachments; pending-input refresh enabled image-only submission.
- A failed interceptor left POST count **3 → 3**, acceptance count **0**, and the draft
  retained. A verbatim plugin JSON string containing code retained separate answer,
  thinking and reading image channels.
- Native model retry left hook count **6 → 6**, without replaying acceptance callbacks.
  An actual practice `problem` accepted empty-text thinking with images through its marker
  and provider projection. A `.png` path remained text, not image input.
- Exact session-body bounds/title/X, nested mounted surface DOM, Settings/one-Escape
  behavior and navigation-expired target rejection.

Builtin regrading after deterministic shuffle/pending initial selection and real busy
steer **409** fallback with a single hook invocation have focused **unit proof**, rather
than browser proof. Integration found a P2 raw-preview/normalized-canonical duplicate
before acknowledgment. The human-approved fix preserves instant previews, defers canonical
adoption during the owning POST, then makes a fresh canonical read on success, refusal
or lost acknowledgment, preserving drafts without guessed observers. **Eleven permanent
causal regressions** cover the fix; the independent delta audit was clear.

Final browser log: `/tmp/lh-session-browser-7.log`. Evidence:
`/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-8jOHFr/plugin-browser-evidence.json`.
These fixture/loopback proofs do not establish real-provider quality/entitlement, actual
OS microphone/IME interaction, signed-installer behavior, a full Electron-window run or
Windows/Linux runtime behavior. The previously recorded wheel-over-native-prose follow-up
in architecture (historical destination: `architecture.md#10-verification-seams`) remains unresolved; this checkpoint
does not claim it fixed. Broader UI anchors/context hooks/native send remain deferred.

### Plugin question verification checkpoint — 2026-11-02

The bounded v1 host implementation passed **3,778 tests / 560 suites**, with **zero failures
or skips**, global TypeScript, ESLint (**zero errors**, one pre-existing head warning at
`tests/source-name-ui.test.tsx:27`) and diff checks. Following three P2 fixes, independent
**201 backend** and **126 frontend** checks plus **three unchanged causal reproductions**
passed; no confirmed P1/P2 findings remain. This host increment is implemented and verified
on `feature/plugin-architecture`, not released; migration checkpoint `792671e` and the
**3,681-test Markdown checkpoint** below remain separate historical evidence.
Both products remain paused, with no assessment, generic forms or installer scope added.

A fresh isolated Next production build and server assembly passed. The strict **external
packaged SDK consumer** passed with **skipLibCheck false**, NodeNext, ES2022 and DOM,
covering typed question definitions/renderers, rejected generic-pending/frontend-submit
capabilities, picker and Markdown. Privacy tracing checked **96 NFT manifests / 275,228
entries**, with **zero private-root hits**; all **401 production source files** were
byte-identical from checkout to isolated source to payload, with zero missing/mismatched
files. Authoring-document payload checks passed **11 tests**, including the question-contract
link target.

The packaged browser used an isolated **Electron-Node server, system Chrome, public
external plugin and loopback mock**. It exercised a native predict mixed invalid/valid
pose, canonical editor adoption, verbatim answer plus separate host Thinking, and ordinary
teacher review; trusted fold/selection, Tab, newline and Mod+Enter; check ReadingThinking/
reveal and showThinking-false visible disabled microphone; backend-disable fallback and
identity-bound native dismissal without a new turn. Existing Markdown, overlay, native
number-input and admission assertions also passed. CDP confirmed **all three SSE streams
reached `[DONE]`**; matching terminal `ERR_ABORTED` entries were narrowly explained for
those completed streams, not treated as general transport success. There were **zero page
errors or off-origin requests** in the exercised flow. Actual OS microphone capture and
IME interaction are **not browser-proof claims**; focused causal tests cover final STT,
IME, replacement and related ownership paths. See the
authoritative question contract (historical destination: `plugin-question-contract.md`) for scope and verification limits.

Artifacts: `/tmp/lh-question-final-gates-Q7Hu4L/*-v3.log`;
`/tmp/lh-question-isolated-package-MH6M2n/build-v3.log`, `final-sdk-v3.log`,
`final-payload-audit.json` and `browser-v3-script-reading-field.log`; browser evidence
`/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-20Ls0y`.
These are fixture/runtime proofs, not real-provider quality/entitlement, signed-installer,
full Electron-window or Windows/Linux runtime guarantees.

### Static Markdown final verification — 2026-11-02

This is the historical pre-question Markdown checkpoint, not question-v1 verification.
The additive Markdown implementation passed **3,681 tests / 555 suites**, **four example
tests**, scoped and full TypeScript checks, full lint (only the historical no-head warning),
and diff checks. Independent P1/P2 review found no findings; **107 focused tests** passed.
A fresh isolated production build and full packaged-browser scenario passed. The strict
packaged-SDK consumer compiled **without `skipLibCheck`**, exercising the new mount,
update/dispose and expected type errors. All **393 production files** were byte-identical
between checkout, isolated source and standalone payload; **96 NFT traces / 273,716 entries**
contained **zero private-root hits**.

Actual new-API browser checks in both a plugin view and public dialog verified Mermaid
SVG, math, highlighted tokens, tables, callouts and a local image. Registered plugin
code-block counters stayed unchanged, auxiliary controls were absent, and invalid Mermaid
showed its error heading/message and source directly. Checks covered retiring a pending
diagram to plain text, updating back to a diagram, abort/dispose/remount sentinel
preservation, navigation/disable cleanup and acknowledged prose-setting updates.
Real new-tab navigation reached the expected URL while leaving the original page intact,
without a link-safety modal; the fixture was corrected to match existing host link behavior,
with no production fix or API/UX change required.

The same packaged run passed existing picker/source rename/folder/drag, nested painted/inert
parents, passive-tooltip Escape, native incomplete `1e` retention, canonical `3.0 → 3` /
`-5 → 12`, and admission regression checks. Local packaging/browser artifacts are under
`/tmp/lh-markdown-isolated-package-6sHn16`, including `browser-retest.log` and browser
evidence `lh-plugin-browser-evidence-bX4qCm`. This does not establish signed/notarized
installer behavior, a full Electron-window run, Windows/Linux runtime behavior or real
provider generation. The **3,665-test** migration checkpoint `792671e` below remains
separate historical evidence, not verification of the later Markdown API.

### Historical shared interaction final verification — 2026-11-02

The approved contract (historical destination: `dialog-overlay-contract.md`) is implemented by the shared modal,
menu/popup, keyboard and view-scope foundation, superseding the provisional hidden-parent
picker coordinator and unconditional any-Settings-open picker cancellation.

At migration checkpoint `792671e`, source verification passed **3,665 / 3,665 tests across 555 suites** with fresh
HOME/data/auth, **four example tests**, strict packaged-SDK consumer compilation **without
`skipLibCheck`**, typecheck, ESLint (only the existing no-head warning), and diff checks.
The final isolated production build, including the latest tooltip fixes, and full source-free smoke
passed using **Electron's bundled Node and real Chrome**. Privacy audit of **96 NFT traces /
273,464 entries** found **zero private roots**; all **392 app/components/src/lib files**
were byte-identical from checkout to isolated source to standalone payload.

Browser evidence covers the full-window picker, source rename/folder creation/dragging,
painted/inert nested parents, and guarded Settings singleton return-to/deep-linking. A
modal-owned passive Close tooltip was painted above Settings, yet one Escape closed Settings;
a focused menu tooltip likewise left one Escape to close only the menu. Native Chromium
editing-viewport inspection proved visible incomplete **`1e`** retained before/after Escape
in Agent and Appearance, with no invalid writes and no input-type/stepper change or human
fallback required. Existing field-specific canonical normalization (**`3.0 → 3`** and
**`-5 → 12`**) also passed. Admission regression exercised **1 → 2 → 1**, FIFO/live decrease
and panel END cancellation with **zero completed mock responses**, not paid-provider or
real-model generation.

Local artifacts: tests under `/tmp/lh-overlay-final-suite-kS7nJV`; packaged browser log
`/tmp/lh-overlay-isolated-package-tq6SQm/final-browser.log`, evidence `evidence-A6JwY3`.
These results do not establish signed/notarized installer behavior, a full Electron-window
run, Windows/Linux runtime behavior or real-provider inference. The older checkpoints below
remain separate historical evidence; none of these checkpoints verifies the later static Markdown API.

### Historical ordinary-view picker checkpoint — 3,530 tests

The ordinary-view picker checkpoint passed **3,530 tests**, packaged actual-browser checks
including source rename, folder creation and drag organization, the full admission checks,
and the SDK consumer check. This is historical evidence, not verification of the current
full-window modal picker or app-wide interaction migration.

The human-requested WIP checkpoint `2c44868` recorded **3,559 tests** before this migration.
It includes the provisional foreground experiment and is not final migration proof.

### Historical worker admission and activity verification checkpoint — 2026-11-01

The admission/activity increment passed **3,513 tests / 552 suites** under the default
test runner, plus **four separate example-UI tests**, typecheck and lint (zero errors;
one pre-existing warning already present at HEAD). An isolated source-copy production
build, server payload assembly and source-free smoke with Electron's bundled Node and
local Chrome all passed. Inert private-sentinel tracing found **zero** private sentinels;
the assembled payload contained no private records.

The browser exercised the actual Settings → Agent numeric control: **1 → 2 → 1**,
with each value persisted. Three standalone `ctx.workers` tasks appeared in Background
agents without chat links. The run verified live increase and FIFO admission; decreasing
the limit left two active requests running. END cancellations drained the active count
**2 → 1 → 1 → 0**: the third request was admitted after the second cancellation freed
capacity, and all three tasks ultimately became cancelled. The loopback mock OpenAI
endpoint received **three held protocol requests**, with **zero completed responses**.
This was not real model generation, a paid-provider call or real-account inference.
Unlike the historical rendering-only browser checks below, this admission check did
send those three local mock protocol requests.

A reviewer P2 reproduction confirmed that constructor-time abort had replaced native
usage **7** with **0**. It failed before the fix; the exact reproduction then passed,
preserving native usage **7** and identity without leaking a permit. The actual
extraction pipeline's audit-lock test likewise failed before the cancelled-middle-waiter
fix and passed afterward.

Local verification artifacts (temporary paths):

- Tests: `/tmp/lh-admission-verified-tests-bfXAdL/tests.log`.
- Isolated packaging: `/tmp/lh-admission-isolated-package-ovfxV0/final-package.log`.
- Browser evidence: `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-dVX3ym`.

These results do not establish signed/notarized installer behavior, a full Electron-window
run, Windows/Linux runtime behavior or real-provider inference.

### Historical implementation verification — through checkpoint `968ceaa`

The results below record earlier checkpoints, including the UI checkpoint `968ceaa`.
They are historical evidence, **not verification of the admission/activity increment**;
that increment's distinct results are recorded above.

The UI increment passed **3,465 tests / 552 suites** under the default test runner,
plus the four standalone example-UI tests, typecheck and lint (zero errors; the same
existing `source-name-ui` warning). Its production build, payload curation and
source-free bundled-Node/Chrome smoke passed. Browser checks cover exact session/plugin
title typography, explicit placements, sidebar row-major scrolling above ten buttons,
graph-rail scrolling with the sidebar open/closed and pointer pass-through between
buttons, keyboard-accessible top-bar overflow, controlled composer/model shortcut,
dialogs, plugin settings gears/schema updates, renderer defaults and disable cleanup.
A strict TypeScript consumer also compiled against the emitted framework-neutral SDK.

Final suite verification exposed a pre-existing test-isolation bug: the background-tool
test's recovery sweep could deliver another test process's pending job from shared disk
stores. Clean pre-UI HEAD reproduced it; a cross-process write trace identified the
foreign delivery. That test now allocates private storage before importing application
modules and removes it after completion. No production scheduler or timeout was changed.

The initial host checkpoint (before additive contributions/workers) passed **2,229 tests**
(**468 suites**, no failures or skips), alongside `npm run typecheck`, `npm run lint`,
and the production Next build. `tests/plugin-integration.test.ts` exercises a native
external backend through the real host, inference adapter, managed Agent loop and
plugin-local store, including persisted input across disable/re-enable, validated
answers, end-run publication, idempotent retries and usage attribution.

The extended instructions/tools/renderers/workers checkpoint passed **2,342 tests**
(**479 suites**, no failures or skips), typecheck, lint, and the production build.
`tests/plugin-teaching-integration.test.ts` drives the teaching-extension example through
native tool execution, validated worker submission, separate result delivery, transcript
projection/persistence and usage accounting without provider requests. Worker/bridge tests
cover interruption, durable accept-one results, cancellation before dispatch, formatter
failures, and recovery without tool replay.

Integration with main **v0.4.1** (`e69e852`) passed **3,410 tests / 546 suites** with
no failures or skips, typecheck, and lint (zero errors; one existing warning in
`tests/source-name-ui.test.tsx`). The production build, payload curation and source-free
Electron/Chrome smoke also passed. The merge retains main's independent computation and
delivery lifecycle, model-aware tools, provider gates and named-core-role diagnostic
captures alongside plugin contributions and awaited native worker checkpoints. Unscoped
plugin workers do not acquire an invented diagnostic capture role.

Packaging verification exposed that Next 16.3.2 traces some runtime path producers even
without file reads, and instrumentation does not inherit route-level trace exclusions.
Comment-only per-expression opt-outs now keep mutable data/auth/debug paths out of the
payload while retaining shipped prompts. Controlled disposable builds checked independent
chat/graph/settings/jobs/override/auth sentinels; `tests/runtime-path-tracing.test.ts` locks
the identified source boundaries. The main integration additionally exposed installed
plugin data to tracing: runtime plugin/service directories, inference usage filenames,
both recovery task-directory producers, and main's background-capture paths now carry
per-expression opt-outs. Independent Next 16.4.3 inert-copy builds confirmed that the usage
join and **each** task-directory join independently reintroduced private sentinels when
left unannotated; together the opt-outs removed them while retaining shipped prompts.
The production payload's existing data/secret refusal checks remain unchanged and run
before plugin SDK assembly. Two existing route-only broad-trace warnings (headless browser
spawn and PDF download path) remain; this is not a warning-free build claim.

After `node scripts/build-server.mjs`, the extended source-free check
`node scripts/smoke-server.mjs --electron --isolated --browser` passed. It copies the
standalone payload outside the checkout, rejects imports escaping that payload or the
fixture's plugin directory, boots with Electron's bundled Node, and drives local Chrome
through Settings enablement, sidebar navigation, native ES modules/relative assets,
backend RPC, view unmount/remount and disablement. Seeded native history also verifies
shared fenced-block/tool renderers, later worker-result presentation, and readable raw
fallbacks after disablement; those browser checks make no model calls. All fixture data/auth are disposable;
provider-adapter initialization is offline. The browser evidence retains the expected
keyless dictation `503` and absent favicon `404`, separately from plugin failures.

These are not claims of a signed/notarized installer test, a full Electron-window test,
real-account inference, or Windows/Linux runtime testing. Windows directory-fsync
behavior is tested through the installer's injected platform/IO seam; its documented
recovery limitation remains. No full flashcard feature is shipped by this change.


## Teaching-question checkpoints

Source: `docs/plugin-question-contract.md` before documentation cleanup.

## 11. Implementation sequence and verification

1. Add public contracts, registration validation, pure snapshot/answer readers and identity tests.
2. Build accepted per-turn question tools, pose ledger, stream suppression/classification and settled canonical authority.
3. Add canonical submission/dismissal/compatibility and terminal reconciliation; integrate pending/history/model/wake/phase/position helpers.
4. Add owner-scoped frontend registrations and sibling card/editor/answered mounts, private keyboard/focus integration and host dictation routing.
5. Document API and lifecycle, add strict SDK-consumer checks and disposable fixtures, and perform independent review.

Required proofs:
- Native validated pose versus failed authoring; mixed batches; all temporary-ack carriers; unchanged ordinary/builtin behavior; metadata stripped from model input.
- Exact occurrence identity, historical duplicate IDs, normalized args, frozen schema authority, local-reference meaning under native payload embedding, finite JSON/verbatim strings and false/zero/null/empty answers.
- Duplicate/stale submission and alternate legacy-route bypass rejection; write-before-continuation; unavailable/disabled/missing/failed renderers; explicit incompatibility; no automatic cancellation on revision/number changes; silent cancellation/dismissal with no turn; unreadable protocols with insufficient identity must not cause guessed cancellation.
- Missed global settlement event, awaited canonical adoption, reconciliation-only retry, reload/resume pending authority.
- Controlled editor stability, folding, async mount/dispose, stale callbacks, field focus, editing Tab/Enter/Escape, host shortcuts, IME and covered scopes.
- Final dictation chunks before reveal/submit, reading-versus-thinking separation, opt-in answer routing, visible disabled microphone and no hidden-composer writes.
- Real packaged-browser proof through a disposable plugin and loopback mock provider/native turns; no live accounts or product plugin implementation needed.
- Full test suite/examples, typecheck/lint/diff checks, strict packaged-SDK consumer, isolated production build, packaged Electron/Chromium, privacy/tracing and production-byte audit.

Preserve the verified Markdown increment and peer-owned product paths. Implementation approval alone did not authorize staging or committing; the human subsequently authorized committing the feature-branch checkpoint. No push, release or product resumption is implied.

## 12. Verified implementation checkpoint — 2026-11-02

- **3,778 tests / 560 suites passed**, with no failures or skips. Whole-project type checking and diff checks passed. ESLint reported no errors and one pre-existing `source-name-ui` `<head>` warning.
- Independent backend/core review found no confirmed P1/P2. Frontend review identified three ordering/recovery defects; all were fixed, their three unchanged causal reproducers passed, and the final 126-test focused frontend run passed with no additional confirmed P1/P2.
- A fresh, credential-scrubbed isolated Next.js build and standalone curation passed. A separate strict consumer compiled the actual curated SDK with `skipLibCheck: false`, including question registrations, typed payload/answer definitions and renderer slots, existing picker/Markdown APIs, and negative checks for excluded APIs.
- All **96 tracing manifests / 275,228 entries** had **zero private-root hits**. All **401 production files** under `app`, `components`, `src` and `lib` were byte-identical between the working source, isolated build source and payload, with no missing copies or mismatches.
- The packaged server ran under Electron's Node runtime outside the checkout and passed the live Chrome smoke with a public external plugin and loopback-only mock provider. Genuine native turns proved mixed failed/successful prediction posing, canonical editor admission, exact answer whitespace and separate host thinking, ordinary teacher review, natural fold/mount/selection retention, editing Tab/newlines and host Mod+Enter, check reading/reveal, a visible disabled microphone without answer-dictation opt-in, disabled-plugin fallback and silent occurrence-bound dismissal. Existing Markdown, overlays, native number-input and admission checks also passed.
- CDP captured all three question streams through `[DONE]`; only exact matching HTTP-200 terminal cancellations were classified as expected. There were no page errors or off-origin requests. Final STT delivery, IME/229 and missing/replaced-renderer behavior have focused causal coverage; this is not a claim of real microphone capture or OS IME verification.

Evidence: `/tmp/lh-question-final-gates-Q7Hu4L/`; isolated package and build/SDK/payload/browser logs under `/tmp/lh-question-isolated-package-MH6M2n/`; browser screenshots and `plugin-browser-evidence.json` under `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-20Ls0y/`.

Observed follow-up, left unchanged: trusted upward wheels over an ordinary transcript prose wrapper did not move the transcript, whereas wheels over its blank margin did and naturally folded the dock. No intentional wheel-owning surface was identified; the cause and whether this pre-existed or depends on the question state remain causally unresolved. The browser proof uses the working natural blank-margin interaction and does not establish that all transcript wheel targets behave correctly.

## 13. Question-card native-parity checkpoint — 2026-11-03

The human approved a bounded presentation correction after reviewing coding questions: native pending thinking-field framing; recovery-only dismissal; reading thinking above the submitted card and answer thinking inside. The human explicitly rejected adding blank/whitespace omission rules. These changes are **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. Shared `ctx.ui` primitives, plugin APIs, saved envelopes, grading, editor key handlers and dictation routing are unchanged.

- **3,925 tests / 564 suites passed**, no failures, cancellations or skips. The focused dock/transcript run passed **27 tests**, covering all recovery paths, healthy/canonical-readiness states, native frame styling, preserved keyboard/ref behavior, defined empty/whitespace channels, native placement/expansion, image-only channels, combined text/images and renderer-slot isolation. Whole-project typecheck/lint/diff checks passed; lint has only the existing test-fixture `<head>` warning.
- A fresh isolated production/standalone build and strict consumer of the freshly curated SDK (`skipLibCheck: false`) passed. **96 tracing manifests / 277,413 entries / zero private-root hits**; **410 production files** were identical between working source, isolated source and payload. Independent read-only review found no confirmed P1/P2 in the three-file production delta.
- The extended public coding-plugin packaged proof passed using Electron's Node runtime and Chrome, disposable data, the unchanged built coding plugin and a loopback-only provider. It now genuinely **submits** a teach check, rather than stopping at reveal. Exact code, reading thinking and answer thinking were preserved in the POST, canonical result and next teacher request. Native DOM checks proved reading above/default-open and answer thinking inside/inCard/default-closed, with trusted clicks exposing the exact text. Defined blank/whitespace preservation and image layout have separate offline regressions.
- Pending fields matched canonical native classes and computed background/border styles; healthy questions exposed no Dismiss. A fresh second check used a unique occurrence, then backend disable retained both earlier answers and exposed only recovery dismissal. Dismissal canceled only that pending check without another answer, chat POST, turn or provider request. All **five expected loopback request/stream phases** completed; no page errors, off-origin requests or microphone attempts occurred. The verified payload remained byte-identical during the proof.

Evidence: `/tmp/lh-question-cards-tests-final.log`, `/tmp/lh-question-cards-build.log`, `/tmp/lh-question-cards-sdk-strict.log`, `/tmp/lh-question-cards-isolated-package-NUCzsG/`, and `/private/tmp/lh-coding-native-3tz94a/evidence.json` with pending/submitted/recovery screenshots. No real learner profile, paid provider, microphone recording, OS IME, code execution, staging or commit is claimed. The earlier wheel-over-prose follow-up remains outside this correction.

## 14. Native-default and reconnection checkpoint — 2026-11-03

The subsequent human-approved increment is **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. It supersedes the earlier Enter-editing/host-thinking-newline defaults and phase-sized plugin thinking minimum, not the preserved thinking-channel placement or defined-empty/whitespace rules.

- Host defaults now provide **Enter-submit / Shift+Enter-newline** in both plugin answer editors and host Thinking; Mod+Enter remains reserved host submission. Optional explicit plugin editing overrides remain possible. The coding plugin no longer overrides plain Enter; it retains Tab and Shift+Enter indentation. The native footer reads `↵ submits · ⇧↵ newline` and `Submit answer`. Thinking has a compact **40px minimum in every variant**, with natural growth.
- The reported navigation error was reproduced in a disposable **Next development** browser on all **10 pending-question returns/mounts**, despite **162 successful HTTP-200 session responses**. Actual React hook/model fixtures identified the cleanup-invalidated read, null-owner stale-task deduplication and retained one-shot identity gate. Ordinary pre-fix production navigation remained healthy; Activity reconnection is separately proven by React fixtures, not attributed to the current Next configuration.
- Reconciliation now fences task ownership by connection generation as well as consume owner. A stable identity effect starts fresh synchronization on reconnection. Canonical epoch/ticket fences and genuine failure/manual Retry remain intact; no replacement teacher turn is generated. Unknown authority is shown as preparing, not confirmed unavailability or a disabled recovery-Dismiss state.
- **3,965 tests / 564 suites passed**, with no failures, cancellations or skips. Focused card/frontend coverage passed **62 tests**; lifecycle/core regressions additionally prove StrictMode replay, hidden/revealed Activity, null-owner replacement, stale success/failure ordering, preserved drafts and real-error read-only Retry. Typecheck, lint, diff checks, fresh isolated production/standalone build and strict consumer of the freshly curated SDK (`skipLibCheck: false`) passed. The existing test-fixture `<head>` lint warning and two dynamic filesystem tracing build warnings remain.
- Read-only review caught and closed a transient implementation regression: readiness checks had discarded legitimate current-owner transcript completions and async editor initial publications. Original draft-delivery ownership safeguards are restored while user interaction stays inactive and submission remains canonically gated. Causal tests cover both transcript timing windows, host Thinking, async first publication, exact-once retention, no replay/reversion and continued stale/revoked-owner rejection. Independent closing review found no remaining confirmed P1/P2. This is not actual microphone verification.
- Final packaged proof passed actual **plain Enter from code** for prediction and **plain Enter from host Thinking** for teach-check submission, actual Shift+Enter newlines, synthetic composing/229 guard probes, exact answer/reading/multiline-thinking data in the canonical envelope and next loopback teacher request, native answered-card placement/defaults and fresh disabled recovery/silent dismissal.
- Final production **and** development browser navigation each passed **10 healthy returns/mounts**, including fresh-document mounts and held canonical reads: **no Retry clicks, false sync errors, false unavailable state, healthy Dismiss or navigation-induced model requests**. Held reads showed `Preparing question…`. Empty inputs measured **40px actual height** at factory 16px prose size; three-line thinking grew to **76px**, retaining a **192px maximum**; its frame grew from **109.39px to 145.39px**.
- Payload audit passed **96 tracing manifests / 277,497 entries / zero private-root hits**, with **410 byte-identical production files**. All three browser runs preserved the exact approved host digest; their byte comparisons retained **5,535 runtime files** and all **130 installed coding-plugin files**. No page errors, off-origin requests or recording attempts occurred.

Evidence: full Native `/private/tmp/lh-coding-native-7HLV1v/`; production navigation `/private/tmp/lh-coding-native-oE0g2v/`; development navigation `/private/tmp/lh-coding-native-aHcEYr/`; final host gates `/tmp/lh-question-defaults-final-{tests,types,lint,build}.log`; isolated build `/tmp/lh-question-defaults-final-isolated-package-kxuVdF/`. These use disposable profiles and a loopback-only provider, not real learner data, paid providers, OS IME or learner-code execution. The coding package was rebuilt at `plugins/coding-questions/dist/coding-questions`; updating a real installed copy is a separate action and was not performed. No staging, commit, push or release is implied.

## 15. Continuous question opening — 2026-11-04

The human approved a bounded host-only animation correction after frame-level investigation reproduced a two-phase first opening. It is **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. No plugin API, editor lifecycle, saved data, keyboard or dictation changes are included.

Before the correction, production and development traces showed the host measuring a **211.78px** height destination before the coding editor existed. Thinking was already mounted. Editor insertion increased natural height to **357.56px**, but the stale fixed-height animation clipped the whole **109.39px** footer until completion, then jumped about **146px** in one sampled frame. Warm reopens retained the editor and were smooth; asynchronous highlighting was separately ruled out. Investigation evidence: `/private/tmp/lh-coding-native-FNDJPu/` and `/private/tmp/lh-coding-native-hZnPXi/`.

A private height-only controller now retargets the same live opening animation when post-constraint layout observations detect changed natural height. It starts from the current visible height and consumes only the remaining original **document-timeline** animation time, including pending starts; no wall-clock timeout, added delay or full-duration restart is used. Temporary natural-height measurement restores the exact prior inline height/priority and retains CSS clamps. Existing 120ms height morphs, 160ms content fades, initial instant appearance, ordinary unanimated typing growth, closing behavior, reserve policy and retained editors remain intact. Cleanup disposes only the owned height animation and rejects queued obsolete observers.

- **3,988 tests / 566 suites passed**. The focused dock run passed **42 tests**, including timing/geometry, repeated and late retargeting, pending starts, same-target no-ops, clamps/style restoration, unchanged typing/closing, unrelated animation ownership and Activity/observer cleanup. Whole-project typecheck, lint, diff checks and a fresh isolated production/standalone build passed; only the existing lint and tracing warnings remain.
- Strict curated-SDK consumption passed, including an async question renderer without keyboard/animation readiness callbacks and negative checks that private morph controls are not public plugin APIs. Independent read-only review found no confirmed P1/P2.
- Privacy/source audit passed **96 tracing manifests / 277,665 entries / zero private-root hits** and **411 byte-identical production files**.
- Production and development frame traces passed cold prediction, first check reveal and warm reopening. Cold opens retargeted the **same animation instance** to **357.56px**, preserving visible height across each complete synchronous retarget. Thinking became progressively visible **44–64ms** after animation creation, before completion. The former approximately **146px** terminal jump became a **0.016–0.031px** subpixel difference. A running development retarget consumed **33.314ms** and retained **86.686ms**, with exactly the same document-timeline deadline before and after; pending starts retained 120ms without inventing a wall-clock deadline.
- Warm reopens retained both editor and Thinking DOM identities and needed no retarget. Settled code/Thinking typing produced **zero height animations**. At a **540px** viewport, the existing shared cap remained **392px**, with correct whole-content scrolling.
- The unchanged full five-phase Native regression passed Enter/Shift+Enter, synthetic composition guards, exact answer/thinking channels, history and fresh disabled recovery. Production and development navigation each passed **10 healthy returns/mounts**, with no Retry, false unavailable or healthy Dismiss. All five runs preserved the approved digest and **5,537-file payload**, with all **130 coding-plugin files** byte-identical to the frozen product. No page errors, off-origin requests or recording attempts occurred.

Final browser evidence: production opening `/private/tmp/lh-coding-native-7xTVux/`; development opening `/private/tmp/lh-coding-native-buhm3z/`; full Native `/private/tmp/lh-coding-native-XlX2w6/`; production navigation `/private/tmp/lh-coding-native-GWerVN/`; development navigation `/private/tmp/lh-coding-native-sPEMjv/`. Opening directories include `opening-afterfix-summary.json`, per-frame/mutation/animation traces and screenshots; all five include `final-byte-comparison.json`. These are disposable-profile, loopback-provider proofs, not actual microphone, OS IME, paid-provider or learner-code execution checks.

Host gates: `/tmp/lh-question-opening-{tests,types,lint,build,sdk}.log`; isolated build: `/tmp/lh-question-opening-isolated-package-vDB0QD/`. This remains uncommitted on `feature/plugin-architecture`, not released. No real-profile installation, staging, commit or push is authorized by this correction.


## Session-extension checkpoints

Source: `docs/plugin-session-extension-contract.md` before documentation cleanup.

## 9. Implementation sequence and verification

Implemented and verified in this sequence:

1. Shared image/submission/surface types, strict validators, immutable preparation helpers, SDK declarations and contract tests.
2. Native image DTO/persistence/UI/model projection and actual-engine admission, with exact-target/async-race tests. Preserve existing question/privacy gates and provider/subscription semantics.
3. Frontend registry/ordered preparation, form/dictation/raw-grading integration, pending-input availability, draft/cancellation/acceptance handling.
4. Session-body surface boundary/stack using existing UI store and interaction infrastructure.
5. Documentation, public external fixtures and independent P1/P2 review. Only fix causal findings and add permanent regressions.
6. Full tests/typecheck/lint/diff checks; strict generated SDK consumer; isolated production/standalone build; payload tracing/private-root/source byte audit; packaged Electron/Chrome smoke with loopback mock, no paid providers or real learner data.

Required causal proofs include: path-not-image; image-only user/thinking/answer rendering; distinct thinking/reading placement; native model bytes, not metadata-only images; explicit unsupported-model refusal; raw-answer regrading after deterministic shuffle; invalid hook output; priority/composition; pending readiness refresh; failure/cancel retains drafts; final dictation before capture; stale occurrence/model/plugin/view; hooks that ignore abort; single interception across busy retries/fallback; model retry reuses accepted content; no acceptance callback on refusal; stacked mounted surfaces, correct bounds, one Escape, focus return, no covered-input actions, nested Settings, owner-scoped unload/navigation and late cleanup.

Implementation approval alone did not authorize staging or committing. The human subsequently authorized committing the feature-branch checkpoint; no push or release is authorized here.

## 10. Implementation verification

This increment is implemented and verified alongside the existing Markdown and bounded-question work on the feature branch. Historical verification counts for those earlier increments are separate checkpoints.

### Final gates

- Full offline suite: **3,869 tests across 564 suites**, with no failures, cancellations or skips.
- Whole-project TypeScript: passed.
- Whole-project ESLint: no errors; only the pre-existing `tests/source-name-ui.test.tsx` `<head>` warning.
- Diff whitespace check: passed.
- Fresh isolated Next.js production and curated standalone build: passed.
- Strict external consumer of the freshly emitted SDK: passed with `skipLibCheck: false`, physical isolated dependencies, positive interceptor/image/surface usage and negative readonly/protected-field/backend-pipeline checks.
- Payload audit: **96 tracing manifests, 277,077 entries, zero private-root hits**. All **410 production files** match byte-for-byte from the working tree to the isolated source and raw standalone payload, with no missing or mismatched files.
- Independent read-only P1/P2 reviews covered the shared contracts/projections, native server admission, frontend lifecycle/raw grading, surfaces and final normalization/opening deltas. No remaining confirmed P1/P2 finding was reported.

### Causal proofs

Permanent offline regressions cover structural and byte validation, effective-model/resize-policy refusal, exact occurrence and live-agent races, native persistence/UI/model projection, raw builtin regrading against the displayed shuffled question, pending material supplying the initial selection, immutable ordered hooks, final dictation capture, cancellation and newer edits, known-model changes, callback isolation, real busy-steer 409 fallback with one interception, and StrictMode-safe one-shot opening setup.

During integration, a real pre-acknowledgment normalization race was reproduced: append-only canonical adoption could duplicate an original optimistic image preview when the server resized it. The human selected the bounded deferral policy in section 6. Its implementation has **11 permanent regressions**, including refused/lost acknowledgments, failed reconciliation and delayed old ACK/GET races; the final delta review found no confirmed P1/P2 issue.

The fresh packaged Electron + Chrome smoke passed **23 assertion groups** across existing and new runtime behavior, with zero page errors, blocked external requests or unexpected HTTP failures. New checks used an ordinary external plugin and genuine native actions—not seeded answers/results or private host imports—to prove:

- Canvas PNG bytes are saved and reach actual loopback OpenAI-compatible `image_url` requests.
- Failed interception preserves the native draft, makes no POST (count **3 → 3**) and notifies no acceptance.
- Pending-input refresh enables an empty native composer to submit an image-only interaction.
- A verbatim plugin JSON-string/code answer can be transformed while answer, thinking and reading-thinking images remain distinct host-owned channels in history and model requests.
- A deliberate model failure followed by native Retry reuses accepted images without interception (**hook count 6 → 6**) or acceptance replay.
- A genuinely generated native practice problem accepts image-only thinking, persists its native marker and sends the image bytes to the model.
- A `.png` path remains text/path presentation, never an inferred image.
- Surfaces fill the actual painted session-body bounds, retain nested DOM state, expose title/X, sit below Global Settings, obey natural one-Escape ordering and expire opaque targets on native navigation.

### Evidence and boundaries

- Isolated source and payload: `/tmp/lh-session-isolated-package-0Vu03a/source`.
- Full tests: `/tmp/lh-session-full-tests-final.log`.
- Production/standalone build: `/tmp/lh-session-build-final.log`.
- Strict SDK and payload audit: `/tmp/lh-session-isolated-package-0Vu03a/final-sdk.log` and `final-payload-audit.json`.
- Passing packaged run: `/tmp/lh-session-browser-7.log`.
- Browser JSON and screenshots: `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-8jOHFr/` (`plugin-browser-evidence.json`).

Verification used isolated temporary storage and loopback fixtures, not paid providers or real learner data. The earlier wheel-over-transcript-prose follow-up is not claimed fixed by this increment. Broader UI placements, a native send/steer API, model-context hooks and additional surface coverage regions remain deferred. Nothing is staged, committed, pushed or released by this verification.

## 11. Subsequent UI-polish verification — 2026-11-03

The human-approved presentation amendment is implemented and verified on `feature/plugin-architecture`, **uncommitted and not released**. It does not change submission interception, grading, image projection or native question authority.

- Full offline suite: **3,908 tests / 564 suites**, zero failures, cancellations or skips. Whole-project TypeScript, ESLint (only the existing test-fixture `<head>` warning) and whitespace checks passed.
- UI Showcase: **17 tests**, strict public-SDK type checks and a frontend-only **18,421-byte** bundle passed. A separate consumer compiled against the freshly curated SDK with `skipLibCheck: false`, including both background presets and negative checks for invented targets, arbitrary opacity and plugin-selected knowledge-picker origins.
- Fresh isolated production build and standalone curation passed. **96 tracing manifests / 277,329 entries / zero private-root hits**; all **410 production files** matched the working tree, isolated source and raw payload byte-for-byte.
- Expanded packaged Electron-Node/Chrome proof passed with **223 requests / 217 responses**, zero off-origin, generation, microphone, WebSocket or page-error events. Only `GET /v1/models` reached the loopback catalog; settings, synthetic knowledge and the approved host payload remained unchanged. One canceled source read was narrowly expected.

Native proofs include accessible-only overlay titles, pinned floating X controls, outer-edge scrolling, transparent showcase content, dimmed **0.8 alpha / 8px blur** versus opaque **1 alpha / no blur**, nested surfaces/menus/dialogs/Settings, focus return and disable cleanup. They also cover self-contained 11px model controls, configured reading typography, the native standard-composer layout, continuous slider dragging (**52 → 44 → 36 → 26 → 16**, same enabled node, no disabled mutations), and all twelve worker status/presentation combinations with application Hint tooltips.

The unchanged knowledge-picker API now uses actual invocation ownership: page/session-surface origins get a main-pane view with interactive sidebar; modal origins retain a full-viewport modal. Eleven native origin/geometry cases cover sidebar configurations, native-control clearance simulations and route expiry. A global-modal picker belongs to its actual owner/widget, **not an unrelated background route**; a causal review finding here was fixed with pending/open regressions and independently re-reviewed. Covered-source retention is proved by hit-testing, unchanged DOM/draft/owner and trusted Tab/Shift+Tab/Find isolation—not by assuming that every cross-region view sets DOM `inert`. Existing modal and session-surface inertness policies remain intact. Reverse programmatic surface-over-picker ordering is a host-integration proof, not a claimed visible browser flow.

Evidence: `/tmp/lh-ui-polish-isolated-package-rPMHuU/source`, `/tmp/lh-ui-polish-tests-final.log`, `/tmp/lh-ui-polish-build.log`, `/tmp/lh-ui-polish-sdk-strict.log`, and `/private/tmp/lh-ui-showcase-native-ssfmL3/result.json` with nine viewport screenshots. Independent source/delta audits reported no remaining confirmed P1/P2. Windows/Linux checks simulate CSS window-control geometry; physical OS chrome, real microphone capture, OS IME, signed installers, paid providers and real-profile installation are not claimed. The separate proposed coding-question UI changes are not part of this checkpoint.

## 12. Generalized page-body surfaces — implemented and verified

**Implemented and verified, uncommitted above `8dd7409` on `feature/plugin-architecture`; not installed or released.** The amended section 8 adds `ctx.ui.openSurface(surface, { signal })` while retaining `openSurface(target, surface, { signal })` for precise native submission/action targeting. No new method or props are added: the UI API remains **14 methods**.

Capture the active page boundary once at invocation: plugin views, native chat, Home and New Draft. Page-body coverage, mounted covered content, page-hide/leave expiry, always-foreground dialogs/Settings and page—not modal-opener—ownership are normative in section 8. Existing headerless floating-X presentation, backgrounds, stacked-content lifecycle and interaction controller/view layers are reused. Private implementation names are `plugin-surface-targets.ts`, `plugin-surfaces.tsx` and `plugin-surface-shell.tsx`; they are not public imports. No new overlay/window manager, global clipping rule or persistence is introduced. Native submission capture, hooks and token exposure remain limited to their existing native chat scope.

UI Showcase's **Surfaces** family now has a direct **Open surface** gallery button using the targetless overload; the explicit native top-bar action, nesting, background, menu and dialog demonstrations remain. The gallery stays **14 methods / 12 families**. This checkpoint is separate from earlier tree/session/UI-polish proofs and includes the previously verified worker-header scroll regression.

### Final gates — 2026-11-04

- **4,045 host tests / 568 suites**, zero failures; **78 plugin tests** (47 Flashcards, 5 Coding Questions, 26 UI Showcase).
- Whole-project TypeScript, ESLint and whitespace checks passed; ESLint retains only the pre-existing test-fixture `<head>` warning.
- Fresh isolated production/standalone build and strict generated-SDK consumer passed, including both overloads and negative invented routing/modal/missing-signal checks.
- Payload audit: **96 tracing manifests / 278,337 entries / zero private-root hits**; **415 production files** match source and payload with no missing or mismatched files.
- Independent final read-only review reported no remaining confirmed P1/P2. Permanent regressions cover immediate view-mount opening, stable coverage across plugin loading/error/unavailable branches, and a genuinely later native Draft picker. The latter stays inside the shared region with locally restored pointer events, without a new layout box or global Chains changes.

### Packaged browser proof

The literal `npm run test:native` entrypoint exited **0** at `/private/tmp/lh-ui-showcase-native-knRqpm`, passing **15 assertion groups** with **29 screenshots**:

- Direct gallery invocation and the existing explicit native-target demo; retained nested/background/menu/dialog behavior, covered drafts and focus return.
- Seven page variants: Home graph/minimal, teaching/practice Drafts, settled native teaching/practice sessions and plugin route. Exact body bounds, covered controls, usable sidebar/floating chrome or native/plugin top bar, navigation abort, once-only late cleanup and inert expired callbacks/updates.
- Native Draft picker search/disclosure/X use trusted clicks and actual hit tests, both alone and asynchronously above an older Surface.
- Real visible ordinary-dialog and public plugin-Settings controls open later page-owned Surfaces. Existing modals remain painted and focused above them; both hidden field/button points hit the modal/backdrop, and real Tab/Shift+Tab remain modal. This proves the unchanged host default-prevention policy and containment, **not native Tab traversal**. Modal background protection uses the existing ARIA-hiding/backdrop/focus contract, not a new `inert`-attribute requirement.

Final safety: zero page errors, off-origin requests, microphone requests, WebSockets, generation/chat POSTs or browser graph writes. Settings were restored exactly and the seeded graph hash remained unchanged. One expected canceled picker source read was recorded; there were **zero canceled prefetches**. Existing permitted responses were one favicon 404 and 33 idle STT-token 503s. Verification used disposable synthetic data and a separately fingerprinted public-API test plugin, never a real profile or paid provider.

Prior complete runs `CMWNKt` and `Bh11JN` also passed all 15 UI groups but exited 1 on a canceled Next prefetch in the new native-practice/native-teach matrix stages. Those failures remain preserved. The human approved adding **only those two observed stages** to the existing classifier, retaining same-origin non-API GET/fetch, positive RSC/prefetch headers, matching same-stage HTTP 200 and `ERR_ABORTED` requirements. The actual classifier passed **25 positive/negative checks**; the successful browser run had no canceled prefetch and therefore did **not** exercise the added branches. No API/provider or arbitrary-stage failure is ignored.

### Evidence, bytes and limits

- Native artifacts: `knRqpm/{result.json,proof-summary.json,final-byte-comparison.json}` and screenshots; consolidated report `/tmp/lh-page-surfaces-bounded-guard-evidence.json`.
- Host build: `/tmp/lh-page-surfaces-isolated-package-dRJrno/source/.next/standalone`; gate logs `/tmp/lh-page-surfaces-final-{build,tests,types,lint}.log`; payload audit `/tmp/lh-page-surfaces-final-payload-audit.json`.
- Native-tested host digest: `5405def55db9712c5a5c8bf9eadb52540da6943dbe52dcaabb19307ac2668c33`; product digest: `a4493b43fa2883d9db7d4bbbe3fdaf630591e1adb1f37a07fcdbb03822bbb132`; test-fixture digest: `69ef0efb5eaacb4b2d87402c77743323bdb25131a561bac606f5884bc759a4b3`.
- All **5,547 host files / 5 product files** matched before/after the browser run with zero missing, extra or mismatched entries. These digests identify the native-tested snapshots; subsequent documentation-only curation must preserve tested runtime bytes.

Physical Electron window chrome, real microphone/OS IME, and loading/error/unavailable plugin-page transitions were not exercised in this browser proof; branch transitions have offline causal regressions. No installation changes, real-profile installation, staging, commit, push or release are authorized or performed by this checkpoint.


## Shared-tree checkpoint

Source: `docs/plugin-tree-contract.md` before documentation cleanup.

## Verification checkpoint — 2026-11-04

Implemented and verified, **uncommitted on `feature/plugin-architecture` above `bdd0666`,
not released or installed**. This is separate from all earlier checkpoints.

- **4,021 root tests / 568 suites / zero failures**; typecheck, lint, fresh isolated
  production build and strict packaged-SDK checks passed. Separately, **69 product tests**
  passed: 47 Flashcards, 5 coding, 17 showcase; this is not a product migration.
- Privacy audit: **96 NFT manifests / 278,169 entries**, zero private-root hits;
  **415 production files**, zero missing files or mismatches.
- Final native proof: `/private/tmp/lh-tree-proof-native-4Z9LS1`, including
  `proof-summary.json` and `result.json`; baseline:
  `/private/tmp/lh-tree-proof-native-YZurqn`. All **eight native states** had exact
  geometry and computed-style equality, without tolerances; native arrows and Space
  passed. Four screenshots were pixel-identical. Other raster variance also occurred
  between repeats of the old payload: **universal pixel identity is not claimed**.
- Public page, caller-owned container and dialog mounts passed; controlled controls and
  occurrence-key isolation did not cascade selection. Stable `onDetails`/`onChange`
  content retained DOM/drafts after label updates and column reordering. Collapse/abort,
  including late async cleanup, cleaned up exactly once per mount. Arrows, deferred focus,
  editable isolation, plugin-button Space, nested roots and unchanged global Tab passed.
- Column x/left/right boundaries were exact at every visible depth for wide and
  **valid 600px narrow** fixtures. Relative widths matched between headers/bodies:
  `10em` = 110px, `10ch` = 66px, `calc(8rem + 1px)` = 129px; percentage widths stayed
  stable. Primary labels were 12.5px/500, metadata 11px/400. This is not a promise that
  plugin content matches every native line height.
- The **460px overconstrained fixture shifted 27px**: this demonstrates the explicitly
  approved caller-width limit, **not an alignment pass**. Authors still own sufficient
  width/minimum width, scrolling or fewer/narrower columns; no responsive engine was added.
- The pre-document-curation payload digest was
  `75999544d91cb67ce6e68a69bfc0bda6b8dabdefdc7126b48361da139124894d`, unchanged across
  proof; all **5,545 runtime files** matched their source copy with zero differences.
  The baseline's 5,537 runtime files also had zero differences from its own source copy.
  This records the exercised payload, not a later document-curated artifact digest.
- Safety: zero page errors, off-origin requests, microphone attempts, model-generation
  calls or WebSockets; settings and fixture graph unchanged.

Not exercised: actual session-surface mounting, microphone recording, real-profile
installation, or native rename/drag UI in the browser (rename/drag unit regressions passed).
This is scoped proof, not a whole-app manual UX claim. No product plugin was migrated;
no install, staging, commit, push or release follows from verification.
