import type { PluginTreeProps, PluginTreeRow, PluginUi, PluginUiContent, PluginWidgetHandle } from "learnharness-plugin-api";
import { Scope, button, element, example, note, readout } from "./dom.ts";

/** Synthetic controlled values only; the host owns row presentation and keyboard behavior. */
export function mountTreeDemo(ui: PluginUi, body: HTMLElement, life: Scope): void {
  note(body, "A small synthetic directory using the host tree. Shared item appears under both folders with independent occurrence keys. Selection is optional and never cascades from folders to children. Hiding selection preserves it; Reset clears this family's state.");
  note(body, "Click a row, then use the host's arrow-row navigation; Space selects an enabled host checkbox. The editable draft keeps its normal input keys. This example owns its 36rem minimum width and horizontal scrolling, not a responsive tree engine.");
  let selectionEnabled = false;
  const selectedOccurrenceKeys = new Set<string>();
  const expanded: Record<string, boolean> = { "example-folder": true, "another-folder": true };
  let draft = "Local draft";
  let lastCallback = "none";
  const show = readout(body, "tree");
  let tree: PluginWidgetHandle<PluginTreeProps>;
  const toggle = button(ui, body, life, "toggle-tree-selection", { label: "Enable selection", variant: "outline", onClick() {
    if (life.signal.aborted) return;
    selectionEnabled = !selectionEnabled;
    lastCallback = selectionEnabled ? "selection enabled" : "selection disabled";
    render();
  } });

  // One factory per family lifetime: controlled updates retain this content's
  // DOM, while disclosure unmounts it and a later mount restores the local draft.
  const draftContent: PluginUiContent = (container, signal) => {
    const content = new Scope(signal);
    if (life.signal.aborted || content.signal.aborted) { content.dispose(); return content.dispose; }
    const root = element("div");
    root.append(element("div", "Draft note", "ui-showcase-label font-ui text-xs"));
    const input = element("input", undefined, "font-ui text-sm");
    input.type = "text";
    input.setAttribute("aria-label", "Directory draft");
    input.value = draft;
    const change = () => {
      if (life.signal.aborted || content.signal.aborted) return;
      draft = input.value; lastCallback = "draft.onInput"; render();
    };
    input.addEventListener("input", change);
    root.append(input); container.append(root);
    content.own(() => { input.removeEventListener("input", change); root.remove(); });
    return content.dispose;
  };
  const selection = (key: string, label: string): Pick<PluginTreeRow, "selection"> => selectionEnabled ? { selection: {
    label, checked: selectedOccurrenceKeys.has(key), onChange(value) {
      if (life.signal.aborted || !selectionEnabled) return;
      if (value) selectedOccurrenceKeys.add(key); else selectedOccurrenceKeys.delete(key);
      lastCallback = `selection.onChange: ${key}`; render();
    },
  } } : {};
  const folder = (key: string, title: string, children: readonly PluginTreeRow[]): PluginTreeRow => ({
    key, content: title, cells: { kind: "Folder", state: expanded[key] ? "Expanded" : "Collapsed" }, children,
    ...selection(key, `Select ${title}`),
    disclosure: { label: `Toggle ${title}`, expanded: expanded[key]!, onChange(value) {
      if (life.signal.aborted) return;
      expanded[key] = value; lastCallback = `disclosure.onChange: ${key}`; render();
    } },
  });
  const rows = (): PluginTreeRow[] => [
    folder("example-folder", "Example folder", [
      { key: "example-folder/shared-item", content: "Shared item", cells: { kind: "Note", state: "Repeated" }, ...selection("example-folder/shared-item", "Select Shared item in Example folder") },
      { key: "example-folder/draft-note", content: draftContent, cells: { kind: "Draft", state: "Editable" }, ...selection("example-folder/draft-note", "Select Draft note") },
    ]),
    folder("another-folder", "Another folder", [
      { key: "another-folder/shared-item", content: "Shared item", cells: { kind: "Note", state: "Repeated" }, ...selection("another-folder/shared-item", "Select Shared item in Another folder") },
    ]),
  ];
  const viewport = example(body, "tree");
  viewport.style.overflowX = "auto";
  const minimum = element("div"); minimum.style.minWidth = "36rem";
  viewport.append(minimum);
  tree = life.widget(ui.mountTree(minimum, {
    label: "Directory example", header: "Name", rows: rows(), columns: [
      { key: "kind", header: "Kind", width: 56 },
      { key: "state", header: "State", width: 80 },
    ],
  }, { signal: life.signal }));
  function render() {
    tree.update({ rows: rows() });
    toggle.update({ label: selectionEnabled ? "Disable selection" : "Enable selection" });
    show({ selectionEnabled, selectedOccurrenceKeys: [...selectedOccurrenceKeys], expanded: { ...expanded }, draft, lastCallback });
  }
  render();
}
