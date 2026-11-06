# Build a LearnHarness plugin

> **Shared-tree commit closeout — 2026-11-04:** the verified tree foundation is
> included in its feature-branch commit. Tree-checkpoint “uncommitted” notices below
> retain verification-time status; no push, installation or release is implied.

> **Commit closeout — 2026-11-04:** The verified UI-polish, question-card, native-default/reconnection and opening-animation changes are included in this feature-branch commit, together with Coding Questions and UI Showcase. “Uncommitted” notices below retain their original verification-time status; this note supersedes them for the current Git state. No push or release is implied.

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
5. Edit the installed code in `hello-plugin/dist/`, restart LearnHarness, and enable
   it if necessary. Refresh discovers packages; it is not a JavaScript hot-reloader.

Packaged desktop builds also include a `plugin-authoring/` directory beside the
standalone server, under the app's resources. It contains these docs, examples, a
coding-agent skill, and the generated type-only API tree. This is read-only authoring
material, separate from the writable installed plugins directory.

No npm command is run by LearnHarness. Each plugin has one workspace at
`<learning data>/plugins/<id>/`, whether you install a distribution or author it there.
The host requires **`<id>/dist/manifest.json`** and its referenced built bundles. A source
project may keep `package.json`, source and build scripts alongside `dist/`; running its
build writes directly to that `dist/`, not `dist/<id>/`. You can therefore edit and build
in the installed workspace without copying or registering a second folder. After the
first build of a previously unbuilt workspace, refresh the list to discover it. Changes
to code already admitted by the host require a server restart, not just refresh.
There is no separate development mode, registration, profile, hot reload, or legacy-layout
fallback; an ID folder with only a root manifest is not an installable plugin.

For distribution, copy the **contents of the built `dist/`** into
`<learning data>/plugins/<id>/dist/`, never directly into `<id>/`. Keep optional source
and development dependencies outside the runtime `dist/`, and never distribute persistent
`data/`. Preserve the sibling
`<id>/data/` when replacing code. A production plugin can use TypeScript, React, and a
bundler during authoring; ship the browser bundle as an ES module and the Node bundle as
CommonJS. Bundle JavaScript libraries; leave Node built-ins external in the backend.
Native dependency installation/rebuilds are not provided. The examples use plain JS and
Node built-ins, needing no build: their complete ID folders already include `dist/` and
can be copied as-is. Besides the independent
hello/managed-agent views, `examples/plugins/teaching-extension` demonstrates contributions
to existing lessons: a normal native tool, a background-worker tool, and shared renderers.
The background example may incur model cost, but runs only when explicitly requested.

The exact API contracts are `src/core/plugins.ts`, `src/core/plugin-ui.ts`,
`src/core/plugin-agents.ts`, `src/core/plugin-workers.ts`, `src/core/plugin-questions.ts`,
`src/core/plugin-submissions.ts`, and `src/core/plugin-tree.ts`.
The [native session-extension contract](plugin-session-extension-contract.md) is normative
for the session-extension increment, implemented and verified on
`feature/plugin-architecture`, not released.
For TypeScript in a checkout, use **type-only** imports from those files. Do not import
application implementation modules at runtime. `scripts/build-plugin-types.mjs` emits
a portable declaration tree for authors who do not use a source checkout. The TypeScript
plugin projects in this repository use `.sdk/`: their `npm run sdk` command invokes the
checkout's generator. Outside a checkout, copy the packaged `plugin-authoring/types/` tree
into the project's `.sdk/` before installing dependencies; the build itself needs no app
checkout. Pi native message/tool types are intentionally part of API v1 and match the app's pinned SDK;
this is not an unversioned compatibility promise for arbitrary Pi releases.

## Current UI-polish increment — implemented and verified

The human-approved presentation increment and origin-sensitive knowledge picker are
**implemented and verified, uncommitted on `feature/plugin-architecture`, not released**.
The separate [UI-polish verification record](plugin-architecture.md#ui-polish-status--2026-11-03)
records 3,908 root tests / 564 suites, 17 showcase tests, strict SDK/build/privacy gates
and the expanded packaged Electron-Node/Chrome proof. Historical Markdown, question,
interaction and session-extension checkpoints retain their original scope; they are not
retroactive proof of these later changes. No commit, push or release follows from verification.

## Installed folder

```text
<learning data>/plugins/my-plugin/
  package.json      # optional authoring/build configuration
  src/              # optional source; never used as a runtime fallback
  dist/             # REQUIRED fixed runtime directory; build output goes here
    manifest.json
    main.js         # optional browser ES module
    backend.cjs     # optional Node CommonJS module
    styles.css      # optional; requires a frontend entry
    assets/         # public distributable assets/modules
  data/             # persistent sibling, never distributed or served as static assets
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
optional except that at least one of `main` or `backend` is needed. They name files at
the root of `dist/`, not the workspace root or paths into `data/`. Version fields initially
use numeric `x.y.z`. An
incompatible or malformed package is reported without executing its code.

Use the workspace's sibling `data/` for user-created state, never `dist/data/`.
Build cleanup must remove only generated `dist/`, never the workspace root or `data/`.
Before cleanup, refuse a symlinked `dist/` or any `dist/data/` entry (including symlinks)
to avoid deleting or building over misplaced persistent records. Disabling never deletes
data. Official code updates preserve it. If you manually replace an external package,
replace only its `dist/` code and preserve its data yourself.
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
The API has 15 methods, including `mountTree` and the generic `mountBadge` primitive.

| Method | Controlled inputs and callbacks |
| --- | --- |
| `mountModelPicker(container, props, options)` | `value: { provider, id } \| undefined`, `onChange(value)`, optional `disabled` |
| `mountThinkingPicker(container, props, options)` | `model: { provider, id } \| undefined`, `value: ThinkingLevel \| undefined`, `onChange(value)`, optional `disabled` |
| `mountKnowledgePicker(container, props, options)` | `value: readonly string[]`, `onChange(ids)`, optional `disabled`; host node-selection bubble and Chains picker, as below |
| `mountComposer(container, props, options)` | `value`, `onChange`, `onSend`; optional `busy`, `onStop`, `canSend`, `placeholder`, `autoFocus` |
| `mountDictation(container, props, options)` | `onTranscript(text)`, optional `disabled`; handle also has `toggle()`, `finish(): Promise<void>`, `cancel()` |
| `mountStandardComposer(container, props, options)` | `{ composer, model, thinking, dictation }`, using the independent controls' props |
| `mountButton(container, props, options)` | `label`, `onClick`; optional `icon` (trusted SVG string), `iconOnly`, `disabled`, `variant` (including `custom`), `colors`, `size`, `title` |
| `mountBadge(container, props, options)` | `text: string`; optional `color` supplies text color and a 15% background tint; omitted color is neutral |
| `mountSettingsRows(container, schema, options)` | `{ rows }`, as below |
| `mountWorkerResult(container, props, options)` | `label`, terminal `status`, `text`, optional `content`, `presentation` |
| `mountMarkdown(container, props, options)` | `text: string`; static complete Markdown through the actual host pipeline, built-ins only |
| `mountTree(container, tree, options)` | accessible `label`, controlled `rows`; optional primary `header`, aligned trailing `columns`; presentation only |
| `openMenu(anchor, props, options)` | `items: [{ key, label, onSelect, disabled? }]`; optional `label`, `preferredSide`, `onClose` |
| `openDialog(props, options)` | `title`, `content`, optional `onClose` |
| `openSurface(props, options)` / `openSurface(target, props, options)` | page-body surface; optional precise native-view target; accessible `title`, `content`, optional `background`, `onClose` |

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
standalone composer is a bare input primitive. In the standard composer, only the text
entry has a frame; the model/thinking/dictation/send control row sits below and outside
that frame. The preset is a convenience, not a complete teaching/practice dock: it
excludes usage meters, practice controls, attachments, and default file/drop insertion
behavior. It finishes dictation and awaits transcript delivery before send; plugins
using independent controls must coordinate that themselves.

The approved polish makes model/thinking controls self-contained at **11px**; their
appearance must not depend on a plugin's surrounding font size. These are the exact
independent host controls: their model values remain plugin-local and core settings
remain read-only. They do not replace native writing controls. Existing button variant
palettes are preserved. Gallery explanations use the configured reading size (**16px**
by default), while Settings headings keep the compact `SettingsHeading` treatment.
These presentation changes passed the separate UI-polish verification checkpoint.

Dictation has one exclusive recording owner per window, including core and plugin
controls. A competing start reports **“Dictation is active elsewhere”**, rather than
stealing the recording. Focused plugin controls own their matching shortcuts; merely
mounting one does not take over core shortcuts. An Escape owned by dictation cancels the
actual recording owner; an Escape consumed by a higher layer must not also cancel it.
Plugin dictation always delivers to its explicit `onTranscript` callback, never
silently into a core composer/question. The plugin decides where that text goes.

### Button icons

`mountButton` accepts `icon?: string` using the same **trusted plugin SVG markup**
convention as `PluginAction.icon`. It is not a sanitizer or a custom-renderer slot.
The host renders the icon decoratively before the visible label, using native button
SVG sizing, spacing and padding. Existing text-only buttons are unchanged.

Set `iconOnly: true` to hide visible text; the required `label` becomes the button's
accessible name. Icon-only buttons require a nonblank label and icon. Invalid new
props throw on live mount/update before changing the widget; disposed handles remain
inert. Updates shallow-merge, so removing an icon from an icon-only button also requires
`iconOnly: false` in that update. `size` still controls geometry only—it never implicitly
hides text. The existing optional `title` is unchanged and is not filled automatically.

```js
ctx.ui.mountButton(container, {
  label: "Settings",
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M4 8h8M8 4v8" /></svg>',
  iconOnly: true,
  size: "icon-sm",
  onClick: () => ctx.app.openSettings()
}, { signal });
```

Omit `iconOnly` for an icon-plus-text button. Variants, disabled behavior, callbacks,
abort/disposal and the controlled update handle retain their existing semantics.
This additive API v1 extension does not add a UI method or require private host imports.

### Custom button colors

Use `variant: "custom"` for full **color** customization without overriding native
button geometry, layout or activation behavior. The optional `colors` object has this
public shape; every slot is optional:

```ts
interface PluginButtonColorState {
  background?: string;
  text?: string;
  border?: string;
}
interface PluginButtonColors extends PluginButtonColorState {
  hover?: PluginButtonColorState;
  active?: PluginButtonColorState;
  focusVisible?: PluginButtonColorState & { ring?: string };
  disabled?: PluginButtonColorState;
}
```

For example, using CSS variables defined in your own content styles:

```js
const button = ctx.ui.mountButton(container, {
  label: "Continue",
  variant: "custom",
  colors: {
    background: "var(--example-fill)",
    text: "var(--example-text)",
    border: "var(--example-border)",
    hover: { background: "var(--example-hover)" },
    focusVisible: { ring: "var(--example-focus)" }
  },
  onClick: () => continueFlow()
}, { signal });
```

- Normal fallbacks use the native default button's primary background/foreground.
  The custom variant reserves a fixed **1px border**, transparent unless colored;
  native sizes, padding, shape, typography and icon layout remain host-owned.
- Omitted state slots do **not** reset other applicable colors. Overrides cascade
  **per property**: disabled > active > focus-visible > hover > normal. No new shades
  are calculated. `active` means native CSS `:active`, not toggle state or a new
  activation handler.
- Native focus-visible border and ring colors remain unless explicitly overridden.
  Ring geometry and focus-visible behavior stay native. Disabled controls retain
  native pointer blocking and **50% opacity**, even when disabled colors are supplied.
- Values are nonblank, browser-supported CSS color strings, including `var(...)`,
  `currentColor` and `color-mix(...)`. Unknown slots, invalid object shapes/types and
  invalid color syntax throw before a live mount/update is published or mutated.
  Disposed/aborted handles remain inert. Validation checks syntax, **not** variable
  resolution, contrast or whether the chosen focus color is visible; the plugin owns
  those palette decisions.
- `colors` is validated for every variant but applied **only** to `custom`. Switching
  to another variant retains the palette without styling that variant. Set
  `colors: undefined` to return to the custom variant's native fallbacks.
- Updates remain shallow: `button.update({ colors: nextPalette })` **replaces the whole
  colors object**, including its state objects. Omitted prior slots are removed; pass
  your complete desired palette when changing one slot.

No arbitrary CSS properties, selectors, geometry, opacity or keyboard overrides are
exposed. The host implements the colors on the actual native Button; do not style its
private descendants or depend on private host CSS-variable names. This additive API v1
extension adds no UI method or dependency and leaves existing variants unchanged.

### Generic badges

Use `ctx.ui.mountBadge(container, { text, color? }, { signal })` for the same badge
component used by native correct/incorrect and practice-outcome labels. It returns
`PluginWidgetHandle<PluginBadgeProps>` with the usual shallow `update` and `dispose`
methods. Native compact uppercase typography, padding and rounded shape are
self-contained; plugin surroundings do not need to reproduce the header styles.

```js
const badge = ctx.ui.mountBadge(container, {
  text: "Tests passed",
  color: "#22c55e"
}, { signal });
badge.update({ text: "Any outcome", color: "var(--plugin-accent)" });
badge.update({ color: undefined }); // Keep the text; restore the neutral treatment.
```

`text` is required plain text, not Markdown, HTML or a renderer. `color` is one
nonblank CSS color, including CSS variables, `currentColor` and color expressions;
it sets the text color and the background uses `color-mix(in oklab, color 15%, transparent)`.
Omit it for native muted text/background. Invalid text types or color syntax reject
live mount/update atomically. CSS-wide property keywords such as `inherit` are not
color-mix operands and are refused. Syntax validation does not check variable
resolution or contrast; the plugin owns those decisions.

This is a generic noninteractive display primitive: no grade/status enum, scoring,
automatic placement, click handler or live announcement. It does not interpret a
grading result or persist anything. Plugins decide what text and color to display,
and where to mount it; it is not restricted to question renderers. The Buttons
family in UI Showcase includes neutral and colored examples. This additive API v1
method needs no new dependency or version bump.

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

### Shared tree presentation — implemented and verified

The [approved tree contract](plugin-tree-contract.md) adds
`ctx.ui.mountTree(container, tree, { signal }): PluginWidgetHandle<PluginTreeProps>`.
Exact types live in `src/core/plugin-tree.ts`. This increment is **implemented and
verified, uncommitted on `feature/plugin-architecture` above `bdd0666`, not released or
installed**, at its own [4,021-test / 568-suite checkpoint](plugin-tree-contract.md#verification-checkpoint--2026-11-04).
Earlier checkpoints remain historical. The generic `tree` configuration is not the Chains
Props/proposition column; `PluginTreeProps` simply names its properties. The checkpoint
records exact native geometry/styles and fitting-width column proof, not universal pixel
identity, underconstrained alignment or whole-app manual UX coverage.

Use globally unique row-occurrence keys (any string, including empty), independent of
item identities. There is no `itemId` or automatic selection cascade. Optional controlled
checkboxes/disclosures, primary content/header and width/alignment-defined trailing cells
use fixed native shells; content slots accept strings or existing `PluginUiContent`, not
replacement row markup. Keep content-mount function identities stable to avoid remounts
on unrelated updates. Collapse unmounts descendant content and cleanup; reopening
remounts it, so retain drafts/data in plugin state. The normal signal/update/dispose
contract applies: widget abort/plugin deactivation disposes mounts, but checkbox
`selection.disabled` does not unmount content. See the contract's concrete plugin-owned
folder/file example.

The shared foundation is presentation only, also consumed by native Chains without
controller/business-logic migration or native navigation changes. The caller owns
search/sort/actions, rename/move/storage, selection policy, scroll containers, loading and
empty UI. The widget opens nothing and adds no public keyboard-controller API, column
resizing or sticky system. Its root-local adapter reuses Chains arrow-row rules:
Up/Down siblings, Right open/enter child, Left parent/fold parent; Space toggles only an
enabled, host-owned row checkbox. Nested widgets are independent; plugin inputs,
contenteditable and handled keys are isolated. No autofocus, Find/search or global handler
is added. The app-wide Tab policy stays unchanged; there is no native Tab-focus promise.

Defaults match native `font-ui`: primary labels `text-sm`/12.5px, weight 500; metadata and
headers `text-xs`/11px, weight 400. Width-bearing header/body cells share font metrics,
including for CSS `em`/`ch` widths; this is not universal positional alignment under width
constraints. Rich content may style itself. Thin native separators
appear only between top-level groups, not nested rows or after the last group. Internal
selectors are not public API. Knowledge pickers and surfaces remain separate. No product
plugin, including Flashcards, is migrated by this increment.

**Width/fit/scrolling warning:** if configured columns plus maximum indentation and
control/prefix space exceed the available width, the tree can overflow and header/body
column positions can diverge even when declared widths are retained. Provide sufficient
width/minimum width and your own horizontal scroll container, or fewer/narrower columns.
There is no host minimum-width calculator, clipping policy or responsive engine. For
your controlled `tree` inside a view mount, a tiny wrapper is:

```js
const scroller = document.createElement("div");
scroller.style.overflowX = "auto";
const inner = document.createElement("div");
inner.style.minWidth = "32rem"; // Example only: caller chooses a sufficient budget.
scroller.append(inner);
container.append(scroller);
const handle = ctx.ui.mountTree(inner, tree, { signal });
return () => { handle.dispose(); scroller.remove(); };
```

`32rem` is not a host requirement; choose for your hierarchy, controls, primary content
and column widths. Native layout behavior is unchanged.

### Knowledge picker

The approved knowledge-picker increment adds
`ctx.ui.mountKnowledgePicker(container, { value, onChange, disabled? }, { signal })`
to API v1, with types in `src/core/plugin-ui.ts` included in the generated type bundle.
`value` is a `readonly string[]` of selected node IDs; `onChange(ids)` receives the new
ID array. It returns the standard handle with `update(partialProps)` and `dispose()`.
The app-wide dialog/interaction foundation and then-full-window picker passed
[historical interaction verification](plugin-architecture.md#historical-shared-interaction-final-verification--2026-11-02).
The [dialog and overlay contract](dialog-overlay-contract.md) governs the shared foundation.
The implemented and verified origin-sensitive policy below supersedes the earlier
always-full-window picker presentation at the separate UI-polish checkpoint.

The plugin chooses where to place the bubble, controls selection IDs, and owns any
persistence. The host does not write plugin state. The bubble reuses the **exact existing
`NodePickerControl`**: **Pick nodes**, selected count and **Clear**. Clear emits the
controlled empty array `[]`. Clicking opens the real **`ChainTableOverlay`**, retaining
the existing translucent/blurred Chains appearance, not an inline embed or copied table.
The host captures the actual opening origin; plugins supply no public presentation option:

- From a plugin/native page or session-body surface, the picker is a **main-pane view
  overlay**, excluding the sidebar. The sidebar stays interactive; navigation away from
  the source view expires the picker.
- From a dialog, Settings or another modal origin, it is a **full-viewport modal**.
  The launching parent remains painted/stateful but inert, using the common modal
  focus and interaction rules. Its lifetime follows the actual modal origin and widget,
  not an unrelated background route.

Existing Graph/Practice Chains views retain their existing content-area behavior.
Checkbox selection changes are immediate through `onChange`; reflect the new array with
`handle.update({ value: ids })`, not a later Done commit. **Done**, **X** and an unconsumed
selector-owned **Escape** close only it, retain controlled selection and return eligible
focus. Reopening retains the controlled value. Picker **Done** has no dumbbell/practice
glyph; the native practice action keeps its own glyph.

The picker supports ordinary plugin views, native pages/session surfaces, plugin Settings
and public `ctx.ui.openDialog` content without new props or plugin-side lifetime requirements.
There is no sidebar-reopen button inside the picker. Left-side clearance applies only
where the picker reaches the viewport's left edge (including full-viewport modal or
closed-pane cases); Windows/Linux window-controls-overlay gutter handling keeps the
existing calculation. This does not change sidebar-state persistence.
A launching Settings or public dialog stays **mounted, painted and visible underneath**, preserving state and
scroll position; it is inert while covered, not hidden with `display: none`. New public
dialogs and menus can foreground normally. A fresh Settings open nests **above** the
picker without discarding it. Returning to an already-open Settings singleton requests
closure of intervening layers top-down through normal callbacks, stopping on blocked,
handled-without-closing or pending outcomes. There is no queued navigation or forced
cancellation; Settings retargets/deep-links only after return-to succeeds.

Only **one selector** is active. Its exclusive opening slot uses the shared controller's
normal close guards; closing a previous selector does not clear its controlled IDs or
automatically reopen it later. Newer UI openings or retargets invalidate older pending
graph loads so they cannot promote a stale picker. Pending graph loading must also
respect the captured origin and its lifetime, never opening against a replacement view.
Route-lifetime binding applies to nonmodal page/session-surface origins only; a modal-origin
picker follows its actual modal and widget lifetime. Covered view sources retain their
DOM/drafts and interaction ownership, but this does not imply blanket DOM `inert` across
view regions. Existing modal and session-surface inert policies remain unchanged. These
are host-private mechanisms, not public origin options or a new overlay framework/SDK API.

The host supplies the graph and source organization, loading lazily on first open using
the existing new-practice pattern, and owns focus, portals and abort/disposal cleanup.
Graph names, chain presentation and source organization use the canonical existing UX.
Selection mode is **not read-only**: user-driven source **rename**, folder **creation**
and **drag organization** remain available. Management **Delete** remains unavailable in
practice-picker mode, matching existing behavior. These are existing host UI operations,
not new programmable core-write APIs: the backend learning-data API remains read-only.
There is no deck/library domain API: the new `mountTree` is generic presentation only.
Deck hierarchy, state, membership and selection limits remain plugin-owned.

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

### Plugin dialog presentation — implemented and verified

`ctx.ui.openDialog({ title, content, onClose? }, { signal })` still requires `title` as
its accessible name. The host renders **no visible title or header row**. Plugins own
any visible heading and bottom action layout inside `content`; no header/appearance props
are added. A quiet, muted Close/X floats above the content, independent of its scrolling.
This is presentation polish, not a change to shared close, focus or ownership rules.

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
actual Promise-returning callback is pending the row is disabled; a synchronous slider
change must not cause a transient disabled state or interrupt dragging. Genuine pending
Promise behavior is unchanged. A thrown/rejected persistence callback is displayed as an
error, not a successful save. Validate backend inputs too. Continuous native-slider dragging
passed the packaged UI-polish proof without node replacement or transient disabling.

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

## Convert an uploaded document

Frontend-only `ctx.documents.toMarkdown(file, options?)` accepts a browser `File` and
returns `Promise<{ name: string; markdown: string; notices: string[] }>`. The
`documents` context member is readonly. `options` supports only optional
`signal: AbortSignal`; activation cancellation is automatic, and a caller signal can
add a shorter lifetime such as a view mount. There is no backend `documents` member,
named public document DTO/service/error type, error code, or discriminated outcome.
Refusals and conversion failures reject the Promise with an `Error`. Caller cancellation
honors the supplied `AbortSignal.reason` (normally an `AbortError`, but a caller may
choose a different reason).

Use a native file input, for example inside `mount(container, signal)` with `ctx` from
activation (this does not assume a host file-picker API):

```js
const input = document.createElement("input");
input.type = "file";
input.setAttribute("aria-label", "Document to convert");
const status = document.createElement("p");
const output = document.createElement("pre");
input.addEventListener("change", async () => {
  const file = input.files?.[0]; // Browser File, not a path or URL.
  if (!file) return;
  try {
    const result = await ctx.documents.toMarkdown(file, { signal });
    if (signal.aborted) return;
    output.textContent = result.markdown;
    status.textContent = [result.name, ...result.notices].join("\n");
  } catch (error) {
    if (!signal.aborted) status.textContent = error instanceof Error ? error.message : "Conversion failed";
  }
}, { signal });
container.append(input, status, output);
```

Omit the second argument when activation lifetime is sufficient. The host uses an
internal multipart route, **not** the JSON `ctx.call` bridge; do not pass a `File`
through `ctx.call` or construct a private route request. Disk paths, URLs, upload
tokens and storage references are not inputs.

Conversion is generic and deterministic:

- A leading `%PDF-` signature **or** a `.pdf` filename suffix selects PDF parsing.
  Invalid PDFs never fall back to text. PDFs use the exact native deterministic
  `convertPdf` / `PdfPage` / `joinPages` engine and its page markers, not a second converter.
  Mixed PDFs skip image-only pages with notices; an all-image PDF is refused because
  OCR is unavailable, distinctly from a blank PDF.
- Everything else is strict UTF-8 text, regardless of filename suffix or MIME type;
  there is no text-extension whitelist. Binary, disallowed control content and empty
  input are refused. Tab, LF and CR are allowed; other C0, DEL and C1 control
  characters are refused. Text is returned as text, not converted from HTML or DOCX.
- Limits are **25 MiB per file**, **26 MiB for the actual multipart body including
  headers**, **1,000 PDF pages** (checked after the document opens), and **2 MiB of
  final UTF-8 Markdown including page markers**. Oversize input/results are refused,
  never truncated. The result cap is not a peak-memory bound.
- Only **one conversion globally across plugins** is admitted; competing requests
  fail fast with a busy message asking the caller to retry. There is no queue. The
  slot is admitted before body buffering and remains held through underlying work
  and document-destruction settlement, even after request cancellation.

Cancellation is cooperative only. PDF fake-worker execution may parse synchronously;
this helper promises no hard deadline, CPU bound, peak-memory bound or process
isolation. It performs no OCR, model/provider calls, learning-graph changes, storage
or temporary persistence. Conversion itself stores nothing; the user can subsequently
choose to persist the returned text through the plugin's own backend.

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

### Question defaults and navigation recovery — implemented and verified

This later increment is **implemented and verified, uncommitted on
`feature/plugin-architecture`, not released**. It changes host question keyboard defaults,
footer wording, Thinking height and canonical-read recovery. Its separate
[3,965-test checkpoint](plugin-architecture.md#question-defaults-and-navigation-recovery--implemented-and-verified)
includes final development/production navigation and native submission proof. The prior
**3,925-test native-parity** and **3,908-test UI-polish** checkpoints remain historical,
not retroactive proof of this delta. No grading, saved-data, blank/whitespace filtering,
public API shape or `ctx.ui` change is included. See the separate
[native-default and reconnection contract checkpoint](plugin-question-contract.md#14-native-default-and-reconnection-checkpoint--2026-11-03),
not the historical section 13 card-placement checkpoint.

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
outside custom answered content: reading thinking sits above the submitted card with the
native `YOUR THINKING` label and initially expanded behavior; answer thinking uses the
native `inCard` row inside it. Each channel combines its own text/images; defined empty
or whitespace-only channels are not filtered out. Pending thinking uses the native
bordered background container. `Dismiss question` is recovery-only for confirmed
unavailable, missing or failed renderers, not a healthy working question action. An unknown
or failed canonical synchronization is **not confirmed unavailability**: retain readable
saved content and a genuine reconciliation **Retry** banner, without a fabricated
Unavailable state or recovery Dismiss action. This distinction passed the separate
question-defaults/navigation checkpoint. Cancellation always has host fallback presentation. See the [verified native-parity checkpoint](./plugin-question-contract.md#13-question-card-native-parity-checkpoint--2026-11-03).

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

Opening geometry is host-owned. During an active opening, the host retargets late editor
or status-size changes from the current visible height over the remaining original
animation time, rather than clipping Thinking until a final height snap. Keep the normal
mount lifecycle: no plugin animation timer, readiness callback or remount workaround is
required. Ordinary typing growth remains unanimated; existing folds and fades are unchanged.

### Host controls, keyboard and dictation

The host retains the card/dock, fold/reveal, submit/dismiss, StatsBar/session metadata,
microphone, model and model-thinking controls. These common controls remain present.
Required `showThinking` controls the host Thinking field, not a nonempty-answer requirement;
it is not model-authored. The existing check ReadingThinking/reveal flow is independent.

The host defaults are now **Enter submits and Shift+Enter inserts a
newline** in both the plugin answer editor and host Thinking. Cmd/Ctrl+Enter remains
reserved host Submit, subject to readiness/IME gates; Shift+Tab still cycles model
thinking. An optional editor `handleKeyDown` may explicitly override an offered editing
key. Returning `"pass"`, or omitting the hook, uses the host defaults: unclaimed plain
Enter submits, rather than silently becoming an editing newline. Handled keys are claimed
once; passed plain Tab enters the private host field chain, never native Tab navigation.
The coding plugin now omits a plain-Enter override while retaining Tab indentation
and Shift+Enter newline indentation, inheriting host Enter-submit.

The native footer hint is **↵ submits · ⇧↵ newline**, with **Submit answer** on the button.
The human explicitly chose a compact **40px minimum Thinking height for every plugin
question variant**, replacing the former 72px teaching minimum. Native browser proof
measured an empty field at 40px with 16px text, three lines at 76px and a 192px maximum.
Composition/229 and covered/hidden/stale scope guards remain unchanged; the host
owns suppression and eligibility, not fabricated keyboard dispatch or plugin DOM inspection.

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
not a new teacher turn or a fabricated Unavailable/Dismiss fallback. Unknown canonical
status retains readable saved content while readiness remains gated.

Navigation recovery now uses private connection-generation task ownership and a
stable-identity effect reconnect read after cleanup. The pre-fix development reproduction
failed on **10/10 pending prediction/check mount returns** despite **all 162 GETs returning
200**: StrictMode cleanup invalidated the read, reconnect could join a dead ownerless task,
and a permanent identity ref prevented replacement. The fix retains stale-read/identity
fences and StrictMode; it does not enable Cache Components. Final current-transcript and
async-initial-publication audit findings were closed by restoring original draft-ownership
guards while retaining canonical editor-admission and Submit gates.

Final development/production proof passed **20 healthy returns/mounts, ten each**, without
Retry/error/false Unavailable/Dismiss on healthy returns; held GETs correctly stayed in
Preparing. Trusted Enter submitted a prediction from code and a check from Thinking;
Shift+Enter worked in both fields, and exact canonical/model thinking channels plus fresh
backend-disable recovery were exercised. Composition guards were tested synthetically,
not with actual OS IME. React Activity lifecycle reproduction remains fixture evidence,
not a claim that this app enables Next Cache Components/Activity. No actual microphone
recording, paid-provider or real-install proof is implied.

Private saved metadata binds a host-minted stable question ID to
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

### Page-body surfaces — implemented and verified

The [generalized-surface checkpoint](plugin-session-extension-contract.md#12-generalized-page-body-surfaces--implemented-and-verified)
is **implemented and verified, uncommitted above `8dd7409` on `feature/plugin-architecture`**.
The existing explicit-native-target overload remains compatible. Its own verification
passed 4,045 host tests / 568 suites, 78 plugin tests, strict SDK/build/privacy gates and
15 packaged-browser assertion groups across seven page variants. Section 12 records
runtime-byte provenance, the bounded test-harness adjustment and proof limits.

`ctx.ui.openSurface({ title, content, background?, onClose? }, { signal })` captures the
active page boundary **once at invocation**: plugin views, native chat, Home or New Draft.
No native target is required. It returns `PluginWidgetHandle<PluginSurfaceProps>` with
standard shallow update/dispose and existing `PluginUiContent`/async cleanup. Async work
never silently retargets to a new page. With live signals and no active boundary, throw
`Surface target is no longer active`; an already-aborted signal returns an inert disposed
handle **before boundary resolution**. Leaving/hiding the page aborts its surfaces;
re-entry creates a new boundary. Mount commit rechecks lifetime; late cleanup runs exactly
once and content replacement cleans up its prior mount.

A `PluginUiContent` callback describes one content mount, not the lifetime of its
owning surface. The host may clean up and invoke it again, including during React's
development-mode effect replay. Each invocation should create fresh DOM and scope its
requests, timers and cleanup to that invocation. A mount-signal abort or returned
cleanup must release that mount's resources without unconditionally disposing the
owning surface or aborting a longer-lived controller. Keep explicit close and caller
or view lifetimes separate. An already-expired invocation should return inertly;
late results or cleanup from an old mount must not remove or mutate its replacement.

For precise native action/submission targeting, keep
`ctx.ui.openSurface(target, surface, { signal })`. Obtain its opaque `PluginSurfaceTarget`
from native top-bar `PluginActionContext.surfaceTarget` or submission context, never a
session ID/selector/DOM parent/global-current inference. The token still identifies one
mounted teaching/practice view; unknown/expired live targets throw the same error and
returning to the same session ID never revives it. No native submission capture, hooks
or public target exposure are extended beyond native chat. Both forms retain plugin
unload, caller-abort and explicit-dispose cleanup.

Surfaces cover **only the owning page body**, leaving native/plugin top bars and sidebar
usable. Home/New Draft have no top bar: only the floating sidebar toggle and window chrome
remain exposed; graph controls and composer are covered/inactive but mounted.
The parent page stays mounted. Stacked covered surfaces stay mounted and painted but
only eligible foreground content receives covered-body interaction. Ordinary stack
entries are visual siblings, **not each other's lifetime owners**: disposing a lower
plugin surface cannot dispose another plugin's foreground surface. Explicit caller
signals may bind lifetimes. Global Settings is not lifetime-owned merely because it
paints above a surface. Dialogs and Settings always remain in front, even if the surface
request happens while a dialog is open. The surface belongs to the page, **not its modal
opener**; it cannot use that opener to gain focus eligibility or Escape ownership. Closing
the dialog can reveal the surface underneath only while the caller signal remains live.

The host uses existing `view` interaction layers/owner propagation, not an app-wide
modal, viewport scroll lock or second overlay registry. Under the approved polish,
`background?: "dimmed" | "opaque"` defaults to `"dimmed"`: the existing Chains-style
80%-background backdrop with blur. `"opaque"` uses a solid background with no blur.
The handle validates this enum on `update(...)` as well as opening. No additional header
or appearance props are authorized.

`title` remains required for the accessible name, but the host renders **no visible title
or header row**. A quiet muted Close/X floats above content independently of scrolling.
Content fills the owning page body, with its scrollbar at the outer edge, not inset by
a host frame. The plugin owns visible headings, internal layout and bottom actions; there
is no forced diagram pan/zoom border. These presentation changes are **implemented and
verified** at the separate UI-polish checkpoint. Existing one-Escape rules apply; covered native inputs never
receive submit/Tab/dictation actions. Exposed page chrome stays usable, without a focus trap.
Generalized page coverage has its own section-12 verification; the earlier polish proof is unchanged.

Entry preserves eligible focus already inside the foreground surface, and remembered
surviving-region focus takes priority on return. Otherwise, a surface can opt in to a
specific entry region with the public **`data-plugin-initial-focus`** DOM marker. The host
queries the current content afresh and tries the first eligible marked element before
its automatic editable-field, genuine-heading and painted-frame fallbacks. For example,
inside a content mount:

```js
const region = document.createElement("section");
region.tabIndex = -1;
region.setAttribute("data-plugin-initial-focus", "");
region.setAttribute("role", "group");
region.setAttribute("aria-label", "Review card");
region.textContent = "A visible question"; // Replace with your actual visible content.
container.append(region);
```

Mark a **real, visible, focusable content region**, not a hidden/fake heading. The marker
does not add `tabindex` or make a plain div focusable. Hidden, inert or disabled candidates
are skipped; if the first eligible candidate cannot actually receive focus, the existing
automatic fallbacks remain. This opt-in applies to `openSurface` entry only—not dialogs
or native/owning-page entry. It does not force focus on updates, observe later DOM changes
or retry asynchronous content. Mount the entry region synchronously; only the active
surface may enter, without stealing focus from Settings, dialogs or newer foreground
views. Unmarked surfaces retain their existing entry behavior.

Delayed covered mounts do not steal focus. Closing foreground restores an eligible
uncovered opener (including chrome), else surviving foreground remembered focus/entry
policy, or owning-page-body policy when no surfaces remain. Covered disposal never steals
focus; expired views never receive focus restoration. `onClose` is a close notification,
not an async veto; programmatic dispose/abort keep normal handle semantics.

### Deferred extension points

This increment adds no message/card/composer slots, generic rich-transcript renderer,
backend submission hooks, native send/steer API, mutable agent/event/context hooks, image
picker/clipboard/drop importer, path inference, asset store or image export redesign.
Alternate surface regions (including transcript-only) and navigation suspension/restoration
remain deferred; the approved targetless overload adds page-body coverage only, not
submission interception or native tokens for plugin/Home/New Draft pages. Existing tools/question renderers
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

The approved default remains a **collapsed result**, not an always-expanded standalone
card. The current UI polish changes the plugin worker shell only: its visible header is
**status icon plus label**, without a Background prefix or raw status text. Collapsed
results use a chevron, without **View result / Hide result** text. Full status remains
accessible and available in a tooltip; failure uses the native failure X. The host owns
this shell and formatter errors outside the custom body. Existing native Research/PDF
disclosure grammar is **not** redesigned. All twelve terminal-status/presentation combinations
passed the packaged UI-polish proof, including actual accessible hover-tooltips.
For host-delivered later results,
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
