import type {
  PluginFrontendContext, PluginModelValue, PluginThinkingPickerProps, PluginStandardComposerProps,
  PluginSettingsSchema, PluginWidgetHandle,
  PluginThinkingPickerProps as ThinkingProps, PluginButtonProps,
} from "learnharness-plugin-api";
import { Scope, button, element, example, family, note, readout, row } from "./dom.ts";
import { mountOverlayExamples, openPageSurfaceDemo } from "./surfaces.ts";
import { mountTreeDemo } from "./tree.ts";

type Thinking = PluginThinkingPickerProps["value"];
export const FAMILY_IDS = ["pickers", "composer", "dictation", "standard-composer", "buttons", "settings", "markdown", "tree", "worker-results", "menus", "dialogs", "surfaces"] as const;

export function mountGallery(container: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal): () => void {
  const scope = new Scope(signal);
  if (signal.aborted) return scope.dispose;
  const root = element("div", undefined, "ui-showcase");
  root.dataset.showcase = "gallery";
  container.append(root);
  scope.own(() => root.remove());
  note(root, "Host UI examples. Values and callback readouts are local to this view and reset when you leave. Send and Stop only simulate local state; they do not call a model. Dictation is real and uses your configured speech provider only when explicitly started.");
  const ui = ctx.ui;

  family(ui, root, scope, "pickers", "Pickers", (body, life) => {
    note(body, "The model and thinking controls use the real host catalog. Their linked choices stay in this family; core defaults are not changed.");
    let model: PluginModelValue | undefined;
    let thinking: Thinking;
    let lastCallback = "none";
    const show = readout(body, "pickers");
    let thinkingPicker: PluginWidgetHandle<ThinkingProps>;
    const modelPicker = life.widget(ui.mountModelPicker(example(body, "model-picker", "Model"), {
      value: model, onChange(value) {
        if (life.signal.aborted) return;
        model = value; thinking = undefined; lastCallback = "model.onChange (thinking cleared)";
        modelPicker.update({ value: model });
        thinkingPicker.update({ model, value: thinking }); render();
      },
    }, { signal: life.signal }));
    thinkingPicker = life.widget(ui.mountThinkingPicker(example(body, "thinking-picker", "Thinking for this model"), {
      model, value: thinking, onChange(value) {
        if (life.signal.aborted) return;
        thinking = value; lastCallback = "thinking.onChange";
        thinkingPicker.update({ value }); render();
      },
    }, { signal: life.signal }));
    let knowledge: readonly string[] = [];
    note(body, "Selection stays local to this demo. The host picker also offers source-management actions; those affect your real sources.");
    const knowledgePicker = life.widget(ui.mountKnowledgePicker(example(body, "knowledge-picker", "Knowledge selection"), {
      value: knowledge, onChange(value) {
        if (life.signal.aborted) return;
        knowledge = [...value]; lastCallback = "knowledge.onChange";
        knowledgePicker.update({ value: knowledge }); render();
      },
    }, { signal: life.signal }));
    function render() { show({ model: model ?? null, thinking: thinking ?? null, knowledge, lastCallback }); }
    render();
  });

  family(ui, root, scope, "composer", "Composer", (body, life) => {
    note(body, "Send enters a local busy state and retains your draft. While busy with a nonempty draft, the host keeps Send available for steering. Clear the draft to expose Stop, or use Complete simulation, which is available throughout the busy state. Nothing is sent or saved.");
    let value = ""; let busy = false; let sends = 0; let lastCallback = "none";
    const show = readout(body, "composer");
    const composer = life.widget(ui.mountComposer(example(body, "composer", "Independent composer"), {
      value, placeholder: "Type a local draft", autoFocus: false, canSend: false,
      onChange(next) { if (!life.signal.aborted) { value = next; lastCallback = "onChange"; render(); } },
      onSend() { if (!life.signal.aborted && value.trim()) { busy = true; sends++; lastCallback = "onSend (local simulation)"; render(); } },
      onStop() { if (!life.signal.aborted) { busy = false; lastCallback = "onStop (local simulation)"; render(); } },
    }, { signal: life.signal }));
    const complete = button(ui, body, life, "complete-composer", { label: "Complete simulation", disabled: true, variant: "outline", onClick() { busy = false; lastCallback = "simulation completed"; render(); } });
    function render() { composer.update({ value, busy, canSend: !!value.trim() }); complete.update({ disabled: !busy }); show({ draft: value, busy, sends, lastCallback }); }
    render();
  });

  family(ui, root, scope, "dictation", "Dictation", (body, life) => {
    note(body, "Real dictation: explicitly choose Dictate or the microphone to use your configured speech provider. This can send audio to that provider and may incur cost. Nothing starts automatically. Finish awaits final transcript delivery; Cancel affects only this control's recording, not another owner.");
    let transcript = ""; let deliveries = 0; let lastCallback = "none";
    const show = readout(body, "dictation");
    const dictation = ui.mountDictation(example(body, "dictation", "Host dictation control"), {
      onTranscript(text) { if (!life.signal.aborted) { transcript = join(transcript, text); deliveries++; lastCallback = "onTranscript"; render(); } },
    }, { signal: life.signal });
    life.own(() => dictation.dispose());
    const controls = row(body);
    button(ui, controls, life, "dictate", { label: "Dictate", onClick() { lastCallback = "toggle requested (not recording status)"; render(); dictation.toggle(); } });
    button(ui, controls, life, "finish-dictation", { label: "Finish dictation", variant: "outline", async onClick() {
      await dictation.finish();
      if (!life.signal.aborted) { lastCallback = "finish resolved after final delivery"; render(); }
    } });
    button(ui, controls, life, "cancel-dictation", { label: "Cancel dictation", variant: "outline", onClick() { dictation.cancel(); lastCallback = "cancel requested"; render(); } });
    function render() { show({ transcript, deliveries, lastCallback }); }
    render();
  });

  family(ui, root, scope, "standard-composer", "Standard composer", (body, life) => {
    note(body, "Independent local model, thinking and draft state. Send waits for final dictation delivery through the host API before this local simulation and retains your draft. While busy with a nonempty draft, the host keeps Send available for steering. Clear the draft to expose Stop, or use Complete simulation, which is available throughout the busy state. The microphone explicitly starts real dictation using your configured speech provider; it may send audio and incur cost.");
    let value = ""; let model: PluginModelValue | undefined; let thinking: Thinking;
    let busy = false; let sends = 0; let deliveries = 0; let lastCallback = "none"; let lastSent = "";
    const show = readout(body, "standard-composer");
    let composer: PluginWidgetHandle<PluginStandardComposerProps>;
    let complete: PluginWidgetHandle<PluginButtonProps>;
    const props = (): PluginStandardComposerProps => ({
      composer: {
        value, busy, autoFocus: false, placeholder: "Independent local draft",
        onChange(next) { if (!life.signal.aborted) { value = next; lastCallback = "composer.onChange"; render(); } },
        onSend() { if (!life.signal.aborted && value.trim()) { lastSent = value; busy = true; sends++; lastCallback = "composer.onSend (after final dictation; local simulation)"; render(); } },
        onStop() { if (!life.signal.aborted) { busy = false; lastCallback = "composer.onStop (local simulation)"; render(); } },
      },
      model: { value: model, onChange(next) { if (!life.signal.aborted) { model = next; thinking = undefined; lastCallback = "model.onChange (thinking cleared)"; render(); } } },
      thinking: { model, value: thinking, onChange(next) { if (!life.signal.aborted) { thinking = next; lastCallback = "thinking.onChange"; render(); } } },
      dictation: { onTranscript(text) { if (!life.signal.aborted) { value = join(value, text); deliveries++; lastCallback = "dictation.onTranscript (draft updated)"; render(); } } },
    });
    composer = life.widget(ui.mountStandardComposer(example(body, "standard-composer", "Host standard composer"), props(), { signal: life.signal }));
    complete = button(ui, body, life, "complete-standard-composer", { label: "Complete simulation", variant: "outline", disabled: true, onClick() { busy = false; lastCallback = "simulation completed"; render(); } });
    function render() { composer.update(props()); complete.update({ disabled: !busy }); show({ draft: value, model: model ?? null, thinking: thinking ?? null, busy, sends, deliveries, lastSent, lastCallback }); }
    render();
  });

  family(ui, root, scope, "buttons", "Buttons", (body, life) => {
    note(body, "The host button currently does not automatically show a pending or disabled style while an async callback awaits. This example's pending readout and Complete async example control are local to the demo.");
    let clicks = 0; let lastCallback = "none"; let pending: (() => void) | undefined;
    const show = readout(body, "buttons");
    const variants = row(body);
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost", "link"] as const) {
      button(ui, variants, life, `button-variant-${variant}`, { label: variant, variant, onClick() { clicks++; lastCallback = `variant: ${variant}`; render(); } });
    }
    const sizes = row(body);
    for (const size of ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const) {
      const icon = size.startsWith("icon");
      const slot = example(sizes, `button-size-${size}`, size);
      life.widget(ui.mountButton(slot, { label: icon ? "+" : size, title: icon ? `Add example (${size})` : `${size} size`, size, variant: "outline", onClick() { clicks++; lastCallback = `size: ${size}`; render(); } }, { signal: life.signal }));
    }
    note(body, "Badges use plugin-supplied text and a single color with a 15% background tint. These are static examples, not grading results.");
    const badges = row(body);
    for (const [id, props] of [
      ["neutral", { text: "Neutral" }],
      ["green", { text: "Tests passed", color: "#22c55e" }],
      ["red", { text: "Tests failed", color: "#ef4444" }],
      ["amber", { text: "With hints", color: "#f59e0b" }],
    ] as const) {
      life.widget(ui.mountBadge(example(badges, `badge-${id}`), props, { signal: life.signal }));
    }
    button(ui, body, life, "button-disabled", { label: "Disabled", disabled: true, onClick() { throw new Error("Disabled example must not run"); } });
    const actions = row(body);
    button(ui, actions, life, "button-async", { label: "Start async example", onClick() {
      if (pending || life.signal.aborted) return;
      lastCallback = "async callback pending";
      const promise = new Promise<void>(resolve => { pending = resolve; });
      render();
      return promise;
    } });
    const complete = button(ui, actions, life, "complete-button-async", { label: "Complete async example", variant: "outline", disabled: true, onClick() { finish(); lastCallback = "async callback completed"; render(); } });
    function finish() { const resolve = pending; pending = undefined; resolve?.(); }
    life.own(finish);
    function render() { complete.update({ disabled: !pending }); show({ clicks, pending: !!pending, lastCallback }); }
    render();
  });

  family(ui, root, scope, "settings", "Settings rows", (body, life) => {
    note(body, "All values stay local. Text must contain at least three non-space characters. Number and slider values must be whole numbers in their displayed range. Invalid edits are rejected by the host before onChange.");
    let enabled = true; let text = "Example"; let choice = "first"; let count = 3; let amount = 50; let lastCallback = "none";
    const show = readout(body, "settings");
    const update = (key: string, apply: () => void) => { if (!life.signal.aborted) { apply(); lastCallback = `${key}.onChange`; render(); } };
    const schema = (): PluginSettingsSchema => ({ rows: [
      { key: "toggle", type: "toggle", label: "Toggle example", description: "A local boolean value.", value: enabled, onChange: value => update("toggle", () => { enabled = value; }) },
      { key: "text", type: "text", label: "Text example", description: "At least three non-space characters.", value: text, validate: value => value.trim().length < 3 ? "Enter at least three non-space characters." : undefined, onChange: value => update("text", () => { text = value; }) },
      { key: "dropdown", type: "dropdown", label: "Dropdown example", description: "Choose one of two local options.", value: choice, options: [{ value: "first", label: "First option" }, { value: "second", label: "Second option" }], onChange: value => update("dropdown", () => { choice = value; }) },
      { key: "number", type: "number", label: "Number example", description: "Whole number from 1 to 10.", value: count, min: 1, max: 10, step: 1, validate: value => Number.isInteger(value) ? undefined : "Enter a whole number.", onChange: value => update("number", () => { count = value; }) },
      { key: "slider", type: "slider", label: "Slider example", description: "Whole number from 0 to 100.", value: amount, min: 0, max: 100, step: 1, validate: value => Number.isInteger(value) ? undefined : "Choose a whole number.", onChange: value => update("slider", () => { amount = value; }) },
      { key: "disabled", type: "text", label: "Disabled example", description: "This row cannot be edited.", value: "Unavailable", disabled: true, onChange() {} },
    ] });
    const settings = life.widget(ui.mountSettingsRows(example(body, "settings-rows"), schema(), { signal: life.signal }));
    function render() { settings.update(schema()); show({ enabled, text, choice, count, amount, lastCallback }); }
    render();
  });

  family(ui, root, scope, "markdown", "Markdown", (body, life) => {
    note(body, "Static host rendering: prose, code, table, math and Mermaid. No images, remote resources or model calls.");
    life.widget(ui.mountMarkdown(example(body, "markdown"), { text: MARKDOWN }, { signal: life.signal }));
    readout(body, "markdown")({ mode: "static", lastCallback: "none" });
  });

  family(ui, root, scope, "tree", "Directory / tree", (body, life) => mountTreeDemo(ui, body, life));

  family(ui, root, scope, "worker-results", "Worker results", (body, life) => {
    note(body, "Twelve static examples: all four terminal statuses with all three presentations. No workers are started.");
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      for (const presentation of ["collapsed", "card", "plain"] as const) {
        life.widget(ui.mountWorkerResult(example(body, `worker-${status}-${presentation}`, `${status} / ${presentation}`), {
          label: "Example worker", status, presentation,
          text: `**Static example:** ${status}. No worker was run.`,
        }, { signal: life.signal }));
      }
    }
    readout(body, "worker-results")({ examples: 12, workersStarted: 0, lastCallback: "none" });
  });

  family(ui, root, scope, "menus", "Menus", (body, life) => mountOverlayExamples(ui, body, life, "menus"));
  family(ui, root, scope, "dialogs", "Dialogs", (body, life) => mountOverlayExamples(ui, body, life, "dialogs"));
  family(ui, root, scope, "surfaces", "Surfaces", (body, life) => {
    note(body, "Open a nonmodal host surface over the current page body. Its page top bar or floating sidebar control stays outside; the sidebar and global dialogs remain available. Navigating away closes the surface.");
    note(body, "The same demo is also available from a native teaching or practice session's UI Showcase surface top-bar action. Both include background presets, retained text, nested surfaces, and menus/dialogs above the surface. Escape and focus remain entirely host-owned.");
    let opens = 0; let closed = 0; let lastCallback = "none";
    const show = readout(body, "surfaces");
    const render = () => show({ target: "current page", opens, closed, lastCallback });
    button(ui, body, life, "open-surface", { label: "Open surface", variant: "outline", onClick() {
      if (life.signal.aborted) return;
      opens++; lastCallback = "openSurface (current page body)"; render();
      life.widget(openPageSurfaceDemo(ui, life.signal, () => {
        if (life.signal.aborted) return;
        closed++; lastCallback = "surface.onClose"; render();
      }));
    } });
    render();
  });
  return scope.dispose;
}

function join(current: string, text: string): string { return current ? `${current}\n${text}` : text; }

const MARKDOWN = `A **host-rendered** paragraph with *emphasis*, inline \`code\`, and a short list:

- Complete static content
- Built-in renderers only

\`\`\`ts
const message: string = "Hello, gallery";
console.log(message);
\`\`\`

| Example | Value |
| --- | --- |
| Local state | Ephemeral |
| Model calls | None |

Inline math: $a^2 + b^2 = c^2$.

$$
\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}
$$

\`\`\`mermaid
flowchart LR
  A[Local input] --> B[Host widget]
  B --> C[Local callback]
\`\`\`
`;
