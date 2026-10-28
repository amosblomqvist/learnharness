"use client";

/** Thin CodeMirror 6 wrapper: language extension + a real parse for JS/TS.
 *  Deliberately small — the editor is a surface, not a feature. */

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { go } from "@codemirror/legacy-modes/mode/go";
import { csharp, dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { r } from "@codemirror/legacy-modes/mode/r";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { crystal } from "@codemirror/legacy-modes/mode/crystal";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { linter, lintGutter } from "@codemirror/lint";

/** Token colours. Without a highlight style the parser still classifies tokens
 *  but nothing colours them — the editor would look like a plain textarea. */
const highlight = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#c586c0" },
	{ tag: [t.name, t.variableName, t.propertyName], color: "#d4d4d4" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#dcdcaa" },
	{ tag: [t.string, t.special(t.string), t.regexp], color: "#ce9178" },
	{ tag: [t.number, t.bool, t.null], color: "#b5cea8" },
	{ tag: [t.typeName, t.className, t.namespace], color: "#4ec9b0" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "#5f6b5f", fontStyle: "italic" },
	{ tag: [t.operator, t.punctuation, t.bracket], color: "#9cdcfe" },
	{ tag: t.meta, color: "#c586c0" },
	{ tag: t.invalid, color: "#e06c75" },
]);

const theme = EditorView.theme(
	{
		"&": { backgroundColor: "#111", color: "#d4d4d4", fontSize: "13px" },
		".cm-content": { fontFamily: "var(--font-jetbrains), ui-monospace, monospace", padding: "10px 0" },
		".cm-gutters": { backgroundColor: "#111", color: "#4b4b4b", border: "none" },
		".cm-activeLine": { backgroundColor: "#1a1a1a" },
		".cm-activeLineGutter": { backgroundColor: "#1a1a1a" },
		"&.cm-focused": { outline: "none" },
		".cm-selectionBackground, ::selection": { backgroundColor: "#2f4a63 !important" },
	},
	{ dark: true },
);

function engineFor(language: string) {
	const l = language.toLowerCase();
	if (l.startsWith("python") || l === "py") return python();
	// Compiled / long-tail languages: the editor must highlight what it can run.
	const legacy: Record<string, () => unknown> = {
		rust: () => StreamLanguage.define(rust),
		lua: () => StreamLanguage.define(lua),
		ruby: () => StreamLanguage.define(ruby),
		rb: () => StreamLanguage.define(ruby),
		bash: () => StreamLanguage.define(shell),
		sh: () => StreamLanguage.define(shell),
		shell: () => StreamLanguage.define(shell),
		go: () => StreamLanguage.define(go),
		golang: () => StreamLanguage.define(go),
		csharp: () => StreamLanguage.define(csharp),
		"c#": () => StreamLanguage.define(csharp),
		kotlin: () => StreamLanguage.define(kotlin),
		dart: () => StreamLanguage.define(dart),
		scala: () => StreamLanguage.define(scala),
		julia: () => StreamLanguage.define(julia),

		r: () => StreamLanguage.define(r),
		octave: () => StreamLanguage.define(octave),
		matlab: () => StreamLanguage.define(octave),
		haskell: () => StreamLanguage.define(haskell),
		hs: () => StreamLanguage.define(haskell),
		lisp: () => StreamLanguage.define(commonLisp),
		commonlisp: () => StreamLanguage.define(commonLisp),
		perl: () => StreamLanguage.define(perl),
		pl: () => StreamLanguage.define(perl),
		fortran: () => StreamLanguage.define(fortran),
		erlang: () => StreamLanguage.define(erlang),
		elixir: () => StreamLanguage.define(erlang),   // closest available grammar
		tcl: () => StreamLanguage.define(tcl),
		racket: () => StreamLanguage.define(scheme),
		groovy: () => StreamLanguage.define(groovy),
		crystal: () => StreamLanguage.define(crystal),
		ocaml: () => StreamLanguage.define(oCaml),
		clojure: () => StreamLanguage.define(scheme),   // s-expression family
		f90: () => StreamLanguage.define(fortran),
	};
	if (l === "sql" || l === "sqlite" || l === "postgres" || l === "psql") return sqlLang();
	if (legacy[l]) return legacy[l]() as never;
	if (l === "c" || l === "cpp" || l === "c++" || l === "cxx" || l === "cc") return cpp();
	if (l === "java") return java();
	if (l === "php") return php();
	if (["javascript", "js", "typescript", "ts", "tsx", "jsx", "node"].includes(l)) {
		return javascript({ typescript: l === "typescript" || l === "ts" || l === "tsx", jsx: l.endsWith("x") });
	}
	return null;
}

/** Real syntax diagnostics where a parser exists in-process; nothing faked. */
function jsLinter(view: EditorView) {
	const code = view.state.doc.toString();
	try {
		// Parse only — never call the result.
		new Function(code);
		return [];
	} catch (e) {
		const err = e as SyntaxError;
		const line = /line (\d+)/i.exec(err.message)?.[1];
		const pos = line ? view.state.doc.line(Math.min(Number(line), view.state.doc.lines)).from : 0;
		return [{ from: pos, to: Math.min(pos + 1, view.state.doc.length), severity: "error" as const, message: err.message }];
	}
}

export function CodeEditor({
	value,
	language,
	onChange,
	readOnly,
}: {
	value: string;
	language: string;
	onChange: (next: string) => void;
	readOnly?: boolean;
}) {
	const host = useRef<HTMLDivElement | null>(null);
	const view = useRef<EditorView | null>(null);
	const change = useRef(onChange);
	change.current = onChange;

	useEffect(() => {
		if (!host.current) return;
		const lang = engineFor(language);
		const isJs = language.toLowerCase().match(/^(javascript|js|typescript|ts|tsx|jsx|node)$/) !== null;
		const state = EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				keymap.of([...defaultKeymap, indentWithTab]),
				theme,
				syntaxHighlighting(highlight),
				placeholder("Write your code here…"),
				...(lang ? [lang] : []),
				...(isJs ? [linter(jsLinter), lintGutter()] : []),
				EditorView.editable.of(!readOnly),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) change.current(u.state.doc.toString());
				}),
			],
		});
		view.current = new EditorView({ state, parent: host.current });
		return () => {
			view.current?.destroy();
			view.current = null;
		};
		// Recreate only when the language changes; value is owned by the editor.
	}, [language, readOnly]);

	return <div ref={host} data-testid="code-editor" className="overflow-hidden rounded-b-md" />;
}
