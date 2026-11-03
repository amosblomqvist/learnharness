import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { bracketMatching, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginQuestionMountContext } from "learnharness-plugin-api";
import { isReady, normalizeLineEndings, type CodingQuestionPayload } from "./contract.ts";

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
      view.dispatch({ effects: languageSupport.reconfigure(support.language) });
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

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<CodingQuestionPayload>): PluginQuestionEditorHandle {
  let disposed = false;
  let active = props.active;
  const initialCode = props.answer.status === "empty" ? normalizeLineEndings(props.input.payload.starterCode ?? "") : codeFromAnswer(props.answer);
  const publish = (code: string) => {
    if (!disposed && !props.signal.aborted) props.onChange({ status: isReady(code) ? "ready" : "unready", value: code });
  };
  const editor = createCodeView(container, props.input.payload.language, initialCode, active, code => {
    if (active) publish(code);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    editor.dispose();
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
      editor.update(codeFromAnswer(next.answer), active);
    },
    focus() { if (!disposed && active) editor.view.focus(); },
    handleKeyDown(key) {
      if (disposed || !active || props.signal.aborted) return "pass";
      if (key === "Tab") { indentMore(editor.view); return "handled"; }
      if (key === "Shift+Enter") { insertNewlineAndIndent(editor.view); return "handled"; }
      return "pass";
    },
    dispose,
  };
}

export function mountAnswered(container: HTMLElement, props: PluginQuestionMountContext<CodingQuestionPayload> & { readonly answer: string }): () => void {
  const editor = createCodeView(container, props.input.payload.language, props.answer, false);
  const dispose = () => {
    props.signal.removeEventListener("abort", dispose);
    editor.dispose();
  };
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
