import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { CodingTestResult } from "./test-result.ts";

/** The host owns the heading slot; output and fallback placement stay plugin-owned. */
export function mountTestResult(container: HTMLElement, ui: PluginFrontendContext["ui"], result: CodingTestResult, signal: AbortSignal, headerContainer?: HTMLElement): () => void {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-coding-test-result";
  root.dataset.testStatus = result.status;
  const badgeRoot = document.createElement("span");
  badgeRoot.className = "lh-coding-test-result__badge";
  badgeRoot.dataset.testStatus = result.status;
  (headerContainer ?? root).append(badgeRoot);
  const badge = ui.mountBadge(badgeRoot, {
    text: result.status === "passed" ? "Tests passed" : result.status === "failed" ? "Tests failed" : "Could not run tests",
    ...(result.status === "passed" ? { color: "var(--color-green-500, #22c55e)" } : result.status === "failed" ? { color: "var(--color-red-500, #ef4444)" } : {}),
  }, { signal });
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Test output";
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.classList.add("lh-coding-test-result__chevron");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) chevron.setAttribute(name, value);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  chevron.append(path);
  summary.append(chevron);
  details.append(summary);
  if (result.message !== undefined) {
    const message = document.createElement("p");
    message.textContent = result.message;
    details.append(message);
  }
  for (const [label, text, truncated] of [["Stdout", result.stdout, result.stdoutTruncated], ["Stderr", result.stderr, result.stderrTruncated]] as const) {
    const block = document.createElement("div");
    block.className = "lh-coding-question";
    const heading = document.createElement("div");
    heading.className = "lh-coding-question__header";
    heading.textContent = label;
    const output = document.createElement("pre");
    output.textContent = text;
    block.append(heading, output);
    details.append(block);
    if (truncated) {
      const notice = document.createElement("p");
      notice.textContent = `${label} truncated at 64 KiB.`;
      details.append(notice);
    }
  }
  root.append(details);
  container.append(root);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    try { badge.dispose(); }
    finally { badgeRoot.remove(); root.remove(); }
  };
  if (signal.aborted) dispose();
  else signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
