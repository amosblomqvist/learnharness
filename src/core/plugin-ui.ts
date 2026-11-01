/** Framework-neutral, controlled host UI. No widget reads or writes plugin storage. */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type PluginUiCallback<T = void> = (value: T) => void | Promise<void>;
export interface PluginWidgetOptions { signal: AbortSignal }
export interface PluginWidgetHandle<Props> {
	update(props: Partial<Props>): void;
	dispose(): void;
}
export interface PluginModelValue { provider: string; id: string }
export interface PluginModelPickerProps {
	value: PluginModelValue | undefined;
	onChange: PluginUiCallback<PluginModelValue>;
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
	toggle(): void;
	finish(): Promise<void>;
	cancel(): void;
}
export interface PluginStandardComposerProps {
	composer: PluginComposerProps;
	model: PluginModelPickerProps;
	thinking: PluginThinkingPickerProps;
	dictation: PluginDictationProps;
}
export interface PluginButtonProps {
	label: string;
	onClick: () => void | Promise<void>;
	disabled?: boolean;
	variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
	size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
	title?: string;
}
/** Content stays plugin-owned; mount may return cleanup, including asynchronously. */
export type PluginUiContent = HTMLElement | ((container: HTMLElement, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>);
export interface PluginWorkerResultProps {
	label: string;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	text: string;
	content?: PluginUiContent;
	presentation?: "collapsed" | "card" | "plain";
}
export interface PluginDialogProps {
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
export interface PluginUi {
	mountModelPicker(container: HTMLElement, props: PluginModelPickerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginModelPickerProps>;
	mountThinkingPicker(container: HTMLElement, props: PluginThinkingPickerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginThinkingPickerProps>;
	mountComposer(container: HTMLElement, props: PluginComposerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginComposerProps>;
	mountDictation(container: HTMLElement, props: PluginDictationProps, options: PluginWidgetOptions): PluginDictationHandle;
	mountStandardComposer(container: HTMLElement, props: PluginStandardComposerProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginStandardComposerProps>;
	mountButton(container: HTMLElement, props: PluginButtonProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginButtonProps>;
	mountSettingsRows(container: HTMLElement, props: PluginSettingsSchema, options: PluginWidgetOptions): PluginWidgetHandle<PluginSettingsSchema>;
	mountWorkerResult(container: HTMLElement, props: PluginWorkerResultProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginWorkerResultProps>;
	openMenu(anchor: HTMLElement, props: PluginMenuProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginMenuProps>;
	openDialog(props: PluginDialogProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginDialogProps>;
}
