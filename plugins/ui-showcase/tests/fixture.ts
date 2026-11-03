/** Unit-only public widget recorder, deliberately not a native widget substitute.
 * Real controls, focus, validation and overlay geometry are proved by native.mjs. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// Linkedom's declarations implement an older DOM lib and conflict with modern
// lib.dom. Keep this test double behind a narrow typed runtime boundary rather
// than weakening the product's skipLibCheck:false policy.
const { parseHTML } = createRequire(import.meta.url)("linkedom") as { parseHTML(html: string): { document: Document } };
import type { PluginFrontendContext, PluginUi } from "learnharness-plugin-api";

type AnyProps = Record<string, any>;
export interface MountRecord {
  method: string;
  container: HTMLElement;
  props: AnyProps;
  signal: AbortSignal;
  disposed: number;
  updates: AnyProps[];
  target?: unknown;
  dictation: { toggle: number; finish: number; cancel: number };
  handle: { update(props: AnyProps): void; dispose(): void };
}
export function createFixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const root = document.querySelector("main") as unknown as HTMLElement;
  const controller = new AbortController();
  const records: MountRecord[] = [];
  const calls: string[] = [];
  const ui = new Proxy({}, {
    get(_object, key: string) {
      if (!key.startsWith("mount") && !key.startsWith("open")) throw new Error(`Unexpected UI API: ${key}`);
      return (...args: any[]) => {
        const overlay = key === "openDialog" || key === "openSurface";
        const props: AnyProps = overlay ? args[key === "openSurface" ? 1 : 0] : args[1];
        const options = args.at(-1) as { signal: AbortSignal };
        assert.ok(options.signal instanceof AbortSignal, `${key} must receive a real lifetime signal`);
        const container = overlay ? document.createElement("div") as unknown as HTMLElement : args[0] as HTMLElement;
        if (overlay) root.append(container);
        const contentLife = new AbortController();
        let contentCleanup: void | (() => void);
        const record: MountRecord = { method: key, container, props, signal: options.signal, disposed: 0, updates: [], dictation: { toggle: 0, finish: 0, cancel: 0 }, handle: null! };
        if (key === "openSurface") record.target = args[0];
        const handle = {
          update(next: AnyProps) { record.updates.push(next); record.props = { ...record.props, ...next }; },
          dispose() {
            if (record.disposed) return;
            record.disposed++; contentLife.abort(); contentCleanup?.();
            if (overlay) container.remove();
          },
          toggle() { record.dictation.toggle++; },
          async finish() { record.dictation.finish++; },
          cancel() { record.dictation.cancel++; },
        };
        record.handle = handle; records.push(record);
        options.signal.addEventListener("abort", handle.dispose, { once: true });
        if (overlay && typeof props.content === "function") contentCleanup = props.content(container, contentLife.signal);
        return handle;
      };
    },
  }) as PluginUi;
  const context = new Proxy({ ui, signal: controller.signal }, {
    get(object, key) {
      if (key in object) return object[key as keyof typeof object];
      calls.push(String(key));
      throw new Error(`Gallery must not access backend, storage, inference, registration or app API: ${String(key)}`);
    },
  }) as PluginFrontendContext;
  function find(example: string, method?: string) {
    const record = records.findLast(entry => !entry.disposed && entry.container.closest(`[data-example="${example}"]`) && (!method || entry.method === method));
    assert.ok(record, `Live widget for ${example}${method ? ` (${method})` : ""}`); return record;
  }
  function state(id: string) {
    const node = root.querySelector(`[data-state="${id}"]`);
    assert.ok(node, `State readout ${id}`); return JSON.parse(node.textContent!);
  }
  function restore() {
    controller.abort();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
  return { root, context, controller, records, calls, ui, find, state, restore };
}
