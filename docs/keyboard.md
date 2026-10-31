# Keyboard shortcuts

This reference describes the shipped defaults. **Mod** means ⌘ on macOS and
Ctrl on Windows/Linux; the dispatcher accepts either modifier on every platform.
Press **?** outside a text field for the in-app cheat sheet.

## Default key map

| Action | Binding |
|---|---|
| Toggle dictation | Mod+D |
| Open settings | Mod+, |
| Model selector | Mod+K |
| Cycle thinking level | Shift+Tab |
| Toggle sessions sidebar | Mod+B |
| Search sessions | Mod+Shift+F |
| Graph view | Mod+G |
| New session | Mod+N |
| Rename current session | F2 |
| Toggle all your thinking in the session | Mod+T |
| Find in session / search graph or chains view | Mod+F |
| Shortcut cheat sheet | ? |

Surface-specific actions require their surface to be mounted. Bare shortcuts
such as **?** and **F2** do not fire while typing; modifier shortcuts still do.

**Settings → Keyboard** displays the registry and offers Rebind, per-action
Reset, and Reset all controls. Overrides are stored on this device in
localStorage (`lh:keymap`), not in the learning-data settings file. Contextual
question keys are shown as **Fixed — part of this screen**, not rebindable.
Tab and Esc also have dedicated handling outside ordinary registry dispatch.

## Keyboard layouts

Shortcut matching and Settings rebinding use the same normalization. With
**Ctrl, ⌘, or Alt/Option** held, a single non-ASCII character falls back to its
physical **A–Z or comma** key position when the event supplies that code. For
example, Russian Ctrl+`л` at `KeyK` matches **Mod+K**, and ⌘+`б` at `Comma`
matches **Mod+,**. This also covers non-ASCII characters produced by Alt/Option,
such as Option+K reporting `˚` at `KeyK` and normalizing to `alt+k`.

ASCII characters still follow the reported character, not the physical position:
an AZERTY event reporting `q` at `KeyA` stays `mod+q`. Bare typing is unchanged.
Other physical codes and named keys (including dead keys) keep their existing
handling; this is not a guarantee for every OS/IME or layout-specific key.

## Focus and Esc

- **Tab** does not use the browser's normal focus traversal. On composer-bearing
  pages it cycles the live text fields forward, wrapping to the first. In a
  session the order is reading-thinking → active dock fields → composer,
  including only fields currently mounted. From elsewhere it enters the first
  field. The expanded select-question dock has its own rows↔thinking cycle below.
- **Shift+Tab** cycles the model's thinking level, including while typing; it is
  not backward focus traversal. Connection dialogs can own their own Tab trap.
- **Esc** acts on the active field or topmost surfaced layer first: for example,
  leave a field, dismiss a menu/dialog, or close Find. Handlers claim the event
  so one Esc does not also act on lower layers. With no layer claiming it, the
  fallback closes the cheat sheet or cancels dictation (discarding its pending
  transcript) before reaching the chat's confirmation to dismiss a pending
  question/problem or abort a running turn. Confirmed turn abort signals the
  server, including for background turns; it also detaches any local stream.

To keep dictated text, stop dictation with **Mod+D** / Stop rather than the
fallback Esc cancellation.

## Enter and submission

- In the **chat composer**, **question answer/thinking fields**, and **practice
  thinking field**, **Enter submits**; **Shift+Enter** inserts a newline;
  **Mod+Enter** also submits. A question still needs an answer, and practice
  needs nonempty thinking. Submission is disabled during compaction.
- The composer's action follows its state: send text (or steer a running turn),
  Stop when busy with no sendable text, or **Next problem** when empty in the
  practice pause.
- Plain **Enter outside a typing surface** also submits the active question or
  practice response when valid, or advances from the practice pause. A
  pointer-clicked transcript button does not steal this submit. Keyboard-focused
  buttons and buttons in open menus/dialogs retain native Enter activation.
- When a pending check is closed, **Enter** opens it rather than submitting a
  hidden answer. In **Thinking while reading**, Enter / Mod+Enter opens that
  waiting check; otherwise Enter makes a newline and Mod+Enter leaves the field.
- The single-line **Other…** answer submits on Enter, including Shift+Enter.
- Search/menu fields own their Enter; Find navigation never submits an answer.

## Question dock

While a select question is expanded and active:

- **↑/↓** walk answer rows: options first, then **I don't know** (quiz) or
  **Other…** (ask). The walk stops at either end; it does not wrap.
- **Space** acts like clicking the walked row: toggles a multi-select option or
  picks a single-select option. Selecting Other focuses its input; Space on an
  already selected Other row deselects it without erasing its text.
- **←/→** adjust quiz confidence through its stops, except on **I don't know**.
- **Tab** toggles between the thinking field and walked (or first) answer row.
  Focus follows the arrow walk while in the rows. The confidence slider is not
  part of this cycle. **Shift+Tab** remains the thinking-level shortcut.
- Arrows and Space keep their text-editing meaning in typing fields; Alt/Ctrl/⌘
  combinations do not walk the dock. In Other, **Esc** leaves the input but
  keeps the answer selected.

Text-only questions have no answer-row machine; their answer field uses the
submission conventions above.

## Chains view

- **Mod+F** focuses the chains search while the view is open, rather than the
  graph search underneath it. **↓** from that field enters the first result;
  the other arrows retain their text-editing meaning there.
- **↑/↓** move between siblings in the current layer, skipping expanded
  descendants and stopping at either end without wrapping.
- **→** expands the highlighted row and enters its first child: folders →
  sources → chains → propositions. A leaf stays where it is.
- **←** returns to the parent and collapses that parent's contents. At the top
  level, it collapses the highlighted row if open.
- **Space** toggles the highlighted row's checkbox, where available. Ordinary
  browsing selects whole sources/folders; practice's Pick nodes also offers
  chain/proposition checkboxes. Text inputs retain normal Space behavior.
- Clicking blank space below the tree clears row focus/highlighting, not checked
  items. Creating a folder clears any search and focuses the new folder.
- The whole active row is highlighted and scrolled into view. This focus is
  separate from checkbox selection; navigation does not select graph nodes.
  Clicking a row establishes the navigation position. Rename inputs keep their
  normal text-editing arrow keys; foreground menus/dialogs take priority.

## Search and menus

- **Sessions search (Mod+Shift+F):** opens the sidebar if needed and focuses its
  search field. **↑/↓** walk the filtered sessions with wrap; **Enter** opens the
  walked row, or the first match if none was walked, then leaves the field.
  **Esc** leaves the field without clearing the query.
- **Model search menus:** focus stays in search. **↑/↓** walk filtered results
  without wrap; the first ↓ starts at the first result, the first ↑ at the last.
  **Enter** picks the walked result or the first result. Editing the query resets
  the walk. Menus without a search field instead move button focus with wrapping
  **↑/↓**, support **Home/End**, and use native **Enter** activation.
- **Find (Mod+F):** in the graph, focuses node search; with the chains view
  open, focuses that view's search instead. In a session, opens a
  literal, case-insensitive search of displayed session text, including offscreen
  scroll content but excluding hidden/collapsed content, draft fields, and embedded
  documents. **Enter / Shift+Enter** in the Find field move to the next/previous
  match with wrap. **Esc** closes Find, clears highlights, and restores prior
  focus. Reopening retains the query and reading position within that session;
  changing sessions resets Find. A foreground menu/dialog takes priority.

## Implementation sources

- [Registry and persistence](../src/core/keyboard.ts),
  [window dispatcher and cheat sheet](../components/keyboard-shortcuts.tsx),
  [Keyboard settings](../components/settings/keyboard-section.tsx).
- [Field cycle](../components/field-cycle.ts),
  [question dock](../components/question-dock.tsx),
  [practice dock](../components/practice-dock.tsx),
  [composer](../components/composer.tsx),
  [chat focus and abort handling](../components/chat.tsx),
  [reading-thinking field](../components/reading-thinking.tsx),
  [Enter focus rules](../components/enter-submits.ts).
- [Sidebar search](../components/sidebar.tsx),
  [model menus](../components/settings/model-menu.tsx),
  [menu shell](../components/menu-shell.tsx),
  [session Find](../components/session-find.tsx),
  [displayed-text matching](../components/session-find-dom.ts),
  [chains navigation](../components/chain-navigation.ts).
