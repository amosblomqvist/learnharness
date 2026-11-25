import type { PluginFrontendContext } from "learnharness-plugin-api";
import { mountDisclosure } from "./disclosure.ts";
import type { CodingTestResult } from "./test-result.ts";

/** The badge uses the host heading; output stays in the provided footer/body slot. */
export function mountTestResult(container: HTMLElement, ui: Pick<PluginFrontendContext["ui"], "mountBadge">, result: CodingTestResult, signal: AbortSignal, headerContainer?: HTMLElement): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-coding-test-result";
  root.dataset.testStatus = result.status;
  const badgeRoot = document.createElement("span");
  badgeRoot.className = "lh-coding-test-result__badge";
  badgeRoot.dataset.testStatus = result.status;
  (headerContainer ?? root).append(badgeRoot);
  container.append(root);
  let badge: ReturnType<PluginFrontendContext["ui"]["mountBadge"]> | undefined;
  let outputCleanup: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    try { outputCleanup?.(); }
    finally {
      try { badge?.dispose(); }
      finally { badgeRoot.remove(); root.remove(); }
    }
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    badge = ui.mountBadge(badgeRoot, {
      text: result.status === "passed" ? "Tests passed" : result.status === "failed" ? "Tests failed" : "Could not run tests",
      ...(result.status === "passed" ? { color: "var(--color-green-500, #22c55e)" } : result.status === "failed" ? { color: "var(--color-red-500, #ef4444)" } : {}),
    }, { signal });
    if (disposed) { badge.dispose(); return dispose; }
    if (result.stdout !== "" || result.stderr !== "" || result.message || result.stdoutTruncated || result.stderrTruncated) {
      outputCleanup = mountDisclosure(root, "test-output", "Test output", signal, body => {
        if (result.message) {
          const message = document.createElement("p");
          message.textContent = result.message;
          body.append(message);
        }
        for (const [label, text, truncated] of [["Stdout", result.stdout, result.stdoutTruncated], ["Stderr", result.stderr, result.stderrTruncated]] as const) {
          if (text !== "") {
            const block = document.createElement("div");
            block.className = "lh-coding-question";
            const heading = document.createElement("div");
            heading.className = "lh-coding-question__header";
            heading.textContent = label;
            const output = document.createElement("pre");
            output.textContent = text;
            block.append(heading, output);
            body.append(block);
          }
          if (truncated) {
            const notice = document.createElement("p");
            notice.textContent = `${label} truncated at 64 KiB.`;
            body.append(notice);
          }
        }
      });
      if (disposed) outputCleanup();
    }
  } catch (error) { dispose(); throw error; }
  return dispose;
}
