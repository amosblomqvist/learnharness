/** Framework-neutral, controlled host UI. No widget reads or writes plugin storage. */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PluginTreeProps } from "./plugin-tree.ts";

/** Host-invoked interaction callback; async failures are reported, not accepted as
 * successful persistence. Callbacks do not change controlled values by themselves. */
export type PluginUiCallback<T = void> = (value: T) => void | Promise<void>;
/** Required caller lifetime, combined with plugin activation and any owning host
 * surface lifetime. Pass a per-mount signal for UI inside a view. */
export interface PluginWidgetOptions { signal: AbortSignal }
/** Control one registration/mount; handles do not persist plugin values. */
export interface PluginWidgetHandle<Props> {
	/** Shallow-merge props and callbacks; replace whole nested objects/arrays.
	 * Publish accepted values explicitly. Disposed handles ignore updates; where
	 * props are validated, invalid updates throw before replacing current props. */
	update(props: Partial<Props>): void;
	/** Idempotently release this registration/mount and its scoped resources.
	 * UI content signals abort and cleanup runs; explicit overlay disposal is not
	 * a user close notification and does not call onClose. */
	dispose(): void;
}
export interface PluginModelValue { provider: string; id: string }
export interface PluginModelPickerProps {
	value: PluginModelValue | undefined;
	onChange: PluginUiCallback<PluginModelValue>;
	disabled?: boolean;
}
export interface PluginKnowledgePickerProps {
	value: readonly string[];
	onChange: PluginUiCallback<readonly string[]>;
	disabled?: boolean;
}
export interface PluginThinkingPickerProps {
	model: PluginModelValue | undefined;
	value: ThinkingLevel | undefined;
	onChange: PluginUiCallback<ThinkingLevel>;
	disabled?: boolean;
}
export interface PluginComposerProps {
	value: string;
	onChange: PluginUiCallback<string>;
	onSend: () => void | Promise<void>;
	busy?: boolean;
	onStop?: () => void | Promise<void>;
	canSend?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
}
export interface PluginDictationProps {
	disabled?: boolean;
	onTranscript: PluginUiCallback<string>;
}
export interface PluginDictationHandle extends PluginWidgetHandle<PluginDictationProps> {
	/** Start recording when idle, or stop and keep speech when active. One recording
	 * owner is allowed per window; a competing start reports an error. */
	toggle(): void;
	/** Stop this recording and await transcript delivery before sending. Does not
	 * start capture when idle; delivery failures can reject. This does not send a
	 * message or update a hidden native composer. */
	finish(): Promise<void>;
	/** Cancel capture and discard buffered speech rather than flushing it. Does not
	 * undo text already delivered through onTranscript. Disposal/abort also cancels. */
	cancel(): void;
}
export interface PluginStandardComposerProps {
	composer: PluginComposerProps;
	model: PluginModelPickerProps;
	thinking: PluginThinkingPickerProps;
	dictation: PluginDictationProps;
}
export interface PluginButtonColorState {
	background?: string;
	text?: string;
	border?: string;
}
/** CSS colors only; state overrides cascade per property, not as complete palettes. */
export interface PluginButtonColors extends PluginButtonColorState {
	hover?: PluginButtonColorState;
	active?: PluginButtonColorState;
	focusVisible?: PluginButtonColorState & { ring?: string };
	disabled?: PluginButtonColorState;
}
export interface PluginButtonProps {
	/** Visible text, or the accessible name when iconOnly is true. */
	label: string;
	/** Trusted plugin SVG markup, rendered decoratively before the label. */
	icon?: string;
	/** Hide visible text; requires a nonblank label and icon. Size remains independent. */
	iconOnly?: boolean;
	onClick: () => void | Promise<void>;
	disabled?: boolean;
	variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link" | "custom";
	/** Validated for every variant, applied only to custom. Updates replace this whole object. */
	colors?: PluginButtonColors;
	size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
	title?: string;
}
/** Generic native-style badge. No grading semantics or automatic placement. */
export interface PluginBadgeProps {
	text: string;
	/** CSS color for text and a 15% background tint. Omit for the native neutral badge. */
	color?: string;
}
/** Content stays plugin-owned; mount may return cleanup, including asynchronously. */
export type PluginUiContent = HTMLElement | ((container: HTMLElement, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>);
/** Built-in host Markdown rendering without auxiliary controls or plugin code-block widgets. */
export interface PluginMarkdownProps { text: string }
export interface PluginWorkerResultProps {
	label: string;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	text: string;
	content?: PluginUiContent;
	presentation?: "collapsed" | "card" | "plain";
}
declare const pluginSurfaceTargetBrand: unique symbol;
/** Opaque host-created identity for one mounted host page body. */
export interface PluginSurfaceTarget { readonly [pluginSurfaceTargetBrand]: true }
/** Page-body overlay content, not a modal dialog or top-bar/sidebar replacement.
 * User close notifies onClose; it is not an asynchronous veto. Abort/programmatic
 * disposal performs cleanup without a close notification. */
export interface PluginSurfaceProps {
	/** Accessible name only; visible headings belong to plugin content. */
	title: string;
	/** Defaults to the translucent, blurred Chains-like background. */
	background?: "dimmed" | "opaque";
	content: PluginUiContent;
	onClose?: () => void | Promise<void>;
}
/** Modal content with host close/focus handling and no visible host title row.
 * User close notifies onClose, not an async veto; disposal/abort only cleans up. */
export interface PluginDialogProps {
	/** Accessible name only; visible headings belong to plugin content. */
	title: string;
	content: PluginUiContent;
	onClose?: () => void | Promise<void>;
}
export interface PluginMenuItem {
	key: string;
	label: string;
	disabled?: boolean;
	onSelect: () => void | Promise<void>;
}
export interface PluginMenuProps {
	items: PluginMenuItem[];
	label?: string;
	preferredSide?: "up" | "down";
	onClose?: () => void | Promise<void>;
}
interface PluginSettingsRowBase<T> {
	key: string;
	label: string;
	description?: string;
	value: T;
	onChange: PluginUiCallback<T>;
	validate?: (value: T) => string | undefined;
	disabled?: boolean;
}
export type PluginSettingsRow =
	| (PluginSettingsRowBase<boolean> & { type: "toggle" })
	| (PluginSettingsRowBase<string> & { type: "text" })
	| (PluginSettingsRowBase<string> & { type: "dropdown"; options: { value: string; label: string }[] })
	| (PluginSettingsRowBase<number> & { type: "number" | "slider"; min?: number; max?: number; step?: number });
export interface PluginSettingsSchema { rows: PluginSettingsRow[] }
/** Controlled host presentation: plugins own values, persistence and accepted-value
 * updates. Every method returns a shallow-update/idempotent-dispose handle and is
 * scoped to options.signal plus activation; aborted scopes produce inert handles.
 * Async interaction failures are reported by the host, not silently saved. */
export interface PluginUi {
	/** Mount host-catalog model selection; returns a controlled picker handle.
	 * Does not change core defaults, silently refresh accounts or choose a fallback. */
	mountModelPicker(container: HTMLElement, props: PluginModelPickerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginModelPickerProps>;
	/** Mount thinking-level selection for the supplied model/value. Returns a
	 * controlled handle; selection alone does not update plugin or core settings. */
	mountThinkingPicker(container: HTMLElement, props: PluginThinkingPickerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginThinkingPickerProps>;
	/** Mount the native knowledge-selection bubble/Chains picker. Reflect onChange
	 * immediately via the returned handle; Done/X/Escape do not discard selection.
	 * Host manages origin, focus and selector lifetime; no graph-write API is added. */
	mountKnowledgePicker(container: HTMLElement, props: PluginKnowledgePickerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginKnowledgePickerProps>;
	/** Mount a controlled text composer with send/stop callbacks and return its
	 * handle. No default attachment/drop handling or model dispatch is added;
	 * standalone users coordinate dictation completion themselves. */
	mountComposer(container: HTMLElement, props: PluginComposerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginComposerProps>;
	/** Mount native dictation into onTranscript only; returns update/dispose plus
	 * toggle/finish/cancel controls. Abort/dispose cancels capture. Speech never
	 * targets a hidden native composer; recording ownership is per window. */
	mountDictation(container: HTMLElement, props: PluginDictationProps, options: PluginWidgetOptions): PluginDictationHandle;
	/** Mount text entry with model/thinking/dictation controls. Finishes dictation
	 * before onSend; no attachment, usage or practice controls are included. Returns
	 * a controlled handle; replace whole nested control props on update. */
	mountStandardComposer(container: HTMLElement, props: PluginStandardComposerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginStandardComposerProps>;
	/** Mount a native-style button and return its handle. SVG is trusted plugin
	 * markup. Invalid label/icon/color combinations throw on mount/update; updates
	 * reject atomically. onClick does not implicitly persist or dispatch anything. */
	mountButton(container: HTMLElement, props: PluginButtonProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginButtonProps>;
	/** Mount a plain-text status badge, not grading or automatic placement. Returns
	 * an update/dispose handle; invalid text/color props reject atomically. */
	mountBadge(container: HTMLElement, props: PluginBadgeProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginBadgeProps>;
	/** Mount controlled settings fields and return their handle; no automatic reads
	 * or saves. Validation/range failures stay inline without onChange persistence;
	 * pending async saves disable their row and failures are shown. */
	mountSettingsRows(container: HTMLElement, props: PluginSettingsSchema, options: PluginWidgetOptions): PluginWidgetHandle<PluginSettingsSchema>;
	/** Mount complete Markdown through built-in host rendering, including math/code,
	 * without auxiliary controls or registered plugin fence renderers. Returns a
	 * text-update/dispose handle; no model, storage or worker work is started. */
	mountMarkdown(container: HTMLElement, props: PluginMarkdownProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginMarkdownProps>;
	/** Mount a controlled accessible hierarchy, not a file/deck controller. Returns
	 * a handle; invalid trees throw on mount/update. Collapse/removal/replacement
	 * cleans affected content mounts, so retain drafts in plugin state. */
	mountTree(container: HTMLElement, tree: PluginTreeProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginTreeProps>;
	/** Mount a terminal worker-result presentation and return its handle. This only
	 * renders supplied status/text/content; it does not start, wait for or cancel a
	 * task. Optional content is signal-scoped and cleaned on replacement/disposal. */
	mountWorkerResult(container: HTMLElement, props: PluginWorkerResultProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginWorkerResultProps>;
	/** Open an anchored menu and return its handle. Same UI owner + exact anchor
	 * toggles an existing menu closed, calls its latest onClose once, and returns
	 * an inert handle. Other owners/anchors are independent. Abort/dispose does not
	 * call onClose; detached anchors/expired scopes return inert handles. */
	openMenu(anchor: HTMLElement, props: PluginMenuProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginMenuProps>;
	/** Open a modal with accessible title and plugin-owned content; returns its
	 * handle. Content gets a mount signal and sync/async cleanup. Host owns close,
	 * Escape and focus; title does not create a visible heading. */
	openDialog(props: PluginDialogProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginDialogProps>;
	/** Capture the active host page once, for this surface's whole lifetime; return
	 * an overlay handle. Page leave/hide expires it, not a later page after awaits.
	 * A missing live boundary throws; already-aborted signals return inert handles first. */
	openSurface(props: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
	/** Bind explicitly to an existing page instance, including native submission
	 * targets; returns an overlay handle. Targets are opaque, nonpersistent and do
	 * not revive on re-entry. Missing/expired targets throw unless already aborted;
	 * covered bodies stay mounted, with host-owned stacking/interaction/focus. */
	openSurface(target: PluginSurfaceTarget, props: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
}
