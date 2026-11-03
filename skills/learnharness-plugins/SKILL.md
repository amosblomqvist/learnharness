---
name: learnharness-plugins
description: Build, inspect, or debug a trusted-local LearnHarness plugin using the public plugin API. Use for host UI widgets, explicit action placements, plugin settings, custom views, native teaching tools/instructions, bounded native question formats, native submission interception/images/session-body surfaces, content renderers, validated background workers, interactive agents, learning-data readers, or plugin lifecycle problems.
---

# LearnHarness plugin authoring

First read `docs/plugin-authoring.md`, `docs/plugin-architecture.md`, the authoritative
`docs/dialog-overlay-contract.md`, `docs/plugin-question-contract.md`, the
[authoritative session-extension contract](../../docs/plugin-session-extension-contract.md),
and the actual contracts `src/core/plugins.ts`, `src/core/plugin-ui.ts`, `src/core/plugin-agents.ts`,
`src/core/plugin-workers.ts`, `src/core/plugin-questions.ts`, and
`src/core/plugin-submissions.ts` in the matching app checkout. Native session extensions
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

## Rules

- Ask the human for feature behavior, prompts, defaults, algorithms, source policy,
  data deletion, and interface decisions. A plugin platform does not choose a product.
- Start from `examples/plugins/hello-plugin` (frontend only) or
  `examples/plugins/managed-agent` (Node + managed interactive/background agent), or
  `examples/plugins/teaching-extension` (instructions, native tools, renderers and a
  detached result worker in existing lessons).
- Installed folder ID must match `manifest.json`. Ship built ES-module frontend and
  CommonJS backend JavaScript, with JS dependencies bundled. Install built package contents
  with the root manifest/referenced bundles, not the source project root; preserve existing
  plugin `data/` when replacing code. No app-side npm install.
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
  `mountWorkerResult`, `mountMarkdown`,
  `openMenu`, and `openDialog`. Every call takes final `options: { signal }` and
  returns `update(partialProps)`/`dispose()`; updates are shallow, so replace whole
  nested preset props. Plugin callbacks own values/persistence; feed accepted values
  back into handles. Model/thinking selectors never write core settings.
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
- The additive API v1 knowledge picker uses
  `ctx.ui.mountKnowledgePicker(container, { value, onChange, disabled? }, { signal })`:
  `value: readonly string[]` of node IDs, `onChange(ids)`, standard `update`/`dispose`.
  Plugins own bubble placement, controlled selection and persistence; the host never
  writes plugin state. Reuse the exact `NodePickerControl` and real `ChainTableOverlay`,
  not copies: Pick nodes/count/Clear (`[]`), immediate checkbox updates reflected via
  `handle.update({ value: ids })`. The plugin picker is a **full-window modal** with
  existing translucent/blurred Chains visuals; background/sidebar are inactive. Core
  Graph/Practice Chains remain nonmodal, content-column bounded and sidebar-interactive.
  Done/X and unconsumed selector-owned Escape close only it, retain selection and restore
  eligible focus. Ordinary views, plugin Settings and public `ctx.ui.openDialog` content
  use the same API/props/signal and lifetime contract. Launching parents stay mounted,
  **painted/visible underneath and inert**, preserving state/scroll—not `display: none`.
  New public dialogs/menus foreground normally. Fresh Settings nests above the picker
  without discarding it; returning to existing Settings uses guarded top-down close
  callbacks, stopping on blocked/handled/pending, with no queued navigation or forced
  cancellation. Retarget only after return-to succeeds. One selector uses a shared
  exclusive opening slot and normal close guards; closing the previous selector retains
  controlled IDs without auto-reopening it. Newer UI/retarget invalidates older pending
  graph loads so they cannot promote stale UI. The host supplies canonical graph/source
  organization, lazy first-open loading, focus/portals and abort cleanup. Preserve source
  rename, folder creation and dragging: selection mode is **not read-only**. Management
  Delete stays unavailable in practice-picker mode. Backend learning APIs remain read-only;
  no programmable core-write/deck-tree API is added. Deck state/membership/limits stay
  plugin-owned. The shared foundation/modal picker passed the historical 3,665-test and
  packaged gates recorded in `docs/plugin-architecture.md`; this does not verify the later
  static Markdown API.
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
- Composer, dictation, model and thinking are independent controls; the standard
  composer is only a convenience preset. It excludes usage/practice controls,
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
  authoring guide example). Do not publish success after validation/write failure.
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
  answer fallback). Host ThinkingBlocks remain outside custom answered content. Immutable
  input/chatId/questionId/contractVersion/variant/signal identify each mount. The editor
  publishes atomic empty (no value) or unready/ready with JsonValue synchronously via
  `onChange`; only a current ready handle can submit. Handle update({ answer, active })
  never echoes or resets identical selection/composition; provide focus/dispose, optional
  handleKeyDown for exact `Tab`/`Enter`/`Shift+Enter`/`Escape` handled/pass and optional
  appendTranscript. Host shortcuts/Shift+Tab/Mod+Enter/IME keep precedence; passed Tab uses
  private field cycling, unclaimed editor Enter edits. No public generic key/field SDK.
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
- `ctx.ui.openSurface(target, { title, content, onClose? }, { signal })` returns standard
  PluginWidgetHandle<PluginSurfaceProps>, with existing PluginUiContent/async cleanup.
  Obtain opaque PluginSurfaceTarget from native session top-bar action or submission
  context; no selector/DOM/session-ID/global-current inference or persistence. One mounted
  teaching/practice view owns the token; navigation back to the same ID never revives it.
  Live expired/unknown target throws `Surface target is no longer active`; already-aborted
  signals yield inert handles. Recheck mount lifetime and clean up late results exactly once.
- Surfaces cover the full session body/inputs, not top bar/sidebar. Keep native and covered
  surfaces mounted/painted; only eligible foreground body receives actions. Stack entries
  are visual siblings, not lifetime owners: lower plugin unload/disposal cannot remove
  another owner's foreground or Settings merely painted above. Explicit signals may bind
  lifetimes. Navigation/plugin unload/abort/dispose tear down only their scopes; no restore
  across navigation. Reuse view layers/owner propagation, no app-wide modal hiding, scroll
  lock, focus trap or second registry. Use body-bounded background/80 blur, p-4 frame, visible
  accessible title and slim Close/X header, content filling remaining width/height; no forced
  diagram viewport border. onClose notifies, never async-vetoes disposal.
- One Escape has one owner; covered native submit/Tab/dictation is ineligible. Surface entry
  honors eligible foreground explicit focus, else first editable text/number/textarea then
  title heading. Delayed covered mount/disposal never steals focus. Foreground close restores
  eligible uncovered opener including chrome, else surviving foreground remembered focus/
  entry policy or native-body entry policy. Expired views never receive restoration; exposed
  chrome stays interactive. These are scoped view surfaces, not the full-window modal picker.
- Do not broaden this increment into message/card/composer slots, generic rich-transcript
  rendering, backend submission hooks, native send/steer, mutable agent/event/context hooks,
  image picker/clipboard/drop import, path inference, asset storage/export redesign or extra
  surface regions/graph/plugin-route targets. All remain deferred. Session extensions passed
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
- Worker results default to collapsed research/PDF-style disclosure by user decision,
  not always-expanded cards. The host owns identity/status (and disclosure when
  collapsed); custom renderers own only the body. Set the optional
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
