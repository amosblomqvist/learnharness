"use client";
/**
 * A profile's avatar (multi-user profiles, 2026-10-27): the initials on
 * a gradient of the profile's color. No images, no dependencies.
 */

import { profileGradient, profileInitials, type ProfileColor } from "@/src/core";
import { cn } from "@/lib/utils";

export function ProfileAvatar({
	name,
	color,
	className,
}: {
	name: string;
	color: ProfileColor;
	/** Size + type scale, e.g. "size-28 text-4xl". */
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 select-none items-center justify-center rounded-full font-ui font-semibold text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]",
				className,
			)}
			style={{ backgroundImage: profileGradient(color) }}
		>
			{profileInitials(name)}
		</span>
	);
}
