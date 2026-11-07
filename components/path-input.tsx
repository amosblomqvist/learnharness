"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FilePathChip } from "./file-path-chip";
import { CitationChip } from "./citation-chip";
import { cn } from "../lib/utils";
import {
	adjacentPathRange, atomicPathRange, clampPathSelection, insertCitation, insertFilePaths, locateToken,
	normalizePathEdit, normalizePathInputValue, pathInputStaticRange, PathInputHistory, readPathInput, readPathSelection, renderPathInput,
	replacePathSelection, restorePathSelection,
	type ChipHost, type PathEditSnapshot, type TextSelection,
} from "./path-input-dom";

export const INSERT_FILE_PATHS_EVENT = "lh:insert-file-paths";
/** detail: { link, onInserted?(range) } — insert a citation link at the saved caret. */
export const INSERT_CITATION_EVENT = "lh:insert-citation";
/** detail: { start, end, previous, source, spaceBefore?, spaceAfter? } —
 *  replace a citation link (new comment), or remove it when source is null
 *  (with the spaces its insertion added, for a cancelled fresh cite). */
export const UPDATE_CITATION_EVENT = "lh:update-citation";
export type CitationInsertedRange = { start: number; end: number; spaceBefore: boolean; spaceAfter: boolean };
export type InsertCitationDetail = { link: string; onInserted?: (range: CitationInsertedRange) => void };
export type UpdateCitationDetail = { start: number; end: number; previous: string; source: string | null; spaceBefore?: boolean; spaceAfter?: boolean };
export type PathInputProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML" | "defaultValue" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	defaultDropTarget?: boolean;
	/** Native text-input semantics: strip CR/LF and leave Enter to the caller. */
	singleLine?: boolean;
};

type Controller = {
	external: (value: string) => void;
	remember: () => void;
};

/**
 * A controlled plaintext editor. Only the source string is state; chips are atomic
 * views of it. React never reconciles the editable DOM after a native mutation.
 */
export const PathInput = React.forwardRef<HTMLDivElement, PathInputProps>(function PathInput({
	value, onValueChange, placeholder, autoFocus, defaultDropTarget = false, singleLine = false, className,
	onKeyDown, onFocus, onBlur, onInput, onPaste, onCopy, onCut,
	onCompositionStart, onCompositionEnd, ...props
}, forwardedRef) {
	const rootRef = React.useRef<HTMLDivElement>(null);
	const controllerRef = React.useRef<Controller | null>(null);
	const callbacks = React.useRef({ onValueChange, singleLine });
	const composing = React.useRef(false);
	const [chips, setChips] = React.useState<ChipHost[]>([]);
	// Keep this text child immutable: SSR/hydration gets the complete draft,
	// while subsequent React renders leave the browser-owned editable DOM alone.
	const initial = React.useRef({ value: normalizePathInputValue(value, singleLine), autoFocus, singleLine });

	React.useImperativeHandle(forwardedRef, () => rootRef.current!, []);
	React.useLayoutEffect(() => { callbacks.current = { onValueChange, singleLine }; }, [onValueChange, singleLine]);

	React.useLayoutEffect(() => {
		const root = rootRef.current!;
		const document = root.ownerDocument;
		let current = normalizePathInputValue(initial.current.value, initial.current.singleLine);
		let saved: TextSelection = { anchor: current.length, focus: current.length };
		let beforeEdit: PathEditSnapshot | null = null;
		let compositionStart: PathEditSnapshot | null = null;
		let pendingExternal: string | null = null;
		let pendingPaths: string[] = [];
		let pendingPaste: string[] = [];
		let pendingCitations: InsertCitationDetail[] = [];
		let mounted = true;
		const history = new PathInputHistory();

		function remember() {
			if (document.activeElement !== root) return;
			const selection = readPathSelection(root);
			if (selection) saved = selection;
		}
		function snapshot(): PathEditSnapshot {
			return { value: current, selection: { ...saved } };
		}
		function paint(selection: TextSelection, restore: boolean) {
			setChips(renderPathInput(root, current));
			saved = clampPathSelection(current, selection);
			if (restore) restorePathSelection(root, saved);
		}
		function change(next: PathEditSnapshot, record = true, before = snapshot(), notify = true) {
			next = normalizePathEdit(next, callbacks.current.singleLine);
			if (next.value === current) { paint(next.selection, document.activeElement === root); return; }
			if (record) history.push(before);
			current = next.value;
			paint(next.selection, document.activeElement === root);
			if (notify) callbacks.current.onValueChange(current);
		}
		function replace(text: string) {
			remember();
			change(replacePathSelection(current, saved, text));
		}
		function travel(direction: "undo" | "redo") {
			remember();
			const next = history[direction](snapshot());
			if (next) change(next, false);
		}
		function stage(paths: string[]) {
			if (composing.current) { pendingPaths.push(...paths); return; }
			remember();
			// Global drop may have moved focus: saved selection is still authoritative.
			let next: PathEditSnapshot;
			try { next = insertFilePaths(current, saved, paths); }
			catch { return; } // Invalid event payloads never mutate learner text.
			change(next);
			root.focus();
			restorePathSelection(root, saved);
		}
		function cite(detail: InsertCitationDetail) {
			if (composing.current) { pendingCitations.push(detail); return; }
			remember();
			const next = insertCitation(current, saved, detail.link);
			change(next);
			root.focus();
			restorePathSelection(root, saved);
			detail.onInserted?.(next.inserted);
		}
		function insertCitationEvent(event: Event) {
			const detail = (event as CustomEvent<unknown>).detail as Partial<InsertCitationDetail> | null;
			if (detail && typeof detail.link === "string") cite(detail as InsertCitationDetail);
		}
		function updateCitationEvent(event: Event) {
			const detail = (event as CustomEvent<unknown>).detail as Partial<UpdateCitationDetail> | null;
			if (!detail || typeof detail.previous !== "string" || typeof detail.start !== "number") return;
			if (composing.current) return;
			const found = locateToken(current, detail.start, detail.previous);
			if (!found) return; // moved beyond recognition or deleted: never edit other text
			let { start, end } = found;
			const source = typeof detail.source === "string" ? detail.source : "";
			if (detail.source === null) {
				if (detail.spaceBefore && current[start - 1] === " ") start -= 1;
				if (detail.spaceAfter && current[end] === " ") end += 1;
			}
			const value = current.slice(0, start) + source + current.slice(end);
			const caret = start + source.length + (detail.source === null ? 0 : 1);
			change({ value, selection: { anchor: Math.min(caret, value.length), focus: Math.min(caret, value.length) } });
		}
		function insertEvent(event: Event) {
			const paths: unknown = (event as CustomEvent<unknown>).detail;
			if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) stage(paths);
		}
		function beforeInput(event: InputEvent) {
			if (composing.current || event.isComposing) return;
			remember();
			beforeEdit = snapshot();
			if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
				event.preventDefault();
				travel(event.inputType === "historyUndo" ? "undo" : "redo");
			} else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
				event.preventDefault();
				if (!callbacks.current.singleLine) replace("\n");
			} else if (event.inputType.startsWith("format") || event.inputType === "insertHTML") {
				event.preventDefault();
			} else if (event.inputType === "deleteByCut") {
				// The cut handler owns both the full-source clipboard and deletion.
				// Never perform a second deletion if a browser also sends beforeinput.
				event.preventDefault();
			} else if (/^delete(?:(?:Word|SoftLine|HardLine)(?:Backward|Forward)|EntireSoftLine)$/.test(event.inputType)) {
				// Modifier keys have platform-specific word/visual-line semantics.
				// Only the browser knows that extent; never substitute an adjacent chip.
				let targets: StaticRange[] = [];
				try { targets = event.getTargetRanges?.() ?? []; } catch { /* Native fallback below. */ }
				const range = targets.length === 1 ? pathInputStaticRange(root, targets[0]!) : null;
				if (range && event.cancelable) {
					event.preventDefault();
					// replacePathSelection expands any intersected chip atomically.
					change(replacePathSelection(current, range, ""));
				}
				// Missing/invalid/non-single targets: native edit + input projection owns it.
			} else if (event.inputType.startsWith("delete")) {
				const range = adjacentPathRange(current, saved, event.inputType.includes("Backward") ? "backward" : "forward");
				if (range) {
					event.preventDefault();
					change(replacePathSelection(current, range, ""));
				}
			}
		}
		function input() {
			if (composing.current) {
				root.dataset.empty = normalizePathInputValue(readPathInput(root), callbacks.current.singleLine).length === 0 ? "true" : "false";
				return;
			}
			const nextValue = readPathInput(root);
			const selection = readPathSelection(root) ?? saved;
			const previous = beforeEdit ?? snapshot();
			beforeEdit = null;
			change({ value: nextValue, selection }, true, previous);
		}
		function keyDown(event: KeyboardEvent) {
			if (composing.current || event.isComposing || event.keyCode === 229) return;
			// Shift+Delete is native Cut on Windows/Linux, not forward deletion.
			// Let the browser dispatch cut so our clipboard handler can own it.
			if (event.key === "Delete" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return;
			remember();
			if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
				event.preventDefault();
				travel(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo");
			} else if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) {
				const range = adjacentPathRange(current, saved, event.key === "Backspace" ? "backward" : "forward");
				if (range) {
					event.preventDefault();
					change(replacePathSelection(current, range, ""));
				}
			}
		}
		function paste(event: ClipboardEvent) {
			if (event.defaultPrevented) return;
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain") ?? "";
			// Image/file/HTML-only clipboard contents are not text replacement.
			if (text === "") return;
			if (composing.current) pendingPaste.push(text);
			else replace(text);
		}
		function copy(event: ClipboardEvent) {
			if (event.defaultPrevented) return;
			remember();
			if (saved.anchor === saved.focus || !event.clipboardData) return;
			const { start, end } = atomicPathRange(current, saved);
			event.clipboardData.setData("text/plain", current.slice(start, end));
			event.preventDefault();
			if (event.type === "cut" && !composing.current) change(replacePathSelection(current, saved, ""));
		}
		function startComposition() {
			remember();
			composing.current = true;
			compositionStart = snapshot();
		}
		function endComposition() {
			// Some browsers send the final input immediately AFTER compositionend.
			queueMicrotask(() => {
				if (!mounted) return;
				let nextValue = readPathInput(root);
				let selection = readPathSelection(root) ?? saved;
				const previous = compositionStart ?? snapshot();
				const reset = pendingExternal !== null && !pendingExternal.startsWith(previous.value);
				const nativeChanged = normalizePathInputValue(nextValue, callbacks.current.singleLine) !== current;
				const notify = pendingExternal === null || (!reset && nativeChanged);
				if (pendingExternal !== null) {
					if (pendingExternal.startsWith(previous.value)) {
						nextValue += pendingExternal.slice(previous.value.length);
					} else {
						nextValue = pendingExternal;
						selection = clampPathSelection(nextValue, selection);
					}
				}
				pendingExternal = null;
				compositionStart = null;
				beforeEdit = null;
				composing.current = false;
				if (reset) history.reset();
				change({ value: nextValue, selection }, !reset, previous, notify);
				if (pendingPaste.length) { const text = pendingPaste.join(""); pendingPaste = []; replace(text); }
				if (pendingPaths.length) { const paths = pendingPaths; pendingPaths = []; stage(paths); }
				if (pendingCitations.length) { const citations = pendingCitations; pendingCitations = []; citations.forEach(cite); }
			});
		}
		controllerRef.current = {
			remember,
			external(next) {
				next = normalizePathInputValue(next, callbacks.current.singleLine);
				if (composing.current) { pendingExternal = next; return; }
				if (next === current) return;
				remember();
				const previous = snapshot();
				// Dictation appends are undoable; a controlled reset starts fresh history.
				if (next && next.startsWith(current)) history.push(previous);
				else history.reset();
				const selection = saved.anchor === current.length && saved.focus === current.length
					? { anchor: next.length, focus: next.length } : clampPathSelection(next, saved);
				current = next;
				paint(selection, document.activeElement === root);
			},
		};
		paint(saved, false);
		if (initial.current.autoFocus) { root.focus(); restorePathSelection(root, saved); }
		root.addEventListener(INSERT_FILE_PATHS_EVENT, insertEvent);
		root.addEventListener(INSERT_CITATION_EVENT, insertCitationEvent);
		root.addEventListener(UPDATE_CITATION_EVENT, updateCitationEvent);
		root.addEventListener("beforeinput", beforeInput);
		root.addEventListener("input", input);
		root.addEventListener("keydown", keyDown);
		root.addEventListener("paste", paste);
		root.addEventListener("copy", copy);
		root.addEventListener("cut", copy);
		root.addEventListener("compositionstart", startComposition);
		root.addEventListener("compositionend", endComposition);
		document.addEventListener("selectionchange", remember);
		return () => {
			mounted = false;
			composing.current = false;
			controllerRef.current = null;
			root.removeEventListener(INSERT_FILE_PATHS_EVENT, insertEvent);
			root.removeEventListener(INSERT_CITATION_EVENT, insertCitationEvent);
			root.removeEventListener(UPDATE_CITATION_EVENT, updateCitationEvent);
			root.removeEventListener("beforeinput", beforeInput);
			root.removeEventListener("input", input);
			root.removeEventListener("keydown", keyDown);
			root.removeEventListener("paste", paste);
			root.removeEventListener("copy", copy);
			root.removeEventListener("cut", copy);
			root.removeEventListener("compositionstart", startComposition);
			root.removeEventListener("compositionend", endComposition);
			document.removeEventListener("selectionchange", remember);
		};
	}, []);

	React.useLayoutEffect(() => { controllerRef.current?.external(value); }, [value, singleLine]);

	return <>
		<div
			{...props}
			ref={rootRef}
			role="textbox"
			aria-label={props["aria-label"] ?? placeholder}
			aria-multiline={singleLine ? "false" : "true"}
			aria-placeholder={placeholder}
			contentEditable
			suppressContentEditableWarning
			data-file-path-input=""
			data-empty={initial.current.value.length === 0 ? "true" : "false"}
			data-file-path-default={defaultDropTarget ? "" : undefined}
			data-placeholder={placeholder}
			className={cn("block w-full min-w-0 outline-none data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(data-placeholder)]", singleLine ? "whitespace-pre break-normal overflow-x-auto overflow-y-hidden" : "whitespace-pre-wrap break-words overflow-y-auto", className)}
			onKeyDown={(event) => {
				if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
				onKeyDown?.(event);
			}}
			onFocus={(event) => { controllerRef.current?.remember(); onFocus?.(event); }}
			onBlur={(event) => { controllerRef.current?.remember(); onBlur?.(event); }}
			onInput={onInput}
			onPaste={onPaste}
			onCopy={onCopy}
			onCut={onCut}
			onCompositionStart={onCompositionStart}
			onCompositionEnd={onCompositionEnd}
		>{initial.current.value}</div>
		{chips.map(({ host, token }) => createPortal(token.kind === "path"
			? <FilePathChip path={token.path} contentEditable={false} />
			: <CitationChip citation={token.citation} variant="composer" contentEditable={false} source={{ start: token.start, end: token.end, link: token.text, host }} />, host))}
	</>;
});
