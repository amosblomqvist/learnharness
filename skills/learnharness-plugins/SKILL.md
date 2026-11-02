---
name: learnharness-plugins
description: Build, inspect, or debug a trusted-local LearnHarness plugin using the public plugin API. Use for host UI widgets, explicit action placements, plugin settings, custom views, native teaching tools/instructions, content renderers, validated background workers, interactive agents, learning-data readers, or plugin lifecycle problems.
---

# LearnHarness plugin authoring

First read `docs/plugin-authoring.md`, `docs/plugin-architecture.md`, the authoritative
`docs/dialog-overlay-contract.md`, and the actual
contracts `src/core/plugins.ts`, `src/core/plugin-ui.ts`, `src/core/plugin-agents.ts`,
and `src/core/plugin-workers.ts` in the matching app
checkout. These paths are repository-relative, not relative to an installed plugin.
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
  CommonJS backend JavaScript, with JS dependencies bundled. No app-side npm install.
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
  `mountKnowledgePicker`, `mountStandardComposer`, `mountButton`, `mountSettingsRows`, `mountWorkerResult`,
  `openMenu`, and `openDialog`. Every call takes final `options: { signal }` and
  returns `update(partialProps)`/`dispose()`; updates are shallow, so replace whole
  nested preset props. Plugin callbacks own values/persistence; feed accepted values
  back into handles. Model/thinking selectors never write core settings.
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
  plugin-owned. The shared foundation/modal picker passed the final 3,665-test and packaged
  gates recorded in `docs/plugin-architecture.md`; older checkpoints remain historical.
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
