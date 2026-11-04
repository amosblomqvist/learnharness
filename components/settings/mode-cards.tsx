"use client";
/**
 * THE MODE PICKER (light-mode wave, 2026-10-29): three preview cards —
 * Dark | Light | System — each a miniature of the app drawn in that
 * variant's palette. Dark and Light list their colors beneath as swatch
 * squares that each open to their hex on hover or click; System has none
 * (it adopts those two). System is split diagonally: the dark preview,
 * with the light one clipped over its lower-right half.
 *
 * Each preview carries its palette as inline CSS variables on its own
 * root (variantPalette, src/core/appearance-palette.ts), so the Tailwind
 * token utilities inside resolve to THAT variant — never the page's live
 * palette — and a custom background shows in its card. The mock is laid
 * out at the app's own type ladder and spacing, then scaled to half: the
 * miniature stays on the 4px scale instead of inventing tiny sizes.
 */

import { useState, type CSSProperties } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { variantPalette, type AppearanceMode } from "@/src/core";

/** The hexes each card lists, in the mockup's order. */
const SWATCH_TOKENS = ["--background", "--card", "--accent", "--border", "--muted-foreground"] as const;

/** The selected card's frame: its usual edge, a 2px gap in the dialog's
 *  own surface, then a 1px ink ring (the check by the label does the rest). */
const SELECTED_FRAME = "shadow-[0_0_0_2px_var(--card),0_0_0_3px_var(--foreground)]";

/** The light half of the System card: everything below the top-right →
 *  bottom-left diagonal. */
const SYSTEM_SPLIT: CSSProperties = { clipPath: "polygon(100% 0, 100% 100%, 0 100%)" };

/** One miniature app (sidebar, header, title, prose, a question card, the
 *  composer) in the given palette. Fills its positioned parent. */
function MiniApp({ palette }: { palette: Record<string, string> }) {
	// --color-border too: the default edge (`* { border-color:
	// var(--color-border) }`) resolved that var once on <html>, so without
	// this the previews would draw the page's edge, not their own.
	const style = { ...palette, "--color-border": palette["--border"] } as CSSProperties;
	return (
		<div
			aria-hidden
			style={style}
			className="absolute top-0 left-0 grid h-[200%] w-[200%] origin-top-left scale-50 grid-cols-[112px_1fr] bg-background text-foreground"
		>
			<div className="border-r border-border bg-card p-2 font-ui text-xs text-muted-foreground">
				<div className="px-2 py-1 font-semibold text-foreground">LH</div>
				<div className="my-1 truncate rounded-sm bg-accent px-2 py-1 text-foreground">Chain rule</div>
				<div className="truncate px-2 py-1">Eigen</div>
			</div>
			<div className="flex min-w-0 flex-col">
				<div className="flex h-9 shrink-0 items-center border-b border-border px-3 font-ui text-xs">Chain rule</div>
				<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
					<div className="font-title text-xl">Chain rule</div>
					<div className="font-prose text-sm">
						If <b>y = f(g(x))</b>, then <i>dy/dx = f′(g)·g′</i>.
					</div>
					<div className="rounded-md border border-border bg-card px-2 py-1">
						<span className="block font-ui text-xs text-muted-foreground">QUESTION 1/3</span>
						<span className="font-prose text-sm">d/dx sin(x²) = ?</span>
					</div>
					<div className="mt-auto flex items-center justify-between rounded-lg border border-border bg-card py-1 pr-1 pl-3 font-prose text-sm text-muted-foreground">
						<span className="truncate">What do you want to learn?</span>
						<span className="rounded-sm bg-accent px-2 py-1 text-foreground">↵</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/** One color square that opens to its hex on hover, or stays open once
 *  clicked (a second click closes it). Inside the card's button, so the
 *  click stops there — reading a hex never switches the mode. */
function Swatch({ color, ink, token }: { color: string; ink: string; token: string }) {
	const [open, setOpen] = useState(false);
	return (
		<span
			data-testid="mode-swatch"
			data-open={open}
			title={token.slice(2)}
			style={{ background: color, color: ink }}
			onClick={(e) => {
				e.stopPropagation();
				setOpen((o) => !o);
			}}
			className="group/swatch flex h-5 min-w-5 cursor-pointer items-center rounded-sm border border-muted-foreground/30 font-ui text-xs"
		>
			<span className="max-w-0 overflow-hidden whitespace-nowrap transition-[max-width,padding] group-hover/swatch:max-w-16 group-hover/swatch:px-1 group-data-[open=true]/swatch:max-w-16 group-data-[open=true]/swatch:px-1">
				{color.slice(1)}
			</span>
		</span>
	);
}

/** The swatch row beneath a card, each square painted in its own color. */
function Swatches({ palette }: { palette: Record<string, string> }) {
	return (
		<div className="flex flex-wrap gap-1">
			{SWATCH_TOKENS.map((token) => (
				<Swatch key={token} token={token} color={palette[token]!} ink={palette["--foreground"]!} />
			))}
		</div>
	);
}

export function ModeCards({
	value,
	background,
	lightBackground,
	onSelect,
}: {
	/** The stored mode — its card is pressed. */
	value: AppearanceMode;
	/** The custom backgrounds (null = the variant's default), so each
	 *  preview shows the EFFECTIVE palette. */
	background: string | null;
	lightBackground: string | null;
	onSelect: (mode: AppearanceMode) => void;
}) {
	const dark = variantPalette("dark", background);
	const light = variantPalette("light", lightBackground);
	const cards: Array<{ mode: AppearanceMode; label: string; preview: React.ReactNode; swatches?: React.ReactNode }> = [
		{ mode: "dark", label: "Dark", preview: <MiniApp palette={dark} />, swatches: <Swatches palette={dark} /> },
		{ mode: "light", label: "Light", preview: <MiniApp palette={light} />, swatches: <Swatches palette={light} /> },
		{
			mode: "system",
			label: "System",
			preview: (
				<>
					<MiniApp palette={dark} />
					<div className="absolute inset-0" style={SYSTEM_SPLIT}>
						<MiniApp palette={light} />
					</div>
				</>
			),
		},
	];
	return (
		<div className="grid grid-cols-3 gap-3">
			{cards.map((card) => {
				const selected = card.mode === value;
				return (
					<button
						key={card.mode}
						type="button"
						data-testid={`mode-card-${card.mode}`}
						aria-pressed={selected}
						onClick={() => onSelect(card.mode)}
						className="group flex min-w-0 flex-col gap-2 text-left"
					>
						<span
							className={cn(
								"flex h-4 items-center gap-2 font-ui text-xs",
								selected ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{selected && (
								<span className="flex size-4 items-center justify-center rounded-full bg-foreground text-background">
									<CheckIcon className="size-3" strokeWidth={3} />
								</span>
							)}
							{card.label}
						</span>
						<div
							className={cn(
								"relative h-36 w-full overflow-hidden rounded-lg border transition-colors",
								selected ? SELECTED_FRAME : "border-border group-hover:border-muted-foreground/50",
							)}
						>
							{card.preview}
						</div>
						{card.swatches}
					</button>
				);
			})}
		</div>
	);
}
