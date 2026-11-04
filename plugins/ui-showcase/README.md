# UI Showcase

A frontend-only LearnHarness plugin demonstrating **all 14 public `ctx.ui` methods** across **12 families** in one scrollable, host-themed gallery, plus a real native-session surface demo. No backend, runtime dependencies, storage, workers or model generation are used.

## Requirements

- The current **`feature/plugin-architecture`** LearnHarness checkout with the public Tree, Markdown, knowledge-picker and native session-surface APIs. These additive API v1 capabilities are not a released-version compatibility promise.
- Manifest: API version **1**, minimum app version **0.4.1**. The version number alone does not prove these feature-branch methods exist. Activation checks all 14 UI methods (including `mountTree`) and required registrations and fails with an explicit missing-capability error; there is no copied or hand-rolled fallback.
- Node/npm for development only. LearnHarness does not run npm when loading the built plugin.

## Build

From this directory:

```sh
npm run sdk
npm ci --ignore-scripts
npm run typecheck
npm run build
```

`npm run sdk` generates a local **type-only** public API tree in `.sdk/` using the repository's SDK generator. Generate it before the first install. For dependency development, use `npm install --ignore-scripts` instead of `npm ci` when deliberately updating `package-lock.json`. Root dependencies are unchanged.

The installable package is **`dist/ui-showcase/`**, containing `manifest.json`, `main.js`, `styles.css`, this README and the license. It contains no backend, SDK declarations, source, tests, development dependencies or data. The build verifies that only plugin source files enter the JavaScript bundle. `.sdk/`, `node_modules/`, `dist/` and `data/` are ignored.

To try it, copy the **built `ui-showcase` folder**, not this source project, into a deliberately chosen LearnHarness plugins directory, refresh Settings → Plugins, and enable **UI Showcase**. For verification use a temporary app data directory with synthetic data, never your real installed plugins or learning records. No installation is performed by the build.

## Use

- Choose **UI Showcase** in the sidebar. The host supplies the top-bar title; the plugin supplies only the gallery body.
- Every family has a **Reset** button. Values, accepted drafts and callback readouts are local to that mounted family. Reset remounts just that family's widgets and closes its owned overlays. Leaving the view clears its state.
- Pick real catalog models or knowledge nodes. The model and thinking controls are linked only within their own family. Their triggers use the same compact UI typography as native controls. The standard composer's model, thinking and draft are independent of the standalone examples. Changing a local model clears its local thinking choice.
- The standalone composer is the intentionally bare input row. The standard preset adds the native-style bordered text frame, with dictation/model/thinking controls **below and outside** that border. Explanatory text follows the configured reading font/size; family headings use compact settings-section styling.
- Send enters a **local simulation** and retains your draft. While busy with a nonempty draft, the host keeps Send available for steering. Clear the draft to expose **Stop**, or use **Complete simulation**, which is available throughout the busy state. This applies to both composer examples; nothing is submitted to a native conversation or model.
- **Start async example** returns an actually pending callback Promise. **Complete async example** resolves it. The host button currently does not automatically show a pending or disabled style while that Promise awaits; the pending readout and completion control are local to this demo. Reset, navigation or plugin disable also releases the pending Promise; no timer is used.
- In an actual teaching or practice session, choose **UI Showcase surface** in its native top bar. This passes the actual opaque `context.surfaceTarget` directly to `openSurface`; the gallery cannot invent a target. Open the nested surface to test retained parent text, and open menus/dialogs above either surface. Dialog/surface titles are accessible names, not automatic visible heading rows. The quiet X floats above scrolling content without consuming layout space; plugins own visible headings and bottom actions. The host still owns Escape routing and focus behavior.
- Switch **Dimmed background** / **Opaque background** in the surface example. These call the public `background: "dimmed" | "opaque"` option; Reset restores the dimmed, Chains-like translucent/blurred default without remounting the surface. The example content does not paint an opaque layer over the chosen treatment.
- **Directory / tree** is a small synthetic fixture rendered by `mountTree`, not a source-management view. Both folders start expanded. The same **Shared item** has a distinct occurrence key in each folder; selection is independent, including parent rows, and never cascades. **Enable selection** shows the host checkboxes; **Disable selection** hides them without clearing their values. Click a row for the host's arrow/row navigation and use Space for an enabled host checkbox. The **Directory draft** input keeps its editing keys; its local value survives collapse/re-expand through a stable content factory. This family's Reset clears selection and draft and expands both folders without changing siblings. The two compact **Kind**/**State** columns are host-rendered; the caller owns the horizontal scroller and 36rem minimum width, not a responsive layout engine. Nothing is persisted.
- Knowledge selection is also available inside an ordinary dialog and the parent surface. Page/surface origins use a main-pane view that leaves the sidebar visible and interactive; a dialog/Settings origin uses a full-viewport modal. Leaving an originating page closes its picker. A live modal's picker belongs to that modal, not an unrelated background route.

## Safety boundaries

**Local selection is not a sandbox for the host picker.** The knowledge example displays this warning:

> Selection stays local to this demo. The host picker also offers source-management actions; those affect your real sources.

The picker is the actual host picker, with its normal controls intact. This plugin does not call any learning-data API or write the graph, core defaults or settings. Choosing model/thinking/node values changes only plugin-local controlled values. However, explicit source-management actions inside the host picker retain their real host effects. Use synthetic data when exercising them.

**Dictation is real and opt-in.** Choosing **Dictate** or a host microphone explicitly starts the normal dictation service, using your configured speech provider. It may send audio to that provider and incur cost. Mounting or resetting the gallery never starts recording. No recording state is fabricated. Transcript callbacks update only local demo state/drafts. The standard composer uses the host's normal finish-and-await-final-delivery behavior before its Send callback; the standalone dictation example exposes **Finish dictation** separately. Cancel/disposal is scoped through that control's host handle; no global dictation service, keyboard handler or other owner's recording is touched.

There are no model requests, provider setup changes, backend operations, persistence, worker starts, remote images or plugin-created network calls. The real catalog and knowledge controls may load host data normally, and explicitly started dictation uses the configured host service. Markdown is static, including a local Mermaid diagram; it contains no remote resources.

All widgets use per-mount abort signals. Reset/abort disposes owned widgets, overlays and pending asynchronous scopes. Native targets are not serialized, inferred from session IDs, or retained for later navigation. Nested surface lifetimes are explicitly bound to their demo parent; independent host/global surfaces are not disposed. No global key handlers or focus overrides are installed.

## Coverage

| Gallery family | Public API and examples |
| --- | --- |
| Pickers | `mountModelPicker`, `mountThinkingPicker`, `mountKnowledgePicker`; real host catalogs/data, local controlled selection |
| Composer | `mountComposer`; draft callbacks, local Send/Stop/busy/completion |
| Dictation | `mountDictation`; explicit toggle, finish, cancel, transcript readout |
| Standard composer | `mountStandardComposer`; independent state, linked local model/thinking, real optional dictation |
| Buttons | `mountButton`; all 6 variants, all 8 sizes, descriptive icon titles, disabled, manually completable async callback with local pending readout |
| Settings rows | `mountSettingsRows`; toggle, text, dropdown, number, slider; descriptions, text/integer/range validation, disabled example |
| Markdown | `mountMarkdown`; prose/list, TypeScript code, table, inline/display math, Mermaid |
| Directory / tree | `mountTree`; synthetic folders, repeated logical item with unique occurrence keys, optional independent controlled selection, host arrow/row navigation, rich draft lifecycle, Kind/State metadata and caller-owned horizontal scrolling |
| Worker results | `mountWorkerResult`; succeeded/failed/cancelled/interrupted × collapsed/card/plain, 12 static examples, zero workers |
| Menus | `openMenu`; enabled/disabled items, local selection, preferred up/down side |
| Dialogs | `openDialog`; ordinary, long-scroll and nested, accessible names, floating X, retained local text and modal-origin knowledge selection |
| Session surfaces | `openSurface`; native top-bar target, accessible name/floating X, dimmed/opaque backgrounds, nested retained parent, pane-origin knowledge selection and menu/dialog layering |

## Development and verification

```sh
npm run typecheck
npm test
npm run build
LH_POLISH_BUILD_READY=1 \
LH_APPROVED_HOST_DIGEST=<approved-standalone-tree-sha256> \
LH_STANDALONE=/path/to/verified/.next/standalone npm run test:native
```

The test harness is kept in `tests/`. Native verification requires `LH_POLISH_BUILD_READY=1`, the exact separately approved standalone tree digest in `LH_APPROVED_HOST_DIGEST`, and `LH_STANDALONE` pointing to that already built and verified payload. The runner rejects the earlier pre-polish host. A built plugin alone is not a running host. Native verification must use only temporary synthetic app data and must not start real speech recording, contact paid providers or run model generation. Follow the harness's prerequisite/environment instructions. A simulated API test is not evidence of actual native host rendering or Escape/focus behavior.

### Verified Directory / tree checkpoint — 2026-11-04

Strict TypeScript, all **23 plugin tests**, and the plugin build pass for the **14-method/12-family** gallery. The added unit checks cover required Tree capability detection, controlled occurrence-local selection without cascade, preservation when hiding selection, stable rich-content identity and draft restoration after collapse, family-local Reset, abort/stale-callback cleanup, and public SDK types. The unit recorder mounts only plugin-owned content lifetimes; it does not simulate native tree controls, layout or keyboard navigation.

The literal **`npm run test:native` passed** against the approved packaged host, covering **11 assertion groups and 14 screenshots**, including all five directory states. Actual native controls demonstrated optional selection/no gutter, independent repeated occurrences and parent selection, hide/re-enable preservation, stable rich DOM/drafts through updates, controlled collapse/reopen, native arrows/Space, editable-input isolation, unchanged global Tab, exact metadata boundaries, caller-owned horizontal scrolling, isolated Reset and expired controls after navigation. Existing picker, composer, slider, worker-result, overlay and native-session-surface regressions also passed.

Evidence: `/private/tmp/lh-ui-showcase-native-Yu2cEV/{result.json,proof-summary.json,literal-entrypoint-proof.json,final-byte-comparison.json}`. The exercised host digest was `dcfed5d65a68faacd6cc3026f13d74bfc0aeed9988889d4fea1fd71810d1ae4f`; the pre-document-closeout showcase package digest was `700b9b9db189cd93124f765a5e721ec93af57b78be6bacd12fb9d1f742cb0853`. All **5,545 host files and 5 plugin files** matched the exercised copies. Settings and the original preboot synthetic graph baseline remained unchanged; page errors, off-origin requests, microphone attempts, generation calls and WebSockets were all zero. One expected picker-close read cancellation was recorded. Precisely identified successful router-prefetch cancellations are retained separately by the harness, not treated as API/page/provider failures; the final run needed none.

This directory example was gallery-mounted; the existing session-surface example was verified separately. Microphone recording and OS IME were not tested, and simulated window-control CSS geometry is not physical Windows/Linux chrome verification. No live-profile installation, push or release is implied.

### Verified UI-polish checkpoint (historical)

Strict TypeScript, all **17 plugin tests**, and the expanded packaged Electron-Node/Chrome proof passed against the updated host. The native proof covers continuous slider dragging on the same enabled node, all twelve worker outcome tooltips, typography/composer layout, headerless overlays and pinned close controls, dimmed/opaque surfaces, eleven contextual-picker origin/geometry cases, covered-field command isolation, nested ownership/focus and disable cleanup. Settings, synthetic knowledge and the approved host payload remained unchanged; no generation, off-origin request, microphone request, WebSocket or page error occurred. Windows/Linux clearance checks simulate CSS geometry, not physical OS chrome. Microphone recording and OS IME are not tested. Reverse programmatic surface-over-picker ordering is covered by host integration tests, not an invented visible browser flow.

Source modules:

- `src/main.ts`: capability checks and sidebar/native top-bar registrations.
- `src/gallery.ts`: `mountGallery(root, ctx, signal)` and exported `FAMILY_IDS`.
- `src/surfaces.ts`: native-target surfaces and real menu/dialog demos.
- `src/tree.ts`: the controlled synthetic directory fixture, independent selection and family-local rich draft.
- `src/dom.ts`: plugin-owned layout/readouts and scoped cleanup.
- `src/styles.css`: plugin-specific layout/text classes only; no host-widget selectors or restyling.

Stable test selectors: `[data-showcase="gallery"]`, `[data-family="<family>"]`, `[data-example="<semantic-id>"]`, `[data-state="<family>"]`. Reset buttons are inside `[data-example="reset-<family>"]`. The directory uses `[data-example="tree"]`, `[data-example="toggle-tree-selection"]`, `[data-state="tree"]` and `input[aria-label="Directory draft"]`. Its readout contains `selectionEnabled`, `selectedOccurrenceKeys`, `expanded`, `draft` and `lastCallback`. Native surfaces use `data-showcase="surface"` and `"surface-nested"`; dialogs use `"dialog-ordinary"`, `"dialog-long"`, and `"dialog-nested"`.

## Limits

**Host API polish candidate:** `mountButton` does not currently provide automatic pending/disabled visual feedback for an asynchronous callback. This gallery records that limitation rather than implementing replacement button behavior or claiming native busy styling. No host fix is included.

This is a public-API gallery, not a component redesign, persistence layer, model playground, worker runner, or generalized host extension. It does not alter native Escape/Tab/focus policy, host picker source-management capabilities, or host widget appearance. Missing catalogs, empty knowledge data, microphone permission/provider errors, and host API behavior are shown by the real host controls, not replaced with fake fixtures. Any host defect found while using these examples should be recorded separately rather than patched or hidden by the plugin.
