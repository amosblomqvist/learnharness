import type { PluginFrontendContext, PluginSessionViewInput } from "learnharness-plugin-api";

export interface Reference {
  label: string;
  question: string;
  context?: string;
  options: readonly { label: string; description?: string }[];
  multiple: boolean;
  extra?: string;
}
/** Only the host-selected, learner-facing projection is consumed here. */
export function referenceFor(input: PluginSessionViewInput): Reference | undefined {
  if (input.type === "thinking") return { label: "Problem", question: input.problem.statement, options: [], multiple: false };
  if (input.type !== "answer" || !input.revealed || !input.available) return undefined;
  const question = input.question;
  const tool = question.occurrence.toolName;
  const label = tool === "probe" ? "Probe" : tool === "recall" ? "Recall" : question.kind === "quiz"
    ? question.questionType === "predict" ? "Prediction" : "Check" : question.kind === "explain" ? "Explain" : "Question";
  return {
    label, question: question.question, context: question.context, multiple: question.mode === "multi-select",
    options: question.mode === "text" ? [] : question.options.map(option => ({ label: option.label,
      ...(question.kind !== "quiz" && option.description ? { description: option.description } : {}) })),
    ...(question.mode !== "text" && question.kind === "quiz" ? { extra: "I don't know" } :
      question.mode !== "text" && question.kind === "ask" ? { extra: "Other…" } : {}),
  };
}
export function mountReference(root: HTMLElement, ctx: PluginFrontendContext, reference: Reference, signal: AbortSignal): {
  slots: HTMLElement[]; dispose(): void;
} {
  const handles: { dispose(): void }[] = [];
  const slots: HTMLElement[] = [];
  const label = document.createElement("div");
  label.className = "drawing-pad-reference-label";
  label.textContent = reference.label + (reference.multiple ? " · select all that apply" : "");
  root.append(label);
  const markdown = (parent: HTMLElement, text: string, className: string) => {
    if (!text) return;
    const target = document.createElement("div"); target.className = className;
    parent.append(target); slots.push(target);
    handles.push(ctx.ui.mountMarkdown(target, { text }, { signal }));
  };
  markdown(root, reference.question, "drawing-pad-reference-question");
  if (reference.context) markdown(root, reference.context, "drawing-pad-reference-context");
  for (const option of reference.options) {
    const row = document.createElement("div"); row.className = "drawing-pad-reference-option";
    const mark = document.createElement("span"); mark.className = "drawing-pad-reference-mark";
    mark.dataset.multiple = String(reference.multiple);
    const body = document.createElement("div");
    row.append(mark, body); root.append(row);
    markdown(body, option.label, "drawing-pad-reference-option-label");
    if (option.description) markdown(body, option.description, "drawing-pad-reference-description");
  }
  if (reference.extra) {
    const extra = document.createElement("div");
    extra.className = "drawing-pad-reference-option drawing-pad-reference-extra";
    extra.textContent = reference.extra; root.append(extra);
  }
  return { slots, dispose() { for (const handle of handles) handle.dispose(); root.replaceChildren(); } };
}
