"use client";
/**
 * The profile form (multi-user profiles, 2026-10-27): name, one of eight
 * colors, optional PIN, with a live avatar preview. Shared by the select
 * screen's "Add profile" and the Users settings section.
 */

import { useId, useState } from "react";
import {
	PROFILE_COLORS,
	PROFILE_NAME_MAX,
	isValidPin,
	normalizeProfileName,
	profileGradient,
	type ProfileColor,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { ProfileAvatar } from "./profile-avatar";

export interface ProfileFormValues {
	name: string;
	color: ProfileColor;
	/** undefined = unchanged (editing), null = clear, string = set. */
	pin?: string | null;
}

export function ProfileForm({
	initial,
	hasPin = false,
	submitLabel,
	onSubmit,
	onCancel,
	compact = false,
}: {
	initial?: { name: string; color: ProfileColor };
	/** Editing a profile that already has a PIN: offer to keep or remove it. */
	hasPin?: boolean;
	submitLabel: string;
	/** Resolves to an error message to show, or null on success. */
	onSubmit: (values: ProfileFormValues) => Promise<string | null>;
	onCancel?: () => void;
	/** Settings density: smaller preview, tighter spacing. */
	compact?: boolean;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [color, setColor] = useState<ProfileColor>(initial?.color ?? "indigo");
	const [pin, setPin] = useState("");
	const [removePin, setRemovePin] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const pinId = useId();

	const submit = async () => {
		const trimmed = normalizeProfileName(name);
		if (!trimmed) return setError("Enter a name.");
		if (pin && !isValidPin(pin)) return setError("A PIN is 4 to 8 digits.");
		const values: ProfileFormValues = { name: trimmed, color };
		if (pin) values.pin = pin;
		else if (removePin) values.pin = null;
		else if (!initial) values.pin = null;
		setBusy(true);
		setError(null);
		const problem = await onSubmit(values);
		setBusy(false);
		if (problem) setError(problem);
	};

	return (
		<form
			data-testid="profile-form"
			className={cn("flex flex-col items-center", compact ? "gap-4" : "gap-6")}
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && onCancel) {
					e.preventDefault();
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<ProfileAvatar name={name || "?"} color={color} className={compact ? "size-16 text-xl" : "size-28 text-4xl"} />

			<label className="flex w-full max-w-72 flex-col gap-1.5">
				<span className="text-xs uppercase tracking-widest text-muted-foreground">Name</span>
				<input
					autoFocus
					value={name}
					maxLength={PROFILE_NAME_MAX}
					onChange={(e) => setName(e.target.value)}
					placeholder="Your name"
					data-testid="profile-name"
					className="h-9 rounded-md border border-border bg-background px-3 font-prose text-(length:--lh-prose-size) text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground"
				/>
			</label>

			<div className="flex w-full max-w-72 flex-col gap-1.5">
				<span className="text-xs uppercase tracking-widest text-muted-foreground">Color</span>
				<div role="radiogroup" aria-label="Color" className="flex justify-between gap-2">
					{PROFILE_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							role="radio"
							aria-checked={color === c}
							aria-label={c}
							data-testid={`profile-color-${c}`}
							onClick={() => setColor(c)}
							className={cn(
								"size-7 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
								color === c && "ring-2 ring-foreground",
							)}
							style={{ backgroundImage: profileGradient(c) }}
						/>
					))}
				</div>
			</div>

			<div className="flex w-full max-w-72 flex-col gap-1.5">
				<label htmlFor={pinId} className="text-xs uppercase tracking-widest text-muted-foreground">
					{hasPin ? "New PIN" : "PIN"} <span className="normal-case tracking-normal text-muted-foreground/60">(optional)</span>
				</label>
				<input
					id={pinId}
					type="password"
					inputMode="numeric"
					autoComplete="off"
					value={pin}
					maxLength={8}
					onChange={(e) => {
						setPin(e.target.value.replace(/\D/g, ""));
						setRemovePin(false);
					}}
					placeholder={hasPin ? "Leave empty to keep it" : "4 to 8 digits"}
					data-testid="profile-pin"
					className="h-9 rounded-md border border-border bg-background px-3 font-ui text-sm tracking-[0.3em] text-foreground outline-none placeholder:tracking-normal placeholder:text-muted-foreground/60 focus:border-muted-foreground"
				/>
				{hasPin && (
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={removePin}
							onChange={(e) => {
								setRemovePin(e.target.checked);
								if (e.target.checked) setPin("");
							}}
							data-testid="profile-remove-pin"
						/>
						Remove the PIN
					</label>
				)}
			</div>

			{error && (
				<p role="alert" data-testid="profile-error" className="text-xs text-red-400">
					{error}
				</p>
			)}

			<div className="flex gap-2">
				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						className="h-8 rounded-md px-4 font-ui text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Cancel
					</button>
				)}
				<button
					type="submit"
					disabled={busy}
					data-testid="profile-submit"
					className="h-8 rounded-md bg-primary px-4 font-ui text-xs uppercase tracking-wider text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}
