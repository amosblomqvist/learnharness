# Dialog, popup, and interaction contract

> **Commit closeout — 2026-11-04:** The verified UI-polish, question-card, native-default/reconnection and opening-animation changes are included in this feature-branch commit, together with Coding Questions and UI Showcase. “Uncommitted” notices below retain their original verification-time status; this note supersedes them for the current Git state. No push or release is implied.

**Status:** Human-approved contract (approved 2026-11-01), implemented and verified 2026-11-02. The behavior decisions below are authoritative. The pre-migration checkpoint is `2c44868`; verification does not imply a subsequent commit, push or release.

## Purpose and preservation boundary

Standardize the application's interaction infrastructure without redesigning its existing surfaces or changing their domain workflows. Core UI and plugin UI use the same foundation.

Preserve current typography, spacing, dimensions, position, frame/scrim classes, content, labels, buttons, menu positioning, search/arrow behavior, mutation sequencing, and established flow-specific close actions except for the subsequent human-approved UI-polish amendment below. Do not substitute a library theme. A difference between two flows is not automatically a defect.

**Subsequent approved UI-polish amendment — implemented and verified, uncommitted:** public plugin dialogs and session surfaces no longer reserve a visible host title/header row. Their required title supplies the accessible name; a quiet muted corner X floats above edge-aligned scrolling content. Plugins own visible headings and bottom actions. Surface content fills the session-body bounds, with `background?: "dimmed" | "opaque"` (`"dimmed"` preserves the Chains-like translucent/blurred default). Context-sensitive knowledge-picker bounds below supersede the original always-modal presentation. These approved presentation changes do not alter leaf-first Escape, focus ownership, covered-parent retention, domain operations or close guards. The original migration and the later amendment have separate verification checkpoints below.

The checkpoint includes a **provisional picker-specific foreground experiment**. Its hidden-parent presentation, independent activation ordering, and special-case routing are not the preservation baseline. Replace that experiment with the common contract rather than extending it.

No changes to background-worker admission, model request classification, plugin trust, learning-data permissions, or flashcard product behavior belong to this migration.

## Human-approved interaction decisions

### Escape: one event, one owner

Only the topmost active interaction responds to a physical Escape event. This includes a focused editor that already owns Escape, a menu above a dialog, or a child dialog above its parent.

- Give leaf handlers their normal opportunity to handle the event before dismissing a containing surface.
- A handled Escape cannot also dismiss a parent, cancel dictation, or abort a turn.
- Snapshot the owning surface at the start of the event. Closing it must not make the newly exposed surface eligible for that same key.
- A top surface that refuses dismissal still consumes Escape; it does not pass dismissal to a lower surface.
- Existing explicit editor cancellation remains intact, including source/folder/session renaming.
- Do not introduce a generic search-clear-first rule: model/provider/font/language menus currently close; sidebar search retains its query and leaves the field.

### Passive tooltips

Tooltips are passive help, not Escape-owning interaction layers. They must not consume or intercept Escape before a focused field, menu, dialog, or the normal fallback action. Preserve their existing visual appearance, delay, positioning, hover/focus behavior and accessibility relationships; associate their portal with the owning modal so they remain visible above that modal's frame. Do not register a tooltip as a modal, popup or content-view interaction owner.

### Tab: no native navigation

Native browser Tab and Shift+Tab navigation remains disabled, including inside dialogs and popups.

Preserve existing explicit application bindings and their applicable scope:

- Plain Tab: the existing forward field-cycle action or the question-choice row/thinking action.
- Shift+Tab: the existing thinking-level cycle.
- Shortcut rebinding: Tab can still be recorded as a binding candidate.

Do not let a modal primitive add boundary looping. Do not dispatch an explicit action into covered fields or a covered thinking control. Prevent native defaults without suppressing normal target-handler propagation.

### Settings fields: Escape retains and commits

Escape in a focused settings text/number field:

1. Claims that Escape event.
2. Leaves the field using its normal blur/save path.
3. Saves a valid value using the existing domain validation and normalization.
4. Does not discard the typed value and does not close Settings.

Invalid values must not be persisted. Retain an unsuccessful draft rather than erasing it merely because Escape was used; retain existing validation/error presentation. After an accepted save, display the acknowledged canonical stored value, including established normalization/clamping behavior.

A subsequent Escape outside the field can close Settings. This policy does not redefine explicit rename/cancel workflows.

Credential/custom-provider editors retain their explicit Save workflow: Escape does not save credentials automatically. Preserve their established editor-first ordering even when focus is elsewhere in Settings, after a focused leaf or a higher menu has had its turn. Escape folds the expanded editor without closing Settings. Unsaved drafts survive that folding, including switching between provider editors, until Settings closes. Preserve each existing explicit Save/Cancel action's domain semantics rather than normalizing them all.

If a successful settings response lacks a valid canonical saved-settings record, use the existing inline error area with the approved wording: “Could not confirm saved settings. Your input has been kept.” Existing HTTP/network error wording is unchanged.

Acknowledged-save authority persists across Settings close/reopen. A late older response must not replace a newer acknowledged canonical snapshot or its live appearance; the newest accepted full snapshot applies its appearance slice regardless of which section was written. A pending save completing after reopen updates the current Settings instance. Older Settings/startup appearance GET results must not undo an already acknowledged save. Fresh loads still read the server normally.

### Initial focus and return

Preserve existing explicit initial-focus targets. Where a modal has no explicit target:

1. Focus the first eligible editable text/number field, if one exists.
2. Otherwise focus its eligible content heading programmatically, if present.
3. With no eligible field or content heading, focus the accessible modal boundary or painted surface frame—not the close action. Headerless surfaces must not try to focus a non-rendering `display: contents` wrapper.

Exclude disabled, read-only, hidden, or inactive controls. Do not default to an action button. This does not enable Tab navigation.

Closing a child modal returns focus to its eligible invoking element in the resumed parent. Detached, disabled, hidden, or superseded targets cannot steal focus. If the target no longer exists, use the active surface's approved initial-focus policy. Retain existing explicit popup focus-return behavior rather than silently normalizing every popup.

### Nested modal parents

Opening a child modal does not close, remount, or apply `display: none` to its parent. Parents remain painted underneath and retain their state and scroll position. Only the active modal and its owned interactive children receive interaction/accessibility access.

This is interaction isolation, not automatic visual hiding. A child can naturally cover part or all of its parent.

### Busy operations and close guards

Deletion confirmations for sources/folders, sessions, and nodes remain open while deletion is in progress when Escape is pressed. They consume the event. This aligns Escape with their disabled Cancel/backdrop dismissal paths.

Do not generalize that rule from a variable named `busy`:

- Abort/dismiss confirmation's busy state describes an underlying turn, not a dismissal lock.
- Setup retains its existing dismissibility.
- Provider connection callbacks retain their existing refusal, confirmation-back, and OAuth-cancellation behavior.

Closing a UI surface does not implicitly cancel an accepted source write or other domain operation. Preserve existing ownership and cancellation contracts.

### Settings singleton and return-to navigation

There is one Settings instance.

- If Settings is not open, open it above the current surface without discarding that surface.
- If Settings is already below child layers, returning to it requests closure of those intervening layers from the top down, through their normal close callbacks.
- Respect every close restriction. Stop if a layer refuses, handles the request without closing, or starts asynchronous cancellation and remains open.
- Invoke each close callback at most once per request. Do not force cancellation, spin until a layer disappears, or queue a later surprise navigation.
- Retarget the existing Settings instance only when return-to succeeds. Preserve its existing section/deep-link semantics and state.

A layer's visual position is not its lifetime ownership. For example, unloading a plugin dialog beneath global Settings must not automatically destroy Settings.

## Classification and existing surfaces

| Family | Members | Migration treatment |
| --- | --- | --- |
| Modal dialogs | Settings; setup; source/folder/session/node deletion; abort/dismiss confirmation; provider connection; public plugin dialogs; keyboard cheat sheet | Shared modal shell/ownership; existing body and visuals preserved. |
| Anchored menus/popups | Model, thinking, provider, font, language, session/graph context menus, plugin overflow/menu; graph/statistics/coverage/metadata panels | Shared interaction ownership and popup infrastructure; preserve current geometry, search/arrow navigation, outside-pointer, scroll-close, success/failure, and explicit restoration rules. |
| Content-area views | Existing Graph/Practice Chains browser, expanded diagrams/figures, expanded full plan | Preserve current bounds, sidebar interaction and visuals. Register interaction ownership without viewport-modal isolation. Correct misleading modal semantics without changing presentation. |
| Inline/noninteractive UI | Activity disclosure, notifications/update banner, drag preview | Do not make these modal layers. |

### Plugin menu repeated-anchor toggle

Subsequent human-approved amendment: within the same plugin UI owner, repeated
`openMenu` calls for the exact same anchor element toggle the existing menu closed,
synchronously even before React mounts it. Closing invokes the existing menu's latest
`onClose` once and returns an inert handle for the repeated call; its incoming props
and callback do not create a new menu. Different owners and anchors retain their
existing behavior. Outside clicks (including another button), action dismissal,
Escape-only anchor focus return and error/async behavior are unchanged. Caller,
plugin and owning-surface expiry or explicit disposal clear the anchor registration
without synthesizing `onClose`; stale handles cannot affect a later menu.

### New plugin knowledge picker

The picker reuses the existing Chains interface and translucent/blurred appearance. The later human-approved presentation is origin-sensitive: opening from a plugin/native page or session surface uses a main-content-pane `view`, excluding the sidebar and leaving sidebar interaction available, like native Chains. Opening from a dialog, Settings or another modal ancestor uses the full-window modal presentation, with its painted parent and background/sidebar inactive. The host captures the actual invocation owner and bounds; plugins do not guess a context or supply a public origin option. Navigation away from an originating page or expiry of the exact owner/widget closes pending and open pickers; merely covering a live origin retains mounted state. A global-modal origin follows its actual modal/widget lifetime, not an unrelated background pathname. This supersedes the original always-full-window plugin-picker policy.

Reuse the real Chains content, controlled selection, source organization operations and data handling. Do not duplicate the table or move deck/library ownership into the host. Existing Graph/Practice content-area presentation remains unchanged.

The public controlled `mountKnowledgePicker` API stays unchanged. Both presentations reserve the applicable native-window control clearance without adding a sidebar-reopen control to the picker or mutating the background sidebar preference. The generic selection action is **Done**, without a practice-specific dumbbell. Shared local view paint ranks must agree with interaction order, including session surfaces and owned popup hosts; global modal dialogs remain above this main-local stratum. Do not carry the provisional per-picker modal-hiding coordinator forward as the application foundation.

## Approved implementation architecture

### Why not wrap stock Radix Dialog unchanged?

The installed `Dialog.Content` hardcodes a looping focus scope and dismisses Escape during document capture. Those defaults can move focus on Tab despite native-default prevention, and dismiss a dialog before a focused editor's Escape handler runs.

Use established lower-level pieces instead of a library fork or a new keyboard framework:

- Radix FocusScope with containment enabled and **looping disabled**.
- Accessible outside-content isolation.
- Nested scroll isolation.
- LearnHarness-owned portal/backdrop structure, preserving existing classes and genuine-backdrop pointer gestures.
- App-owned leaf-first dismissal and interaction routing.

The existing transitive packages are declared directly where used: `@radix-ui/react-focus-scope` (`1.1.16`), `aria-hidden` (`1.2.6`), and `react-remove-scroll` (`2.7.2`). Passive tooltips use the installed `@radix-ui/react-popper` (`1.3.7`) and `@radix-ui/react-presence` (`1.1.10`) directly, preserving their existing timing, positioning, visuals and accessibility without stock Tooltip Content's capture-phase Escape dismissal. No new visual component theme or library fork is used.

### Shared primitives and thin controller

Private implementation modules:

- `components/interaction-layers.tsx`: provider, ordered layer registrations, event-owner snapshots, close outcomes, guarded return-to, and command eligibility.
- `components/host-dialog.tsx`: unstyled controlled modal composition, interaction/accessibility/focus/scroll isolation, and existing backdrop-gesture support.
- Existing `components/menu-shell.tsx` and `components/popover-dismiss.ts`: adopt shared popup/owner behavior without replacing existing positioning or keyboard machines.

Keep the controller narrowly responsible for interaction ordering and ownership. It must not contain settings validation, authentication cancellation logic, source mutations, or plugin business logic.

Match actual paint order to interaction order declaratively. Associate portaled popup content with its owning modal so focus containment, accessibility, scrolling, and rendering agree. Do not move React-owned DOM nodes manually or escalate unrelated fixed z-indexes as a substitute for ordering.

### Event and lifecycle integration

- Observe/capture Escape ownership early without preemptively preventing the original event; route unconsumed Escape after leaf handlers.
- Prevent native Tab defaults at capture without stopping propagation. Keep primitive looping disabled; scope the existing explicit actions to eligible owners.
- Migrate independent surface-level capture/bubble listeners to the shared contract. Keep intentional leaf handlers and make handled editor Escape claims explicit.
- Scope Find, Enter submission, model/thinking shortcuts, and fallback Escape actions to their eligible interaction owner. Preserve each command's existing meaning.
- Close callbacks return an explicit outcome such as closed, blocked, handled-without-closing, or pending. A pending authentication cancellation does not authorize deferred stack traversal.
- Settings editor commits expose an explicit acceptance outcome to preserve unsuccessful drafts and display acknowledged canonical values. Validation remains with each field/domain adapter. Adapt the ten `CommitInput` callbacks in appearance, agent/compaction, and plugin schema rows, plus the shared Settings writer/adapters; no public plugin callback signature changes. Distinguish success, validation rejection, blocked writes and persistence failure rather than treating every fulfilled `void` callback as acceptance. Use revision tickets so old acknowledgements cannot erase newer typing. Preserve existing number-input types and steppers; account for native `badInput` so an incomplete numeric token is never mistaken for an intentional empty/unset value. Verify native-number draft retention in Chromium; if preserving it would require a new interaction or input-type change, consult the human rather than silently changing that behavior.
- Disposed or superseded opening requests cannot activate from a late response. Preserve explicit signals and plugin-content cleanup; hiding behind a child does not dispose content.
- Module initialization and server rendering must not access browser globals. Keep the provider inside the client AppShell; do not pull server/store modules into the client graph.

## Approved migration sequence

1. **Characterize the preservation baseline.** Keep the per-surface dismissal/focus/keyboard matrix and capture isolated browser screenshots/interactions before shell changes. Distinguish established core behavior from the checkpoint's provisional picker experiment.
2. **Implement and test the common foundation.** Pure ordering/close-outcome tests plus DOM/browser tests for leaf-first Escape, no native Tab movement, focus ownership, qualified backdrop gestures, and portal containment.
3. **Migrate modal shells.** Settings, provider connection, setup, confirmations, plugin dialogs, and cheat sheet. Keep domain state/actions/content/styling and explicit close guards. Apply only the approved busy-deletion and default-focus changes.
4. **Migrate popup and content-view ownership.** Preserve geometry/search/arrows, per-surface outside/scroll behavior, core content-view boundaries, and existing explicit Tab commands. Remove duplicated dismissal listeners as each surface migrates.
5. **Integrate the plugin knowledge picker.** Use the shared modal infrastructure and actual Chains UI. Remove the provisional picker-only coordinator; preserve API, selection, source edits, and accepted-write lifetimes. Reconcile provisional docs/smoke assertions with this contract.
6. **Independent review and full verification.** Resolve causal findings; run full tests, examples, strict SDK-consumer compilation, typecheck/lint, isolated production build, package privacy checks, and packaged-browser regression/visual checks. No paid model requests are needed for these UI proofs.

Do not ship an intermediate mixed behavior as the completed migration. No release or push is part of this plan.

## Required verification matrix

- Settings → menu; Settings → provider connection; plugin dialog → menu/dialog/picker.
- One Escape closes only the event's original owner; repeated Escape walks layers individually.
- Focused field Escape retains/commits and leaves Settings open; rename cancellation retains its distinct contract.
- Busy deletion consumes Escape without dismissal or lower-layer effects.
- Global Find/Enter/Tab/thinking do not act in covered content; native Tab never moves focus; explicit bindings/rebinding retain their behavior.
- Initial focus follows explicit targets or first editable field/heading; nested close restores eligible focus without delayed steals.
- Return-to Settings honors blocked, handled, pending and closed outcomes; no forced cancellation or deferred navigation.
- Parent content/state/scroll survive children; plugin unload/navigation/abort clean up only owned content; late reads cannot resurrect a surface.
- Existing genuine-backdrop gestures survive drag/text selection; per-flow scroll/outside policies remain intact.
- Chains selection, rename, folder creation, dragging, controlled updates and cleanup still use the real host implementation.
- Existing dialogs and content views retain their visual appearance and bounds except for the explicitly approved later plugin presentation and origin-sensitive picker amendments.

## Verification — 2026-11-02

- **3,665 tests / 555 suites passed**, plus four plugin-example tests, strict compilation of a consumer of the packaged SDK declarations, typecheck and lint (only the existing test-fixture `<head>` warning).
- Isolated production build and packaged Electron-Node/Chrome browser proof passed. The browser exercised controlled picker selection and source editing, nested painted/inert parents, singleton Settings return-to, passive tooltip paint/Escape behavior, and the existing worker-admission 1→2→1/FIFO/END-cancellation proof with zero completed mock generations.
- Chromium's native user-agent editing viewport proved visible `1e` retention before/after field Escape for both worker concurrency and prose size, without invalid writes or dialog dismissal. Valid `3.0` and `-5` displayed acknowledged canonical values `3` and `12`; number types and native steppers were unchanged.
- All four sampled legacy dialog/menu frames retained identical bounds and computed styles. Public-dialog and font-menu pixel crops matched exactly; Settings crops differed only at six rounded-border anti-aliasing pixels. Tooltip bounds matched and tooltip paint remained above its owning Settings frame.
- All 392 production-source files under `app`, `components`, `src` and `lib` matched their isolated source and standalone copies byte-for-byte. The 96 tracing manifests contained no private-root entries.
- Independent review's confirmed ownership and settings-ordering findings were fixed and causally retested. Final review reported no further confirmed P1/P2 findings. Historical admission/picker/checkpoint counts are separate evidence, not this migration's verification.

## UI-polish amendment verification — 2026-11-03

The later approved amendment is implemented and verified, **uncommitted and not released**. Full offline verification passed **3,908 tests / 564 suites**, plus **17 UI Showcase tests**, whole-project typecheck/lint, a strict consumer of the curated SDK, a fresh isolated production/standalone build, and a privacy/byte audit (**96 manifests / 277,329 entries / zero private-root hits / 410 identical production files**).

Expanded packaged Electron-Node/Chrome verification passed headerless accessible dialogs/surfaces, pinned muted X controls and edge-aligned scrolling, both surface backgrounds, real Hint tooltips, nested painted parents, command/focus ownership and disable cleanup. Eleven knowledge-picker origin/geometry cases covered interactive sidebar main-pane views versus modal-origin viewport dialogs, source navigation expiry and simulated native-window clearance. Global-modal origins remain independent of background routes. Cross-region view coverage preserves source DOM/draft/registration and blocks covered field commands; it does not imply a new universal DOM-inertness rule. Reverse programmatic picker/surface ordering has a separate causal host-integration regression.

The native run recorded **223 requests / 217 responses**, zero off-origin/generation/microphone/WebSocket/page errors, unchanged settings/synthetic graph/approved host bytes, and one narrowly expected canceled source read. Evidence and boundaries are detailed in [the archived session-extension checkpoint](archive/plugin-implementation-history.md#11-subsequent-ui-polish-verification--2026-11-03). The Windows/Linux checks are CSS geometry simulations, not physical OS verification; no paid provider, microphone recording, OS IME, signed installer, real-profile install or commit is claimed.
