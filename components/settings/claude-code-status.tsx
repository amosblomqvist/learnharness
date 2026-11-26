"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	CLAUDE_CODE_MINIMUM_VERSION,
	type ClaudeCodeProfilesResponse,
	type ClaudeCodeStatus,
	type UserSettings,
} from "@/src/core";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { SettingsMenuTrigger, SettingsRow, Toggle } from "./controls";
import {
	ClaudeProfileMenuList,
	claudeProfileHint,
	claudeProfileTriggerLabel,
} from "./claude-profile-menu";

export function claudeCodeStatusLabel(status: ClaudeCodeStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "meets-minimum": return `Version ${status.version} · meets minimum`;
		case "update-required": return `Version ${status.version} · update required`;
		default: return "Version could not be checked";
	}
}

function isValidProfilesPayload(value: unknown): value is ClaudeCodeProfilesResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		Array.isArray(v.profiles) &&
		typeof v.defaultDir === "string" &&
		(v.configuredDir === null || typeof v.configuredDir === "string") &&
		(v.inheritedEnvDir === null || typeof v.inheritedEnvDir === "string") &&
		(v.effectiveDir === null || typeof v.effectiveDir === "string")
	);
}

export function ClaudeCodeInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [configDir, setConfigDir] = useState<string | undefined>(undefined);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [profilesData, setProfilesData] = useState<ClaudeCodeProfilesResponse | null>(null);
	const [profilesLoading, setProfilesLoading] = useState(false);
	const [profilesError, setProfilesError] = useState<string | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);

	const triggerRef = useRef<HTMLButtonElement>(null);
	const interactions = useOptionalInteractionLayers();
	const request = useRef<AbortController | null>(null);
	const profilesRequest = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);

	const read = useCallback(async () => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = await response.json() as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				setEnabled(body.settings?.claudeCode?.enabled === true);
				setConfigDir(body.settings?.claudeCode?.configDir);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Claude Code settings.");
		}
	}, []);
	useEffect(() => {
		void read();
		return () => {
			settingsRead.current?.abort();
			settingsWrite.current?.abort();
			profilesRequest.current?.abort();
		};
	}, [read]);
	useSettingsSaved((section) => { if (section === "claudeCode") void read(); });

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/claude-code", {
				cache: "no-store",
				signal: controller.signal,
				headers: { "x-learnharness-claude-code": "1" },
			});
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as ClaudeCodeStatus;
			if (!["not-found", "meets-minimum", "update-required", "version-unchecked"].includes(value.state)
				|| value.minimumVersion !== CLAUDE_CODE_MINIMUM_VERSION
				|| (value.version !== null && (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)))) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);

	const loadProfiles = useCallback(async () => {
		if (!enabled) return;
		profilesRequest.current?.abort();
		const controller = new AbortController();
		profilesRequest.current = controller;
		setProfilesLoading(true);
		setProfilesError(null);
		try {
			const response = await fetch("/api/claude-code/profiles", {
				cache: "no-store",
				signal: controller.signal,
				headers: { "x-learnharness-claude-code": "1" },
			});
			if (!response.ok) throw new Error("profiles unavailable");
			const value: unknown = await response.json();
			if (!isValidProfilesPayload(value)) throw new Error("invalid profiles response");
			if (!controller.signal.aborted) {
				setProfilesData(value);
				setProfilesError(null);
			}
		} catch {
			if (!controller.signal.aborted) setProfilesError("Could not scan Claude Code profiles.");
		} finally {
			if (!controller.signal.aborted) setProfilesLoading(false);
		}
	}, [enabled]);

	useEffect(() => {
		if (enabled) {
			void refresh();
			void loadProfiles();
		} else {
			request.current?.abort();
			profilesRequest.current?.abort();
			setStatus(null);
			setBusy(false);
			setProfilesData(null);
			setProfilesLoading(false);
			setProfilesError(null);
			setMenuOpen(false);
		}
		return () => {
			request.current?.abort();
			profilesRequest.current?.abort();
		};
	}, [enabled, refresh, loadProfiles]);

	useEffect(() => {
		if (!menuOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			if (interactions) {
				const popup = interactions.getTopLayer();
				if (
					popup?.kind !== "popup" ||
					popup.anchorRef?.current !== triggerRef.current ||
					!interactions.isElementEligible(popup.rootRef.current)
				) {
					return;
				}
			}
			const target = event.target;
			if (target instanceof Element && target.closest('[data-testid="claude-code-profile-menu"]')) return;
			if (target instanceof Node && triggerRef.current?.contains(target)) return;
			setMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [menuOpen, interactions]);

	const saveSettings = async (next: { enabled: boolean; configDir?: string | null }): Promise<boolean> => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		const payload: { enabled: boolean; configDir?: string | null } = { enabled: next.enabled };
		if (next.configDir !== undefined) {
			payload.configDir = next.configDir;
		}
		try {
			const response = await fetch("/api/settings/claudeCode", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!response.ok) {
				let message = "Could not save Claude Code settings.";
				try {
					const errBody = await response.json() as { error?: unknown };
					if (typeof errBody.error === "string" && errBody.error.trim()) {
						message = errBody.error;
					}
				} catch {
					// Keep fallback message when response body is not JSON.
				}
				if (!controller.signal.aborted) setError(message);
				return false;
			}
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.claudeCode?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.claudeCode.enabled);
				setConfigDir(body.settings.claudeCode.configDir);
				notifySettingsSaved("claudeCode");
			}
			return true;
		} catch {
			if (!controller.signal.aborted) setError("Could not save Claude Code settings.");
			return false;
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const pickProfile = async (picked: string | null) => {
		if (!enabled || saving) return;
		const saved = await saveSettings({ enabled: true, configDir: picked });
		if (saved) {
			setMenuOpen(false);
			if (
				!interactions ||
				interactions.isElementEligible(triggerRef.current) ||
				interactions.isPopupOrigin(triggerRef.current)
			) {
				triggerRef.current?.focus();
			}
			void loadProfiles();
			void refresh();
		}
	};

	const triggerLabel = claudeProfileTriggerLabel(configDir, profilesData);
	const hint = claudeProfileHint(configDir, profilesData);

	return <div className="space-y-2" data-testid="claude-code-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Claude Code</span>
			<Toggle
				label="Claude Code"
				checked={enabled}
				disabled={!loaded || saving}
				onChange={(next) => void saveSettings({ enabled: next, configDir })}
			/>
		</div>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : claudeCodeStatusLabel(status)}</span>
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="cursor-pointer disabled:cursor-not-allowed"
					disabled={busy}
					onClick={() => {
						void refresh();
						void loadProfiles();
					}}
					data-testid="claude-code-check-again"
				>
					Check again
				</Button>
			</div>
			<SettingsRow
				label="Profile"
				hint={<span className={hint.warning ? "text-error" : undefined}>{hint.text}</span>}
				testid="row-claude-code-profile"
			>
				<SettingsMenuTrigger
					ref={triggerRef}
					value={triggerLabel}
					data-testid="claude-code-profile-trigger"
					aria-label={`Claude Code profile: ${triggerLabel}`}
					aria-expanded={menuOpen}
					disabled={!loaded || saving}
					onClick={() => {
						setMenuOpen((open) => {
							const next = !open;
							if (next) void loadProfiles();
							return next;
						});
					}}
					className="min-w-28 max-w-[65%]"
				/>
			</SettingsRow>
			{menuOpen && <MenuShell
				anchorRef={triggerRef}
				testid="claude-code-profile-menu"
				onClose={(reason) => {
					setMenuOpen(false);
					if (reason === "escape") triggerRef.current?.focus();
					return "closed";
				}}
				preferredSide="down"
				menuClass="flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
			>
				<div onKeyDown={(event) => {
					if (event.key === "Enter") {
						if (event.target instanceof HTMLInputElement) event.preventDefault();
						event.stopPropagation();
					}
				}}>
					<ClaudeProfileMenuList
						data={profilesData}
						configuredDir={configDir}
						loading={profilesLoading}
						disabled={saving}
						error={profilesError}
						onPick={(picked) => { void pickProfile(picked); }}
					/>
				</div>
			</MenuShell>}
			<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Install and authenticate Claude Code in your terminal, then select a Claude Code model here.</strong> LearnHarness starts it when needed—no background process required.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Checks installation/version only—not authentication, model access, or quota. Claude Code controls billing. Requires v{CLAUDE_CODE_MINIMUM_VERSION}+. <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Setup ↗</a></p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
