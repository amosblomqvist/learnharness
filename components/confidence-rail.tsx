"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";
import { useDirection } from "@/components/i18n";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: #141414 base (the darker main background), SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

/** The rail's paint for a stop value (0–100). */
export function confidenceRailStyle(value: number, rtl = false): CSSProperties {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	const isRtl = rtl;
	const gradientDir = isRtl ? "to left" : "to right";
	const tickPositions = isRtl
		? [30, 50, 70, 90].map((p) => `${100 - p}% 0`)
		: [30, 50, 70, 90].map((p) => `${p}% 0`);

	return {
		backgroundColor: "#141414",
		backgroundImage: [
			`linear-gradient(${gradientDir}, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
			...[30, 50, 70, 90].map(
				() => "linear-gradient(90deg, rgba(230,230,230,0.35), rgba(230,230,230,0.35))",
			),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...tickPositions].join(", "),
		backgroundRepeat: "no-repeat",
	};
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className, rtl }: { value: number; className?: string; rtl?: boolean }) {
	const dir = useDirection();
	const isRtl = rtl ?? (dir === "rtl");
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value, isRtl)}
		/>
	);
}
