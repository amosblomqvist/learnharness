import type { PluginFrontendContext, PluginQuestionGradingOutcome, PluginQuestionMountContext } from "learnharness-plugin-api";
import { mountAudioControl } from "./audio-control.ts";
import { element } from "./dom.ts";
import { optionKey, readGrading, type ListeningAnswer, type ListeningPayload } from "./contract.ts";
import { failed, finished, startedAt, type PlaybackStore } from "./playback-state.ts";
import type { LoadedAudio } from "./player.ts";

type Ui = Pick<PluginFrontendContext["ui"], "mountMarkdown" | "mountBadge">;
type Load = (text: string, language: string) => Promise<LoadedAudio>;

/** Run each cleanup even if an earlier one throws. */
function combine(cleanups: (() => void)[]): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    let failure: unknown;
    for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  };
}


function markdown(container: HTMLElement, ui: Ui, className: string, text: string, signal: AbortSignal): () => void {
  const root = element(container.ownerDocument, "div", className);
  container.append(root);
  const handle = ui.mountMarkdown(root, { text }, { signal });
  return () => { try { handle.dispose(); } finally { root.remove(); } };
}

/** Pending question: gated audio above the authored question. */
export function mountQuestion(container: HTMLElement, props: PluginQuestionMountContext<ListeningPayload>, deps: { ui: Ui; load: Load; store: PlaybackStore }): () => void {
  if (props.signal.aborted) return () => {};
  const { questionId, signal } = props;
  const { text, language } = props.input.payload.audio;
  const cleanups: (() => void)[] = [];
  const dispose = combine(cleanups);
  try {
    cleanups.push(mountAudioControl(container, {
      text, language, load: deps.load, signal, mode: "pending",
      completed: () => deps.store.get(questionId).completed,
      onStarted: rate => deps.store.update(questionId, record => startedAt(record, rate)),
      onEnded: () => deps.store.update(questionId, finished),
      onFailed: () => deps.store.update(questionId, failed),
      continueAnotherWay: {
        available: () => deps.store.get(questionId).failures >= 2,
        run: () => deps.store.update(questionId, record => ({ ...record, audioUnavailable: true })),
      },
    }));
    cleanups.push(markdown(container, deps.ui, "lh-listening-prompt", props.input.question, signal));
  } catch (error) { dispose(); throw error; }
  return dispose;
}

function mountBadge(header: HTMLElement, ui: Ui, text: string, color: string | undefined, signal: AbortSignal): () => void {
  const slot = element(header.ownerDocument, "span", "lh-listening-badge");
  header.append(slot);
  const handle = ui.mountBadge(slot, { text, ...(color ? { color } : {}) }, { signal });
  return () => { try { handle.dispose(); } finally { slot.remove(); } };
}

function mountWhy(container: HTMLElement, ui: Ui, explanation: string, signal: AbortSignal): () => void {
  const document = container.ownerDocument;
  const root = element(document, "div", "lh-listening-why");
  const toggle = element(document, "button", "lh-listening-why__toggle", "Why");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  root.append(toggle);
  container.append(root);
  let body: (() => void) | undefined;
  const onClick = () => {
    if (body) { body(); body = undefined; toggle.textContent = "Why"; toggle.setAttribute("aria-expanded", "false"); return; }
    toggle.textContent = "Hide why";
    toggle.setAttribute("aria-expanded", "true");
    body = markdown(root, ui, "lh-listening-why__body", `**Why:** ${explanation}`, signal);
  };
  toggle.addEventListener("click", onClick);
  return () => { toggle.removeEventListener("click", onClick); try { body?.(); } finally { root.remove(); } };
}

/** Answered card: verdict, options or answers, then the transcript with replay. */
export function mountAnswered(container: HTMLElement, props: PluginQuestionMountContext<ListeningPayload> & { readonly answer: ListeningAnswer; readonly grading?: PluginQuestionGradingOutcome; readonly headerContainer?: HTMLElement; readonly footerContainer?: HTMLElement }, deps: { ui: Ui; load: Load }): () => void {
  if (props.signal.aborted) return () => {};
  const document = container.ownerDocument;
  const { payload } = props.input;
  const { answer, signal } = props;
  const footer = props.footerContainer ?? container;
  const grading = props.grading && "result" in props.grading ? readGrading(props.grading.result) : {};
  const cleanups: (() => void)[] = [];
  const dispose = combine(cleanups);
  try {
    const header = props.headerContainer ?? container;
    if (answer.status === "audio_unavailable") cleanups.push(mountBadge(header, deps.ui, "audio unavailable", undefined, signal));
    else if (grading.correct !== undefined) cleanups.push(mountBadge(header, deps.ui, grading.correct ? "correct" : "incorrect", grading.correct ? "var(--lh-success)" : "var(--lh-error)", signal));

    cleanups.push(markdown(container, deps.ui, "lh-listening-prompt", props.input.question, signal));
    const body = element(document, "div", "lh-listening-answered");
    container.append(body);
    cleanups.push(() => body.remove());

    if (answer.status === "audio_unavailable") {
      body.append(element(document, "p", "lh-listening-note", "Audio was unavailable, so the learner continued another way. Listening was not assessed."));
    } else if (payload.format === "choice" && "choice" in answer) {
      const list = element(document, "div", "lh-listening-options lh-listening-options--answered");
      const correctKey = payload.correctAnswer.trim();
      for (const option of payload.options ?? []) {
        const key = optionKey(option);
        const selected = key === answer.choice, correct = key === correctKey;
        const row = element(document, "div", "lh-listening-option");
        row.dataset.selected = String(selected);
        row.dataset.correct = String(correct);
        const mark = element(document, "span", "lh-listening-option__mark", correct ? "✓" : selected ? "✗" : "");
        mark.setAttribute("aria-hidden", "true");
        const text = element(document, "span", "lh-listening-option__label", option.label);
        if (selected || correct) text.setAttribute("aria-label", `${option.label} (${[selected ? "your answer" : "", correct ? "correct" : ""].filter(Boolean).join(", ")})`);
        row.append(mark, text);
        list.append(row);
      }
      body.append(list);
      if (payload.explanation?.trim()) cleanups.push(mountWhy(footer, deps.ui, payload.explanation, signal));
    } else if ("text" in answer) {
      body.append(element(document, "p", "lh-listening-recall-answer", `“${answer.text}”`));
      const committed = element(document, "div", "lh-listening-committed");
      committed.append(element(document, "span", "lh-listening-committed__label", "The answer: "));
      body.append(committed);
      cleanups.push(markdown(committed, deps.ui, "lh-listening-committed__text", payload.correctAnswer, signal));
    }

    const transcript = element(document, "div", "lh-listening-transcript");
    transcript.append(element(document, "div", "lh-listening-transcript__label", "Transcript"));
    const transcriptText = element(document, "p", "lh-listening-transcript__text", payload.audio.text);
    transcriptText.lang = payload.audio.language;
    transcript.append(transcriptText);
    footer.append(transcript);
    cleanups.push(() => transcript.remove());
    cleanups.push(mountAudioControl(transcript, { text: payload.audio.text, language: payload.audio.language, load: deps.load, signal, mode: "replay" }));
  } catch (error) { dispose(); throw error; }
  return dispose;
}
