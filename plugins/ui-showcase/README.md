# UI Showcase

A runnable **Community developer gallery**, not a Core plugin. This frontend-only
LearnHarness plugin demonstrates **all 15 public `ctx.ui` methods** across **12 families**
in one scrollable, host-themed view, including page-body and explicit native-target
surfaces. It has no backend, runtime dependencies, storage, workers or model generation.

## Requirements

- A matching LearnHarness host with the public Tree, Markdown, knowledge-picker and
  surface APIs, including targetless `openSurface(surface, { signal })`.
- Manifest API version **1** and the declared minimum app version are necessary but
  do not prove individual capabilities exist. Activation checks all 15 UI methods and
  required registrations and fails with an explicit missing-capability error; there
  is no copied or hand-rolled fallback. The presence of `openSurface` alone does not
  establish support for its targetless overload.
- Node/npm and dependencies are development prerequisites only. LearnHarness does not
  run npm when loading the built plugin.

## Development and Community installation

In the extracted authoring kit, copy the shared **kit-root `types/` contents** into
`.sdk/` **before dependency setup**. From `plugins/ui-showcase/`:

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

In a LearnHarness source checkout instead, `npm run sdk` generates `.sdk/` via
`../../scripts/build-plugin-types.mjs`. That command is **checkout-only**; the extracted
kit does not include the host generator. SDK imports are type-only.

Set up development dependencies separately, including the SDK's declared
peer dependencies/types. With dependencies already available, the build-only command is:

```sh
npm run build
```

The build writes directly to **`dist/`**, containing `manifest.json`, `main.js`,
`styles.css`, this README and the license. It verifies that only plugin source files
enter the JavaScript bundle. It includes no backend, SDK, source, tests, development
dependencies or data. The complete source project in the authoring kit is distinct
from this runtime output.

For in-place development, put the source project at `<plugins-directory>/ui-showcase/`
using the path shown in **Settings → Community plugins**, prepare dependencies and
build there. Alternatively copy the contents of the local built `dist/` into
`<plugins-directory>/ui-showcase/dist/`. The host needs `ui-showcase/dist/manifest.json`,
not a root-only manifest or nested `dist/ui-showcase/`. Refresh the list and enable
**UI Showcase**; restart LearnHarness after changing already-loaded code. No separate
development registration is needed. Building does not install or enable the gallery.
Cleanup replaces only `dist/`, refuses symlinked `dist/` or misplaced `dist/data/`,
and preserves sibling `data/`. Never distribute persistent data. Use a temporary
synthetic learning profile for development, not real installed plugins or records.

## Use

- Choose **UI Showcase** in the sidebar. The host supplies the top-bar title; the plugin supplies only the gallery body.
- Every family has a **Reset** button. Values, accepted drafts and callback readouts are local to that mounted family. Reset remounts just that family's widgets and closes its owned overlays. Leaving the view clears its state.
- Pick real catalog models or knowledge nodes. The model and thinking controls are linked only within their own family. Their triggers use the same compact UI typography as native controls. The standard composer's model, thinking and draft are independent of the standalone examples. Changing a local model clears its local thinking choice.
- The standalone composer is the intentionally bare input row. The standard preset adds the native-style bordered text frame, with dictation/model/thinking controls **below and outside** that border. Explanatory text follows the configured reading font/size; family headings use compact settings-section styling.
- Send enters a **local simulation** and retains your draft. While busy with a nonempty draft, the host keeps Send available for steering. Clear the draft to expose **Stop**, or use **Complete simulation**, which is available throughout the busy state. This applies to both composer examples; nothing is submitted to a native conversation or model.
- The **Buttons** family also includes neutral, green, red and amber badges using `mountBadge`. Text and one CSS color are plugin-controlled; the host supplies the native shape/typography and 15% background tint. These static examples do not run grading or tests.
- **Start async example** returns an actually pending callback Promise. **Complete async example** resolves it. The host button does not automatically show a pending or disabled style while that Promise awaits; the pending readout and completion control are local to this demo. Reset, navigation or plugin disable also releases the pending Promise; no timer is used.
- In **Surfaces**, choose **Open surface** to call `ctx.ui.openSurface(surface, { signal })` directly from the gallery. This captures its active page boundary once; no native-session target is required or invented. The targetless overload also supports native chat, Home and New Draft. Leaving/hiding the owning page aborts the surface; returning creates a new boundary, not a restored surface.
- In an actual teaching or practice session, choose **UI Showcase surface** in its native top bar. It passes the actual opaque `context.surfaceTarget` to `openSurface(target, surface, { signal })`. The top-bar button toggles that page's showcase surface: click again to close it and its nested examples, rather than stacking another copy. X/Escape also close it; the next click opens fresh. Navigation retires the page target, so returning starts fresh. **Open nested surface** stacks intentionally, retaining parent text and menu/dialog examples. Dialog/surface titles are accessible names, not automatic visible heading rows. The quiet X floats above scrolling content without consuming layout space; plugins own headings and bottom actions. The host owns Escape routing and focus behavior.
- Surfaces cover only the page body; native/plugin top bars and sidebar remain usable. Home/New Draft preserve only their floating sidebar toggle and window chrome; graph controls/composer remain mounted but covered/inactive. Dialogs and Settings always stay in front, even if a surface is requested while a dialog is open. The surface belongs to its page, not the modal opener, and cannot gain focus/Escape eligibility through that opener; it can be revealed after the dialog closes only if its caller signal stays live.
- Switch **Dimmed background** / **Opaque background** in the surface example. These call the public `background: "dimmed" | "opaque"` option; Reset restores the dimmed, translucent/blurred default without remounting the surface. The example content does not paint an opaque layer over the chosen treatment.
- **Directory / tree** is a small synthetic fixture rendered by `mountTree`, not a source-management view. Both folders start expanded. The same **Shared item** has a distinct occurrence key in each folder; selection is independent, including parent rows, and never cascades. **Enable selection** shows host checkboxes; **Disable selection** hides them without clearing values. Click a row for the host's arrow/row navigation and use Space for an enabled host checkbox. The **Directory draft** input keeps its editing keys; its local value survives collapse/re-expand through a stable content factory. Reset clears selection and draft and expands both folders without changing siblings. The compact **Kind**/**State** columns are host-rendered; the caller owns the horizontal scroller and 36rem minimum width, not a responsive layout engine. Nothing is persisted.
- Knowledge selection is also available inside an ordinary dialog and the parent surface. Page/surface origins use a main-pane view that leaves the sidebar visible and interactive; a dialog/Settings origin uses a full-viewport modal. Leaving an originating page closes its picker. A live modal's picker belongs to that modal, not an unrelated background route.

See the [surface contract](../../docs/plugin-session-extension-contract.md#8-public-surface-contract)
for targetless and explicit-target lifecycle rules; these are overloads of one method,
not separate UI families.

## Safety boundaries

**Local selection is not a sandbox for the host picker.** The knowledge example displays this warning:

> Selection stays local to this demo. The host picker also offers source-management actions; those affect your real sources.

The picker is the actual host picker, with its normal controls intact. This plugin does
not call any learning-data API or write the graph, core defaults or settings. Choosing
model/thinking/node values changes only plugin-local controlled values. However,
explicit source-management actions inside the host picker retain their real host
effects. Use synthetic data when exercising them.

**Dictation is real and opt-in.** Choosing **Dictate** or a host microphone explicitly
starts the normal dictation service, using your configured speech provider. It may send
audio to that provider and incur cost. Mounting or resetting the gallery never starts
recording. No recording state is fabricated. Transcript callbacks update only local
demo state/drafts. The standard composer finishes dictation and awaits final delivery
before its Send callback; the standalone example exposes **Finish
dictation** separately. Cancel/disposal is scoped through that control's host handle;
no global dictation service, keyboard handler or other owner's recording is touched.

There are no model requests, provider setup changes, backend operations, persistence,
worker starts, remote images or plugin-created network calls. Real catalog/knowledge
controls may load host data normally, and explicitly started dictation uses the
configured host service. Markdown is static, including a local Mermaid diagram;
it contains no remote resources.

All widgets use per-mount abort signals. Reset/abort disposes owned widgets, overlays
and pending asynchronous scopes. Native targets are not serialized, inferred from
session IDs, or retained for later navigation. Nested surface lifetimes are bound to
their demo parent; independent host/global surfaces are not disposed. No global key
handlers or focus overrides are installed.

## Gallery map

| Gallery family | Public API and examples |
| --- | --- |
| Pickers | `mountModelPicker`, `mountThinkingPicker`, `mountKnowledgePicker`; real host catalogs/data, local controlled selection |
| Composer | `mountComposer`; draft callbacks, local Send/Stop/busy/completion |
| Dictation | `mountDictation`; explicit toggle, finish, cancel, transcript readout |
| Standard composer | `mountStandardComposer`; independent state, linked local model/thinking, real optional dictation |
| Buttons | `mountButton`; all 6 non-custom variants, all 8 sizes, icon titles, disabled and manually completable async callback; `mountBadge` with neutral and three custom colors |
| Settings rows | `mountSettingsRows`; toggle, text, dropdown, number, slider, descriptions, validation and disabled example |
| Markdown | `mountMarkdown`; prose/list, TypeScript code, table, inline/display math, Mermaid |
| Directory / tree | `mountTree`; occurrence-local selection, host navigation, rich draft lifetime, metadata and caller-owned horizontal scrolling |
| Worker results | `mountWorkerResult`; succeeded/failed/cancelled/interrupted × collapsed/card/plain, static examples with zero workers |
| Menus | `openMenu`; enabled/disabled items, local selection, preferred up/down side |
| Dialogs | `openDialog`; ordinary, long-scroll and nested, accessible names, floating X, retained local text and modal-origin knowledge selection |
| Surfaces | `openSurface`; direct gallery and explicit native top-bar target, nested retained parent, background choices, pane-origin knowledge selection and menu/dialog layering |

## Tests and boundaries

After SDK/dependency setup, these checks use only the plugin project:

```sh
npm run typecheck
npm test
npm run build
```

Unit tests use a DOM fixture and controlled UI recorder to exercise activation,
family-local Reset, callbacks, drafts, tree state, surface ownership and cleanup.
They do not establish native layout, keyboard, Escape or focus behavior.

`npm run test:native` additionally requires built gallery files, an already built
matching standalone host in `LH_STANDALONE`, its exact `LH_APPROVED_HOST_DIGEST`,
`LH_POLISH_BUILD_READY=1`, local Chrome and an Electron Node runtime (checkout default
or `LH_NODE_RUNTIME`). Read [`tests/isolated.mjs`](tests/isolated.mjs) and
[`tests/native.mjs`](tests/native.mjs) before running this maintainer harness.
The exported project alone does not supply that host/runtime. The harness copies
host/package files into disposable storage and uses synthetic records and loopback
fixtures, not real learner profiles. Do not start real speech recording, paid-provider
calls or model generation. This is not physical Electron-window, real microphone/IME,
installer or cross-platform acceptance.

## Source reading route

- [`src/main.ts`](src/main.ts): capability checks and sidebar/native top-bar registrations.
- [`src/gallery.ts`](src/gallery.ts): `mountGallery` and `FAMILY_IDS`; start here for the 15 UI methods.
- [`src/surfaces.ts`](src/surfaces.ts): page-body/native-target surfaces, menus/dialogs and nested ownership.
- [`src/tree.ts`](src/tree.ts): controlled synthetic directory, independent selection and rich drafts.
- [`src/dom.ts`](src/dom.ts): plugin-owned layout/readouts and scoped cleanup.
- [`src/styles.css`](src/styles.css): plugin layout/text classes, not host-widget restyling.
- [`scripts/build.mjs`](scripts/build.mjs) and [`tests/`](tests/): source-only bundling and fixtures.

Stable test selectors: `[data-showcase="gallery"]`, `[data-family="<family>"]`,
`[data-example="<semantic-id>"]`, `[data-state="<family>"]`. Reset buttons live in
`[data-example="reset-<family>"]`. The directory uses `[data-example="tree"]`,
`[data-example="toggle-tree-selection"]`, `[data-state="tree"]` and
`input[aria-label="Directory draft"]`; its readout exposes `selectionEnabled`,
`selectedOccurrenceKeys`, `expanded`, `draft` and `lastCallback`. Surface values are
`data-showcase="surface"` / `"surface-nested"`; dialogs use `"dialog-ordinary"`,
`"dialog-long"` and `"dialog-nested"`.

See the [example map](../../docs/plugin-examples.md),
[authoring guide](../../docs/plugin-authoring.md) and
[API reference](../../docs/plugin-api/README.md).

## Limits

`mountButton` does not provide automatic pending/disabled visual feedback for an
async callback. This gallery shows that limitation rather than implementing a
replacement button or claiming native busy styling.

This is a public-API gallery, not a component redesign, persistence layer, model
playground or worker runner. It does not alter native Escape/Tab/focus policy, host
picker source-management capabilities or host-widget appearance. Missing catalogs,
empty knowledge, microphone/provider errors and host API behavior are shown by the
real controls, not replaced with fake fixtures. Report host defects separately
rather than patching or hiding them in the plugin.

## License

AGPL-3.0-only; see [`LICENSE`](LICENSE).
