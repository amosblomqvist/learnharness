---
name: learnharness-plugins
description: Build, inspect, or debug a trusted-local LearnHarness plugin using the public plugin API. Use for host UI widgets, explicit action placements, plugin settings, custom views, native teaching tools/instructions, bounded native question formats, native submission interception/images, page-body surfaces, content renderers, validated background workers, interactive agents, learning-data readers, or plugin lifecycle problems.
---

# LearnHarness plugin authoring

> **Shared-tree commit closeout — 2026-11-04:** the verified tree foundation is
> included in its feature-branch commit. Tree-checkpoint “uncommitted” notices below
> retain verification-time status; no push, installation or release is implied.

> **Commit closeout — 2026-11-04:** The verified UI-polish, question-card, native-default/reconnection and opening-animation changes are included in this feature-branch commit, together with Coding Questions and UI Showcase. “Uncommitted” notices below retain their original verification-time status; this note supersedes them for the current Git state. No push or release is implied.

First read `docs/plugin-authoring.md`, `docs/plugin-architecture.md`, the authoritative
`docs/dialog-overlay-contract.md`, `docs/plugin-question-contract.md`, the
[authoritative session-extension contract](../../docs/plugin-session-extension-contract.md),
the [approved tree contract](../../docs/plugin-tree-contract.md), and the actual contracts `src/core/plugins.ts`, `src/core/plugin-ui.ts`, `src/core/plugin-agents.ts`,
`src/core/plugin-workers.ts`, `src/core/plugin-questions.ts`, and
`src/core/plugin-submissions.ts` and `src/core/plugin-tree.ts` in the matching app checkout. Native session extensions
are **implemented and verified on `feature/plugin-architecture`, not released**, at the
separate 3,869-test/564-suite
checkpoint in `docs/plugin-architecture.md`, including whole-project TypeScript, lint
(zero errors, existing head warning only), strict physical external SDK
(`skipLibCheck: false`), isolated Next/standalone build, privacy/source-byte audits and 23 packaged
Electron-Node/Chrome assertion groups. Historical question/Markdown checkpoints remain
separate evidence. A subsequent fresh run passed the full 3,869 tests plus 47 flashcards
tests, without expanding host scope or establishing product/release readiness. The human
separately authorized committing all changes and preparing the branch for a human-performed
push; no agent push or release is authorized. These paths are repository-relative,
not relative to an installed plugin.
If only a packaged app is available, use its matching `plugin-authoring/` docs/types
bundle beside the standalone server rather than inventing private-module imports. Type-only API
bundles can be emitted with `node scripts/build-plugin-types.mjs`.

## Current UI-polish status

The later human-approved UI-polish increment and origin-sensitive picker are
**implemented and verified, uncommitted on `feature/plugin-architecture`, not released**.
The separate checkpoint in `docs/plugin-architecture.md` records **3,908 root tests /
564 suites, zero failures** (including a final scrubbed rerun), typecheck/lint/diff checks,
**17 showcase tests**, strict showcase types/build, fresh isolated Next 16.4.3/standalone
curation and strict external curated-SDK compilation (`skipLibCheck: false`). Privacy
proof checked **96 NFT manifests / 277,329 entries**, zero private-root hits and **410
byte-identical production files**. Expanded packaged Electron-Node/Chrome proof passed
with nine screenshots, 223 requests / 217 responses, no off-origin/forbidden generation,
microphone/WebSocket/page-error activity, and unchanged settings/graph/host source. Only
provider catalog `GET /v1/models` was used; one cancelled graph-source read and expected
fixture favicon/dictation-token errors are explicitly recorded. Reverse programmatic
surface-over-picker ordering has host integration proof only, not a visible browser
flow; Windows/Linux window-controls proof simulates CSS, not physical OS chrome. No
actual microphone/IME, paid-provider, signed-installer, real-profile install, full
Electron-window or Windows/Linux runtime proof, commit, push or release is implied.
Separately held question fixes remain outside this checkpoint. Historical
3,778/3,869/3,665-test records retain their original scope; do not invent public options.

## Question defaults and navigation recovery — implemented and verified

This increment is **implemented and verified, uncommitted on `feature/plugin-architecture`,
not released**, at the separate **3,965-host-test / 564-suite checkpoint** with zero
failures/cancellations/skips. Typecheck/lint, fresh isolated build and strict external SDK
passed; privacy proof checked **96 NFT manifests / 277,497 entries**, zero private-root
hits and **410 byte-identical production source files**. The 62 card/frontend, 39 core/
lifecycle and earlier 90 session-core focused tests are separate runs, not additive counts.
Prior **3,925-test native-parity** and **3,908-test UI-polish** records stay historical.

Host defaults are now Enter-submit/Shift+Enter-newline in both plugin answer editors and
host Thinking; Mod+Enter remains reserved Submit. Explicit optional editor key overrides
remain allowed, but `"pass"`/no hook means host Enter-submit. Native footer hint: **↵ submits
· ⇧↵ newline**; button: **Submit answer**. The human selected **40px minimum Thinking height
for all variants**, replacing teaching 72px. The coding plugin now omits a plain-Enter
override, retaining Tab indentation and Shift+Enter newline indentation.

Unknown/failed canonical sync keeps readable saved content and genuine Retry, not false
Unavailable/recovery Dismiss. Recovery uses private connection-generation task ownership
and stable-identity effect reconnect reads, retaining fences and StrictMode; Cache
Components remains false. Final current-transcript/async-initial-publication P2 findings
were closed by restoring original draft-ownership guards while keeping canonical admission
and Submit gates. No confirmed P1/P2 findings remain.

Final native and dev/production proof passed **20 healthy returns/mounts, ten per mode**,
with held GETs retaining Preparing and no healthy-return Retry/error/false Unavailable/
Dismiss. Trusted code Enter submitted a prediction, Thinking Enter submitted a check,
and both Shift+Enter paths, exact canonical/model channels and fresh backend-disable
recovery passed. Empty Thinking measured 40px at 16px text, three lines 76px, maximum
192px. No page errors, external requests, navigation model calls or microphone attempts
occurred; the native pre-curation payload retained **5,535 runtime / 130 plugin files
byte-identical**. Five product unit/catalog tests and real Chrome component proof passed.
See `docs/plugin-architecture.md` for evidence. React Activity reproduction remains fixture-
only, and composition checks are synthetic, not actual OS IME. No actual mic recording,
paid-provider, signed-installer, real-profile installation, commit, push or release proof
is implied. No grading, data, blank filtering, API-shape or `ctx.ui` changes are included.

## Rules

- Ask the human for feature behavior, prompts, defaults, algorithms, source policy,
  data deletion, and interface decisions. A plugin platform does not choose a product.
- Start from `examples/plugins/hello-plugin` (frontend only) or
  `examples/plugins/managed-agent` (Node + managed interactive/background agent), or
  `examples/plugins/teaching-extension` (instructions, native tools, renderers and a
  detached result worker in existing lessons).
- Use one workspace at `<learning data>/plugins/<id>/` for installation and authoring.
  The ID must match **`<id>/dist/manifest.json`**: `dist/` is the required fixed runtime
  root, with referenced ES-module frontend/CommonJS backend bundles and assets inside.
  Optional source and `package.json` live beside it; builds write to project-root `dist/`,
  not `dist/<id>/`. Refresh can discover the first build of a previously unbuilt workspace;
  code already admitted by the host requires a server restart after changes. No separate
  development mode, registration, profiles, hot reload, legacy-layout fallback or migration.
- Distribute built `dist/` contents with JS dependencies bundled, placing those contents
  into the target `<id>/dist/`, never directly into `<id>/`. Never distribute persistent
  `data/`; it is a sibling at `<id>/data/`, not `dist/data/`. Preserve it during updates.
  Build cleanup must target only `dist/`, never the workspace root, and refuse symlinked
  `dist/` or any misplaced `dist/data/` entry before deletion. The no-build examples already
  contain `dist/` and are installable by copying their whole ID folder. No app-side npm install.
- Only use the supported context APIs. Do not import host implementation modules or
  mutate core learning records. Trusted code can read files, but APIs offer shared
  interpretation and preserve version guards. Keep feature data under plugin `data/`.
- Backend activation is server-owned; frontend activation is window-owned; view mount
  is neither. Return cleanup, dispose React roots, and honor cancellation after awaits.
  Do not start side effects at module top level.
- `PluginView.mount(container, signal)` owns the feature body, not the host top bar,
  title, action overflow, or settings gear. Pass the per-mount signal to UI helpers;
  `ctx.signal` alone is too long-lived for view widgets. No automatic view/action
  chrome or dedicated plugin sidebar section exists.
- Call `registerAction` before `placeAction`. Placements have their own ID and
  `actionId`, with `location: "top-bar" | "sidebar" | "graph"`. Top bars require
  explicit `sessions: ["teaching", "practice"]` (either subset) and/or `views` (own
  view IDs). Sidebar placements share the core action area. Use typed action context,
  optional SVG icon and `disabled` boolean/predicate; call `ctx.refreshActions()`
  after dynamic enabled-state changes. The host handles async busy/repeat prevention.
- Use `ctx.ui` controlled helpers rather than private host component imports:
  `mountComposer`, `mountDictation`, `mountModelPicker`, `mountThinkingPicker`,
  `mountKnowledgePicker`, `mountStandardComposer`, `mountButton`, `mountSettingsRows`,
  `mountWorkerResult`, `mountMarkdown`, `mountTree`,
  `openMenu`, and `openDialog`. Every call takes final `options: { signal }` and
  returns `update(partialProps)`/`dispose()`; updates are shallow, so replace whole
  nested preset props. Plugin callbacks own values/persistence; feed accepted values
  back into handles. Model/thinking selectors never write core settings. Keep the exact
  independent host controls and plugin-local values; they do not replace native writing
  controls. Approved polish makes their **11px** typography self-contained, independent of
  surrounding plugin styles. Preserve button palettes. Gallery explanations use configured
  reading size (**16px** default); Settings headings keep compact `SettingsHeading` styling.
- For `openSurface` entry, optionally mark a real visible focusable content region
  with `data-plugin-initial-focus` (for example `tabIndex = -1`, `role="group"` and an
  accessible label). Preserve genuine headings only when they belong in the UI; never
  invent a hidden focus heading. The host preserves eligible existing/remembered focus,
  then tries the first eligible marker before automatic fields/headings/frame fallbacks.
  It queries the current mount, respects Settings/dialog/newer-view ownership, and falls
  back if the marked element cannot receive focus. Mount it synchronously: no async retry,
  DOM-change autofocus or focus on updates. Dialogs/native-page entry are unchanged.
- `mountButton` accepts optional `icon` as trusted SVG markup, matching action icons.
  It appears before the visible required `label`. Set `iconOnly: true` to hide text
  and use `label` as the accessible name; both label and icon must be nonblank.
  Choose `size: "icon-sm"` (or another existing size) explicitly: size controls
  geometry, never label visibility. `title` stays optional, with no automatic tooltip.
  Invalid icon props reject mount/update atomically; clear `iconOnly` when removing
  an icon. Do not supply a renderer, DOM node or private host import for button icons.
- Use `mountButton` with `variant: "custom"` and optional `colors` for color-only
  customization: normal `background`/`text`/`border`, optional `hover`/`active`/
  `focusVisible`/`disabled` objects with those same slots, and `focusVisible.ring`.
  All are optional CSS color strings (including variables), never arbitrary CSS.
  Defaults are native primary colors plus a fixed transparent 1px border. Missing
  state slots do not reset applicable lower states; priority per property is
  disabled > active > focus-visible > hover > normal. Native focus border/ring remain
  unless overridden; sizes/layout/shape/activation and disabled 50% opacity stay native.
  Invalid shape/type/color syntax rejects atomically, including on other variants;
  valid `colors` are ignored outside `custom`. Updates replace the whole palette,
  not deep-merge it. Color syntax validation cannot ensure variable resolution,
  contrast or visible focus; the plugin owns those choices. Use the public props,
  never native-button descendant styling or private host color variables.
- Use additive API v1 `ctx.ui.mountMarkdown(container, { text }, { signal })`
  for complete static content, with `PluginMarkdownProps { text: string }`. It returns
  `PluginWidgetHandle<PluginMarkdownProps>` with standard update/dispose and per-mount cleanup.
  Reuse the actual host Markdown/math/highlight/code/tables/callout/Mermaid/images/typography
  pipeline, not private React imports or a copy. Only built-ins run—registered plugin
  code-block renderers are excluded. Omit all copy/download/retry/expand/zoom/disclosure
  controls. Ordinary links retain host-native new-tab behavior (`target="_blank"`,
  `rel="noopener noreferrer"`) without extra confirmation. Invalid Mermaid shows
  the existing error heading/message and source directly, no retry/details UI. Plugins
  own data/text/layout; this adds no storage, inference, dependencies or API-version bump.
  Use it for generic bodies such as card fronts/backs, not fake worker-result shells.
  Ask for an explicit host capability decision if needed; do not invent props or bypass
  the API. Markdown passed the 3,681-test, strict SDK and actual packaged-browser gates
  recorded in `docs/plugin-architecture.md`; the earlier 3,665-test interaction checkpoint
  `792671e` remains historical, not proof of this later API.
- The approved API v1 tree method is
  `ctx.ui.mountTree(container, tree, { signal }): PluginWidgetHandle<PluginTreeProps>`;
  it is **implemented and verified, uncommitted on `feature/plugin-architecture` above
  `bdd0666`, not released or installed**, at the separate
  [4,021-test / 568-suite checkpoint](../../docs/plugin-tree-contract.md#verification-checkpoint--2026-11-04).
  Earlier checkpoints remain historical. Exact eight-state native geometry/styles and
  fitting-width column boundaries passed; universal pixel identity, underconstrained
  alignment, actual session-surface/microphone/real-profile installation or native rename/
  drag browser coverage are not claimed. Read `docs/plugin-tree-contract.md` and exact
  `src/core/plugin-tree.ts` types. `tree` is generic configuration, not Chains' Props
  proposition column. Use globally unique occurrence keys (any string, including empty),
  independent of item identity; no `itemId` or selection cascade. Strings/existing
  `PluginUiContent` occupy fixed native row/header/cell slots, never replace row markup.
  Optional controlled checkbox/disclosure and trailing columns leave the primary content
  filling available width; optional primary header is distinct from accessible-only label.
  Width is finite nonnegative pixels (0 allowed) or non-whitespace CSS width, align left
  by default or right. No selection anywhere, including collapsed rows, removes the gutter;
  any selection reserves it for all rows. Flat branchless lists need no disclosure gutter;
  hierarchy keeps alignment (guide 19px without selection / 37px with selection, +36px/depth).
  Children without disclosure stay visible; collapse unmounts descendant mounts/cleanup,
  reopen remounts. Keep mount functions stable across updates and persist drafts in plugin
  state; normal AbortSignal/update/dispose/async cleanup applies. Widget abort/plugin
  deactivation disposes mounts; `selection.disabled` does not unmount content. Caller owns
  search/sort, actions/rename/move/storage, scroll/loading/empty UI. Root-local navigation
  reuses Chains arrow-row rules: Up/Down siblings, Right open/enter child, Left parent/fold
  parent, Space only for an optional enabled host-owned checkbox. Nested widgets are
  independent; plugin text inputs/contenteditable/handled keys are isolated. No autofocus,
  Find/search, global handler or public keyboard-controller API/new props. App-wide Tab
  policy is unchanged in all contexts: no Tab exception or native Tab-focus promise.
  The pure private `components/tree-navigation.ts` kernel is mechanically extracted from
  `chain-navigation.ts`; native exports alias it, without native hook/metadata/event-policy
  or controller/business-logic changes. Defaults match native `font-ui`: primary labels
  `text-sm`/12.5px/500, metadata and headers `text-xs`/11px/400. Width-bearing header/body
  cells share font metrics for `em`/`ch` widths; rich content can override its style.
  Width/fit/scrolling are caller-owned: insufficient width for columns plus maximum hierarchy
  indentation/control prefixes can overflow and column positions can diverge despite
  retained declared widths. Supply sufficient width/minimum width with a scroll container
  or fewer/narrower columns; no universal alignment, host minimum-width calculator,
  clipping policy or responsive engine is promised. See the caller-wrapper example;
  its width budget is illustrative, not a host requirement. Native behavior is unchanged.
  Thin native separators only between top-level groups, not nested rows or after the last
  group; internal root selectors are not API. No column resize/sticky system, automatic
  opening or product-plugin migration; knowledge picker/surfaces remain separate. The UI
  API now has 14 methods. UI Showcase demonstrates all 14 in 12 families, including
  Directory / tree; retain its historical 13-method proof as historical evidence and do
  not claim Flashcards has migrated.
- The additive API v1 knowledge picker uses
  `ctx.ui.mountKnowledgePicker(container, { value, onChange, disabled? }, { signal })`:
  `value: readonly string[]` of node IDs, `onChange(ids)`, standard `update`/`dispose`.
  Plugins own bubble placement, controlled selection and persistence; the host never
  writes plugin state. Reuse the exact `NodePickerControl` and real `ChainTableOverlay`,
  not copies: Pick nodes/count/Clear (`[]`), immediate checkbox updates reflected via
  `handle.update({ value: ids })`. The latest approved policy keeps existing translucent/
  blurred Chains visuals and captures the actual origin in the host, with **no public
  options**: plugin/native pages and session-body surfaces open a **main-pane view overlay
  excluding the interactive sidebar**, expiring on source-view navigation; dialog/Settings/
  modal origins open a **full-viewport modal** using common focus rules. This policy passed
  the separate UI-polish checkpoint. Core Graph/Practice Chains retain existing content-area
  behavior. Done/X and unconsumed selector-owned Escape close
  only it, retain selection and restore eligible focus. Picker Done has no dumbbell/practice
  glyph; native practice keeps its glyph. The API/props/signal contract is unchanged.
  Modal launching parents stay mounted, **painted/visible underneath and inert**, preserving
  state/scroll—not `display: none`. No sidebar-reopen button belongs inside the picker.
  Clearance applies only at the viewport left edge, including full-viewport modal and
  closed-pane cases; keep existing Windows/Linux window-controls-overlay gutter calculation
  and do not change sidebar-state persistence.
  New public dialogs/menus foreground normally. Fresh Settings nests above the picker
  without discarding it; returning to existing Settings uses guarded top-down close
  callbacks, stopping on blocked/handled/pending, with no queued navigation or forced
  cancellation. Retarget only after return-to succeeds. One selector uses a shared
  exclusive opening slot and normal close guards; closing the previous selector retains
  controlled IDs without auto-reopening it. Newer UI/retarget invalidates older pending
  graph loads so they cannot promote stale UI. Pending graph work must respect the captured
  origin/lifetime and not open against a replacement view. Private AppShell main-pane
  isolation and `HostRouteLifetimeContext` bind **nonmodal origins only**; modal-origin
  selection follows its actual modal and widget, not an unrelated background route.
  Covered view-source DOM/drafts and exact owners are retained, without a blanket
  cross-region DOM `inert` rule; existing modal/session-surface inert policies remain.
  These mechanisms are private, not public origin props. The host supplies canonical graph/source
  organization, lazy first-open loading, focus/portals and abort cleanup. Preserve source
  rename, folder creation and dragging: selection mode is **not read-only**. Management
  Delete stays unavailable in practice-picker mode. Backend learning APIs remain read-only;
  no programmable core-write/deck-domain API is added. `mountTree` is presentation only;
  deck hierarchy/state/membership/limits stay plugin-owned. The shared foundation/then-full-window picker passed the historical
  3,665-test and packaged gates in `docs/plugin-architecture.md`; this verifies neither
  the later origin-sensitive picker policy nor static Markdown API.
- Follow the app-wide shared interaction contract, not the removed picker-only hiding or
  unconditional Settings-cancels-picker experiment. Private HostDialog/interaction layers,
  menu/popup ownership and content-view scopes expose no new public SDK APIs. One Escape
  has one original owner, leaf-first; handled/blocked Escape cannot dismiss a parent or
  trigger dictation/turn fallback. Tooltips are passive help, never Escape owners; keep
  their portals associated with the owning modal and painted above its frame. Native
  Tab/Shift+Tab navigation and focus looping stay
  off; keep existing explicit field/thinking/question/rebinding actions scoped to eligible
  controls. Preserve explicit initial focus, else first eligible editable field/heading,
  not an action button. Child close restores only eligible invoking focus. Settings field
  Escape retains/commits via normal validated blur/save without closing Settings, preserving
  failed drafts; explicit credential Save and rename-cancel remain distinct. Newer
  acknowledged canonical snapshots stay authoritative across close/reopen: stale responses
  and Settings/startup GETs cannot roll back saved values/appearance; pending saves finishing
  after reopen update the current instance. Fresh loads still read normally. Busy deletion
  guards consume Escape without closing.
- Plugin dialogs keep required `title` for the accessible name, with **no host-visible
  title/header row** under the approved polish. Plugins own visible headings and bottom
  actions in content. Quiet muted Close/X floats above content independently of scroll;
  no new header/appearance props are approved. This presentation passed packaged verification.
- Composer, dictation, model and thinking are independent controls; the standalone
  composer is a bare primitive. Only text entry is framed in the standard preset; its
  control row sits below and outside the text frame. It excludes usage/practice controls,
  attachments and default file/drop insertion. Do not turn it into a teaching dock.
  Dictation must have an explicit `onTranscript` destination; never redirect it to
  core inputs. One window-wide recording owner is shared with core; competing starts
  report “Dictation is active elsewhere”. Only focused controls claim matching
  shortcuts; mounting alone does not steal them. A dictation-owned Escape cancels the
  actual recording owner; Escape consumed by a higher layer must not also cancel it.
  The preset awaits finish/transcript delivery before send; coordinate that yourself
  for independent widgets. Dictation handles also expose `toggle`, `finish`, `cancel`.
- Every enabled plugin has a dedicated Settings page, even without custom settings.
  Use the host gear or `ctx.app.openSettings()`; Settings → Plugins is management.
  `registerSettings({ rows })` returns `PluginWidgetHandle<PluginSettingsSchema>`:
  `update({ rows })` validates and publishes new controlled values; `dispose()`
  unregisters. Stale/disposed handles are inert. `registerSettings(mount)` still
  returns an unregister function for a custom `mount(container, signal)` with cleanup.
  Row types: toggle, text, dropdown, number, slider; use unique keys, controlled values,
  plugin-owned `onChange` persistence and optional synchronous `validate`. In an async
  callback, use `await ctx.call("save-settings", value); registration.update({ rows: nextRows });`
  with plugin-defined persistence and rows reflecting the accepted value (see the
  authoring guide example). Do not publish success after validation/write failure. Approved
  slider polish avoids transient disabling on synchronous change; disabling for genuine
  pending Promises is unchanged. Packaged continuous dragging retained the same enabled
  slider node through five value samples with zero disabled mutations.
  Custom mounts may also use `mountSettingsRows`, but are not required for live updates.
  Do not invent a host settings store or mutate core settings files.
- Auth and transport stay host-owned. Select an available configured model explicitly.
  Automatic work uses background purpose and existing subscription consent. Do not
  extract credentials, refresh accounts implicitly, or bypass a refusal with fallbacks.
- Use low-level inference for single responses or your own orchestration. Use managed
  agent sessions when navigation-independent execution, persistence, input tools, and
  reattachment are needed. They live in plugin data, not core teaching/practice chats.
- Use `ctx.workers` for bounded tasks that need one validated final result. `start`
  accepts work; `wait` returns a terminal outcome. Supply explicit model, purpose,
  request ID and maxTurns. Validate against immutable `task.input`, not model-authored
  task/source identity. A plain final model response or idle snapshot is not success.
  Keep semantic validators side-effect free. All unfinished tasks become interrupted
  on restart/disable; a new attempt requires a new explicit request identity.
- Bounded native plugin questions are implemented and passed the 3,778-test/560-suite,
  strict SDK, isolated packaging/privacy and exercised browser checkpoint recorded in
  `docs/plugin-architecture.md`; the increment is implemented and verified on
  `feature/plugin-architecture`, not released. `792671e` remains a historical checkpoint.
  The authority remains `docs/plugin-question-contract.md`. Use backend
  `registerQuestionType(PluginQuestionTypeDefinition)` and owner-
  scoped frontend `registerQuestionRenderer(PluginQuestionRenderer)`, actual names in
  `src/core/plugin-questions.ts`. Stable local ID/label, positive safe `contractVersion`,
  schemas and **required `showThinking`**; optional explicit `probe`/`teach` names/descriptions,
  at least one variant, no practice enrollment. Native args are `{ question, payload }`,
  plus teach `{ type: "predict" | "check", nodeId }`. Host common question Markdown supplies
  safe teaser/fallback; do not dump payload/reference material into generic tool traces.
  Host owns pose/identity/persistence, not plugin `execute`. Synchronous side-effect-free
  refinements return undefined/[] or problem strings; never use them for grading or return
  thenables. Finite JSON/verbatim strings and schema-allowed 0/false/null/empty values stay
  exact, without coercion/trim/clean. Historical saved schemas and required same-contract
  answer refinement govern acceptance; newly added refinements do not change old rules.
- Renderer slots are `id`, `supportedContractVersions`, optional `mountQuestion` (host
  Markdown fallback), required `mountAnswerEditor`, optional `mountAnswered` (readable
  answer fallback). Host ThinkingBlocks remain outside custom answered content: reading
  thinking above the submitted card (native label/default-open), answer thinking inside
  (`inCard`); each keeps its own text/images, including defined blank/whitespace channels.
  Pending thinking has the native framed background; Dismiss is recovery-only for a
  confirmed unavailable/missing/failed renderer, not a healthy working question or an
  unknown/failed canonical sync. The latter keeps readable saved content and genuine Retry,
  without a fabricated Unavailable state/recovery Dismiss. Immutable
  input/chatId/questionId/contractVersion/variant/signal identify each mount. The editor
  publishes atomic empty (no value) or unready/ready with JsonValue synchronously via
  `onChange`; only a current ready handle can submit. Handle update({ answer, active })
  never echoes or resets identical selection/composition; provide focus/dispose, optional
  handleKeyDown for exact `Tab`/`Enter`/`Shift+Enter`/`Escape` handled/pass and optional
  appendTranscript. Host defaults are now Enter-submit/Shift+Enter-newline in
  both the answer editor and host Thinking. An explicit optional key override is allowed;
  `"pass"`/no hook uses host Enter-submit. Host shortcuts/Shift+Tab/reserved Mod+Enter/IME229
  and scope guards keep precedence; passed Tab uses private field cycling. No public
  generic key/field SDK.
  Honor async mount aborts, dispose late handles and fence stale callbacks/keys/focus/speech.
  Preserve mounts on fold; drafts live in the existing in-memory session model across
  remount/adoption, not model-destroying navigation/reload/restart. Durable posed questions
  and accepted answers do not imply persistent editor drafts.
- Host Stats/microphone/model/model-thinking and submit/dismiss/reveal controls remain
  present. Check ReadingThinking is independent; speech goes there before check reveal,
  then host Thinking when enabled. Thinking-off answer speech requires explicit editor
  appendTranscript opt-in, otherwise keep the microphone visible/disabled—no hidden
  composer fallback. Await final transcript publication before reveal/submit and settle
  captures before retiring destinations. Mount actionable editors only after canonical
  persistence/adoption; reconciliation retry does not start a teacher turn. Host envelopes
  own identity/time/thinking; plugins publish only answer values. Exact occurrence, saved
  schemas, single-submit and legacy/stale guards prevent bypass/duplicate continuation.
  Exact contractVersion only: compatible updates retain it; explicitly incompatible
  versions permit quiet host cancellation, unknown version/package changes alone do not.
  Missing/disabled backend, required refinement or supported renderer stays unavailable/
  pending with safe host fallback/dismissal. No frontend incompatibility or chat migration.
  **Teacher review only**: no assessment/node hook, grading schema/stage, execution service
  or new worker lifecycle; use separate ordinary tools if needed. Builtins stay unchanged.
  No generic pending-input/forms, new UI catalogue/source metadata/installer extension;
  both product implementations remain paused. The historical 3,681-test Markdown result
  remains separate from the current question verification. Actual OS microphone/IME is
  not browser-verified; focused causal tests cover final-STT/IME/replacement ownership.
- Native session extensions follow the approved contract, not inferred private APIs.
  Frontend `registerSubmissionInterceptor(definition): () => void` and
  `refreshSubmissions(): void` are the public preparation methods. IDs are lowercase-hyphen,
  activation-unique; priority is a finite integer, default 0, high-first, ties by plugin ID
  then interceptor ID. Capture one ordered set per attempt and run serially. Undefined
  passes through, a same-type replacement transforms learner fields, null cancels and
  retains drafts; exceptions/invalid output fail closed. Unregister/unload cancels captured
  preparation; no silent skip or backend registration. May await existing backend calls.
- Use raw `PluginSubmission` DTOs: text/practice thinking have content `{ text, images }`;
  builtin answers have learner-only dontKnow/values/other/text/confidence/images plus
  separate thinking/readingThinking; plugin answers have finite JSON answer, answerImages
  and separate thinking/readingThinking. Stable option values are not display indices.
  Host identity/derived grading/tool envelopes are never hook output. The host revalidates
  captured kind/mode/options/cardinality/confidence/channels and calls existing buildAnswer
  against the same rendered/shuffled question; plugin historical schemas/refinements,
  availability and exact occurrence still govern acceptance. Never silently drop unknown/
  duplicate selections or inapplicable content; preserve plugin raw/falsy JSON values.
- Context/target carry session ID/kind, matching type, channels, learner-facing question/
  problem and opaque surfaceTarget. Exact occurrence is messageId/contentIndex/toolCallId/
  toolName, not a reused call ID. Input/context/history data are detached, recursively
  readonly and runtime-frozen; `messages` is current browser native history, potentially
  streamed/not durable, not rendered text or canonical persisted history. This trusted
  API is not a sandbox. Signals/opaque targets are host references, never persisted JSON.
- hasPendingInput is synchronous/side-effect-free; refreshSubmissions after external state
  changes. Predicate failure reports an error and no readiness. Pending input may start
  builtin preparation before native answer fields are filled, not bypass final validity:
  text mode needs answer text/images, selection mode needs valid selection/Other/dontKnow;
  thinking/reading images alone are insufficient. Plugin questions still require a current
  ready editor/answer state before preparation; missing-renderer gates remain authoritative.
- Reserve preparation before awaits; await final dictation/editor publication for the
  original target and recheck view/question/problem/plugin identity after awaits, never
  retarget. Preparing submission… / Cancel is pre-POST only and retains drafts/final speech;
  fence late results even if hooks ignore abort. Native errors say
  `Could not prepare submission ({plugin name}): {message}. Your input has been kept.`
  Do not erase newer drafts or host-clear plugin data. Release the lease at acknowledgment/
  refusal, not streaming completion, preserving subsequent busy composer steers.
- `context.onAccepted(callback)` consumes only captured pending plugin revisions on live,
  best-effort API acknowledgment. It is not durable/replayed/exactly-once or model success:
  memory-only parked-steer acknowledgment can notify without durable history. Refusal/lost
  acknowledgment never authorizes clearing input. Callback failure reports but cannot fail
  accepted input; late registration after invocation/cancel is ignored, and notifications
  do not delay native stream consumption. Model retries reuse stored/transformed accepted
  content, not hooks; Continue/malformed retry/control-only Next/silent dismissals do not
  intercept. Busy retries/steer-to-send fallback reuse single preparation/observers. Explicit
  unaccepted-form Submit is fresh; uncertain acceptance reconciles, never guesses replay.
- Images must be explicit native `{ type: "image", data: <base64>, mimeType }` blocks,
  text followed by images, not arbitrary interleaving. Image-only messages/practice thinking
  and distinct answer/thinking/reading channels are supported by the approved contract.
  PNG/JPEG/WebP/GIF bytes must validate and match MIME, then use existing processing/actual
  engine resize/capability policy; no Blob/File/object/data URL or path inference. `.png`
  paths stay path chips/text. Persist accepted normalized bytes and project them to both
  native model images and corresponding UI containers, not metadata only. Host images sit
  outside custom question/answer slots, including image-only containers, with centered
  aspect-preserving Submitted image figures and undimmed thinking pixels. Keep instant
  optimistic previews, but defer transcript adoption during the owning image-bearing POST
  so normalized canonical bytes cannot duplicate raw previews. Discard deferred snapshots
  and make a fresh canonical read after success, refusal or lost acknowledgment; retire
  only that attempt's provisional images on failure/ownership loss, preserve drafts/plugin
  pending input, and never infer acceptance observers. This human-approved policy has eleven
  permanent causal regressions. Processing or fresh-image text-only-model refusal retains
  input; no silent image omission. Async
  target/model changes refuse stale rather than delivering to replacements.
- The [generalized-surface checkpoint](../../docs/plugin-session-extension-contract.md#12-generalized-page-body-surfaces--implemented-and-verified)
  is **implemented and verified, uncommitted above `8dd7409` on `feature/plugin-architecture`**. `ctx.ui.openSurface(surface, { signal })` captures the active page
  boundary once at invocation: plugin views, native chat, Home/New Draft. No mandatory
  native target or async retargeting. The existing `openSurface(target, surface, { signal })`
  stays compatible for precise native action/submission targets. Both return standard
  `PluginWidgetHandle<PluginSurfaceProps>` and reuse content/async cleanup.
  Explicit opaque tokens still come only from native top-bar/submission context and expire
  with one mounted teaching/practice view; no selector/DOM/session-ID/global-current
  inference, persistence or native capture/hooks/tokens beyond native chat. Missing live
  page boundaries and expired/unknown live targets throw `Surface target is no longer active`;
  already-aborted signals yield inert handles before boundary resolution. Leaving/hiding
  the page aborts its surfaces; re-entry creates a new boundary, never revives old tokens.
  Recheck mount lifetime and clean up late results exactly once.
- Surfaces cover only page body, not native/plugin top bar or sidebar. Home/New Draft have
  no top bar: preserve only floating sidebar toggle/window chrome; graph controls and
  composer remain mounted but covered/inactive. Keep native and covered
  surfaces mounted/painted; only eligible foreground body receives actions. Stack entries
  are visual siblings, not lifetime owners: lower plugin unload/disposal cannot remove
  another owner's foreground or Settings merely painted above. Explicit signals may bind
  lifetimes. Dialogs/Settings always stay in front, even for requests while a dialog is
  open. The surface belongs to the page, not its modal opener; no modal-opener-derived
  focus eligibility or Escape ownership. Closing the dialog can reveal the surface only
  if the caller signal remains live. Navigation/plugin unload/abort/dispose tear down only
  their scopes; no restore
  across navigation. Reuse view layers/owner propagation, no app-wide modal hiding, scroll
  lock, focus trap, new overlay/window manager, global clipping or persistence. Private
  files are `plugin-surface-targets.ts`, `plugin-surfaces.tsx`, `plugin-surface-shell.tsx`;
  never import them into plugins. Approved polish adds only
  `background?: "dimmed" | "opaque"`, default `"dimmed"` (Chains-style 80%-background/blur);
  `"opaque"` is solid with no blur. Validate the enum on open and handle updates. Required
  `title` is the accessible name, **not a visible host title/header row**. Quiet muted Close/X
  floats above scrolling content. Content fills the whole body with the scrollbar at its
  outer edge, not inset by a host frame; plugins own visible headings and bottom actions.
  No extra header/appearance props or forced diagram border. This polish passed the
  separate UI-polish checkpoint, not proof of generalized page coverage. `onClose`
  notifies, never async-vetoes disposal.
- One Escape has one owner; covered native submit/Tab/dictation is ineligible. Surface entry
  honors eligible foreground explicit focus, else first editable text/number/textarea then
  accessible surface fallback, without requiring a host-visible heading. Delayed covered
  mount/disposal never steals focus. Foreground close restores
  eligible uncovered opener including chrome, else surviving foreground remembered focus/
  entry policy or owning-page-body entry policy. Expired views never receive restoration; exposed
  chrome stays interactive. These are scoped view surfaces; the picker separately chooses
  main-pane view or full-viewport modal presentation from its captured origin.
- Do not broaden this increment into message/card/composer slots, generic rich-transcript
  rendering, backend submission hooks, native send/steer, mutable agent/event/context hooks,
  image picker/clipboard/drop import, path inference, asset storage/export redesign,
  alternate surface regions or navigation restoration. These remain deferred; targetless
  page coverage does not broaden native submission scope. The API stays 14 methods;
  Showcase's Surfaces family/direct Open surface button retain the native action and
  nested/background/menu/dialog examples, still 12 families. Its own checkpoint passed
  4,045 host tests / 568 suites, 78 plugin tests, strict SDK/build/privacy gates and the
  literal packaged-browser entrypoint (15 assertion groups, seven page variants,
  29 screenshots). Section 12 records prior strict prefetch failures, the human-approved
  two-stage classifier adjustment, final zero-prefetch-cancellation run, bytes and limits.
  Original native-target and worker-header scroll regressions remain covered.
  Session extensions passed
  their own 3,869-test checkpoint, not the historical 3,778-test question checkpoint. Packaged
  proof includes genuine Canvas/provider image bytes, fail-closed draft retention, pending
  refresh/image-only input, separate answer/thinking/reading images, model retry without hook
  or acceptance replay, practice thinking, path-not-image and scoped surface interactions.
  Builtin shuffled regrading/pending selection and busy-steer 409 single-hook fallback have
  unit proof; do not claim browser proof for them. The prior wheel-over-prose follow-up is
  unresolved. No actual OS microphone/IME, real-provider, signed-installer, full Electron-window
  or Windows/Linux runtime guarantee follows from these fixture/loopback checks.
- Add existing-agent instructions/tools through `registerInstructions/registerTools`.
  Keep native Pi tools and scoped targets; never replace built-in prompts/registries.
  Use `createBackgroundTool` for ack-now/result-later delivery, not a suspended tool
  Promise or a second agent framework. Keep model text separate from rendered data;
  the original native result stays an acknowledgement. Preparation/formatting must
  not introduce side effects. Do not add a plugin-local worker pool or use purpose
  to bypass host policy.
- Shared host admission uses Settings → Agent → Models → **Concurrent worker requests**,
  `agent.workerRequestConcurrency`: default/unset **8**, any positive safely
  representable whole integer, no arbitrary cap, invalid values rejected, never clamped.
  A live increase admits queued requests immediately; a decrease lets active requests
  finish and waits for active count below the new limit. One process-global FIFO pool
  gates background model request streams, releasing before tools/child waits, not whole
  agents. It covers core extractor/auditor/research/demo/visual/PDF requests and **all**
  detached `ctx.workers`, even `purpose: "user"`. Direct teacher/prober/practice and their
  compaction, interactive managed conversations and standalone raw plugin inference are
  excluded. Purpose governs subscription consent, not worker classification. Queued
  cancellation must not dispatch to a provider. Routes/windows share one app-server
  process pool, not a pool across independent server processes. The obsolete whole-
  extractor-phase three-permit wrapper is removed; source-serial chunks, the
  audit-through-merge consistency lock and frontend three-file upload queue stay separate.
- Standalone `ctx.workers` use the existing **Background agents** panel row, titled
  **plugin name · worker definition ID**, with elapsed/activity/model/usage when
  available and no invented session link. **END** cancels computing/queued work, not
  completed results or pending delivery. Suppress a duplicate row when a linked
  `createBackgroundTool` host job already represents the task. Existing task/delivery
  recovery stays unchanged: no automatic retry or new history screen. Admission/activity
  callbacks and SDK engine operations are host-private, not public plugin APIs or a new
  agent framework.
- Use `registerCodeBlock/registerToolRenderer` for shared presentation, not private
  Markdown/React imports. Honor per-mount abort signals and async cleanup. Preserve
  raw fallback and incomplete fence state; don't insert unsanitized model HTML.
  Renderers may style other plugins' tools; producer identity isn't a sandbox gate.
- Worker results remain collapsed by default, not always-expanded cards. Approved plugin
  worker polish shows **status icon plus label only**, without Background prefix or raw
  status text. Collapsed results use a chevron, without **View result / Hide result** text.
  Keep full status accessible and in a tooltip; failure uses the native failure X.
  Host identity/status, disclosure and formatter errors remain authoritative; custom
  renderers own only the body. All twelve terminal-status/presentation combinations passed
  packaged proof with actual accessible hover-tooltips; do **not** redesign native
  Research/PDF disclosure grammar. Set the optional
  `PluginToolRenderer.backgroundPresentation: "collapsed" | "card" | "plain"` to
  choose the shell of later host-delivered results, not the original acknowledgement.
  For example, with a plugin-owned `mountSvg` function:
  `ctx.registerToolRenderer({ toolName: "my_plugin_svg", backgroundPresentation: "plain", mount: mountSvg })`.
  Reuse `ctx.ui.mountWorkerResult` in plugin-owned surfaces: `label`, terminal `status`,
  `text`, optional `presentation: "collapsed" | "card" | "plain"` and `content`.
  Collapsed is the default; card is expanded/bordered, plain expanded/unframed for
  SVG/demos. Plain still retains host identity/status and formatter errors.
  Custom content (also used by dialogs) is an
  HTMLElement or signal-scoped mount returning cleanup, possibly asynchronously.
  Trusted SVG and interactive demos are allowed; unsanitized model HTML is not.
- Deferred `kind:'input'` tools are declarative: no execute callback. Server tools can
  return normal results with `endRun:true`. Do not persist successful placeholder
  answers for questions the person has not answered.
- Reuse request IDs when retrying the same accepted input. Never replay interrupted
  side effects automatically. App shutdown interrupts live execution; navigation does
  not. Missing definitions/schema incompatibility must be explicit errors.
- Use live notifications plus snapshot/resync, not standing polling of hidden views.
  Unsubscribing observation must not cancel server-owned execution.
- Frontend assets are declared entry/style files and `assets/`; never place secrets or
  user data there. Plugin CSS must be scoped. Renderer isolation is not to be disabled.

## Verification

Use temporary, disposable learning/auth directories. No real account calls or learner
records without explicit permission. Test enable/disable, cleanup, invalid data, repeated
submissions, multiple pending inputs, cancellation, navigation away/back and restart
recovery. For UI changes exercise explicit placements/overflow, disabled refresh and
async busy behavior, mount-signal disposal, controlled selectors without core setting
writes, focused shortcuts and competing dictation owners, settings validation/write
failures, and collapsed/card/plain result bodies plus raw fallback. Verify externally
installed folders in the actual packaged runtime, not only
in dev/source imports. Report what was exercised and what remains unverified.
