import type { PluginFrontendContext, PluginUi } from "learnharness-plugin-api";
import { Scope } from "./dom.ts";
import { mountGallery } from "./gallery.ts";
import { openSurfaceDemo } from "./surfaces.ts";

export const REQUIRED_UI_METHODS = [
  "mountModelPicker", "mountThinkingPicker", "mountKnowledgePicker", "mountComposer",
  "mountDictation", "mountStandardComposer", "mountButton", "mountSettingsRows",
  "mountMarkdown", "mountWorkerResult", "openMenu", "openDialog", "openSurface",
] as const satisfies readonly (keyof PluginUi)[];

export function activate(ctx: PluginFrontendContext): () => void {
  const missing = REQUIRED_UI_METHODS.filter(method => typeof ctx.ui?.[method] !== "function");
  for (const method of ["registerView", "registerAction", "placeAction"] as const) {
    if (typeof ctx[method] !== "function") missingCapabilities(method);
  }
  if (missing.length) missingCapabilities(missing.map(method => `ui.${method}`).join(", "));
  const scope = new Scope(ctx.signal);
  if (scope.signal.aborted) return scope.dispose;
  scope.own(ctx.registerView({ id: "gallery", name: "UI Showcase", mount: (root, signal) => mountGallery(root, ctx, signal) }));
  scope.own(ctx.registerAction({ id: "open-gallery", name: "UI Showcase", run: () => ctx.app.openView("gallery") }));
  scope.own(ctx.placeAction({ id: "gallery-sidebar", actionId: "open-gallery", location: "sidebar" }));
  scope.own(ctx.registerAction({
    id: "open-surface", name: "UI Showcase surface",
    run(context) {
      if (context.placement !== "top-bar" || context.surface !== "session") {
        throw new Error("UI Showcase surface requires a native session top-bar context.");
      }
      scope.widget(openSurfaceDemo(ctx.ui, context.surfaceTarget, scope.signal));
    },
  }));
  scope.own(ctx.placeAction({ id: "surface-topbar", actionId: "open-surface", location: "top-bar", sessions: ["teaching", "practice"] }));
  return scope.dispose;
}

function missingCapabilities(names: string): never {
  throw new Error(`UI Showcase requires the current feature/plugin-architecture public UI API. Missing capabilities: ${names}. No fallback UI is provided.`);
}
