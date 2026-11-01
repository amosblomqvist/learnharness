# Plugin architecture — API v1

## Approved scope

LearnHarness supports trusted-local plugins, including optional official features,
using the same public API as externally installed plugins. Plugins are broad-capability
code, not a sandbox. Electron's renderer isolation and desktop HTTP credential boundary
remain in force. Backend code runs cooperatively inside the existing Node server;
broken code may require restarting the app.

The human approved implementation of this plan in the `feature/plugin-architecture`
worktree. Subsequent decisions: package management in **Settings → Plugins** and,
with the approved UI increment below, dedicated settings pages for enabled plugins
and explicit action placement instead of an automatic plugin sidebar group;
recoverable startup-only official-package updates rather than whole-directory swaps.
Interrupted package updates must block that package from loading until a successful retry. Package-specific update failures are
reported individually and do not prevent unrelated plugins from starting. These choices
do not authorize a marketplace, core learning-data mutation, or a flashcard product design.

## Package contract

A writable `<learning data>/plugins/<id>/` folder contains `manifest.json`, an optional
browser-module `main.js`, an optional Node `backend.cjs`, optional `styles.css` and
`assets/`, and persistent plugin-owned `data/`. See `src/core/plugins.ts` for the actual
manifest fields and public API types. Entries may use another root filename with the
same extension. IDs are lowercase hyphen-separated words and must match the folder.
API version is `1`; package/app version fields initially use numeric `x.y.z` versions.
Distribute built JavaScript, with dependencies bundled. Node built-ins are available
in backends. No runtime npm installation or native-module rebuilding is provided.

Disabled plugins are discovered without evaluation. New plugins, official or external,
are disabled until explicitly enabled. Code updates apply after a server restart;
refresh discovers manually installed folders, not hot replacement of running code.
Do not start timers, processes, or other side effects at module top level: activation
creates an instance and registers its cleanup; the module itself may remain cached.

Frontend entries export `activate(context)`; backends export `{ activate(context) }`
using CommonJS. Activation may return a cleanup function, and `context.cleanup(fn)`
registers additional cleanup. Backend lifecycle is per server; frontend lifecycle is
per window. View lifecycle is independent: closing a view is not disabling a plugin.

## Responsibility boundary

The plugin owns feature prompts, tools, UI, algorithms, schedules, and data. The host
provides:

- Plugin identity, paths, enable/disable, cleanup and compatibility checks.
- Full read access to learning records, graph evidence/provenance, and projections.
- App-configured model catalog and inference without exposing credentials as API data.
- Optional managed agent sessions and result-oriented tasks under the plugin's own data directory.
- Additive instructions/native Pi tools for the existing prober, teacher and practice agents.
- Shared fenced-block/tool-result renderers, including later background-result presentation.
- Host-owned view shells, explicitly placed actions, dedicated plugin settings pages,
  and controlled host UI widgets; navigation and live app notifications.
- A JSON operation bridge between the frontend and its own backend.

The backend learning-data API remains read-only; no new programmable core-write API is
exposed. The knowledge picker's existing user-driven source rename, folder creation and
drag organization are host UI operations, not backend learning-write methods. The learning-data
location remains available to trusted backend code; readers are conveniences that share
the host's file interpretation, not mandatory filesystem access control. Reads across
several files are not promised to be transactional. `readGraphFile` uses store readers:
for example `sources.json` returns source records, not the file's raw keyed JSON map.

Custom views receive an HTMLElement and a mount-scoped AbortSignal. A plugin may use
plain DOM or bundle React and mount/unmount its own root. Do not import private
LearnHarness components or rely on its React context. Public assets are only declared
frontend entry/style files and the explicit `assets/` subtree, never the backend or
`data/` directory.

## Host shell, actions and controlled UI

The exact contracts are `src/core/plugins.ts` and `src/core/plugin-ui.ts`;
`components/plugin-manager.ts` owns the per-window registration/lifecycle boundary.
`PluginView.mount(container, signal)` owns only the feature body. The host owns the
top bar, title, action layout/overflow, and plugin-settings gear. A mount may return
cleanup asynchronously; departure/replacement/disable aborts its signal. This is
separate from the activation lifetime.

Registering views/actions creates no automatic navigation chrome. Register an action
with `registerAction` first, then attach it using `placeAction({ id, actionId,
location, ...targets })`. Locations are `sidebar`, `graph`, and `top-bar`. Top-bar
placements require explicit `sessions` (`teaching`/`practice`) and/or `views` (the
placing plugin's view IDs) targets. Sidebar actions share the core teaching/practice
action area; there is **no dedicated plugin sidebar section**. Graph actions occupy
the host graph strip. Placement and registration have separate unregister handles.

Actions receive typed surface context: session ID/kind on session top bars, plugin/view
IDs on plugin top bars, or the sidebar/graph surface discriminator. Plugins supply
name, optional trusted SVG icon, disabled boolean/predicate, and `run(context)`.
`ctx.refreshActions()` explicitly asks the host to re-evaluate enabled state after
plugin state changes. The host owns surrounding buttons and async busy state, prevents
repeat invocation of the same action until its Promise settles, and surfaces errors.

`ctx.ui` is a framework-neutral controlled facade, implemented in the host tree rather
than exported private React components. It provides independently mountable composer,
dictation, model picker, thinking picker, knowledge picker, button, settings rows and
worker-result presentation; `mountStandardComposer` combines composer, dictation, model
and thinking controls as a preset. Menus and
dialogs are available via `openMenu` and `openDialog`. Every call takes
`options: { signal }` and returns a handle with shallow `update(partialProps)` and
idempotent `dispose()`. Widget scopes terminate on mount-signal abort or plugin disable.
Plugins retain values and callback/persistence policy; selectors never write core
model defaults or other core settings. No widget implicitly starts inference.

The standard composer deliberately excludes usage, practice controls, attachments and
default file/drop insertion. Dictation has an explicit plugin text destination, never
an implicit core composer/question target. There is one recording owner across core
and plugin instances in a window; another start reports “Dictation is active elsewhere”.
Only focused plugin controls claim their matching shortcuts, with core fallback otherwise;
Escape cancels the actual recording owner. The preset finishes dictation and awaits
transcript delivery before send. Independent widgets leave that coordination to the plugin.

Every enabled plugin gets a dedicated Settings navigation page, even without registered
settings or a frontend entry. The host displays an empty state when appropriate; package
management stays separate in Settings → Plugins. Both the view gear and
`ctx.app.openSettings()` select the owning plugin's page. `registerSettings` accepts
one `{ rows }` schema or a custom `mount(container, signal)` escape hatch. Rows support
toggle, text, dropdown, number and slider controls, controlled values, plugin callbacks,
optional validation/description/disabled state and numeric bounds. Schema validation
rejects invalid registrations; value validation prevents invalid commits. Async callback
failures are inline errors, not successful saves. The schema overload returns
`PluginWidgetHandle<PluginSettingsSchema>`: `update({ rows })` validates and publishes
accepted values, and `dispose()` unregisters; stale/disposed handles are inert. The
custom-mount overload retains its unregister-function return. Plugins own persistence
and backend validation, publishing rows only after a successful save; a custom mount
is not required for live updates, but may use `mountSettingsRows` itself. No general
declarative UI language or host-owned plugin settings store is added.

### Knowledge selection through existing host UI

The approved additive API v1 method is
`ctx.ui.mountKnowledgePicker(container, { value: readonly string[], onChange(ids), disabled? }, { signal })`.
Its `PluginKnowledgePickerProps` and standard `update(partialProps)`/`dispose()` handle
are defined in `src/core/plugin-ui.ts` and included in the generated type bundle. The
plugin chooses bubble placement, controls selected node IDs and owns persistence; the
host never writes plugin state.

The host reuses the exact existing `NodePickerControl` and real `ChainTableOverlay`, not
copies. The bubble shows **Pick nodes**, selected count and **Clear**; Clear emits `[]`.
Opening it presents Chains across the full app content column, including the top-bar
area, while the sidebar remains accessible—not an inline embed. Checkbox changes are
immediate controlled updates. Done, X and Escape close without resetting selection;
reopening retains the controlled IDs. The host supplies canonical graph/source organization,
loads lazily at first open following the existing new-practice pattern, and handles focus,
portals and mount-signal/disable cleanup.

The approved foreground extension supports ordinary plugin views, plugin Settings and
content inside public `ctx.ui.openDialog`, without changing the API, adding props or
requiring a new plugin-side lifetime arrangement. An internal host provider coordinates
with the app shell. A launching modal stays mounted and retains state, but is temporarily
hidden while the full-column selector is active. Done, X and Escape close only the
selector and restore the origin's state and focus.

Foregrounding happens at opening, not as a permanent always-on-top claim. A newer public
dialog or menu can foreground normally. **Any Settings open** closes the active or pending
selector from **any origin**: ordinary view, Settings or public dialog. It preserves the
controlled IDs and performs normal Settings opening/deep-linking; closing Settings never
automatically resumes the old picker. Settings does not merely cover the picker for later
restoration. Broader Settings/public-dialog overlap rules remain undecided; this is not a
general modal-stack policy.

There is one active selector: opening a new one closes the previous selector without clearing its
controlled IDs; the previous picker does not auto-resume. An older asynchronous load
must not promote its selector over newer UI. These are scoped host-picker rules, not
a general overlay framework.

Selection mode retains user-driven source **rename**, folder **creation** and **drag
organization**. It must not become a read-only source tree. Management Delete is not
available in practice-picker mode, as before. These existing host UI edits do not expose
new programmable core-write APIs or change the read-only backend learning API. Deck trees,
state, membership and selection limits remain plugin-owned; no generic deck/library-tree
host API is added. Final verification of the Settings/dialog foreground extension is pending.

## Managed agents

Persistent session, active run and observing view are distinct lifetimes. The host
uses the installed Pi Agent loop, not a second general-purpose agent framework.
Definitions select instructions, an explicit model, tools, and optional stopping rules.
Sessions live in `<plugin>/data/agents/`; they are not a new core ChatKind and do not
trigger teaching extraction, graph writes, or teacher/prober behavior.

Two pause mechanisms are supported:

1. `kind: "input"` declares a tool whose result comes from external input. Its valid
   call becomes a persisted pending interaction. The run ends; no unresolved Promise
   or successful placeholder is persisted. `prepareArguments` can validate arguments;
   `resultSchema` validates submitted results; `formatResult` produces model content.
   Input tools do not have `execute` or `endRun`.
2. A server tool executes normally and may use `endRun: true` to end the run after
   a successful result. Later explicit user messages continue the conversation.

Required pending results must all be present before another model request. A failed
argument validation is an error result, not a pending question. Request identities
make retried input idempotent. Accepted input is durable before a run starts; tool
calls are checkpointed before side-effecting execution. Completed tool results are
checkpointed, too. Persistence failures must not claim successful acceptance.

`send(id, explicitText, {requestId, purpose})` starts or continues a task; purpose is
`user` or `background` and the host's existing connection policy applies. `run()`
resumes existing runnable input; it never invents a user message such as “Continue.”
Tools are registered by the backend. Frontends submit through plugin-defined bridge
operations, so plugins own their interaction policy and interface.

Navigation/reload detaches the view without stopping server work. Snapshot observation
reattaches to current state and response-so-far, not an ever-growing chunk replay log.
App/server shutdown does not preserve live execution. Waiting inputs survive restart;
a run interrupted during execution is reported as interrupted, not auto-replayed.
An interrupted incomplete tool batch cannot safely continue automatically; explicit
new input can establish recovery context while the original history stays on disk.
The host does not promise exactly-once execution of arbitrary external side effects.

Inference and managed calls use host-owned authentication/transport and usage collection.
Plugins supply request content and supported generation options, not credential/transport
callbacks. Contributions to core teaching/practice use that conversation's existing engine,
authentication and usage path, not the plugin's independent worker model selection.

## Agent and content contributions

Backend `registerInstructions` and `registerTools` explicitly target prober, teacher and/or
practice. Instructions append to built-in/overridden system-prompt segments; native Pi tools
append to the built-in registry. A fresh synchronous factory receives immutable chat identity
for each turn. Core names remain reserved even if toggle-disabled. Deterministic package-ID
order resolves ownership; a collision/invalid factory omits the offending package's complete
loadout for that turn and reports a visible diagnostic without disabling its other services.
Successful re-evaluation clears that diagnostic. Basic schema hygiene is not a universal
provider-compatibility guarantee. Disabling fences captured tools and aborts cooperative
execution; running conversation prompts are not rewritten.

Frontend `registerCodeBlock` and `registerToolRenderer` use the same HTMLElement/cleanup
model as views. Source, metadata, incomplete-fence state and native result details/content
are public data—not private React components. Built-in exclusive presentations remain
reserved; ordinary generic presentation is extensible. A presentation plugin may render
another plugin's tools. Abort signals and generation-owned DOM prevent stale mounts from
clobbering replacements. Missing/disabled/failing renderers preserve readable raw content.
These hooks do not add a new pending learner-input protocol or change question grading.
Existing compaction behavior is deliberately unchanged: valid provider usage anchors remain
the normal basis, with an estimated appended tail; the rare unanchored fallback does not
include plugin instructions, and changing prompt/tool contributions does not refresh an old
usage anchor. The current trigger prefers `usage.totalTokens` whereas the visible measured
meter sums input/output/cache-read/cache-write. This increment does not align those paths or
promise exact pre-request context sizing for arbitrary contributions.

## Result-oriented workers and background tools

`ctx.workers` complements managed conversational agents: a task has immutable accepted
input, explicit model/purpose, bounded model-turn budget, native tools, a result schema and
optional semantic validation. `start` persists acceptance and defers execution; `wait` returns
a terminal outcome, never an ambiguous idle snapshot. One host `submit_result({result})`
tool provides correction feedback in the same native context. The first durably accepted
valid result wins, including falsy JSON values; subsequent batch effects and replacement
submissions are fenced. No-result exit, turn exhaustion, deadline, provider and storage
failures are not success. Storage uncertainty is not turned into an invented durable result.

Tasks use the existing native sub-agent runner, not another model loop. Records under
`data/tasks/` contain native history/progress, input/configuration and outcomes; usage also
uses the host inference ledger. Views/waiters do not own execution. Explicit cancellation
is cooperative. On disable/restart **all unfinished tasks become interrupted**, including
queued tasks and stored tasks in disabled packages. Retry is a new explicit attempt;
no automatic tool replay or JavaScript handler restoration occurs.

`createBackgroundTool` is a thin native Pi tool helper. It derives identity from the actual
conversation/tool call, starts background-classified work, persists a linked generic plugin
job, and returns an acknowledgement. The original native tool result remains that ack.
Completion uses the existing job/wake/steer pipeline, including live turn boundaries,
pending-question gates, consent, continuation coalescing and deterministic delivery IDs.
Model text and rendered data are separate; the later card reuses the tool renderer with
explicit background metadata rather than fabricating a native tool result.

The user-approved default result presentation is collapsed, sharing the research/PDF
completion/disclosure grammar. Host identity/status (and disclosure when collapsed)
remain authoritative; plugin renderers replace the body only.
`PluginToolRenderer.backgroundPresentation?: "collapsed" | "card" | "plain"` chooses
the shell for later host-delivered results, not the original tool acknowledgement.
`ctx.ui.mountWorkerResult` exposes the same choices through its `presentation` prop
for plugin-owned surfaces: default `"collapsed"` disclosure, expanded bordered `"card"`,
or expanded unframed `"plain"` for SVG/demos. All retain host identity/status and
host-delivered formatter errors remain visible. The helper also takes terminal status,
label, fallback text and optional custom `content`. Content may be an HTMLElement or a signal-scoped mount with cleanup, including
an async mount. Trusted SVG, interactive demos and other rich bodies are permitted;
this does not authorize unsanitized model HTML or hiding readable fallback results.

The canonical task outcome and delivery state are separate: formatter/unavailable-plugin
failure keeps the accepted result plus honest fallback. Worker completion ends the job's
computing state; END does not cancel completed work or its queued delivery. A generic
outcome is persisted before asynchronous formatting; live delivery waits for formatting,
but restart recovery can use that persisted fallback. Recovery reads safe persisted task
state even for disabled packages; it re-delivers results or reports an honest failure,
never replays preparation/tools/formatters. Durable delivery distinguishes result, learner
abort, and failure notices; missing/unreadable task state is not relabeled as learner abort.
The shared job adapter uses atomic fsynced replacement for durable linkage/result updates.

There is no DAG framework, guaranteed execution with the app closed, new plugin concurrency
pool or competing setting. Task computation and result delivery retain their existing
lifecycles; host admission does not add automatic retry or a new task-history screen.

### Shared host worker-request admission

Host admission establishes one process-global FIFO gate for
background **model request streams**, not whole agents. A permit is released when its
request ends, before tool execution or waiting for child work. The pool spans routes and
windows connected to the same app-server process; independent server processes do not
share it.

Settings → Agent → Models exposes **Concurrent worker requests** as
`agent.workerRequestConcurrency`, default **8** when unset. Any positive safely
representable whole integer (JavaScript safe integer) is valid, without an arbitrary cap;
invalid values are rejected rather than clamped. A live increase drains queued requests
immediately up to the new limit. A decrease lets active requests finish and waits until
the active count is below the new limit before admitting another request. Queued
cancellation prevents provider dispatch.

Extractor, auditor, researcher, demo builder, visual maker and PDF reader requests share
the gate with **all** detached `ctx.workers` tasks, including user-initiated tasks.
Direct teacher/prober/practice requests and their compaction, interactive plugin-managed
conversations and standalone raw plugin inference are excluded. `purpose` governs
subscription consent, not worker classification. The old whole-extractor-phase
three-permit wrapper is removed; source-serial chunks and the audit-through-merge FIFO
consistency lock remain. The frontend's three-file upload queue is independent.

Standalone `ctx.workers` tasks integrate into the existing **Background agents** panel:
one row titled **plugin name · worker definition ID**, with elapsed time, activity,
model and usage when available. There is no invented session link. **END** cancels
computing work, including queued work; completion still ends computing state without
cancelling pending delivery. A linked `createBackgroundTool` host job already represents
its task, so the standalone projection is suppressed to avoid duplicate rows. Canonical
task state and existing durable delivery/recovery semantics remain authoritative.

Request admission, activity registration and SDK engine operations/callback metadata are
host implementation details, not new plugin contracts or a public agent framework.
Plugins continue using the existing worker and background-tool APIs.

## Notifications and recovery

The app's existing single per-window notification connection carries plugin availability
changes and namespaced live plugin messages. These are not a durable arbitrary-event
log. A reconnect fires resync callbacks; plugins read a current snapshot. Plugin-specific
model/session observation must release connections on view departure and must never
cancel server execution just because a response reader disconnects.

## Distribution and updates

External installation starts as copying a folder and refreshing the plugin list. Official
packages ship in the app and are installed into the writable plugins location at startup.
Ownership metadata prevents silently overwriting an external package with the same ID.
Official code updates validate/stage first, use per-file atomic replacements, write the
manifest last, and preserve `data/`. A durable in-progress marker blocks loading an
incomplete update until startup retries successfully. Package-specific failure reports
block that package only; corrupt shared ownership/enable-state metadata is refused
rather than overwritten. This is recoverable, not a fully atomic whole-package swap.
Uninstall/data deletion and automatic community updates are not part of v1.

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
11. Knowledge-picker control reusing the existing host Chains/source-organization UI,
    with an approved Settings/dialog foreground extension; final extension verification pending.

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

### Knowledge picker foreground extension — final verification pending

The ordinary-view picker checkpoint passed its tests and packaged actual-browser checks,
including source rename, folder creation and drag organization, alongside the full admission
checks. The SDK consumer check also passed. These results do **not** verify the newly
approved Settings/dialog foreground extension or its revised any-Settings-open closure
rule. Final gates and actual Settings/dialog-origin browser proof remain pending; no new
extension pass counts are claimed. Broader Settings/public-dialog overlap behavior is not
approved by this scoped rule.
The completed admission/activity checkpoint below is retained separately and does not
establish picker-extension verification.

### Worker admission and activity verification checkpoint — 2026-11-01

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
