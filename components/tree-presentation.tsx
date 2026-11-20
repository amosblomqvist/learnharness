"use client";

import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

/** Private presentation only. Callers retain hierarchy, identity and behavior. */
type RowVariant = "branch" | "compact" | "detail";
type Layout = { className: string; style?: CSSProperties };
const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(" ");

export function treeRowLayout({ depth = 0, variant = "branch", className, style }: {
	depth?: number; variant?: RowVariant; className?: string; style?: CSSProperties;
} = {}): Layout {
	const padding = depth === 0 ? "px-3" : depth === 1 ? "pl-12 pr-3" : depth === 2 ? "pl-21 pr-3" : "pr-3";
	return {
		className: classes("flex", variant === "detail" ? "items-start gap-2 py-1" : variant === "compact" ? "items-center gap-1 py-1" : "items-center gap-1", variant === "branch" ? classes(padding, "py-1.5") : padding, className),
		style: depth > 2 ? { paddingLeft: 12 + depth * 36, ...style } : style,
	};
}

/** Existing native drag rows use the layout helper directly, without wrappers. */
export function TreeRow({ depth = 0, variant, selectionColumn, selection, disclosure, children, trailing, className, style, ...props }: HTMLAttributes<HTMLDivElement> & {
	depth?: number; variant?: RowVariant; selectionColumn: boolean;
	selection?: ReactNode; disclosure?: ReactNode; trailing?: ReactNode;
}) {
	// Indent inside the flex content box, not its padding: percentage cells must
	// resolve against the same width as the header at every depth. The spacer's
	// following gap completes the indentation, even when no controls are present.
	const gap = variant === "detail" ? 8 : 4;
	return <div {...props} {...treeRowLayout({ depth: 0, variant, className, style })}>
		{depth > 0 && <span aria-hidden="true" className="shrink-0" style={{ width: depth * 36 - gap }} />}
		{selectionColumn && (selection ?? <TreeSelectionSpacer />)}
		{disclosure}
		<div className="min-w-0 flex-1">{children}</div>
		{trailing}
	</div>;
}

export function treeBranchLayout({ depth = 0, className, style }: {
	depth?: number; className?: string; style?: CSSProperties;
} = {}): Layout {
	return { className: classes("relative", className), style: depth ? { marginLeft: depth * 36, ...style } : style };
}

export function TreeSelectionSpacer() {
	return <span aria-hidden="true" className="size-3.5 shrink-0" />;
}

export function TreeCheckbox({ indeterminate = false, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { indeterminate?: boolean }) {
	return <input {...props} type="checkbox" ref={element => { if (element) element.indeterminate = indeterminate; }} className={classes("size-3.5 shrink-0 accent-primary", className)} />;
}

export function TreeDisclosure({ open, plain = false, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-expanded"> & { open: boolean; plain?: boolean }) {
	return <button {...props} type="button" aria-expanded={open}
		className={classes("flex h-5 w-3.5 shrink-0 items-center justify-center", plain ? "text-muted-foreground/70" : "rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground", className)}>
		<ChevronRightIcon className={classes("size-3.5", !plain && "transition-transform", open ? "rotate-90" : "")} />
	</button>;
}

/** Also spreads onto native sortable buttons: no replacement header element. */
export function treeColumnLayout({ widthClassName, grow = false, align, className, style }: {
	widthClassName?: string; grow?: boolean; align?: "left" | "center" | "right"; className?: string; style?: CSSProperties;
} = {}): Layout {
	return { className: classes(widthClassName, grow ? "flex-1" : "shrink-0", align === "left" ? "text-left" : align === "center" ? "text-center" : align === "right" ? "text-right" : undefined, className), style };
}

export function TreeCell({ widthClassName, grow, align, className, style, ...props }: HTMLAttributes<HTMLSpanElement> & {
	widthClassName?: string; grow?: boolean; align?: "left" | "center" | "right";
}) {
	return <span {...props} {...treeColumnLayout({ widthClassName, grow, align, className, style })} />;
}

export function TreeHeader({ sticky = false, className, ...props }: HTMLAttributes<HTMLDivElement> & { sticky?: boolean }) {
	return <div {...props} className={classes(sticky && "sticky top-0 z-10", "flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur", className)} />;
}

export function TreeGuide({ depth = 0, selectionColumn, variant = "branch", className, style, ...props }: HTMLAttributes<HTMLDivElement> & {
	depth?: number; selectionColumn: boolean; variant?: "branch" | "compact";
}) {
	return <div {...props} className={classes("pointer-events-none absolute bottom-[8px]", variant === "compact" ? "top-[22px]" : "top-[23px]", "w-px bg-border/50", className)}
		style={{ left: (selectionColumn ? 37 : 19) + depth * 36, ...style }} />;
}

export function TreeSeparator({ inset = 0, outside = false, className, style, ...props }: HTMLAttributes<HTMLDivElement> & {
	inset?: number; outside?: boolean;
}) {
	return <div {...props} className={classes("pointer-events-none absolute", outside ? "bottom-[-1px]" : "bottom-0", "right-0 border-b border-border/60", className)} style={{ left: inset, ...style }} />;
}
