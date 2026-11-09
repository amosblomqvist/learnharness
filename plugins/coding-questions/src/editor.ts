import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { bracketMatching, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginProblemEditorHandle, PluginProblemEditorProps } from "learnharness-plugin-api";
import { isReady, normalizeLineEndings, readTests, type CodingPayload, type CodingQuestionPayload } from "./contract.ts";
import { supportsSyntaxDiagnostics, syntaxDiagnosticsExtension } from "./diagnostics.ts";
import type { CodingTests } from "./test-result.ts";
import { mountTestApproval, type TestApproval } from "./tests-view.ts";

export function findLanguage(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name.trim(), false);
}

function codeFromAnswer(answer: PluginQuestionAnswerState): string {
  if (answer.status === "empty") return "";
  if (typeof answer.value !== "string") throw new Error("Coding answers must be strings.");
  return normalizeLineEndings(answer.value);
}

/** Every editor is owned by one host mount; no global editor or plugin draft store. */
function createCodeView(container: HTMLElement, language: string, code: string, active: boolean, onChange?: (code: string) => void) {
  const document = container.ownerDocument;
  const frame = document.createElement("div");
  frame.className = "lh-coding-question";
  const header = document.createElement("div");
  header.className = "lh-coding-question__header";
  const label = document.createElement("span");
  label.textContent = language;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  header.append(label, status);
  frame.append(header);
  container.append(frame);

  let disposed = false;
  let applyingControlledUpdate = false;
  const editable = new Compartment();
  const languageSupport = new Compartment();
  const reservedKeys = new Set(["Tab", "Shift-Tab", "Enter", "Shift-Enter", "Mod-Enter", "Escape"]);
  const view = new EditorView({
    parent: frame,
    state: EditorState.create({
      doc: normalizeLineEndings(code),
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        syntaxHighlighting(oneDarkHighlightStyle),
        EditorView.contentAttributes.of({ "aria-label": onChange ? "Code answer" : "Submitted code" }),
        editable.of([EditorState.readOnly.of(!active), EditorView.editable.of(active)]),
        languageSupport.of([]),
        keymap.of([...standardKeymap, ...historyKeymap].filter(binding => ![binding.key, binding.mac, binding.win, binding.linux].some(key => key !== undefined && reservedKeys.has(key)))),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !disposed && !applyingControlledUpdate && onChange) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  const languageDescription = findLanguage(language);
  if (!languageDescription) status.textContent = "Plain text";
  else {
    status.textContent = "Loading highlighting…";
    void languageDescription.load().then(support => {
      if (disposed) return;
      // Catalog support may include tag insertion, completion keymaps or other
      // editing helpers. Install only its language/parser, never those extras.
      view.dispatch({ effects: languageSupport.reconfigure([
        support.language,
        ...(onChange && supportsSyntaxDiagnostics(languageDescription.name) ? [syntaxDiagnosticsExtension()] : []),
      ]) });
      status.textContent = "";
    }).catch(() => {
      if (!disposed) status.textContent = "Plain text";
    });
  }

  return {
    view,
    update(code: string, nextActive: boolean) {
      if (disposed) return;
      const nextCode = normalizeLineEndings(code);
      const codeChanged = view.state.doc.toString() !== nextCode;
      const activeChanged = active !== nextActive;
      if (!codeChanged && !activeChanged) return;
      applyingControlledUpdate = true;
      try {
        view.dispatch({
          ...(codeChanged ? { changes: { from: 0, to: view.state.doc.length, insert: nextCode } } : {}),
          ...(activeChanged ? { effects: editable.reconfigure([EditorState.readOnly.of(!nextActive), EditorView.editable.of(nextActive)]) } : {}),
        });
        active = nextActive;
      } finally { applyingControlledUpdate = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      view.destroy();
      frame.remove();
    },
  };
}

type CodeEditorProps = Pick<PluginQuestionEditorProps, "answer" | "active" | "signal" | "onChange"> & {
  readonly input: { payload: Pick<CodingPayload, "language" | "starterCode" | "tests"> };
};

/** An invalid recipe is never run by the backend, so it needs no approval. */
function approvableTests(payload: unknown): CodingTests | null {
  try { return readTests(payload); }
  catch { return null; }
}

function mountCodeEditor(container: HTMLElement, props: CodeEditorProps): PluginQuestionEditorHandle {
  let disposed = false;
  let active = props.active;
  const initialCode = props.answer.status === "empty" ? normalizeLineEndings(props.input.payload.starterCode ?? "") : codeFromAnswer(props.answer);
  let approval: TestApproval | undefined;
  const publish = (code: string) => {
    if (disposed || props.signal.aborted) return;
    const ready = isReady(code) && (approval === undefined || approval.approved());
    props.onChange({ status: ready ? "ready" : "unready", value: code });
  };
  const editor = createCodeView(container, props.input.payload.language, initialCode, active, code => {
    if (active) publish(code);
  });
  const tests = approvableTests(props.input.payload);
  if (tests) {
    approval = mountTestApproval(container, tests, active, () => {
      if (active) publish(editor.view.state.doc.toString());
    });
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    try { approval?.dispose(); }
    finally { editor.dispose(); }
  };
  if (props.signal.aborted) dispose();
  else {
    props.signal.addEventListener("abort", dispose, { once: true });
    publish(initialCode);
  }
  return {
    update(next) {
      if (disposed) return;
      active = next.active;
      approval?.setActive(active);
      editor.update(codeFromAnswer(next.answer), active);
    },
    focus() { if (!disposed && active) editor.view.focus(); },
    handleKeyDown(key) {
      if (disposed || !active || props.signal.aborted) return "pass";
      if (key === "Tab") { indentMore(editor.view); return "handled"; }
      if (key === "Enter" || key === "Shift+Enter") { insertNewlineAndIndent(editor.view); return "handled"; }
      return "pass";
    },
    dispose,
  };
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<CodingQuestionPayload>): PluginQuestionEditorHandle {
  return mountCodeEditor(container, props);
}

/** Adapt only the public controlled-state vocabulary; no fabricated question identity. */
export function mountSubmissionEditor(container: HTMLElement, props: PluginProblemEditorProps<CodingPayload>): PluginProblemEditorHandle {
  const handle = mountCodeEditor(container, {
    input: props.input, signal: props.signal, active: props.active,
    answer: props.submission, onChange: props.onChange,
  });
  return {
    ...handle,
    update(next) { handle.update({ answer: next.submission, active: next.active }); },
  };
}

export function mountAnswered(container: HTMLElement, props: {
  readonly input: { payload: Pick<CodingPayload, "language"> };
  readonly signal: AbortSignal;
  readonly answer: string;
}): () => void {
  const editor = createCodeView(container, props.input.payload.language, props.answer, false);
  const dispose = () => {
    props.signal.removeEventListener("abort", dispose);
    editor.dispose();
  };
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
