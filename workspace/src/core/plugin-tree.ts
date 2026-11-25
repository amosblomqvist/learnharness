/** Controlled tree presentation only: identity and behavior remain plugin-owned. */
import type { PluginUiCallback, PluginUiContent } from "./plugin-ui.ts";

export type PluginTreeContent = string | PluginUiContent;
export interface PluginTreeColumn {
	key: string;
	header: PluginTreeContent;
	/** Fixed trailing-column width: pixels for numbers, CSS width for strings. */
	width: number | string;
	align?: "left" | "right";
}
export interface PluginTreeRow {
	/** Globally unique occurrence identity, independent of represented entities. */
	key: string;
	content: PluginTreeContent;
	cells?: Record<string, PluginTreeContent>;
	children?: readonly PluginTreeRow[];
	selection?: {
		label: string;
		checked: boolean;
		indeterminate?: boolean;
		disabled?: boolean;
		onChange: PluginUiCallback<boolean>;
	};
	disclosure?: {
		label: string;
		expanded: boolean;
		onChange: PluginUiCallback<boolean>;
	};
}
export interface PluginTreeProps {
	/** Accessible name; visible headings belong to header or row content. */
	label: string;
	rows: readonly PluginTreeRow[];
	header?: PluginTreeContent;
	columns?: readonly PluginTreeColumn[];
}
