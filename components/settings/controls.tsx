"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useRef, useState, type ComponentPropsWithRef, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section block: pronounced mono heading + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="px-6 py-5">
			<h2 className="text-sm uppercase tracking-widest text-foreground">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
			<div className="mt-4 flex flex-col gap-3">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
			<div className="flex flex-col gap-2">{children}</div>
		</div>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
	wrap,
}: {
	label: string;
	hint?: ReactNode;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
	/** For a control that cannot shrink (a segmented control): when the
	 *  dialog is too narrow for label and control side by side, the control
	 *  drops under the label instead of overflowing. The row also becomes a
	 *  size container, so the control can pick compact labels when even a
	 *  full line is too narrow for it. */
	wrap?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 py-1", wrap && "@container flex-wrap", dimmed && "opacity-40")}>
			<span className="min-w-0">
				<span className="block font-prose text-(length:--lh-prose-size)">{label}</span>
				{hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** The existing Agent/Appearance collapsed-menu look, shared with dictation.
 * `unavailable` preserves callers that gate clicks without native disabling;
 * `disabled` retains native button semantics where the caller requires them. */
export function SettingsMenuTrigger({
	value, unavailable, disabled, className, ...props
}: Omit<ComponentPropsWithRef<"button">, "value" | "children"> & {
	value: string;
	unavailable?: boolean;
}) {
	return <button
		type="button"
		{...props}
		disabled={disabled}
		className={cn(
			"flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors",
			disabled || unavailable ? "cursor-not-allowed" : "hover:border-muted-foreground/50",
			className,
		)}
	>
		<span className="min-w-0 flex-1 truncate">{value}</span>
		<span aria-hidden className="text-muted-foreground">▾</span>
	</button>;
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-4.5 w-8 shrink-0 rounded-full border border-border transition-colors",
				// Owner (2026-09-20): on is a gray track with a WHITE disc (a full-white
				// track was too loud); off stays the muted track.
				checked ? "bg-muted-foreground" : "bg-muted",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-0 top-0.5 flex size-3 items-center justify-center rounded-full transition-transform",
						checked ? "translate-x-4 text-foreground" : "translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-0 top-0.5 size-3 rounded-full transition-transform",
						// 2px inset from each inner edge, both states (owner round: the on
						// disc used to touch the pill's right edge).
						checked ? "translate-x-4 bg-foreground" : "translate-x-0.5 bg-muted-foreground",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** The radiogroup arrow machine (WAI-ARIA radio group, with the same wrap
 *  and Home/End as MenuShell's option walk): the index a key moves to from
 *  `index` in a group of `count`, or null for a key the group does not own.
 *  Exported for tests. */
export function radioTarget(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case "ArrowRight":
		case "ArrowDown":
			return (index + 1) % count;
		case "ArrowLeft":
		case "ArrowUp":
			return (index - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

/** A one-of-N picker (used by the text-alignment rows): a
 *  ThinSelect-height pill of buttons in the radio role, the chosen one
 *  raised. An option with an icon shows only the icon (its label rides
 *  aria-label); without one it shows its label as a word, or its `short`
 *  form when the control sits in a `wrap` row narrower than 10.5rem (the
 *  words need about 10rem). The native tooltip is the option's title, else
 *  its label. Keyboard follows the
 *  ARIA radio group: only the chosen button is a tab stop (roving
 *  tabindex), and the arrows and Home/End move focus AND choose. */
export function SegmentedControl<V extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	testid,
}: {
	value: V;
	options: readonly { value: V; label: string; short?: string; icon?: ComponentType<{ className?: string }>; title?: string }[];
	onChange: (next: V) => void;
	ariaLabel: string;
	testid?: string;
}) {
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	// The one tab stop: the chosen option, else the first.
	const tabStop = Math.max(0, options.findIndex((o) => o.value === value));
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const from = buttons.current.indexOf(event.target as HTMLButtonElement);
		const to = from < 0 ? null : radioTarget(event.key, from, options.length);
		if (to === null) return;
		// Handled here: keep the arrows from also reaching document-level
		// listeners (a quiz dock under the dialog walks on ←/→).
		event.preventDefault();
		event.stopPropagation();
		buttons.current[to]?.focus();
		const next = options[to];
		if (next && next.value !== value) onChange(next.value);
	};
	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			data-testid={testid}
			onKeyDown={onKeyDown}
			className="flex h-7 min-w-0 max-w-full items-center gap-0.5 rounded-sm border border-border bg-background p-0.5"
		>
			{options.map((o, i) => {
				const checked = o.value === value;
				return (
					<button
						key={o.value}
						ref={(el) => { buttons.current[i] = el; }}
						type="button"
						role="radio"
						aria-checked={checked}
						tabIndex={i === tabStop ? 0 : -1}
						aria-label={o.label}
						title={o.title ?? o.label}
						data-testid={testid ? `${testid}-${o.value}` : undefined}
						onClick={() => {
							if (!checked) onChange(o.value);
						}}
						className={cn(
							"flex h-5.5 items-center justify-center rounded-[3px] transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							o.icon ? "w-5.5" : "px-2 font-ui text-xs",
							checked ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{o.icon ? (
							<o.icon className="size-3.5" />
						) : o.short ? (
							<>
								<span className="@max-[10.5rem]:hidden">{o.label}</span>
								<span aria-hidden className="hidden @max-[10.5rem]:inline">{o.short}</span>
							</>
						) : (
							o.label
						)}
					</button>
				);
			})}
		</div>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			className="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
		/>
	);
}