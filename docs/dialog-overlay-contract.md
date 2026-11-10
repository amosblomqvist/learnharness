# Dialog, popup, and interaction contract

Core UI and plugin UI share interaction ownership, keyboard routing, focus and dismissal
rules. Plugins use public `ctx.ui` helpers; the implementation modules described below
are private host infrastructure, not plugin imports.

## Plugin presentation

Public plugin dialogs and page-body surfaces have no visible host title/header row.
Their required title supplies the accessible name. A muted corner X floats above
edge-aligned scrolling content; plugins own visible headings and bottom actions.
Surfaces fill their page-body bounds. `background?: "dimmed" | "opaque"` controls the
surface background; the default `"dimmed"` uses the Chains-like translucent/blurred paint.

## Interaction ownership

### Escape: one event, one owner

Only the topmost active interaction responds to a physical Escape event. This includes
a focused editor that owns Escape, a menu above a dialog, or a child dialog above its parent.

- Leaf handlers get their normal opportunity before a containing surface dismisses.
- A handled Escape cannot also dismiss a parent, cancel dictation or abort a turn.
- Ownership is captured at the start of the event. Closing one surface does not let
  the newly exposed surface handle that same key.
- A surface that refuses dismissal still consumes Escape.
- Explicit editor cancellation, including source/folder/session renaming, retains its
  own semantics. There is no generic search-clear-first rule: model/provider/font/language
  menus close, while sidebar search retains its query and leaves the field.

### Passive tooltips

Tooltips do not own interaction layers or intercept Escape. They remain associated with
their owning modal so their paint, hover/focus behavior and accessibility relationships
remain valid above its frame.

### Tab: no native navigation

Native browser Tab and Shift+Tab navigation is disabled, including in dialogs and popups.
Explicit application bindings still apply within their eligible scope:

- Plain Tab invokes the configured forward field-cycle action or question-choice row/thinking action.
- Shift+Tab invokes the thinking-level cycle.
- Shortcut rebinding can record Tab as a binding candidate.

Modal focus scopes do not add boundary looping. Covered fields and thinking controls
cannot receive these actions. Native-default prevention does not suppress target handlers.

### Settings fields: Escape retains and commits

Escape in a focused settings text/number field claims the event, leaves the field through
its normal blur/save path, and saves a valid value using the domain's validation and
normalization. It does not close Settings or discard the typed value.

Invalid values are not persisted; unsuccessful drafts and validation errors remain.
Accepted saves display acknowledged canonical values, including normalization/clamping.
A later Escape outside the field can close Settings. Explicit rename/cancel workflows
remain separate.

Credential/custom-provider editors retain explicit Save/Cancel actions. Escape folds
the expanded editor without saving credentials or closing Settings, after a focused leaf
or higher menu has its turn. Unsaved drafts survive folding and switching editors until
Settings closes.

A response without a valid canonical saved-settings record displays “Could not confirm
saved settings. Your input has been kept.” Other HTTP/network errors retain their own
messages. Late older responses cannot replace a newer acknowledged snapshot or its
appearance. A pending save finishing after Settings reopens updates the current instance;
older Settings/startup reads cannot undo an acknowledged save.

### Initial focus and return

Explicit initial-focus targets take precedence. Otherwise a modal focuses:

1. Its first eligible editable text/number field.
2. Its eligible content heading, if no field exists.
3. Its accessible boundary or painted frame, not the close action.

Disabled, read-only, hidden and inactive controls are ineligible. Headerless surfaces do
not focus non-rendering `display: contents` wrappers. This does not enable native Tab.

Closing a child returns focus to its eligible invoking element in the resumed parent.
Detached, disabled, hidden or superseded targets cannot steal focus; if the invoker is
unavailable, the active surface uses its initial-focus policy. Popups retain their
explicit focus-return rules.

### Nested modal parents

A child modal does not close, remount or hide its parent with `display: none`. Parents
remain painted and retain state and scroll position. Only the active modal and its owned
interactive children receive interaction/accessibility access. A child may naturally
cover its parent's paint.

### Busy operations and close guards

Source/folder/session/node deletion confirmations consume Escape without closing while
deletion is in progress, matching their disabled Cancel/backdrop dismissal paths.
A generic `busy` flag does not imply a dismissal lock: abort confirmations, setup and
provider connection/cancellation flows retain their domain-specific behavior.
Closing a surface does not implicitly cancel an accepted write or other domain operation.

### Settings singleton and return-to navigation

There is one Settings instance. Opening Settings places it above the current surface
without discarding that surface. Returning to Settings beneath child layers requests
closure top-down through normal callbacks:

- Stop if a layer refuses, handles the request without closing, or remains open during
  asynchronous cancellation.
- Invoke each close callback at most once per request. Do not force cancellation, spin
  until a layer disappears or queue deferred navigation.
- Retarget Settings only after return-to succeeds, preserving section/deep-link state.

Paint order is not lifetime ownership: unloading a plugin dialog below global Settings
does not destroy Settings.

## Surface families

| Family | Examples | Behavior |
| --- | --- | --- |
| Modal dialogs | Settings, setup, confirmations, provider connections, plugin dialogs, keyboard cheat sheet | Modal focus/accessibility/scroll isolation and domain-specific close guards. |
| Anchored menus/popups | Model/thinking/provider/font/language menus, context menus, plugin menus, graph/statistics panels | Owner-scoped interaction with each popup's geometry, search/arrows, outside-pointer, scroll-close and focus-return rules. |
| Content-area views | Chains browser, expanded diagrams/figures, expanded full plan | Main-content bounds with sidebar interaction, not viewport-modal isolation. |
| Inline/noninteractive UI | Activity disclosures, notifications/update banners, drag previews | No modal interaction layer. |

### Plugin menu repeated-anchor toggle

Within one plugin UI owner, repeated `openMenu` calls for the exact same anchor element
toggle the existing menu closed, synchronously even before React mounts it. Closing calls
the existing menu's latest `onClose` once and returns an inert handle for the repeated call.
The incoming props/callback do not create another menu. Different owners and anchors
retain independent behavior.

Outside clicks (including another button), action dismissal, Escape-only anchor focus
return and error/async behavior retain their normal semantics. Caller/plugin/surface
expiry or explicit disposal clears the anchor registration without synthesizing `onClose`;
stale handles cannot affect a later menu.

### Plugin knowledge picker

The controlled `mountKnowledgePicker` uses the real Chains interface and selection/source
organization operations. Presentation depends on the invocation owner:

- A plugin/native page or page-body surface opens a main-content-pane `view`, excluding
  the sidebar and leaving it interactive.
- A dialog, Settings or another modal ancestor opens a full-window modal, with its parent
  painted and the background/sidebar inactive.

The host captures owner and bounds; plugins do not supply an origin option. Navigation
away from the source page or expiry of the exact owner/widget closes pending/open pickers.
Covering a live origin retains mounted state. A global-modal origin follows its actual
modal/widget lifetime, not an unrelated background route.

Both presentations reserve native-window control clearance without adding a sidebar-reopen
control or changing the background sidebar preference. The selection action is **Done**.
Local view paint follows interaction order, including surfaces and owned popups; global
modal dialogs remain above this main-local stratum. Deck/library ownership stays with the
plugin, not the picker.

## Host implementation

Private implementation modules are `components/interaction-layers.tsx`,
`components/host-dialog.tsx`, `components/menu-shell.tsx` and
`components/popover-dismiss.ts`. They coordinate ownership and paint without owning domain
validation, authentication cancellation, source mutations or plugin business logic.

Modal composition uses non-looping Radix FocusScope containment, outside-content
accessibility isolation, nested scroll isolation and host-owned portals/backdrops.
Leaf-first dismissal replaces stock capture-phase Escape dismissal. Passive tooltips use
Popper/Presence without registering an interaction owner.

Escape ownership is observed before routing unconsumed events after leaf handlers. Native
Tab defaults are prevented without stopping propagation. Find, Enter submission,
model/thinking shortcuts and fallback Escape actions use eligible interaction owners.
Close outcomes distinguish closed, blocked, handled-without-closing and pending; pending
cancellation never authorizes deferred stack traversal.

Settings commits distinguish acceptance, validation rejection, blocked writes and
persistence failure. Revision tickets protect newer drafts; native number inputs retain
steppers and `badInput` handling so incomplete tokens are not mistaken for empty values.
Disposed or superseded opening requests cannot activate after late responses. Covering a
parent does not dispose its content. Portaled popup ownership keeps focus, accessibility,
scrolling and paint aligned without manual React DOM relocation or unrelated z-index jumps.

Interaction providers live in the client AppShell. Module initialization/server rendering
does not access browser globals or import private server/store code into the client graph.
