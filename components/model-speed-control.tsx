"use client";
/**
 * The compact Standard / Fast control (Codex subscription models only).
 * Reusable across the composer pill row, the settings slot rows and the
 * setup dialog. Pure presentation: the caller owns persistence, so a failed
 * write never shows as success (the value prop is server truth) and a
 * pending write disables both options.
 *
 * Display maps Standard <-> 'default' and Fast <-> 'priority'. An absent
 * tier displays as Standard; callers decide what an absent tier means for
 * their surface (inherit vs. Standard) before passing `value`.
 */
import { useId } from "react";
import type { ModelCatalogEntry, ModelServiceTier } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

/** Factual usage copy. Does not promise a speedup or change cost accounting. */
export const FAST_MODE_TOOLTIP =
	"Fast requests faster responses. It uses 2.5x your included subscription allowance, or 2x purchased credits. Availability depends on the model and your account.";

export const SPEED_LABEL: Record<"default" | "priority", string> = { default: "Standard", priority: "Fast" };

/** Pure: Fast only when explicitly 'priority'; absent/'default' = Standard. */
export function speedLabel(tier: ModelServiceTier | undefined): string {
	return tier === "priority" ? SPEED_LABEL.priority : SPEED_LABEL.default;
}

/** Pure: whether the catalog entry offers the control at all. */
export function offersFastMode(entry: Pick<ModelCatalogEntry, "supportsFastMode"> | undefined): boolean {
	return entry?.supportsFastMode === true;
}

/** Pure: the tier that rides a model change. Retained across eligible
 *  models, cleared (undefined) for unsupported ones. */
export function tierForModel(
	entry: Pick<ModelCatalogEntry, "supportsFastMode"> | undefined,
	tier: ModelServiceTier | undefined,
): ModelServiceTier | undefined {
	return offersFastMode(entry) ? tier : undefined;
}

export function ModelSpeedControl({
	value,
	onChange,
	disabled = false,
	testid = "model-speed",
	ariaLabel = "Speed",
	className,
}: {
	value: ModelServiceTier | undefined;
	onChange: (next: ModelServiceTier) => void;
	/** True while a write is pending (or no write is possible). */
	disabled?: boolean;
	testid?: string;
	ariaLabel?: string;
	className?: string;
}) {
	const descId = useId();
	const current: ModelServiceTier = value === "priority" ? "priority" : "default";
	const option = (tier: ModelServiceTier) => {
		const selected = current === tier;
		return (
			<button
				key={tier}
				type="button"
				data-testid={`${testid}-${tier === "priority" ? "fast" : "standard"}`}
				aria-pressed={selected}
				aria-describedby={descId}
				disabled={disabled}
				onClick={() => {
					if (!selected && !disabled) onChange(tier);
				}}
				className={cn(
					"rounded-full px-2 py-0.5 text-xs transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
					selected ? "bg-muted font-medium text-card-foreground" : "text-muted-foreground hover:text-card-foreground",
				)}
			>
				{SPEED_LABEL[tier]}
			</button>
		);
	};
	return (
		<Hint label={FAST_MODE_TOOLTIP} side="bottom">
			<span
				role="group"
				aria-label={ariaLabel}
				data-testid={testid}
				aria-busy={disabled || undefined}
				className={cn(
					"flex items-center gap-0.5 rounded-full border bg-card/85 p-0.5 shadow-lg backdrop-blur",
					className,
				)}
			>
				{option("default")}
				{option("priority")}
				<span id={descId} className="sr-only">
					{FAST_MODE_TOOLTIP}
				</span>
			</span>
		</Hint>
	);
}
