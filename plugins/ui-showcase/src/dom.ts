import type { PluginButtonProps, PluginUi, PluginWidgetHandle } from "learnharness-plugin-api";

/** A mount-local lifetime, including promises awaiting manual completion. */
export class Scope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private cleanups = new Set<() => void>();
  private readonly parent: AbortSignal;
  constructor(parent: AbortSignal) {
    this.parent = parent;
    parent.addEventListener("abort", this.dispose, { once: true });
    if (parent.aborted) this.dispose();
  }
  own(cleanup: () => void): () => void {
    if (this.signal.aborted) cleanup();
    else this.cleanups.add(cleanup);
    return cleanup;
  }
  widget<P>(handle: PluginWidgetHandle<P>): PluginWidgetHandle<P> {
    this.own(() => handle.dispose());
    return handle;
  }
  dispose = (): void => {
    if (this.signal.aborted) return;
    this.parent.removeEventListener("abort", this.dispose);
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  };
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function note(parent: HTMLElement, text: string): void {
  parent.append(element("p", text, "ui-showcase-note"));
}
export function example(parent: HTMLElement, id: string, label?: string): HTMLElement {
  const item = element("div", undefined, "ui-showcase-example");
  item.dataset.example = id;
  if (label) item.append(element("div", label, "ui-showcase-label font-ui text-xs"));
  const slot = element("div");
  item.append(slot);
  parent.append(item);
  return slot;
}
export function readout(parent: HTMLElement, family: string): (value: unknown) => void {
  const state = element("pre", undefined, "ui-showcase-state font-ui text-xs");
  state.dataset.state = family;
  state.setAttribute("aria-label", `${family} local state and callbacks`);
  parent.append(state);
  return value => { state.textContent = JSON.stringify(value, null, 2); };
}
export function button(ui: PluginUi, parent: HTMLElement, scope: Scope, id: string, props: PluginButtonProps): PluginWidgetHandle<PluginButtonProps> {
  return scope.widget(ui.mountButton(example(parent, id), props, { signal: scope.signal }));
}
export function row(parent: HTMLElement): HTMLElement {
  const node = element("div", undefined, "ui-showcase-row");
  parent.append(node);
  return node;
}

export function family(ui: PluginUi, parent: HTMLElement, scope: Scope, id: string, title: string,
  mount: (body: HTMLElement, lifetime: Scope) => void): void {
  const section = element("section", undefined, "ui-showcase-family");
  section.dataset.family = id;
  const header = element("div", undefined, "ui-showcase-family-header");
  header.append(element("h2", title, "ui-showcase-heading font-ui text-sm uppercase tracking-widest"));
  section.append(header);
  const body = element("div", undefined, "ui-showcase-family-body");
  section.append(body);
  parent.append(section);
  let current: Scope | undefined;
  const reset = () => {
    current?.dispose();
    body.replaceChildren();
    if (scope.signal.aborted) return;
    current = new Scope(scope.signal);
    mount(body, current);
  };
  button(ui, header, scope, `reset-${id}`, { label: "Reset", title: `Reset ${title.toLowerCase()} examples`, variant: "ghost", size: "xs", onClick: reset });
  scope.own(() => current?.dispose());
  reset();
}
