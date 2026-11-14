import type { PluginFrontendContext } from "learnharness-plugin-api";
import { mountDisclosure } from "./disclosure.ts";

/** Historical questions without a model solution are never backfilled. */
export function mountModelSolution(container: HTMLElement, ui: Pick<PluginFrontendContext["ui"], "mountMarkdown">, value: unknown, signal: AbortSignal): () => void {
  if (typeof value !== "string" || !/\S/.test(value)) return () => {};
  return mountDisclosure(container, "model-solution", "Model solution", signal, body => {
    const markdown = ui.mountMarkdown(body, { text: value }, { signal });
    return () => markdown.dispose();
  });
}
