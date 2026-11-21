"use client";

import { useEffect } from "react";
import { handleCopyAsMarkdown } from "./copy-selection-markdown";

/** Installs a document-level `copy` listener that turns mouse/keyboard text
 *  selections inside rendered teaching prose and KaTeX equations into standard
 *  Markdown (`$...$` inline, `$$...$$` display, headings, lists, tables,
 *  fenced code). Renders nothing. */
export default function CopySelectionAsMarkdown() {
	useEffect(() => {
		const onCopy = (event: ClipboardEvent) => {
			handleCopyAsMarkdown(event, document);
		};
		document.addEventListener("copy", onCopy);
		return () => {
			document.removeEventListener("copy", onCopy);
		};
	}, []);
	return null;
}
