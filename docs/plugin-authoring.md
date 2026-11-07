# Build a LearnHarness plugin

Plugins are **trusted local code**, not sandboxed extensions. Backend modules run in
LearnHarness's Node server with filesystem/network access; frontends run in the app
page. Install only code you trust. The API does not expose provider credentials or
relax Electron renderer isolation.

This guide describes the current checkout's API v1, including additions not present in
the released 0.4.1 app. Use documentation/types matching the target app, and set
`minAppVersion` to a version that actually supplies every capability you use.

## Quick start

1. Open **Settings → Plugins** to find the writable plugins directory.
2. Copy `examples/plugins/hello-plugin` there, keeping its folder name and `dist/`.
3. Refresh the list, enable **Hello plugin**, and open its sidebar action.
4. Edit the installed `hello-plugin/dist/` code and restart LearnHarness to load changes.
   Refresh discovers packages; it does not hot-reload admitted JavaScript.

LearnHarness runs no npm commands. For a TypeScript project, build before refreshing.
The repository's `plugins/` projects demonstrate bundled production features; the
no-build `examples/plugins/` packages are smaller starting points:

| Example | Demonstrates |
| --- | --- |
| `hello-plugin` | Frontend view, actions and plugin settings |
| `managed-agent` | Frontend/backend bridge and persistent interactive agents |
| `teaching-extension` | Additive instructions, native tools, renderers and a detached worker |

Model-using examples may incur cost when explicitly run. These examples are authoring
material, not automatically enabled plugins or a commitment to bundle every feature.

Packaged apps include matching docs, examples, a coding-agent skill and generated
API types in `plugin-authoring/` beside the standalone server in app resources.
That directory is read-only material, **not** the writable installed plugins directory.

## Choose the extension point

| Goal | API / reference |
| --- | --- |
| Own screen and controls | `registerView`, actions, `ctx.ui` below |
| Dedicated plugin settings | `registerSettings` below |
| Inspect the current session, including unsent input | Session top-bar `context.view`; [view context](plugin-view-context.md) |
| Add instructions or tools to existing agents | `registerInstructions`, `registerTools` below |
| Custom teaching question and editor | `registerQuestionType` + `registerQuestionRenderer`; [question contract](plugin-question-contract.md) |
| Custom practice problem and editor | `registerProblemType` + `registerProblemRenderer`; [problem contract](plugin-problem-contract.md) |
| Transform learner input or attach images | `registerSubmissionInterceptor`; [session extensions](plugin-session-extension-contract.md) |
| Cover the current page body | `ctx.ui.openSurface`; [surface contract](plugin-session-extension-contract.md#8-public-surface-contract) |
| Render code fences or tool results | `registerCodeBlock`, `registerToolRenderer` below |
| Display a controlled hierarchy | `ctx.ui.mountTree`; [tree contract](plugin-tree-contract.md) |
| Convert an uploaded PDF/text file | Frontend `ctx.documents.toMarkdown` below |
| Read saved learning records | Backend `ctx.learning` below |
| Call models, run conversations or bounded tasks | Backend `ctx.inference`, `ctx.agents`, `ctx.workers` below |

Feature contracts define lifecycle and acceptance rules; this guide is the entry point.
Exact public types are in `src/core/plugins.ts`, `plugin-ui.ts`, `plugin-agents.ts`,
`plugin-workers.ts`, `plugin-questions.ts`, `plugin-problems.ts`, `plugin-submissions.ts`,
`plugin-view-context.ts` and `plugin-tree.ts` (all under `src/core/`). Use **type-only**
imports, never runtime imports of private host modules. The portable type-only SDK is
emitted by `node scripts/build-plugin-types.mjs`. Repository TypeScript plugins use a
local `.sdk/` and `npm run sdk`; outside a checkout, copy packaged
`plugin-authoring/types/` into `.sdk/` before dependency installation. Pi native types
are intentionally part of API v1 and follow the app's pinned SDK, not arbitrary Pi versions.

## Package and installation

```text
<learning data>/plugins/my-plugin/
  package.json       # optional authoring configuration
  src/               # optional source; never a runtime fallback
  dist/              # required fixed runtime root
    manifest.json
    main.js          # optional browser ES module
    backend.cjs      # optional Node CommonJS module
    styles.css       # optional; requires a frontend entry
    assets/          # public distributable assets/modules
  data/              # persistent sibling; never distribute or serve it
```

A manifest has `apiVersion: 1`, lowercase-hyphen `id` matching the workspace folder,
`name`, numeric `x.y.z` `version` and `minAppVersion`; optional fields are `description`,
`author`, `main`, `backend` and `styles`. At least one of `main` or `backend` is required.
Entry filenames name files at the root of `dist/` with their required extensions, not
paths into source or data. Malformed/incompatible packages are reported without evaluation.

- Build directly into the project's `dist/`, not `dist/<id>/`. Bundle JavaScript
  dependencies; leave Node built-ins external in the CommonJS backend. The host does
  not install dependencies or rebuild native modules.
- Distribute built `dist/` **contents**, installing them into `<id>/dist/`, not `<id>/`.
  The no-build examples already contain this layout and can be copied as whole folders.
- Preserve `<id>/data/` when updating code. Build cleanup must remove only generated
  `dist/`, never the workspace or data. Refuse symlinked `dist/` and any misplaced
  `dist/data/` entry, including symlinks, before deleting/building.
- The plugin owns data schema/migrations; refuse to rewrite a newer format you do not
  understand. Reserve `data/agents/`, `data/tasks/` and `data/usage.jsonl` for host services.
- Newly discovered plugins default to disabled. Disabling does not delete data.
  Source-only projects and root-only manifests are not installable. There is no separate
  development registration, legacy-layout fallback, or hot code replacement.

Official and external plugins use the same APIs and writable installation layout.
The host can install/update flat built packages from app `bundled-plugins/<id>/` into
`<learning data>/plugins/<id>/dist/` at startup, preserving sibling data and refusing
external ID collisions. Editing managed installed code is not durable across startup
updates. Source projects remain under repository `plugins/`; the selection and build
staging of official packages is a separate distribution decision, not implied here.

## Frontend lifecycle and navigation

```js
export function activate(ctx) {
  ctx.registerView({
    id: "library",
    name: "My library",
    mount(container, signal) {
      const button = ctx.ui.mountButton(container, {
        label: "Plugin settings", onClick: () => ctx.app.openSettings()
      }, { signal });
      return () => button.dispose();
    }
  });
  ctx.registerAction({
    id: "open-library", name: "Open my library",
    run: () => ctx.app.openView("library")
  });
  ctx.placeAction({ id: "library-sidebar", actionId: "open-library", location: "sidebar" });
}
```

Activation is once per enabled plugin **per window**. Returned cleanup and
`ctx.cleanup(fn)` run on disable. Register views/actions/settings during activation;
do not start side effects at module top level, because native modules remain cached.
View/action IDs are 1–128 ASCII letters, digits, dots, underscores or hyphens, starting
with a letter or digit. Display names are ordinary text.

A view mounts only the feature body. The host owns its top bar, title, placed actions,
overflow and settings gear. `mount(container, signal)` may return cleanup asynchronously;
departure/replacement/disable aborts its signal. Pass that **per-mount** signal to widgets,
not only the longer activation signal. Unmount React roots and release events/timers.
Use scoped CSS/theme variables (`--foreground`, `--background`, `--border`) and safe text
insertion; shared-page CSS is not sandboxed.

The view body scrolls in a bounded, full-width host viewport **below the top bar**,
with its scrollbar flush to the main pane's right edge. Long content must not move
the document, top bar or sidebar. Plugins may still provide their own bounded
scrollers; content that fits does not create a second host scrollbar. Page-body
surfaces are separate overlay siblings, not children of the background scroll viewport.

`ctx.app` exposes `pathname()`, `openSession(id)`, `openHome()`, `openView(id)` and
`openSettings()`; the latter two target this plugin. It exposes no private React context
or graph-selection internals.

### Actions

Register an action **before** placing it. An action has `id`, `name`, optional trusted
SVG `icon`, optional declarative `shortcut`, optional `disabled` boolean/context predicate, and `run(context)` (sync or
async). The host supplies button/tooltip, busy/repeat prevention and error reporting.
Use `ctx.refreshActions()` when plugin state changes a dynamic predicate.

Placements have independent IDs/unregister handles: `{ id, actionId, location }`.
`sidebar` shares the core action area; `graph` uses the graph action strip. `top-bar`
requires explicit `sessions: ["teaching", "practice"]` (either subset) and/or `views`
(this plugin's view IDs). Registration alone creates no navigation chrome.

| Context `placement` / `surface` | Additional fields |
| --- | --- |
| `top-bar` / `session` | `sessionId`, `kind`, opaque `surfaceTarget`, readonly `view` |
| `top-bar` / `plugin-view` | `pluginId`, `viewId` |
| `sidebar` / `sidebar` | None |
| `graph` / `graph` | None |
| `keyboard` / `session` | Same session fields, including a fresh readonly `view` |
| `keyboard` / `plugin-view` | `pluginId`, `viewId` |
| `keyboard` / `app` | Current `pathname` (other app pages) |

Session `context.view` is a fresh detached/frozen snapshot: full browser-native
`messages`, host-projected `transcript`, metadata/status, queued steers, retained
composer text and host-selected native/custom input, including displayed option order
and published unsent drafts. It stays bound to its original session/occurrence across
awaits. Reads never reveal input, flush dictation, save, process or submit. Disabled
predicates receive the same read-only shape; clicks capture anew. Respect supplied
reveal/availability flags when choosing learner-facing references: full history is
inspectable, not sanitized to currently painted prose. See the [view-context contract](plugin-view-context.md).

### Action shortcuts

Opt an existing action into Keyboard Settings and the shortcut cheat sheet:

```ts
ctx.registerAction({
  id: "open-board", name: "Open board",
  shortcut: {
    scope: { sessions: ["teaching", "practice"], views: ["board"] },
    defaultBinding: "mod+shift+d", // illustrative; omit to start unbound
  },
  run(context) {
    if (context.surface === "session") {
      // Keyboard and top-bar invocations both receive context.view.
    }
  },
});
```

`scope: "app"` explicitly enables an action across pages. Otherwise provide a nonempty
`sessions` and/or `views` scope; view IDs always belong to this plugin. Registration
captures a detached/frozen scope/default. Unregister/re-register to change them;
`refreshActions()` remains for dynamic enabled state, not shortcut metadata changes.
A shortcut requires no button placement, and actions without `shortcut` are unchanged.
Existing actions opting in must accept `placement: "keyboard"`, not assume `top-bar`.
App-wide actions still receive actual session/plugin-view context on those pages.

Bindings use the existing canonical `mod`, `alt`, `shift`, key order: `mod+shift+d`,
`alt+x`, `f8`, etc. `mod` accepts Ctrl or Cmd. Only single Mod/Alt chords and function
keys F1–F24 are supported. Escape/Tab/Enter combinations, bare typing/navigation keys,
sequences and OS-wide hotkeys are not supported. Existing typing-surface guards apply;
leaf editors get first refusal. Repeats, handled events and composition do not invoke
plugin actions. Invocation uses the existing disabled/busy/error-handled action runner.

App-wide means across pages, not through blocking UI. Dialogs, menus, native expanded
viewers and another plugin's foreground surface block shortcuts. An action remains
eligible over its own plugin's page-body surface, allowing a toggle to close it. Scope
still refers to the underlying active page. Navigation/retention never invokes an old
page's reader; session snapshots detach before the action runs and remain immutable
across awaits. One physical key cannot fall through a foreground closed by that key.

Settings lists registered shortcuts under plugin names, including unbound/conflicting
entries. Rebind assigns one chord; Clear saves unbound; Reset restores the optional
plugin default. Overrides share `lh:keymap` under `plugin:<pluginId>:<actionId>` and
survive disable/re-enable or temporary absence. Reset all also removes these overrides.
Only enabled/active registrations participate in dispatch/conflicts.

Core effective bindings always take precedence. Scope-overlapping competing plugin
defaults remain inactive with no load-order winner. Explicit plugin assignments beat
plugin defaults; Settings refuses core collisions and collisions with other explicit
plugin assignments without changing saved bindings. Conflicts use declared scope overlap,
not transient disabled/busy/focus state. Nonoverlapping scopes may share a chord. If
saved assignments conflict after scope changes or manual storage edits, affected
bindings fail closed and Settings explains the conflict. Clickable actions still work.

### Controlled host UI

All 15 `ctx.ui` methods take final `{ signal }` options and return a handle with
shallow `update(partialProps)` and idempotent `dispose()`. Replace whole nested props
when updating them. Abort/plugin disable disposes associated mounts/overlays. The
plugin owns values and persistence; feed accepted values back through `update`.

| Method | Main props |
| --- | --- |
| `mountModelPicker` | `value: {provider,id} \| undefined`, `onChange`, optional `disabled` |
| `mountThinkingPicker` | `model`, `value: ThinkingLevel \| undefined`, `onChange`, optional `disabled` |
| `mountKnowledgePicker` | `value: readonly string[]`, `onChange`, optional `disabled` |
| `mountComposer` | `value`, `onChange`, `onSend`; optional `busy`, `onStop`, `canSend`, `placeholder`, `autoFocus` |
| `mountDictation` | `onTranscript`, optional `disabled`; extra handle methods `toggle`, `finish`, `cancel` |
| `mountStandardComposer` | `{composer,model,thinking,dictation}` using independent control props |
| `mountButton` | `label`, `onClick`; optional `icon`, `iconOnly`, `disabled`, `variant`, `colors`, `size`, `title` |
| `mountBadge` | `text`, optional `color` |
| `mountSettingsRows` | `{rows}` as described below |
| `mountWorkerResult` | `label`, terminal `status`, `text`; optional `content`, `presentation` |
| `mountMarkdown` | `text` (complete static Markdown) |
| `mountTree` | Accessible `label`, controlled `rows`; optional `header`, trailing `columns` |
| `openMenu` | `items: [{key,label,onSelect,disabled?}]`; optional `label`, `preferredSide`, `onClose` |
| `openDialog` | Accessible `title`, `content`, optional `onClose` |
| `openSurface` | Accessible `title`, `content`; optional `background`, `onClose`; optional explicit native-view target |

Mount methods take a container before props; `openMenu` takes an anchor. See the types
for complete signatures. Callbacks may be async; errors surface rather than count as success.

**Writing controls.** Model/thinking pickers use the host catalog without changing core
defaults or choosing fallback models. Their compact typography is self-contained. The
standalone composer is a bare input; the standard preset frames only text entry, with
controls below. It excludes usage meters, practice controls, attachments and default
file/drop behavior. The preset finishes dictation before send; independent controls
must coordinate it themselves.

Dictation has one recording owner per window. A competing start reports
`Dictation is active elsewhere`. Speech goes only to the supplied `onTranscript`, not a
hidden native composer. Focused controls own matching shortcuts; one Escape must not
also cancel another layer's recording. `finish()` awaits delivery; `cancel()` cancels.

**Buttons.** `icon` is trusted SVG markup, not a sanitizer/DOM/custom-renderer slot.
It precedes the required label. `iconOnly: true` hides text and uses `label` as the
accessible name; both icon and label must be nonblank. `size` controls geometry only;
`title` does not appear automatically. Invalid live updates reject atomically; removing
an icon also requires clearing `iconOnly`.

`variant: "custom"` allows colors without overriding geometry/activation. Optional
`colors` slots are normal `background`, `text`, `border`; `hover`, `active`, `disabled`
objects with the same slots; and `focusVisible` with those slots plus `ring`.
Overrides cascade per property: disabled > active > focus-visible > hover > normal.
Normal fallbacks are native primary colors with a reserved transparent 1px border.
Native focus ring geometry, pointer blocking and disabled 50% opacity remain.

Colors must be nonblank browser-supported CSS colors (variables/expressions allowed).
Unknown slots/shapes/syntax reject atomically; variable resolution/contrast remain the
plugin's responsibility. Colors validate on every variant but apply only to `custom`.
Set `colors: undefined` to restore fallbacks; updating `colors` replaces the whole palette.
There are no arbitrary CSS, geometry or keyboard overrides.

**Badges.** `text` is plain text, not a grade enum or Markdown. Optional `color` sets
text and a `color-mix(in oklab, color 15%, transparent)` background; omission is neutral.
Invalid types/color syntax (including CSS-wide keywords) reject atomically. No scoring,
persistence, click behavior or live announcement is implied.

**Markdown.** `mountMarkdown` uses the actual shared host pipeline for math, highlighted
code, tables, callouts, Mermaid, images and typography, with built-ins only: registered
plugin fence renderers do not run. It omits auxiliary copy/download/retry/expand/zoom/
disclosure controls. Links retain native new-tab behavior with `noopener noreferrer`;
invalid Mermaid shows its error/source directly. Do not fabricate a worker result just
to obtain Markdown styling or import a private renderer.

**Trees.** `mountTree` is controlled presentation, not a file/deck controller. Own the
hierarchy, selection, actions, storage and scroll container. Use globally unique row
occurrence keys, stable content-mount identities and a sufficient width budget; columns
plus indentation/controls can overflow and diverge if underconstrained. Collapse unmounts
descendant content, so keep drafts in plugin state. See the [tree contract](plugin-tree-contract.md)
for row/cell slots, arrow/Space behavior and an example.

**Knowledge selection.** `mountKnowledgePicker` reuses the native Pick nodes/count/Clear
bubble and Chains picker. Selection changes immediately; reflect `onChange(ids)` with
`update({value: ids})`. Done/X/Escape close without discarding controlled selection.
The host captures origin: page/surface origins open a main-pane view, while dialog/Settings
origins open a full-viewport modal with their parent painted but inert. Origin/widget
lifetime, focus restoration and stale-load protection are host-owned, not plugin props.
Only one selector is active. The existing user-driven source rename/folder/drag operations
remain available; management Delete does not. This is not a backend graph-write API.

**Dialogs and surfaces.** `content` is an HTMLElement or signal-scoped mount with sync/
async cleanup. Both require accessible titles but render no host title row; plugins own
visible headings/actions. A quiet X floats above scrolling content. Surfaces cover only
the page body, not top bars/sidebar, and stack while keeping covered content mounted.
Use targetless `openSurface(props, {signal})` to capture the current boundary once, or
pass the exact native `surfaceTarget`. Leaving the page expires it; never reconstruct or
persist targets. `background` is `dimmed` (default tint/blur) or `opaque`.

A surface can mark a synchronously mounted, visible focusable region with
`data-plugin-initial-focus`. Existing eligible focus takes precedence, then the marker,
then fields/headings/frame. No async autofocus retry or focus-on-update is promised.
Shared modal/menu/Escape/focus ownership follows the [interaction contract](dialog-overlay-contract.md);
Tab/Shift+Tab do not become browser focus navigation. See the [surface contract](plugin-session-extension-contract.md#8-public-surface-contract)
for lifetime, stacking, close and return-focus rules.

### Dedicated settings

Every enabled plugin has a Settings page, including backend-only/no-settings plugins.
Settings → Plugins manages packages; `ctx.app.openSettings()` and the view gear open
this plugin's page. Without a registration it shows `No settings available`.

`registerSettings({rows})` returns an update/dispose widget handle. Alternatively,
`registerSettings({mount(container, signal) {...}})` returns an unregister function;
the custom mount runs lazily and may use `mountSettingsRows` itself.

Rows have unique nonempty `key`, `label`, controlled `value`, `onChange`; optional
`description`, `disabled`, synchronous `validate(value): string | undefined`. Types:
`toggle` (boolean), `text` (string), `dropdown` (string with `{value,label}` options),
`number`/`slider` (finite number with optional `min`, `max`, `step`). Invalid schemas
reject; validation/range failures show inline without calling persistence. An actual
pending Promise disables its row; synchronous slider changes do not interrupt dragging.
Thrown/rejected saves show errors. Validate backend inputs too.

The host does not load/save plugin settings. Publish accepted rows through the handle
only after successful persistence; mutating a schema does not create a reactive store.

## Uploaded documents

Frontend `ctx.documents.toMarkdown(file, {signal}?)` takes a browser `File` and resolves
`{name, markdown, notices}`. Activation cancellation is automatic; an optional caller
signal adds a shorter lifetime. Failures reject with `Error`; caller cancellation
preserves `AbortSignal.reason`. There is no backend documents member, public error-code
DTO, path/URL/token input, or file-picker API. Use a native input and this helper, not
`ctx.call` (which is JSON-only) or a private multipart route.

- A `%PDF-` signature **or** `.pdf` suffix selects the native deterministic PDF engine
  and page markers. Invalid PDFs do not fall back to text. Mixed image-only pages are
  skipped with notices; all-image PDFs are refused distinctly from blank PDFs. No OCR.
- Everything else is strict UTF-8, irrespective of extension/MIME. Binary, empty input
  and controls other than Tab/LF/CR are refused (other C0, DEL and C1). HTML/DOCX are
  not converted into semantic Markdown.
- Caps: **25 MiB file**, **26 MiB actual multipart body**, **1,000 PDF pages** checked
  after opening, **2 MiB final UTF-8 Markdown** including markers. Refuse, never truncate.
- **One global conversion** across plugins; competing requests fail fast as busy, no
  queue. Admission precedes buffering and lasts through work/destruction settlement,
  including after cancellation.

Cancellation is cooperative, not a deadline/CPU/peak-memory/process-isolation guarantee.
PDF fake-worker parsing can execute synchronously. Conversion performs no persistence,
model requests or learning-data changes; the plugin may later save returned text itself.

## Backend and data

CommonJS backends export `activate(ctx)`. Activation is once per server; return cleanup
or register it with `ctx.cleanup`. Host resources honor `ctx.signal`; custom tasks must
cooperate and recheck cancellation after awaits before side effects. There is no
per-plugin process or forced termination of uncooperative code.

Register JSON-compatible operations with `ctx.handle(name, handler)` and call them
from the frontend with `await ctx.call(name, input)`. This routes only to that plugin,
not arbitrary HTTP endpoints. Validate inputs, expose genuine errors, and use atomic
writes for important plugin-owned state under `ctx.dataDirectory`.

`ctx.learning` is read-only:

| Member | Meaning |
| --- | --- |
| `directory` | Learning-data path, not a credential path |
| `listSessions()`, `getSession(id)` | Summaries and complete native records |
| `graph()` | Current graph projection |
| `readGraphFile(name)` | Host-interpreted ledgers, sources, positions, format/render metadata; sources are a record array |

Read transcripts for learner answers/thinking/mistakes: the graph is extracted from
teacher prose, not a complete learner-response record. Cross-file reads are not
transactional. Write derived feature data to plugin state, never core learning files.

## Existing agents and content renderers

`registerInstructions({agents, text})` and `registerTools({agents, create(context)})`
are additive contributions targeting `prober`, `teacher` and/or `practice`. They do not
replace host prompts, model settings or built-in tools. Each matching turn gets one
fresh native Pi loadout with frozen `{chatId, agent}`; the host saves calls/results.
Instruction text composes into the system prompt, not separate transcript messages.

Use distinctive native tool names: 1–64 provider-safe letters/digits/underscores/hyphens,
starting with a letter or underscore. Core names stay reserved even when disabled.
Sorted plugin-ID admission never overwrites collisions; a definition/factory error
omits the package's whole contribution for that turn, reports a package warning, and
leaves independent views/backend available. Later success clears the warning. Native
schema compilation is not a guarantee every provider accepts a schema.

Unregister affects future turns; disable aborts cooperative executions and fences
captured tools/results without rewriting a running prompt. Honor signals before side
effects; external effects cannot be undone.

Frontend `registerCodeBlock({language, mount})` receives source/meta/incomplete state;
`registerToolRenderer({toolName, mount})` receives native input/state/details as `output`,
optional result content and `background` on a later worker card. Mount into the supplied
HTMLElement and return cleanup; replacement/unregister/disable aborts its signal.
Async cleanup is supported. Errors/missing renderers fall back to readable source/results.

Fence hooks participate in shared extensible Markdown, but not `mountMarkdown`.
Built-in Mermaid/dedicated/hidden tool claims stay reserved; collisions report errors.
Producer identity is metadata, not a sandbox preventing cross-plugin tool presentation.
Use safe text/trusted assets, never unsanitized model HTML. A renderer does not create
pending learner input: use the dedicated question/problem APIs for that.

## Teaching questions, practice problems and learner submissions

These extension points share native host lifecycles; they are not generic form APIs.

- **Teaching:** register schemas and probe/teach posing tools with `registerQuestionType`;
  register owner-scoped `mountQuestion`, `mountAnswerEditor`, optional `mountAnswered`
  through `registerQuestionRenderer`. The host owns identity, reveal, thinking,
  validation, acceptance and teacher continuation. Optional `gradeAnswer` runs after
  validation and before save; finite-JSON results/errors are persisted and rendered by
  the plugin, not inferred as host correctness. [Question contract](plugin-question-contract.md).
- **Practice:** register `registerProblemType` and `registerProblemRenderer` for the
  native statement → plugin editor → Your thinking dock. Each submission follows
  validate → optional `processSubmission` → save → continue. Processing supplies
  observations; only the model's existing `conclude` assesses/closes the problem.
  Native/plugin poses share one active-problem gate. [Problem contract](plugin-problem-contract.md).
- **Input preparation:** `registerSubmissionInterceptor` captures the ordered hook set
  per attempt, can transform learner fields/attach native images, and fails closed while
  retaining drafts. `hasPendingInput` is synchronous/side-effect-free;
  `refreshSubmissions()` updates readiness. Clear captured plugin material only through
  acknowledged `onAccepted`, not model retries, dismissals or lost acknowledgments.
  Ready custom editor values remain mandatory. [Session-extension contract](plugin-session-extension-contract.md).

Do not infer authority from raw model tool names or private DOM, reconstruct shuffled
options from saved history, fabricate native answer envelopes, or re-run processing on
historical presentation. Exact occurrence/saved contract and availability gates matter.

## Inference and persistent work

### Raw model calls

`ctx.inference.catalog()` returns the last-known host catalog; choose an available model
explicitly (or explicitly use a configured slot). No silent refresh, unset-model fallback
or API-key fallback is supplied. `stream(request)` returns native events;
`complete(request)` returns a native assistant message, including error/abort states.
Check `stopReason`, not just text.

Requests take `model` (including thinking level), native `context`, explicit
`purpose: "user" | "background"`, optional allowlisted generation/reasoning/retry
`options`, and signal. The host owns credentials/transport and applies existing
subscription consent, quota and cancellation rules. `purpose` must reflect initiation,
not whether a view is open; do not classify automatic work as user input to evade consent.
Custom fetch/env/headers/deferred remote work are not API options. Usage appends to
plugin `data/usage.jsonl`, not core chat records.

### Managed conversational agents

`ctx.agents.register(definition)` defines instructions, model and native tools;
`create(definitionId)` creates a conversation; `send(sessionId, text, {requestId,purpose})`
adds input. Persist/reconstruct compatible definitions across activation: saved handlers
are not JavaScript, and a missing definition is an error, not permission to reinterpret history.

A `kind: "input"` tool has no `execute`; it persists external input. Render
`snapshot.pending` yourself and call `answer(sessionId, toolCallId, answer, options)`
through your backend. Retry the same action with the same request ID; new IDs mean new
actions. All required inputs need results before continuation. Invalid answers are not
saved; `formatResult` can shape model-facing content. Ordinary server tools may use
`endRun: true` to pause after success; future text is not a missing tool result.

`get`, `list`, `subscribe` expose state/current partial. `agents-changed` notifications
and frontend `onResync` trigger coalesced re-reads; do not poll hidden views.
Unsubscribe only detaches observation. Navigation/reload does not stop execution;
`abort` cooperatively cancels, `run` resumes runnable input without authoring “Continue”.
Restart recovers waiting inputs and interrupts in-flight work. No automatic replay or
exactly-once promise for external tool effects. See `examples/plugins/managed-agent`.

### Result-oriented workers and background tools

`ctx.workers` runs bounded tasks with one validated result, not human-input conversations.
Register instructions, `resultSchema`, optional side-effect-free `validateResult` and
native tools. `start(workerId, {requestId,input,prompt,model,purpose,maxTurns,...})`
persists acceptance synchronously and returns a snapshot, **not completion**.
`options` use the inference allowlist; `timeoutMs` is wall-clock lifetime including
admission waits, distinct from per-request `options.timeoutMs`. Model/purpose and
`maxTurns` are explicit; an identical request ID/request returns the original task,
while conflicting reuse errors. Retry with a new ID for a new attempt.

The host's `submit_result({result})` validates schema/refinements and supplies correction
feedback in the same native context. First durably accepted valid JSON wins, including
falsy values. No-result exit/exhaustion/failure is not success. `wait(id)` resolves a
terminal outcome; canceling its signal stops only that waiter. `get`, `list`, snapshot-first
`subscribe` expose committed state/progress; streaming partials are ephemeral.

States: queued, running, succeeded, failed, cancelled, interrupted. Views/unsubscribes do
not cancel work; call `cancel`. Disable/restart interrupts **all unfinished tasks**, even
queued/saved tasks in disabled packages. No automatic replay, DAG/scheduler or execution
with the app closed is promised. Reserve `data/tasks/` for records.

Inside `registerTools.create(context)`, `ctx.createBackgroundTool(context, spec)` returns
a native tool with worker ID, pure `prepare(input, context)` and `format(outcome, context)`
returning `{text,data?}`. Host-derived identity always classifies it as background.
The initial native result stays an acknowledgement; later model text/rendered data use
the existing job/steer delivery pipeline, respecting pending questions and turn boundaries.
Do not perform side effects in prepare/format.

Task outcome and delivery are separate. Generic outcome persists before async formatting;
live delivery waits for formatting, but restart can deliver persisted fallback without
re-running tools/formatters. Formatter failure/unavailable code does not relabel the real
task outcome. Missing task state produces an honest failure, not a fabricated result.

Later cards set `tool.background`. `backgroundPresentation: "collapsed" | "card" | "plain"`
on a tool renderer chooses its shell; `mountWorkerResult` offers the same `presentation`
for plugin-owned UI. Collapsed is default; card is bordered/expanded; plain is unframed/
expanded. Host identity/status/formatter errors remain outside the custom body. The
compact header is status icon + label, with status accessible/in a tooltip. Optional
`content` is an HTMLElement or signal-scoped mount; terminal status is succeeded,
failed, cancelled or interrupted. This does not redesign native Research/PDF cards.

**Shared admission.** Settings → Agent → Models → Concurrent worker requests
(`agent.workerRequestConcurrency`, default **8**) controls one process-global FIFO pool
for background model request streams, not whole tasks. Positive safe integers only;
invalid values reject, increases admit queued requests, decreases let active ones finish.
All detached workers share it with native background workers, even `purpose: "user"`.
Direct teacher/prober/practice and compaction, interactive managed agents and raw plugin
inference are excluded. Permits end before native tools/child waits; queued cancellation
prevents dispatch. `purpose` controls consent, not pool classification.

Standalone tasks appear in Background agents as **plugin name · worker definition ID**,
without an invented session link; linked background-tool tasks do not duplicate rows.
END cancels computing/queued work, not a completed result or pending delivery.

## Events, recovery and verification

Backend `ctx.events.on` / frontend `ctx.onAppEvent` observe supported app events.
`turn-settled` follows turn persistence, not completion of asynchronous extraction.
Backend `ctx.events.emit(topic, jsonData)` notifies this plugin's frontend
`onNotification`. This is live delivery, not a durable arbitrary event log. On reconnect,
use `onResync` and fetch state. Release subscriptions on cleanup; avoid recursive emits.

Before distributing, check types, built package layout, disabled discovery, enable/disable,
restart, cleanup/late awaits, missing-renderer fallback and data-preserving updates. Test
native lifecycle paths your feature uses, not only its isolated UI. Prefer disposable
profiles and loopback providers; do not overwrite an installed app just to test a plugin.
See [host architecture and verification seams](plugin-architecture.md#verification).

## Deliberate limits

No marketplace/community updater, sandbox/per-plugin process, hot replacement,
programmable core-data writes, general UI/forms or raw keyboard-event framework, or automatic replay
of interrupted arbitrary tools. The platform supplies mechanisms, not feature prompts,
algorithms, defaults or deletion policy; product decisions belong to the human.
