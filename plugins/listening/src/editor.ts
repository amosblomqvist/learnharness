import type { JsonValue, PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { optionKey, type ListeningOption, type ListeningPayload } from "./contract.ts";
import type { PlaybackRecord, PlaybackStore } from "./playback-state.ts";

/** mulberry32 seeded by a string, as the builtin quiz does: stable order per question. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleOptions<T>(options: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  const out = [...options];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type Draft = { choice?: string; text?: string };

function readDraft(answer: PluginQuestionAnswerState): Draft {
  if (answer.status === "empty" || !answer.value || typeof answer.value !== "object" || Array.isArray(answer.value)) return {};
  const value = answer.value as Record<string, JsonValue>;
  return {
    ...(typeof value.choice === "string" ? { choice: value.choice } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
}

/** Readiness requires one full playback and an answer, or the learner's Continue another way. */
export function answerState(format: ListeningPayload["format"], draft: Draft, record: PlaybackRecord): PluginQuestionAnswerState {
  if (record.audioUnavailable) return { status: "ready", value: { status: "audio_unavailable" } };
  const rates = [...record.rates];
  const listened = record.completed && rates.length > 0;
  if (format === "choice") {
    if (draft.choice === undefined) return { status: "empty" };
    return { status: listened ? "ready" : "unready", value: { status: "answered", choice: draft.choice, playbackRates: rates } };
  }
  const text = draft.text ?? "";
  if (text === "") return { status: "empty" };
  return { status: listened && /\S/.test(text) ? "ready" : "unready", value: { status: "answered", text, playbackRates: rates } };
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<ListeningPayload>, store: PlaybackStore): PluginQuestionEditorHandle {
  const document = container.ownerDocument;
  const payload = props.input.payload;
  const root = document.createElement("div");
  root.className = "lh-listening-editor";
  const hint = document.createElement("p");
  hint.className = "lh-listening-editor__hint";
  hint.setAttribute("role", "status");
  container.append(root);

  let disposed = false;
  let active = props.active;
  let draft = readDraft(props.answer);
  const radios: HTMLInputElement[] = [];
  let textarea: HTMLTextAreaElement | undefined;

  if (payload.format === "choice") {
    const group = document.createElement("div");
    group.className = "lh-listening-options";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Answer options");
    const name = `lh-listening-${props.questionId}`;
    for (const option of shuffleOptions<ListeningOption>(payload.options ?? [], props.questionId)) {
      const label = document.createElement("label");
      label.className = "lh-listening-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = optionKey(option);
      const text = document.createElement("span");
      text.textContent = option.label;
      label.append(input, text);
      group.append(label);
      radios.push(input);
      input.addEventListener("change", () => {
        if (!input.checked || !active) return;
        draft = { choice: input.value };
        publish();
      });
    }
    root.append(group);
  } else {
    textarea = document.createElement("textarea");
    textarea.className = "lh-listening-recall";
    textarea.rows = 3;
    textarea.placeholder = "Answer in your own words";
    textarea.setAttribute("aria-label", "Your answer");
    textarea.addEventListener("input", () => {
      if (!active || !textarea) return;
      draft = { text: textarea.value };
      publish();
    });
    root.append(textarea);
  }
  root.append(hint);

  const apply = () => {
    for (const radio of radios) { radio.checked = radio.value === draft.choice; radio.disabled = !active || store.get(props.questionId).audioUnavailable; }
    if (textarea) {
      if (textarea.value !== (draft.text ?? "")) textarea.value = draft.text ?? "";
      textarea.disabled = !active || store.get(props.questionId).audioUnavailable;
    }
    const record = store.get(props.questionId);
    hint.textContent = record.audioUnavailable ? "Audio is unavailable. Submit to continue another way; listening will not be assessed."
      : record.completed ? "" : "Submit unlocks after you listen all the way through once.";
    hint.hidden = hint.textContent === "";
  };
  const publish = () => {
    if (disposed || props.signal.aborted) return;
    props.onChange(answerState(payload.format, draft, store.get(props.questionId)));
  };
  const unsubscribe = store.subscribe(props.questionId, () => { apply(); publish(); });
  apply();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    unsubscribe();
    root.remove();
  };
  if (props.signal.aborted) dispose();
  else {
    props.signal.addEventListener("abort", dispose, { once: true });
    publish();
  }
  return {
    update(next) {
      if (disposed) return;
      active = next.active;
      // Controlled update: adopt the host's answer, but never echo it back.
      const incoming = readDraft(next.answer);
      if (next.answer.status !== "empty" || (draft.choice === undefined && draft.text === undefined)) draft = incoming;
      apply();
    },
    focus() {
      if (disposed || !active) return;
      (textarea ?? radios.find(radio => radio.checked) ?? radios[0])?.focus();
    },
    dispose,
  };
}
