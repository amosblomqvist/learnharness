import type { PluginFrontendContext } from "learnharness-plugin-api";
import { mountSettings } from "./settings-view.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerSettings((container, signal) => mountSettings(container, signal, ctx));
}
