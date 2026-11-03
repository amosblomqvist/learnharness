# Build a LearnHarness plugin

Plugins are **trusted local code**. Only install code you trust: backend modules have
Node filesystem/network capabilities inside the LearnHarness server. Frontends run in
the application page, not in an untrusted iframe. This API does not disable Electron
renderer isolation or grant access to OAuth/BYOK credentials through the API.

## Start without a build system

1. Open **Settings → Plugins**. It shows the writable plugins directory.
2. Copy `examples/plugins/hello-plugin` into that directory (keep the folder name).
3. Refresh the plugin list, then enable **Hello plugin**.
4. Open its view using its explicitly placed sidebar action. Open its dedicated
   Settings page from Settings navigation or the plugin view's gear.
5. Edit the installed code, restart LearnHarness, and enable it if necessary. Refresh
   discovers packages; it is not a JavaScript hot-reloader.

Packaged desktop builds also include a `plugin-authoring/` directory beside the
standalone server, under the app's resources. It contains these docs, examples, a
coding-agent skill, and the generated type-only API tree. This is read-only authoring
material, separate from the writable installed plugins directory.

No npm command is run by LearnHarness. Packages contain built JavaScript. Install the
**built package contents** with `manifest.json` at the package root and its referenced
bundles present—not the source project root. Preserve existing plugin `data/` when replacing
package code. A production
plugin can use TypeScript, React, and a bundler during authoring; ship the browser
bundle as an ES module and the Node bundle as CommonJS. Bundle JavaScript libraries;
leave Node built-ins external in the backend. Native dependency installation/rebuilds
are not provided. The examples use plain JS and Node built-ins, needing no build. Besides the independent
hello/managed-agent views, `examples/plugins/teaching-extension` demonstrates contributions
to existing lessons: a normal native tool, a background-worker tool, and shared renderers.
The background example may incur model cost, but runs only when explicitly requested.

The exact API contracts are `src/core/plugins.ts`, `src/core/plugin-ui.ts`,
`src/core/plugin-agents.ts`, `src/core/plugin-workers.ts`, `src/core/plugin-questions.ts`,
and `src/core/plugin-submissions.ts`.
The [native session-extension contract](plugin-session-extension-contract.md) is normative
for the session-extension increment, implemented and verified on
`feature/plugin-architecture`, not released.
For TypeScript in a checkout, use **type-only** imports from those files. Do not import
application implementation modules at runtime. `scripts/build-plugin-types.mjs` emits
a portable declaration tree for authors who do not use a source checkout. Pi native
message/tool types are intentionally part of API v1 and match the app's pinned SDK;
this is not an unversioned compatibility promise for arbitrary Pi releases.

## Installed folder

```text
my-plugin/
  manifest.json
  main.js           # optional browser ES module
  backend.cjs       # optional Node CommonJS module
  styles.css        # optional; requires a frontend entry
  assets/           # public distributable assets/modules
  data/             # persistent plugin-owned records, never served as static assets
```

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "minAppVersion": "0.3.7",
  "description": "What this plugin does",
  "main": "main.js",
  "backend": "backend.cjs",
  "styles": "styles.css"
}
```

The folder name must match the lowercase-hyphen ID. All three entry filenames are
optional except that at least one of `main` or `backend` is needed. They name root
files, not paths into `data/`. Version fields initially use numeric `x.y.z`. An
incompatible or malformed package is reported without executing its code.

Use `data/` for user-created state. Disabling never deletes it. Official code updates
preserve it. If you manually replace an external package, preserve its data yourself.
A plugin owns its data schema and migrations; refuse to rewrite a newer format you
do not understand. Reserve `data/agents/` for the optional host-managed agent helper
and `data/tasks/` for result-oriented workers, plus `data/usage.jsonl` for host inference
accounting.

## Frontend lifecycle and views

```js
export function activate(ctx) {
  ctx.registerView({
    id: "library",
    name: "My library",
    mount(container, signal) {
      const button = ctx.ui.mountButton(container, {
        label: "Plugin settings",
        onClick: () => ctx.app.openSettings()
      }, { signal });
      return () => button.dispose();
    }
  });
  ctx.registerAction({
    id: "open-library",
    name: "Open my library",
    run: () => ctx.app.openView("library")
  });
  ctx.placeAction({
    id: "library-sidebar",
    actionId: "open-library",
    location: "sidebar"
  });
}
```

`activate` runs once per enabled plugin per window, not once per view mount. The host
calls your returned cleanup and registered `ctx.cleanup(fn)` functions on disable.
Register views/actions/settings during activation, and keep their disposables scoped
to it. View/action IDs use 1–128 ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit; display names can be normal human-readable text.
`PluginView.mount(container, signal)` may return cleanup or a Promise of cleanup.
The per-mount signal aborts on departure/replacement or plugin disable. Scope widgets
to that signal, not just the longer activation `ctx.signal`. A view that uses React
must unmount its own root in its cleanup. Register browser events/timers for cleanup;
never leave them running after disable. Avoid work at module top level because native
module caching lasts until restart.

The host owns the view shell: top bar, view title, explicitly placed actions, and
plugin-settings gear. Mount only the feature body; do not duplicate the shell.
Registering a view or action does **not** create navigation buttons or other automatic
chrome. There is no dedicated plugin sidebar section: explicitly placed sidebar
actions share the normal action area with the core teaching/practice entries.

Views are custom screens in designated host surfaces, not extensions to the existing
teaching question dock. Use app theme variables such as `var(--foreground)`,
`var(--background)`, and `var(--border)`, with plugin-scoped CSS selectors. Shared-page
CSS is not sandboxed. Use `textContent` for text rather than unsafe HTML insertion.

### Explicit actions and placements

Call `ctx.registerAction(action)` **before** `ctx.placeAction(placement)`. Each has its
own ID and unregister function; one action can have several placements. Registration
alone never displays it. An action has `id`, `name`, optional trusted SVG `icon`, optional
`disabled` (boolean or context predicate), and `run(context): void | Promise<void>`.
The host renders the surrounding button, label/tooltip, disabled and async busy states.
It blocks repeat invocation of that action while its Promise is pending and reports
errors. Call `ctx.refreshActions()` when plugin state changes a dynamic disabled
predicate; this requests re-evaluation, not re-registration.

Placements use `{ id, actionId, location }`:

- `location: "sidebar"`: the shared sidebar action area.
- `location: "graph"`: the graph action strip.
- `location: "top-bar"`: also specify `sessions: ["teaching", "practice"]` (either
  subset) and/or `views: ["library"]`. At least one target is required; view IDs refer
  only to the placing plugin's views. There is no implicit “all surfaces” target.
  The host handles narrow-width overflow.

For example, after registering an action, place it on selected top bars with
`ctx.placeAction({ id: "library-top", actionId: "open-library", location: "top-bar",
sessions: ["teaching"], views: ["library"] })`.

`PluginActionContext` is a discriminated union, not a private app state handle:

| Placement/surface | Additional fields |
| --- | --- |
| `"top-bar"` / `"session"` | `sessionId`, `kind: "teaching" \| "practice"`, opaque `surfaceTarget` |
| `"top-bar"` / `"plugin-view"` | `pluginId`, `viewId` |
| `"sidebar"` / `"sidebar"` | none |
| `"graph"` / `"graph"` | none |

`ctx.app` exposes `pathname()`, `openSession(id)`, `openHome()`, `openView(id)` (this
plugin's view), and `openSettings()` (this plugin's dedicated page), not private React
context or graph selection internals.

### Controlled host UI

Use `ctx.ui` for host-styled controls without runtime imports of host components.
Every method takes a final `options: { signal: AbortSignal }` argument and returns a
handle with `update(partialProps)` and idempotent `dispose()`. Updates shallow-merge
props; for a preset, supply a complete replacement for any nested props you change.
Aborting the mount signal or disabling the plugin disposes its widgets and overlays.
Callbacks may return Promises; errors are surfaced rather than treated as success.

| Method | Controlled inputs and callbacks |
| --- | --- |
| `mountModelPicker(container, props, options)` | `value: { provider, id } \| undefined`, `onChange(value)`, optional `disabled` |
| `mountThinkingPicker(container, props, options)` | `model: { provider, id } \| undefined`, `value: ThinkingLevel \| undefined`, `onChange(value)`, optional `disabled` |
| `mountKnowledgePicker(container, props, options)` | `value: readonly string[]`, `onChange(ids)`, optional `disabled`; host node-selection bubble and Chains picker, as below |
| `mountComposer(container, props, options)` | `value`, `onChange`, `onSend`; optional `busy`, `onStop`, `canSend`, `placeholder`, `autoFocus` |
| `mountDictation(container, props, options)` | `onTranscript(text)`, optional `disabled`; handle also has `toggle()`, `finish(): Promise<void>`, `cancel()` |
| `mountStandardComposer(container, props, options)` | `{ composer, model, thinking, dictation }`, using the independent controls' props |
| `mountButton(container, props, options)` | `label`, `onClick`; optional `disabled`, `variant`, `size`, `title` |
| `mountSettingsRows(container, schema, options)` | `{ rows }`, as below |
| `mountWorkerResult(container, props, options)` | `label`, terminal `status`, `text`, optional `content`, `presentation` |
| `mountMarkdown(container, props, options)` | `text: string`; static complete Markdown through the actual host pipeline, built-ins only |
| `openMenu(anchor, props, options)` | `items: [{ key, label, onSelect, disabled? }]`; optional `label`, `preferredSide`, `onClose` |
| `openDialog(props, options)` | `title`, `content`, optional `onClose` |

These controls are controlled, not persistence or inference services. The plugin owns
values, backend persistence, and any model fallback policy. Model/thinking selectors
use the host catalog and emit choices; they do **not** write core model defaults or
other core settings. Feed accepted values back with `handle.update(...)`. For example,
inside a view mount:

```js
let selected;
const picker = ctx.ui.mountModelPicker(container, {
  value: selected,
  async onChange(value) {
    await ctx.call("save-model", value); // plugin-defined, validated backend operation
    if (signal.aborted) return;
    selected = value;
    picker.update({ value: selected });
  }
}, { signal });
```

Composer, dictation, model, and thinking controls are independently mountable. The
standard composer is a convenience preset, not a complete teaching/practice dock:
it excludes usage meters, practice controls, attachments, and default file/drop
insertion behavior. It finishes dictation and awaits transcript delivery before send;
plugins using independent controls must coordinate that themselves.

Dictation has one exclusive recording owner per window, including core and plugin
controls. A competing start reports **“Dictation is active elsewhere”**, rather than
stealing the recording. Focused plugin controls own their matching shortcuts; merely
mounting one does not take over core shortcuts. An Escape owned by dictation cancels the
actual recording owner; an Escape consumed by a higher layer must not also cancel it.
Plugin dictation always delivers to its explicit `onTranscript` callback, never
silently into a core composer/question. The plugin decides where that text goes.

### Static Markdown

The additive API v1 method is
`ctx.ui.mountMarkdown(container, props, { signal }): PluginWidgetHandle<PluginMarkdownProps>`,
with `PluginMarkdownProps { text: string }`. It uses the standard `update`/`dispose` handle
and per-mount signal; no React imports, storage or inference service is involved. The
implementation passed [final Markdown verification](plugin-architecture.md#static-markdown-final-verification--2026-11-02),
separate from the historical interaction checkpoint. No API version bump or new dependency
is required.

For example, inside a view mount:

```js
const markdown = ctx.ui.mountMarkdown(container, {
  text: "# Notes\n\nA **complete** explanation with $x^2$."
}, { signal });
// On a content change: markdown.update({ text: nextText });
return () => markdown.dispose();
```

The plugin owns content, data and surrounding layout. The host renders complete, static
content through its **actual shared Markdown pipeline**: math, syntax-highlighted code,
tables, callouts, Mermaid, images and host typography—not a copied renderer. Only built-in
renderers run; registered plugin code-block renderers do **not** participate in this mount.
All auxiliary copy, download, retry, expand, zoom and disclosure controls are omitted.
Ordinary links keep the host's native new-tab behavior (`target="_blank"`,
`rel="noopener noreferrer"`), with no additional confirmation modal. Invalid Mermaid
shows the existing error heading/message and source directly, without retry or details UI.

Use this generic content renderer for static bodies such as card fronts/backs; do not
fabricate a worker result merely to obtain Markdown styling. If a required capability is
missing, request an explicit host API decision rather than importing private host/React
components, copying the Markdown pipeline or inventing unsupported props.

### Knowledge picker

The approved knowledge-picker increment adds
`ctx.ui.mountKnowledgePicker(container, { value, onChange, disabled? }, { signal })`
to API v1, with types in `src/core/plugin-ui.ts` included in the generated type bundle.
`value` is a `readonly string[]` of selected node IDs; `onChange(ids)` receives the new
ID array. It returns the standard handle with `update(partialProps)` and `dispose()`.
The app-wide dialog/interaction foundation and modal picker passed
[historical interaction verification](plugin-architecture.md#historical-shared-interaction-final-verification--2026-11-02).
The [dialog and overlay contract](dialog-overlay-contract.md) is authoritative and replaces
the provisional picker-only foreground/hiding policies.

The plugin chooses where to place the bubble, controls selection IDs, and owns any
persistence. The host does not write plugin state. The bubble reuses the **exact existing
`NodePickerControl`**: **Pick nodes**, selected count and **Clear**. Clear emits the
controlled empty array `[]`. Clicking opens the real **`ChainTableOverlay`** as a
**full-window modal**, retaining the existing translucent/blurred Chains appearance.
The background, **including the sidebar, is inactive**. This modal presentation is only
for the new plugin picker: existing Graph/Practice Chains views remain nonmodal,
content-column bounded and sidebar-interactive. It is not an inline embed or a copied
table. Checkbox selection changes are immediate through `onChange`; reflect the new
array with `handle.update({ value: ids })`, not a later Done commit. **Done**, **X** and
an unconsumed **Escape** owned by the selector close only it, retain controlled selection
and return focus to an eligible invoking element. Reopening retains the controlled value.

The picker supports ordinary plugin views, plugin Settings and public `ctx.ui.openDialog`
content without new props or plugin-side lifetime requirements. A launching Settings or
public dialog stays **mounted, painted and visible underneath**, preserving state and
scroll position; it is inert while covered, not hidden with `display: none`. New public
dialogs and menus can foreground normally. A fresh Settings open nests **above** the
picker without discarding it. Returning to an already-open Settings singleton requests
closure of intervening layers top-down through normal callbacks, stopping on blocked,
handled-without-closing or pending outcomes. There is no queued navigation or forced
cancellation; Settings retargets/deep-links only after return-to succeeds.

Only **one selector** is active. Its exclusive opening slot uses the shared controller's
normal close guards; closing a previous selector does not clear its controlled IDs or
automatically reopen it later. Newer UI openings or retargets invalidate older pending
graph loads so they cannot promote a stale picker. These are host-private shared
interaction mechanisms, not a new public overlay framework or SDK API.

The host supplies the graph and source organization, loading lazily on first open using
the existing new-practice pattern, and owns focus, portals and abort/disposal cleanup.
Graph names, chain presentation and source organization use the canonical existing UX.
Selection mode is **not read-only**: user-driven source **rename**, folder **creation**
and **drag organization** remain available. Management **Delete** remains unavailable in
practice-picker mode, matching existing behavior. These are existing host UI operations,
not new programmable core-write APIs: the backend learning-data API remains read-only.
There is no generic deck/library-tree host API; deck trees, state, membership and
selection limits remain plugin-owned.

### Shared dialog and keyboard behavior

Core and plugin UI use the same private modal/menu/popup/view-scope foundation;
see the [authoritative interaction contract](dialog-overlay-contract.md). Nested parents
remain painted and stateful; only the active modal and its owned children are interactive.
One physical Escape has one original owner, with leaf handlers first. A handled or blocked
Escape cannot also close a parent, cancel dictation or abort a turn. Tooltips are passive
help, not Escape owners; their owned portals preserve visibility above the modal frame
without intercepting the field/menu/dialog's Escape. Native Tab/Shift+Tab
navigation stays disabled, including modal boundary looping; existing explicit field-cycle,
question/thinking and shortcut-rebinding actions remain scoped to eligible content.

Existing explicit initial-focus targets remain. Otherwise a modal focuses its first
eligible editable text field, or its heading—not an action button. Closing a child restores
only eligible invoking focus, falling back to the active surface's initial-focus policy.
Settings text/number-field Escape uses normal blur/save, retains invalid/failed drafts and
does not close Settings; acknowledged canonical values replace accepted drafts. Save
authority survives close/reopen: older responses and Settings/startup GETs cannot overwrite
a newer acknowledged full snapshot or its appearance. A pending save finishing after reopen
updates the current Settings instance; fresh loads still read the server normally. Explicit
credential Save and rename-cancel workflows retain their own rules. Busy deletion close
guards consume dismissal without closing. These are app-wide rules, not per-picker hacks.

### Dedicated plugin settings

**Every enabled plugin** has its own Settings navigation page, even a backend-only
plugin or one with no settings registration (shown as “No settings available”).
Settings → Plugins remains package management; custom controls are not embedded there.
The host view gear and `ctx.app.openSettings()` open the owning plugin's page.

`ctx.registerSettings(settings)` accepts one registration: either `{ rows }` or a custom
`mount(container, signal)` with the view cleanup contract. The schema overload returns
`PluginWidgetHandle<PluginSettingsSchema>`: `update({ rows })` validates and publishes
new controlled rows; `dispose()` unregisters them. Disposed or stale-generation handles
are inert. The custom-mount overload still returns an unregister function. Custom mounts
are the escape hatch for richer layouts and can themselves use `ctx.ui.mountSettingsRows`.
They mount lazily when the page is opened.

Schema row types are `toggle` (boolean), `text` (string), `dropdown` (string plus
`options: [{ value, label }]`), and `number`/`slider` (finite number, optional `min`,
`max`, `step`). Every row has a unique nonempty `key`, `label`, controlled `value`, and
`onChange(value)`; optional fields are `description`, `disabled`, and synchronous
`validate(value): string | undefined`. Invalid schemas are rejected at registration.
Validation messages/range failures prevent the callback and appear inline. While an
async callback is pending the row is disabled; a thrown/rejected persistence callback
is displayed as an error, not a successful save. Validate backend inputs too.

The host does not load or save plugin settings. Callbacks own persistence and accepted
values; do not mutate core settings files. A schema registration can publish live saved
values directly through its handle, without a custom mount. For example, during async
activation, with plugin-defined validated `get-settings` and `save-settings` operations:

```js
const saved = await ctx.call("get-settings");
function rows(enabled) {
  return [{
    key: "enabled", type: "toggle", label: "Enable feature", value: enabled,
    async onChange(value) {
      await ctx.call("save-settings", { enabled: value });
      registration.update({ rows: rows(value) }); // only after successful persistence
    }
  }];
}
const registration = ctx.registerSettings({ rows: rows(saved.enabled) });
```

A custom settings mount can likewise retain a `mountSettingsRows` handle and update
accepted rows. Do not assume mutating a schema object creates a reactive store or
that a failed write changed the saved value.

## Backend and operation bridge

```js
const fs = require("node:fs");
const path = require("node:path");
exports.activate = (ctx) => {
  ctx.handle("get-state", () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ctx.dataDirectory, "state.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
};
```

A frontend calls `await ctx.call("get-state")`. Inputs/results must be JSON-compatible.
The host routes to this plugin's registered handler; this is not an arbitrary HTTP
router. Validate inputs in the handler and use atomic writes for important state.
Backend exceptions are visible errors, not successful empty results.

Backend activation is once per server. Returning a cleanup function or using
`ctx.cleanup` releases custom resources. All host-managed resources honor
`ctx.signal`; custom asynchronous tasks must cooperate with it. Check cancellation
again after awaited work before writing or publishing. No per-plugin process exists,
so the host cannot forcibly terminate arbitrary synchronous or uncooperative code.

## Extend existing teaching and practice

Backend contributions are additive. They do not replace the app's instructions, prompt
overrides, model selection, or built-in tools. Target `prober`, `teacher`, or `practice`
explicitly:

```js
ctx.registerInstructions({
  agents: ["teacher", "practice"],
  text: "When appropriate, use a plugin-note fenced block for a short note."
});
ctx.registerTools({
  agents: ["teacher"],
  create: ({ chatId, agent }) => [{
    name: "my_plugin_echo",
    label: "My plugin echo",
    description: "Echo a short requested text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (_toolCallId, input, signal) => {
      if (signal.aborted) throw new Error("Cancelled");
      return { content: [{ type: "text", text: input.text }], details: { text: input.text } };
    }
  }]
});
```

These are native Pi tools: parameter validation, execution and model-visible content
use the existing runner. A fresh factory receives frozen conversation identity for each
matching turn. Native calls/results are saved by the host's normal conversation pipeline;
do not duplicate them into core chat files. Instruction contributions compose with the
system prompt, like built-in prompt segments; they are not separate transcript messages.

Use globally distinctive tool names (a plugin prefix is useful): 1–64 provider-safe
letters/digits/underscores/hyphens, starting with a letter or underscore. Core names stay
reserved even when their user toggle is off. Collisions never overwrite another tool;
packages resolve in sorted ID order and the first valid loadout owns its names. A factory
or definition error omits that package's entire contribution for the affected turn and
reports a visible package warning without disabling its independent view/backend. A later
successful evaluation clears that warning. Basic schema hygiene and native compilation do
not guarantee that every provider supports every otherwise valid schema.

Unregistering affects future turns. Disable aborts cooperative plugin tool executions and
fences captured tools against further execution/results; it does not rewrite an already
running conversation's system prompt. Honor the execution signal before side effects,
especially after awaits. Arbitrary external side effects cannot be undone by cancellation.

### Shared content renderers

Frontend renderers mount into a host-owned HTMLElement. They use no private React API:

```js
ctx.registerCodeBlock({
  language: "plugin-note",
  mount(container, block) {
    container.textContent = block.source;
    // block.meta and block.incomplete preserve fence metadata/streaming state.
    return () => container.replaceChildren();
  }
});
ctx.registerToolRenderer({
  toolName: "my_plugin_echo",
  mount(container, tool) {
    container.textContent = tool.output?.text ?? tool.errorText ?? tool.state;
    return () => container.replaceChildren();
  }
});
```

Fence dispatch applies across shared extensible Markdown surfaces, not just a plugin's
own view. The static `ctx.ui.mountMarkdown` helper deliberately uses built-ins only and
does not dispatch registered plugin code-block renderers.
Tool props carry input, state, details as `output`, and optional native `result` content.
A separate background-result card additionally sets `background`; it never pretends to
be a native result replacing the original acknowledgement. Presentation plugins may render
another plugin's tool: producer identity is metadata, not a sandbox boundary.

Built-in Mermaid and existing dedicated/hidden tool presentations remain authoritative;
registering those claims is refused. Ordinary tool names with only a generic fallback can
receive custom presentation. Renderer collisions are reported, not silently overwritten.
Unmount, replacement, unregister and disable abort each mount's `signal`. Async cleanup is
supported and must settle cooperatively. Errors, absent plugins and disabled renderers
fall back to readable source/results rather than hiding saved lesson content. Use
`textContent`, not unsanitized model-generated HTML; bundle chemistry/music libraries in
normal distributable assets if needed. These hooks do not introduce a new pending
learner-answer type into the question dock.

## Native plugin questions — bounded v1

The [approved question contract](plugin-question-contract.md) is authoritative; exact
public names live in `src/core/plugin-questions.ts` and `src/core/plugins.ts`.
The implementation passed the [3,778-test question verification checkpoint](plugin-architecture.md#plugin-question-verification-checkpoint--2026-11-02)
and is implemented and verified on `feature/plugin-architecture`, not released.
Migration checkpoint `792671e` and the historical 3,681-test Markdown checkpoint remain
separate evidence. Both product implementations remain paused.

This adds question formats to teaching conversations, not a generic pending-input/forms
SDK. Builtin question behavior and grading stay unchanged. V1 is **teacher-review only**:
the host saves a valid answer and returns it to the ordinary teacher, without inferring
correctness. There is no assessment hook/schema/result, node-assessment hook, async grading
stage or execution service. A plugin that needs separate grading/execution can contribute
ordinary existing tools; that is not part of question submission. General field-scope,
extra form/button/dialog-layout catalogues, source metadata and installer extensions remain
outside this scope. No builtin migration, global chat-format bump or chat migration is added.

### Backend registration and native arguments

`ctx.registerQuestionType(definition): () => void` takes a
`PluginQuestionTypeDefinition<Q, A>` with:

- `id`: stable local `[A-Za-z0-9_-]` ID, 1–128 characters; `label`: non-whitespace text.
- `contractVersion`: positive safe integer independent of package version; optional
  `incompatibleContractVersions` explicitly names other incompatible saved contracts.
- Required `showThinking: boolean`, `questionSchema` for payload and `answerSchema`.
- Optional `probe` and `teach`, each `{ toolName, description }`; at least one is required.
  Names follow native collision rules; descriptions must be non-whitespace. Probe enrolls
  only the prober, teach only the teacher; no practice enrollment is added.
- Optional synchronous, side-effect-free `validateQuestion` and `validateAnswer` refinements.
  Return `undefined` or `[]` to accept, otherwise readable problem strings. Async/thenable
  validation is rejected. Wrong-but-schema-valid answers are not validation failures.

The host constructs native question tools—there is no question `execute` callback:

```ts
// Probe: payload is governed by questionSchema.
{ question: string, payload: Q }
// Teach: existing predict/check rules; nodeId must be an applicable live plan node.
{ type: "predict" | "check", nodeId: string, question: string, payload: Q }
```

Common `question` is required learner-visible Markdown, preserved verbatim but rejecting
whitespace-only text; it is the durable teaser/fallback, not a guessed payload property.
`validateQuestion({ chatId, variant, contractVersion, input })` sees normalized immutable
input. `validateAnswer({ chatId, questionId, variant, contractVersion, input, answer })`
sees historical input and the submitted answer. Authoring failures use native correction
feedback without posing a question; answer rejection keeps the question/draft pending.
The package's ordinary tools, questions and instructions are admitted together through
one accepted per-turn snapshot; a rejected package contributes none of that turn's loadout.

A minimal text-format definition, inside backend activation:

```js
return ctx.registerQuestionType({
  id: "sample-text", label: "Text response", contractVersion: 1,
  showThinking: false,
  questionSchema: { type: "object", properties: {}, additionalProperties: false },
  answerSchema: { type: "string" },
  teach: { toolName: "sample_text_question", description: "Ask for a text response." }
});
```

Schemas must be self-contained persistable JSON supported by the installed TypeBox
compiler. Local JSON Pointer references retain their meaning under the native payload
wrapper. External references, `$id`/anchors/dynamic references, runtime-dependent functions
or RegExp objects, non-JSON extensions and unsupported formats are rejected. Do not
coerce, trim, clean or truthiness-filter answers. Finite JSON preserves raw strings and
values such as `0`, `false`, `null`, `""` and arrays exactly when the schema allows them.

### Owner-scoped question/editor slots

Frontend `ctx.registerQuestionRenderer(renderer): () => void` accepts
`PluginQuestionRenderer<Q, A>` keyed by the **owning plugin** and backend `id`:
`{ id, supportedContractVersions, mountQuestion?, mountAnswerEditor, mountAnswered? }`.
These are host question-card slots, not generic tool renderers or cross-plugin claims.
Presentation mounts return optional cleanup (possibly asynchronously); the editor returns
its handle, synchronously or asynchronously. `mountQuestion` defaults to host Markdown for the saved common question; `mountAnswered`
defaults to readable accepted learner-answer presentation. Host ThinkingBlocks stay
outside custom answered content. Cancellation always has host fallback presentation.

Every slot receives immutable `input`, `chatId`, stable `questionId`, historical
`contractVersion`, `variant` and `signal`. `mountAnswered` additionally receives accepted
plugin `answer`; `mountAnswerEditor` receives `PluginQuestionEditorProps` with `active`,
controlled `answer` and synchronous `onChange(state)`. Its atomic
`PluginQuestionAnswerState` is exactly:

```ts
{ status: "empty" } // no retained value
// or
{ status: "unready" | "ready", value: JsonValue }
```

A current editor handle must publish ready before submission is possible. `empty` discards
its value; use `unready` to retain incomplete/whitespace drafts. Ready may contain falsy or
empty values; drafts need not yet pass the saved answer schema, accepted answers must.
The `PluginQuestionEditorHandle` has `update({ answer, active })`, `focus()`, `dispose()`,
optional `handleKeyDown(key): "handled" | "pass"` and optional
`appendTranscript(text): void | Promise<void>`. Update never echoes `onChange`; identical
updates preserve selection/composition. `PluginQuestionEditorKey` is exactly
`"Tab" | "Enter" | "Shift+Enter" | "Escape"`, not a general shortcut API.

A matching simple editor, inside frontend activation (empty strings are valid here):

```js
return ctx.registerQuestionRenderer({
  id: "sample-text", supportedContractVersions: [1],
  mountAnswerEditor(container, props) {
    const field = document.createElement("textarea");
    field.setAttribute("aria-label", "Text response");
    let current = props;
    const render = () => {
      const value = current.answer.status === "empty" ? "" : current.answer.value;
      if (field.value !== value) field.value = value;
      field.disabled = !current.active;
    };
    const publish = () => {
      if (current.active) current.onChange({ status: "ready", value: field.value });
    };
    field.addEventListener("input", publish);
    container.append(field);
    render();
    return {
      update(next) { current = { ...current, ...next }; render(); },
      focus() { if (current.active) field.focus(); },
      dispose() { field.removeEventListener("input", publish); field.remove(); }
    };
  }
});
```

Mounts may be async: honor abort, dispose late handles, and bind callbacks/keys/focus/speech
to the exact question and mount generation. Stale instances cannot publish or submit.
Folding retains mounts and updates `active`; repeated canonical adoption does not remount
the same question. Draft answers/thinking live in the existing **in-memory session model**,
keyed by occurrence, surviving editor/dock remounts while that model lives. Navigation that
destroys the model, reload and restart do **not** promise draft persistence. Saved posed
questions and accepted answers are durable; no persistent editor-draft format is added.

### Host controls, keyboard and dictation

The host retains the card/dock, fold/reveal, submit/dismiss, StatsBar/session metadata,
microphone, model and model-thinking controls. These common controls remain present.
Required `showThinking` controls the host Thinking field, not a nonempty-answer requirement;
it is not model-authored. The existing check ReadingThinking/reveal flow is independent.

Host commands retain precedence: Shift+Tab cycles model thinking and Cmd/Ctrl+Enter
submits subject to readiness/IME gates. Only the active eligible editor may receive the
narrow editing-key callback. Handled keys are claimed once; passed plain Tab enters the
private host field chain, never native Tab navigation. Unclaimed editor Enter belongs to
editing, not an accidental native form submission. Host Thinking Enter remains newline.
Composition/229 must not trigger commands; the host owns suppression and eligibility,
not fabricated keyboard dispatch or plugin DOM inspection.

Dictation goes to host ReadingThinking for an unrevealed check, regardless of showThinking;
after reveal/open probe or predict it goes to host Thinking when enabled. With Thinking
off, only an explicit editor `appendTranscript` opts into answer dictation; otherwise the
microphone stays **visible but disabled**, never routed into a hidden composer. An answer
transcript callback must publish before its promise resolves. The host finishes capture
and final deliveries before reveal/submit and settles/cancels capture before retiring an
obsolete destination. Folding neither erases drafts nor redirects speech to the composer.

### Saved authority, results and compatibility

Live tool attempts are non-actionable placeholders. Only a successfully validated host pose,
canonical persistence and client adoption authorize an editor; terminal reconciliation
must finish before actions become ready. A sync failure offers reconciliation-only retry,
not a new teacher turn. Private saved metadata binds a host-minted stable question ID to
an exact native occurrence, not tool-name coincidence or a reused call ID. Attempts,
failures and missing renderers never expose raw authored payload/reference material in
an expandable generic trace; fallback uses saved common question Markdown and safe status.
This is a presentation boundary, not a sandbox or a guarantee about authored prose.

The host validates finite JSON and **saved historical schemas** on submission. A saved
required answer refinement needs an available same-contract implementation; newly adding a
refinement cannot alter old acceptance. Plugins publish only their answer value. The host
constructs `PluginQuestionAnswer` (`kind: "plugin-question"`, canonical question/plugin/type
identity, contract version, `answer`, applicable `thinking`/`readingThinking`, `answeredAt`),
saves the genuine native result before continuation, and enforces single-submit and
sibling-question discipline. Normal text/continue/retry and legacy answer routes cannot
bypass a pending plugin question. Dismissal is a host cancellation, not a fabricated answer
or an automatic teacher run.

Backend `contractVersion` supports **exactly that version**. Compatible package changes
retain it; package version/hash changes or an unknown contract number alone do not cancel
a question. `incompatibleContractVersions` explicitly authorizes quiet cancellation of an
old incompatible contract through the host, without rewriting history or auto-running the
teacher. A genuinely unreadable host protocol may also be quietly cancelled only with
sufficient exact occurrence binding—never a guessed target. Missing/disabled backend,
unknown version, missing required refinement, unsupported/missing/failing renderer keep
the question unavailable/pending with saved fallback and host **Dismiss question**.
Frontend failure cannot declare incompatibility. No version ranges, automatic upgrades
or plugin migrations over chat records are added.

## Native session extensions — implemented and verified

The [human-approved session-extension contract](plugin-session-extension-contract.md)
is authoritative for submission interception, explicit learner images and session-body
surfaces. **Implemented and verified on `feature/plugin-architecture`; not released.**
The human separately authorized committing all changes and preparing the branch for a
human-performed push; this does not authorize an agent push or release. The increment passed
the [3,869-test session-extension checkpoint](plugin-architecture.md#native-session-extension-verification-checkpoint--2026-11-02),
including strict external SDK, isolated packaging/privacy and exercised packaged-browser
checks. The historical Markdown and 3,778-test question checkpoints remain separate. Public
names are defined in `src/core/plugin-submissions.ts`, `src/core/plugin-ui.ts` and the
frontend context in `src/core/plugins.ts`; use matching type-only SDK declarations,
not private runtime imports. The packaged authoring bundle includes this contract.

### Frontend submission interception

Register during frontend activation:

```ts
ctx.registerSubmissionInterceptor({
  id: "prepare-input",
  priority: 0,
  hasPendingInput(target) { /* synchronous, side-effect-free readiness */ return false; },
  async intercept(input, context) {
    // May await this plugin's existing backend operations. Honor context.signal.
    // Return a same-type replacement, undefined to pass through, or null to cancel.
    return input;
  }
});
// After plugin-owned external input changes:
ctx.refreshSubmissions();
```

`registerSubmissionInterceptor(definition)` returns an unregister function. IDs follow
lowercase-hyphen conventions and are unique within a plugin activation. `priority` is
a finite integer, default **0**; higher runs first, then ties sort by plugin ID and
interceptor ID. The host captures the ordered set once per attempt and runs it serially;
later hooks see earlier output. Unregister/unload invalidates captured participation
and cancels preparation; new registrations join the next attempt. There is no backend
hook registration or user-facing ordering setting.

`PluginSubmission` is raw, readonly learner input, not a derived native answer envelope:

| `type` | Replaceable learner fields (input remains readonly) |
| --- | --- |
| `"text"` | `content: PluginSubmissionContent`; host chooses send versus steer |
| `"thinking"` | `content` for the captured active practice problem |
| `"answer"` | `answer: PluginBuiltinSubmissionAnswer`, separate `thinking` and `readingThinking` content |
| `"plugin-question-answer"` | finite JSON `answer`, `answerImages`, separate `thinking` and `readingThinking` content |

`PluginSubmissionContent` is `{ text: string, images: readonly ImageContent[] }`:
text followed by images, not arbitrary interleaving. Builtin answer fields are optional
`dontKnow`, `values` (stable option values, not displayed indices), `other`, `text`,
`confidence`, plus required `images`. Correctness, committed answers, snapshots,
timestamps, routing identity and tool results remain host-owned. Hooks may transform
actual selections or plugin JSON, but cannot choose a new target or submission type.

`PluginSubmissionTarget` and `PluginSubmissionContext` share the input discriminant.
Every target supplies `sessionId`, `sessionKind`, `type`, applicable `channels` and an
opaque `surfaceTarget`. Text/practice-thinking use `channels: ["content"]`; thinking
also supplies `problem: { occurrence, statement }`. Builtin `question` is learner-facing
`ClientQuestion` plus exact `occurrence` and optional `questionType`, including displayed
labels/stable values, not grading keys. Plugin `question` supplies `questionId`,
`occurrence`, `pluginId`, `typeId`, `contractVersion`, `label`, `variant`, `showThinking`.
`PluginSubmissionOccurrence` is `{ messageId, contentIndex, toolCallId, toolName }`.
Applicable answer channels are `"answer"`, `"thinking"`, `"readingThinking"`.

Context adds `messages`, `signal` and `onAccepted(callback)`. Input, context data and
history are detached, recursively readonly and deeply frozen. `messages` is the
browser's current native history, possibly including streamed, not-yet-durable content;
it is neither rendered transcript text nor a canonical persisted-history guarantee.
This trusted API is not a new data-security sandbox. Surface targets and signals are
opaque host references: do not JSON-clone or persist them.

`hasPendingInput(target)` advertises external input that can initiate preparation;
it is not final answer validity. Call `refreshSubmissions()` after state changes.
Predicate exceptions report a plugin error and contribute no readiness. Pending input
can enable builtin preparation before an initial native selection/text exists, but the
final transformed answer must satisfy the captured question. Plugin questions still
require a current ready editor and retained answer state **before** preparation; pending
material cannot bypass that requirement or missing-renderer fallback authority.

### Strict validation, preparation and acceptance

The host reserves one attempt before any await, finishes dictation/editor delivery for
the original target, then captures final learner input and history. It rechecks the exact
native view, question/problem occurrence, readiness and plugin ownership after awaits;
it never silently retargets. Returned learner input is cloned, validated and frozen
before the next hook. `undefined` passes through; `null` intentionally cancels and keeps
drafts. Exceptions, rejected promises, type changes or invalid output **fail closed**.

Builtin answers are revalidated against the privately captured rendered/shuffled
question and rebuilt through existing host `buildAnswer` grading, not by spreading
plugin fields into a derived answer. Unknown/duplicate values, invalid cardinality,
incompatible dontKnow/selections, mode-inapplicable fields or nonfinite confidence
fail; existing confidence rounding/clamping stays host-owned. Text answers require
nonempty answer text or answer-channel images; thinking/reading images alone do not satisfy
answer readiness. Select answers still need a valid final selection/Other/dontKnow.
Plugin JSON preserves raw strings/falsy values apart from deliberate transformations,
and still passes canonical saved-schema/refinement, availability and exact-occurrence
checks. Images sit alongside JSON, never become mandatory arbitrary schema keys.

Inapplicable content channels are empty in public DTOs and must stay empty; nonempty
text/images there fail preparation, rather than being silently discarded. Host adapters
omit inapplicable channels from transport/persistence. Builtin thinking is available
across builtin kinds; reading follows the existing reveal/phase policy. Plugin thinking
requires `showThinking`; reading follows teach/check policy.

During preparation the native input shows **Preparing submission…** and **Cancel**.
Pre-POST cancel retains drafts/final dictated text and ignores late hook results, even
if a hook ignores its signal. Failure uses the native error area:
`Could not prepare submission ({plugin name}): {message}. Your input has been kept.`
The preparation signal cannot cancel an accepted POST. Draft clearing follows confirmed
boundaries without erasing newer edits; the host never clears plugin-owned pending data.
The attempt lease ends on acknowledgment/refusal, not at model-stream completion, so
ordinary busy composer steering remains available.

Use `context.onAccepted(callback)` to consume **only the captured revision** of pending
plugin data after acknowledged API acceptance. This is live/best-effort notification,
not a durable event, replay, exactly-once guarantee or model-success signal. A successful
memory-only parked-steer acknowledgment may notify; it does not guarantee durable
history. Refusal or lost acknowledgment does not notify or authorize clearing input.
Callback failures report plugin errors without failing accepted input; live callbacks
run independently of stream consumption. Late registration after invocation completion
or cancellation is ignored.

Model failure retry, Continue, malformed-question retry, control-only Next and silent
dismissals do not intercept content again: retries reuse stored/transformed accepted
input. An internal busy retry or steer-to-send fallback reuses one prepared payload and
its acceptance observers, with no second interception/notification. Explicit resubmission
of an unaccepted form is a fresh attempt. Uncertain acceptance uses existing canonical
reconciliation/exact-question guards, not an invented automatic replay. Between practice
problems, empty text plus pending plugin material is content submission, not control-only
Next.

### Explicit inline learner images

Only native blocks `{ type: "image", data: <base64>, mimeType: <string> }` are images.
Image-only messages, practice thinking and applicable answer/thinking/reading channels
are supported by the approved contract. A `.png` attachment path remains a path chip/text;
there is no path inference or automatic file read. No Blob/File/object URL/data URL is
accepted. PNG, JPEG, WebP and GIF require nonempty base64 and byte/declared-format
validation. The host uses existing image processing and the actual effective model's
resize policy (existing defaults: 2000×2000 bounds, 4.5 MiB base64 per processed image;
model overrides apply). Processing failure refuses submission, never silently omits an
image or injects processor hints as learner text. Explicitly text-only engines refuse
fresh images; custom endpoints retain existing attempt-transport policy.

Successfully prepared bytes are the accepted persisted/UI/model representation; original
editable material remains plugin-owned. Instant optimistic image previews remain visible.
While their owning image-bearing POST is unresolved, transcript adoption is deferred so
normalized canonical bytes cannot duplicate the original preview. On delivery resolution,
including refusal or lost acknowledgment, the host discards deferred snapshots and makes
a fresh canonical read. Failure or ownership loss retires only that attempt's provisional
image entries, preserving native drafts and plugin pending data; reconciliation never
invents an acceptance notification. Additive image arrays sit beside existing text
fields, with empty arrays omitted. `PluginSubmissionImages` has optional `answer`,
`thinking`, `readingThinking` arrays. Images reach native model content and the matching
user, answer, practice-thinking, question-thinking or reading-thinking container—not
metadata alone. Host image rendering is outside custom question/answer slots: centered,
natural-width, container-constrained, aspect-preserving figures labelled **Submitted
image**, including image-only containers, with no new toolbar or dimmed thinking pixels.
Existing PathText/Markdown text behavior remains. Model/target changes during async
admission are stale refusals, not silent delivery to a replacement engine or occurrence.

### Session-body surfaces

`ctx.ui.openSurface(target, { title, content, onClose? }, { signal })` returns
`PluginWidgetHandle<PluginSurfaceProps>` with standard shallow update/dispose. `content`
is existing `PluginUiContent` (HTMLElement or signal-scoped mount with optional async
cleanup). Obtain the opaque `PluginSurfaceTarget` from an existing native session top-bar
`PluginActionContext.surfaceTarget` or submission target/context; never infer one from a
session ID, selector, DOM parent or global current session.

The target identifies **one mounted teaching/practice view instance**. With live signals,
unknown/expired targets synchronously throw `Surface target is no longer active`;
already-aborted signals return an inert disposed handle. Mount commit rechecks lifetime.
Leaving and returning to the same session ID never revives a token. Navigation, owning
plugin unload, caller abort and explicit dispose tear down scoped surfaces; late async
cleanup runs exactly once, and content replacement cleans up its prior mount.

Surfaces cover the **whole session body including inputs**, not its top bar or sidebar.
The parent session stays mounted. Stacked covered surfaces stay mounted and painted but
only eligible foreground content receives covered-body interaction. Ordinary stack
entries are visual siblings, **not each other's lifetime owners**: disposing a lower
plugin surface cannot dispose another plugin's foreground surface. Explicit caller
signals may bind lifetimes. Global Settings is not lifetime-owned merely because it
paints above a surface.

The host uses existing `view` interaction layers/owner propagation, not an app-wide
modal, viewport scroll lock or second overlay registry. A body-bounded background/80
blurred backdrop, p-4 frame, visible title/accessibility label and slim upper-right
Close/X header leave content filling the remaining width/height; plugin content owns
its layout, without a forced diagram pan/zoom border. Existing one-Escape rules apply;
covered native inputs never receive submit/Tab/dictation actions. Top bar/sidebar stay
exposed, without a focus trap.

Entry honors eligible focus already placed inside the foreground surface; otherwise it
chooses the first eligible editable text/number field or textarea, then the title heading
(`tabIndex=-1`). Delayed covered mounts do not steal focus. Closing foreground restores
an eligible uncovered opener (including chrome), else surviving foreground remembered
focus/entry policy, or native-body policy when no surfaces remain. Covered disposal
never steals focus; expired views never receive focus restoration. `onClose` is a close
notification, not an async veto; programmatic dispose/abort keep normal handle semantics.

### Deferred extension points

This increment adds no message/card/composer slots, generic rich-transcript renderer,
backend submission hooks, native send/steer API, mutable agent/event/context hooks, image
picker/clipboard/drop importer, path inference, asset store or image export redesign.
Additional surface regions (including transcript-only), plugin-route/graph targets and
navigation suspension/restoration remain deferred. Existing tools/question renderers
remain the supported presentation contributions; no broader UI catalogue is implied.

## Learning data

`ctx.learning` provides:

- `directory`: the learning-data location, not a credential location.
- `listSessions()` and `getSession(id)`: summaries and full native records.
- `graph()`: the current graph projection.
- `readGraphFile(name)`: host-interpreted node/chain/session/coverage ledgers, sources,
  positions, format and render metadata. Sources are returned as a record array.

Read the native transcript for learner answers/thinking/mistakes. The knowledge graph
is extracted from teacher prose, not a complete representation of learner responses.
Reads across files are not transactional. The backend learning-data API does not mutate
core learning records; write plugin-generated cards/notes/schedules to plugin-owned state.
The knowledge picker's user-driven source organization remains existing host UI behavior,
not a programmable backend write service.

## Model calls

```js
const catalog = await ctx.inference.catalog();
// Let the user choose a catalog entry, or explicitly use a configured slot.
if (!catalog.defaults) throw new Error("Configure a model first");
const result = await ctx.inference.complete({
  model: { ...catalog.defaults.model, thinkingLevel: catalog.defaults.thinkingLevel },
  purpose: "background",
  context: {
    systemPrompt: "Your plugin's instructions",
    messages: [{ role: "user", content: "Your explicit task", timestamp: Date.now() }]
  },
  signal: ctx.signal
});
if (result.stopReason === "error") throw new Error(result.errorMessage);
```

`stream` exposes native model events including text/thinking/tool calls; `complete`
returns the final native assistant message, including error/abort states. This is not
a text-only completion API. The catalog is the host's last-known catalog: it does not
silently refresh accounts or select a fallback provider. Model selection must be
explicit and currently available; an unset model is an error.

`purpose` classifies automatic/background versus user-initiated work for subscription
consent; it does not classify a request for the shared worker-request pool described
below. Existing subscription background-use consent, provider admission, quota, and
cancellation rules apply. Do not misclassify automatic work as user input to bypass
those rules. Connecting a view never changes a background call into user-initiated work.
Standalone raw plugin inference is outside the worker-request pool, even with background
purpose. There is no automatic API-key fallback after a refused subscription call.

The host owns credentials and transport. Supported generation/reasoning/retry options
are listed in `PluginInferenceOptions`; transport callbacks, custom fetch/env, headers,
and deferred remote work are not part of this API. Put thinking level on the model
spec. Usage appends to plugin-local `usage.jsonl`, not core chat records.

## Managed agent sessions

See `examples/plugins/managed-agent` for a complete frontend/backend example. It uses
normal public APIs; the host has no special knowledge of its operations or tools.
Its model calls may incur cost. It is not installed or enabled automatically.

Backend pattern:

```js
ctx.agents.register({
  id: "assistant",
  instructions: "Your own instructions",
  model: selectedModel,
  tools: [{
    name: "ask",
    kind: "input",
    description: "Ask the person for input",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    resultSchema: { type: "string", minLength: 1 }
  }]
});
const session = ctx.agents.create("assistant");
await ctx.agents.send(session.id, explicitTask, {
  requestId: crypto.randomUUID(), purpose: "background"
});
```

Persist/reconstruct definitions consistently across activation, including their model
selection. The helper stores conversations, not JavaScript handlers. A missing
definition is an unavailable-definition error, not permission to reinterpret history.
A `kind: "input"` tool does not have `execute`: its call becomes persisted external
input. Read `snapshot.pending`, render your own form, and submit via your backend:

```js
await ctx.agents.answer(sessionId, toolCallId, validatedAnswer, {
  requestId: crypto.randomUUID(), purpose: "user"
});
```

Retry the **same** submission with the same request ID. A new ID means a new action.
Do not answer the same question twice under different identities. Multiple required
inputs all need results before continuation. Invalid answers are refused, not saved
as successful tool results. `formatResult` can define model-facing answer content.
An ordinary server tool instead has `execute` and may use `endRun: true` to return a
successful result and pause; future user text is a new contribution, not that tool's
missing result.

`get`, `list`, `subscribe` expose full state/current partial. Subscription teardown
only detaches an observer. The app emits the live plugin notification topic
`agents-changed` on managed state changes; re-read your selected session and coalesce
in-flight fetches as the example does. On reconnect, use `ctx.onResync` to read current
state. Never keep polling a hidden view. A plugin may use backend `subscribe` for its
own feature-local coordination; unsubscribe on cleanup.

`abort` requests cooperative cancellation. `run` resumes runnable persisted input;
it never authors “Continue” for you. App navigation/reload does not stop a run, but
app shutdown does. Restart recovers waiting inputs and marks in-flight work interrupted.
Incomplete side-effecting tool batches are not auto-replayed. Explicit new input may
establish recovery context; do not claim exactly-once external side effects.

## Result-oriented workers

`ctx.workers` is for bounded tasks with one validated result, not conversational sessions
with external human-input tools. The host uses the same native sub-agent runner and
inference/accounting path. Reserve `data/tasks/` for its persisted records.

```js
ctx.workers.register({
  id: "make-note",
  instructions: "Write a short note about the supplied topic, then call submit_result.",
  resultSchema: {
    type: "object", properties: { note: { type: "string", minLength: 1 } }, required: ["note"]
  },
  validateResult(result, task) {
    // task.input is the immutable accepted input; don't trust a model-authored task ID.
    if (!result.note.trim()) throw new Error("The note cannot contain only whitespace.");
  }
});
const accepted = ctx.workers.start("make-note", {
  requestId: crypto.randomUUID(), input: { topic: "Example" }, prompt: "Write a note about Example.",
  model: selectedModel, purpose: "background", maxTurns: 3,
  options: { maxTokens: 1024 }, timeoutMs: 60000
});
const outcome = await ctx.workers.wait(accepted.id);
if (outcome.status === "succeeded") useResult(outcome.result);
else showFailure(outcome.error);
```

The numbers above are example limits, not host defaults. Model and purpose are explicit;
plugins choose their own slot/override policy. `start` synchronously persists acceptance
before scheduling execution and returns a snapshot, **not completion**. Repeating an
identical request ID/request returns the original task; reusing it for different work is
an error. A new attempt uses a new ID. `maxTurns` is required; `options` uses the inference
allowlist and applies across native turns. Task `timeoutMs` is wall-clock lifetime from
acceptance (including admission waits), separate from per-request `options.timeoutMs`.

The host installs `submit_result({ result: ... })`. Schema errors and semantic validation
errors return correction feedback in the same context. The validator must be side-effect
free. Ordinary tools may be supplied by a task-context factory; tool exceptions can be
corrected, but a model ending without a valid final submission is failure, not success.
The first durably accepted valid result is immutable, including falsy JSON values. Later
cancellation or cleanup cannot replace it. There is no exactly-once promise for arbitrary
external tool side effects.

States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`.
`get`, `list`, and snapshot-first `subscribe` expose committed history/progress; streaming
`partial` is ephemeral. `wait` resolves a terminal outcome, while aborting its signal only
stops that waiter. Unsubscribing or leaving a view does not cancel execution. Use `cancel`
explicitly. Disable and server restart mark **all unfinished tasks interrupted**, including
queued tasks and disabled packages' saved tasks. Nothing automatically replays tools or
starts a new model attempt. Completed results/history remain available.

This service does not add a DAG, scheduling language, or a separate plugin concurrency
setting. Compose sequential stages with `wait`; coordinate independent tasks in plugin code.

### Shared host worker-request admission

Host admission does not add plugin APIs or change task outcome/delivery recovery semantics.

Settings → Agent → Models exposes **Concurrent worker requests**
(`agent.workerRequestConcurrency`). The default is **8**, including when unset. Values
must be positive safely representable whole integers (JavaScript safe integers); there is
no arbitrary cap. Invalid values are rejected, not clamped. Increasing the value admits
queued requests immediately. Decreasing it lets active requests finish, admitting no
replacement until the active count is below the new limit.

One process-global FIFO pool limits concurrent background **model request streams**, not
whole agents or tasks. Each permit ends with its model request, before native tools run or
an agent waits for child work. Core extractor, auditor, researcher, demo builder, visual
maker and PDF reader requests share this pool with **all** detached `ctx.workers` tasks,
including tasks started with `purpose: "user"`. Cancelling a queued request prevents
provider dispatch. Teacher/prober/practice requests and their compaction, interactive
plugin-managed conversations, and standalone raw plugin inference are outside this pool.
`purpose` controls subscription consent, not worker classification. The pool is shared
across routes and windows using one app-server process, not independent server processes.
It replaces the old whole-extractor-phase three-permit wrapper; source-serial extraction
chunks and the audit-through-merge consistency lock remain separate. The frontend's
three-file upload queue is also independent of this model-request limit.

Standalone tasks appear in the host **Background agents** panel using the existing row:
title **plugin name · worker definition ID**, elapsed time, activity, model and usage when
available. No session link is invented for a standalone task. **END** cancels computing
work, including queued work; it does not cancel a completed result or pending delivery.
A task already represented by a linked `createBackgroundTool` host job does not get a
second row. This adds neither automatic retry nor a new task-history screen. Admission
and activity bookkeeping, including internal SDK operations/callback metadata, remain
host-private rather than a new public agent framework.

### Background tools in existing lessons

Inside `registerTools.create(context)`, return `ctx.createBackgroundTool(context, spec)`.
It returns a **native Pi tool**, not a separate sub-agent framework. `spec` contains native
tool metadata/schema, `workerId`, `prepare(input, context)` returning worker start options
without request ID/purpose, and `format(outcome, context)` returning `{ text, data? }`.
The host derives the request identity from the actual chat/tool call and always classifies
the detached worker as background work. See `examples/plugins/teaching-extension`.

The tool returns a dispatch acknowledgement promptly; its original native result remains
that acknowledgement forever. A shared background-job row tracks progress/cancellation.
After completion, the existing result-steer pipeline delivers the formatter's model text
and a separate rendered payload, respecting live-turn boundaries, pending questions,
consent and idempotent message identities. `tool.background` distinguishes that later
card in your renderer. The header/status and formatter errors remain host-owned; your
renderer owns the body. Raw fallback stays readable without the plugin.

The approved default is a **collapsed result**, matching the research/PDF completion
pattern, not an always-expanded standalone card. Host identity/status (and disclosure
when collapsed) stay outside the custom body. For host-delivered later results,
`PluginToolRenderer.backgroundPresentation?: "collapsed" | "card" | "plain"` selects
the shell. For a result in your own view, reuse
`ctx.ui.mountWorkerResult(container, { label, status, text, presentation: "collapsed" },
{ signal })`; its `presentation` accepts the same three choices. `"collapsed"` is the
default, `"card"` is an expanded bordered card, and `"plain"` is an expanded unframed
body suitable for SVG or interactive demos. Even plain results retain host identity,
status and formatter errors; presentation does not change execution or delivery.
`status` is `"succeeded"`, `"failed"`, `"cancelled"`, or `"interrupted"`.
Optional `content` replaces the text body with plugin-owned rich content: an HTMLElement
or `(container, signal) => cleanup` (the mount may be async). This same content shape
is used by dialogs. SVG, interactive demos and other custom DOM are allowed; preserve
cleanup/cancellation and never insert unsanitized model HTML. The shared tool-renderer
hook remains the way to customize the body of a host-delivered later result. For example,
this renderer explicitly opts into an unframed later result with a simple SVG demo:

```js
ctx.registerToolRenderer({
  toolName: "my_plugin_diagram",
  backgroundPresentation: "plain",
  mount(container, tool) {
    if (!tool.background) {
      container.textContent = tool.errorText ?? "Diagram dispatched";
      return () => container.replaceChildren();
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Example circle");
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", "50");
    circle.setAttribute("cy", "50");
    circle.setAttribute("r", "40");
    circle.setAttribute("fill", "currentColor");
    svg.append(circle);
    container.append(svg);
    return () => container.replaceChildren();
  }
});
```

Use `presentation: "plain"` with `mountWorkerResult` and custom `content` for the
same unframed presentation in a plugin-owned view. The renderer property applies to
later background results, not the original native tool acknowledgement.

Do not perform side effects in `prepare`/`format`. Completed task outcome and result delivery
are separate facts. Worker completion ends the shared job's computing state; END no longer
cancels a finished worker or its queued result delivery. The generic outcome is persisted
before asynchronous formatting, and delivery waits for formatting while the plugin is live.
A restart can deliver that persisted fallback without running plugin code. Recovery
re-delivers persisted results, never re-runs plugin tools or formatters;
missing/unreadable task state produces an honest failure notification rather than a
fabricated result. Formatter failure or unavailable plugin code keeps the real task
outcome and a safe fallback, not a false task failure.

## App events and notifications

Backend `ctx.events.on(listener)` and frontend `ctx.onAppEvent(listener)` receive the
supported app events. For example, `turn-settled` follows core turn persistence;
extraction is asynchronous and is not promised complete at that moment. Avoid
recursively emitting in response to your own notifications.

`ctx.events.emit(topic, jsonData)` is scoped to your plugin. Frontend
`ctx.onNotification` receives those live notifications. There is no arbitrary durable
event log: on reconnect use `onResync` and fetch current state. Notifications share
the existing per-window app channel; do not open standing polling loops.

## What v1 deliberately does not do

No marketplace, automatic community updater, sandbox, per-plugin process, hot code
replacement, core-data write API, teaching-specific agent framework, general declarative
UI language, or automatic restart/replay of interrupted arbitrary tools. The small
settings-row schema is a controlled presentation helper, not such a UI language.
Your feature owns its own product behavior. Host internals are not a supported extension API.
