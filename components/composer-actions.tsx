"use client";

import type { ReactNode, Ref } from "react";
import { DumbbellIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, setup }: { picker?: ReactNode; setup?: ReactNode }) {
	if (!picker && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear, disabled, triggerRef }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
	disabled?: boolean;
	triggerRef?: Ref<HTMLButtonElement>;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				ref={triggerRef}
				disabled={disabled}
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					disabled={disabled}
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}

/** Per-session pre-start toggle: skips the prober and opens teaching in plan.
 *  Resets on mount; callers only render it for teaching sessions. */
export function SkipProbingToggle({
	checked,
	onChange,
	disabled,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			data-testid="skip-probing-toggle"
			aria-pressed={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={
				"flex cursor-pointer items-center rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
				(checked
					? "border-border bg-accent text-foreground"
					: "border-border/60 bg-background text-muted-foreground hover:text-foreground")
			}
		>
			Skip probing
		</button>
	);
}
