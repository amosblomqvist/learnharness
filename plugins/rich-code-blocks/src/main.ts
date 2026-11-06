import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import { FAMILIES, LABELS, LANGUAGES, parseSettings, type Family, type Settings } from "./contract.ts";
import { RenderService } from "./render.ts";

export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  const rendering = new RenderService();
  let current: Settings | undefined;
  let registration: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  const renderers = new Map<Family, () => void>();
  const subscriptions: (() => void)[] = [];
  let disposed = false;
  let resync: Promise<void> = Promise.resolve();
  const rows = (settings: Settings): PluginSettingsSchema["rows"] => FAMILIES.map(family => ({
    key: family, type: "toggle", label: LABELS[family], value: settings[family],
    async onChange(enabled: boolean) {
      const accepted = await ctx.call("set-family", { family, enabled });
      if (!disposed && !ctx.signal.aborted) apply(accepted);
    },
  }));
  function apply(value: unknown): void {
    if (disposed || ctx.signal.aborted) return;
    const next = parseSettings(value);
    if (current && next.revision <= current.revision) return;
    current = next;
    for (const family of FAMILIES) {
      const unregister = renderers.get(family);
      if (next[family] && !unregister) renderers.set(family, ctx.registerCodeBlock({
        language: LANGUAGES[family], mount: (container, block) => rendering.mount(container, block),
      }));
      else if (!next[family] && unregister) { unregister(); renderers.delete(family); }
    }
    if (!next.technicalDiagrams) rendering.stopTex();
    rendering.clearCache();
    if (registration) registration.update({ rows: rows(next) });
    else registration = ctx.registerSettings({ rows: rows(next) });
  }
  function refresh(): Promise<void> {
    // A reconnect needs a fresh read after any older in-flight snapshot, not a
    // join to a read captured before notifications were lost. No standing polling.
    const task = resync.catch(() => {}).then(async () => {
      if (!disposed && !ctx.signal.aborted) apply(await ctx.call("get-settings"));
    });
    resync = task;
    return task;
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    renderers.forEach(unregister => unregister()); renderers.clear();
    registration?.dispose(); rendering.dispose();
  };
  ctx.cleanup(dispose);
  subscriptions.push(ctx.onNotification(event => {
    if (event.topic === "settings-changed") apply(event.data);
  }));
  subscriptions.push(ctx.onResync(() => {
    void refresh().catch(error => { if (!disposed) console.error("Rich code blocks settings resync failed; retaining the last accepted settings.", error); });
  }));
  try { await refresh(); }
  catch (error) { dispose(); throw error; }
  return dispose;
}
