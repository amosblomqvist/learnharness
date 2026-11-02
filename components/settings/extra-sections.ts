import type { ReactNode } from "react";

/**
 * Extra Settings sections contributed by a host build — the phone build
 * (src/browser/app) registers its on-device "Phone data" section here
 * before the app renders. The desktop app registers none, so its dialog is
 * exactly the built-in SECTIONS list.
 */
export type ExtraSettingsSection = {
	/** Unique section id (must not collide with a built-in one). */
	id: string;
	/** Nav label and section title. */
	label: string;
	hint?: string;
	render: () => ReactNode;
};

const extras: ExtraSettingsSection[] = [];

export function registerSettingsSection(section: ExtraSettingsSection): void {
	if (!extras.some((s) => s.id === section.id)) extras.push(section);
}

export function extraSettingsSections(): readonly ExtraSettingsSection[] {
	return extras;
}
