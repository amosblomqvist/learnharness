import type { PluginQuestionEditorKey } from "../src/core/index.ts";

// Private host seam, deliberately not a public keyboard/field-scope SDK.
const claimed = new WeakSet<object>();
const composing = new WeakSet<object>();
interface EditorKeyOwner {
	eligible(): boolean;
	contains(target: EventTarget | null): boolean;
	key(key: PluginQuestionEditorKey): "handled" | "pass";
	submit(): void;
	cycle(): void;
}
let owner: EditorKeyOwner | null = null;
export function ownPluginQuestionKeys(next: EditorKeyOwner): () => void {
	owner = next;
	return () => { if (owner === next) owner = null; };
}
export function pluginQuestionKeySuppressed(event: { nativeEvent?: object } | object): boolean {
	const native = (event as { nativeEvent?: object }).nativeEvent ?? event;
	return claimed.has(native) || composing.has(native);
}
export function composingQuestionKey(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
	const native = event.nativeEvent ?? event;
	return native.isComposing === true || native.keyCode === 229;
}
/** Called after Escape ownership is snapshotted, before native Tab prevention. */
export function capturePluginQuestionKey(event: KeyboardEvent): void {
	if (composingQuestionKey(event)) { composing.add(event); return; }
	const current = owner;
	if (!current?.eligible()) return;
	const claim = () => { claimed.add(event); event.preventDefault(); };
	// Reserved host submit works even in an arbitrary plugin editor subtree.
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) { claim(); current.submit(); return; }
	if (!current.contains(event.target)) {
		if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { claim(); current.cycle(); }
		return;
	}
	if (event.metaKey || event.ctrlKey || event.altKey || (event.key === "Tab" && event.shiftKey)) return;
	const key = event.key === "Enter" && event.shiftKey ? "Shift+Enter" : event.key;
	if (key !== "Tab" && key !== "Enter" && key !== "Shift+Enter" && key !== "Escape") return;
	if (current.key(key) === "handled") { claim(); return; }
	if (key === "Tab") { claim(); current.cycle(); }
	// A missing hook or "pass" delegates to native host defaults: Enter
	// submits, Shift+Enter keeps native editing without a second host submit.
	if (key === "Enter") { claim(); current.submit(); }
	if (key === "Shift+Enter") claimed.add(event);
}
