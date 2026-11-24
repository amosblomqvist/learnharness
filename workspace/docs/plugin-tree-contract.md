# Shared tree presentation — plugin API v1

Current API v1 contract. Exact public types are in `src/core/plugin-tree.ts`, with
`mountTree` in `src/core/plugin-ui.ts`. Use documentation and type-only SDK declarations
matching the target app, not private runtime imports.

## Boundary

A manageable shared presentation foundation is used by the existing native Chains UI
without moving its controllers or business logic. Native Chains appearance, navigation,
selection, sorting and source operations stay unchanged. The plugin adapter is
`components/plugin-tree.tsx`; it exposes the same native presentation, not native data
or a Chains controller.

```ts
ctx.ui.mountTree(container, tree, { signal }): PluginWidgetHandle<PluginTreeProps>
```

`tree` is a generic configuration object. `PluginTreeProps` means TypeScript properties;
it is not the native Chains **Props** proposition-count column. The widget opens nothing:
knowledge selection, dialogs and session surfaces remain separate APIs.

The caller owns hierarchy/data, search, sorting, actions, domain rename/move rules,
selection policy, storage, scroll containers, loading and empty-state UI. This is not a
file manager, deck/library domain API or new declarative UI framework. No column-resize
or sticky-header system is added. No Flashcards or other product plugin is migrated here.

## Controlled configuration

- `PluginTreeProps`: required accessible `label` and `rows`; optional primary `header`
  and trailing `columns`. `label` is an accessible name only, never an automatic visible
  title. Primary content fills the remaining width.
- `PluginTreeRow`: `key`, primary `content`, optional `cells`, `children`, `selection`
  and `disclosure`. Every row has a **globally unique occurrence key**, including rows
  below collapsed ancestors. Any string, including `""`, is allowed if unique. The key
  identifies that displayed occurrence, independently of the entity it represents:
  there is no `itemId` field or inferred coupling between duplicate entity occurrences.
- `selection`: `{ label, checked, indeterminate?, disabled?, onChange(checked) }`.
  The caller controls each checkbox independently. No parent/child selection cascade or
  derived indeterminate state is supplied.
- `disclosure`: `{ label, expanded, onChange(expanded) }`. Expansion is controlled;
  publish accepted state through `update`. Children without a disclosure are always
  visible. A collapsed disclosure unmounts descendant content and runs cleanup;
  reopening remounts it. Persist retained data/drafts in plugin state, not mounted DOM.
- `PluginTreeColumn`: `{ key, header, width, align? }`; row `cells` are keyed by the
  configured columns. Alignment is `"left"` by default or `"right"`. Numeric width is
  pixels and must be finite and nonnegative (**0 is valid**); a non-whitespace string
  uses CSS width semantics. Width is not a resizing or persistence service.

Primary row/header content and trailing cell/header content accept `PluginTreeContent`:
`string | PluginUiContent`. The latter is the existing HTMLElement or signal-scoped
mount function, with optional synchronous/asynchronous cleanup. Rich content occupies
slots **inside fixed native row/header/cell shells**; it cannot replace row markup,
checkboxes, disclosure controls or their alignment. Actions can be plugin-owned content;
the host does not infer row actions from data.

## Layout and interaction

If no row anywhere in the configuration has `selection`, including collapsed descendants,
the checkbox gutter is removed. Any selection reserves that gutter for **all** rows.
A plain flat list without branches or disclosures has no disclosure gutter; hierarchy
reserves aligned disclosure space. Native guide positions are **19px without selection**
or **37px with selection**, plus **36px per depth**.

Native typography defaults use `font-ui`: primary labels are `text-sm` (**12.5px**),
weight **500**; metadata and headers are `text-xs` (**11px**), weight **400**.
Width-bearing header and body cells use matching font metrics, including for CSS
`em`/`ch` widths; this does not guarantee positional alignment under width constraints.
Rich content may override its own styles. Native thin separators appear
**between top-level groups only**: nested rows are unruled, with no separator after the
last group. Internal root selectors are implementation details, not styling APIs.

**Column fit, available width and scrolling are caller-owned in v1.** If the container
cannot accommodate configured trailing widths plus maximum hierarchy indentation and
control/prefix space, the layout can overflow and header/body column positions can
diverge even while declared widths are retained. Matching font metrics do not remove
this limit. Supply sufficient width or an inner minimum width with a caller-owned
horizontal scroll container, or choose fewer/narrower columns. The required budget
depends on your hierarchy, controls, columns and primary content; the host supplies no
minimum-width calculation, clipping policy or responsive layout engine. Native behavior
is unchanged.

The widget reuses **existing native Chains arrow-row navigation**, not native Tab focus:
Up/Down move among siblings; Right opens a closed branch and enters its first child after
the controlled update, or enters the first child of an open branch. Left follows the
native parent/fold-parent rule (an expandable root folds itself). Space toggles only the
active row's optional host-owned checkbox when enabled. Plugin text inputs,
contenteditable content and already-handled keys retain their own interaction.

A thin root-local adapter uses the private pure `components/tree-navigation.ts` kernel,
mechanically extracted from `chain-navigation.ts`; native exports alias it while the
native hook, metadata and event policy remain unchanged. Nested widget roots navigate
independently. This adds no autofocus, Find/search handling, global handler, public
keyboard-controller API or new props. **The app-wide Tab policy is unchanged in every
context**: no Tab exception or native Tab browser-focus promise is introduced.

## Lifecycle and updates

The normal widget contract applies: final `{ signal }`, shallow `update(partialTree)`
and idempotent `dispose()`. Replace complete `rows`/`columns` arrays when changing them;
callbacks alone do not update controlled values. Widget-signal abort, plugin deactivation,
row removal, collapse and content replacement clean up their affected mounts. Setting
`selection.disabled` disables that checkbox; it does **not** unmount row content. Async
content must honor its mount signal; late cleanup follows the existing `PluginUiContent`
lifecycle.

Keep mount-function identities stable across updates when the content should remain
mounted. Creating a new function on each update replaces that content and remounts it;
stable occurrence keys do not override content-identity changes. Reopening collapsed
content still remounts even when its function identity is stable.

## Example: plugin-owned folders and files

Inside a plugin view's `mount(container, signal)`, this uses arbitrary file-like data,
not a host filesystem service. The caller retains expansion, selection and a draft.
The wrapper demonstrates caller-owned horizontal scrolling and an illustrative `32rem`
inner minimum; choose a sufficient budget for your own data, not a fixed host requirement.

```js
let expanded = true;
let checked = false;
let draft = "A plugin-owned note";
let treeHandle;

// Stable function identity; the draft survives descendant unmount/remount.
function noteContent(slot, mountSignal) {
  if (mountSignal.aborted) return;
  const field = document.createElement("input");
  field.setAttribute("aria-label", "Note draft");
  field.value = draft;
  const saveDraft = () => { draft = field.value; };
  field.addEventListener("input", saveDraft);
  slot.append(field);
  return () => {
    field.removeEventListener("input", saveDraft);
    field.remove();
  };
}

function rows() {
  return [{
    key: "folder-occurrence", content: "Notes", cells: { kind: "Folder" },
    disclosure: {
      label: "Expand Notes", expanded,
      onChange(value) {
        expanded = value;
        treeHandle.update({ rows: rows() });
      }
    },
    children: [{
      key: "note-occurrence", content: noteContent, cells: { kind: "File" },
      selection: {
        label: "Select note", checked,
        onChange(value) {
          checked = value;
          treeHandle.update({ rows: rows() });
        }
      }
    }]
  }];
}

const scroller = document.createElement("div");
scroller.style.overflowX = "auto";
const inner = document.createElement("div");
inner.style.minWidth = "32rem"; // Illustrative caller choice, not a host minimum.
scroller.append(inner);
container.append(scroller);

treeHandle = ctx.ui.mountTree(inner, {
  label: "Plugin notes", header: "Name",
  columns: [{ key: "kind", header: "Kind", width: 72, align: "right" }],
  rows: rows()
}, { signal });
return () => {
  treeHandle.dispose();
  scroller.remove();
};
```

## Testing

Test controlled controls/occurrence keys, content retention across updates, collapse/remount,
late cleanup, editable/nested-widget keyboard isolation, native Chains regressions and
fitting-width header/body alignment. Underconstrained layouts remain the caller's
responsibility, not an alignment guarantee.
