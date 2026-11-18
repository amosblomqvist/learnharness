"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { EXTERNAL_CLI_STATUS_STATES, type ExternalCliStatus, type UserSettings } from "@/src/core";
import type { SettingsSection } from "@/components/settings-signal";
import type { ReactNode } from "react";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function externalCliStatusLabel(status: ExternalCliStatus | null): string {
	switch (status?.state) {
		case EXTERNAL_CLI_STATUS_STATES.notFound: return "Not found";
		case EXTERNAL_CLI_STATUS_STATES.meetsMinimum: return `Version ${status.version} · meets minimum`;
		case EXTERNAL_CLI_STATUS_STATES.updateRequired: return `Version ${status.version} · update required`;
		case EXTERNAL_CLI_STATUS_STATES.nodeMissing: return "Found · Node.js not found on PATH";
		default: return "Version could not be checked";
	}
}

type Props = {
 name: string; section: Extract<SettingsSection, "claudeCode" | "codex" | "geminiCli">;
 statusUrl: string; statusHeaders: Record<string, string>; minimumVersion: string;
 testId: string; checkAgainTestId: string; introduction: ReactNode; billing: ReactNode; setupUrl: string;
};

function useExternalCliSettings({ name, section }: Props) {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
				setEnabled(body.settings?.[section]?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError(`Could not load ${name} settings.`);
		}
	}, [name, section]);
	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);
	useSettingsSaved((savedSection) => { if (savedSection === section) void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch(`/api/settings/${section}`, { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }), signal: controller.signal });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.[section]?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings[section]!.enabled!);
				notifySettingsSaved(section);
			}
		} catch {
			if (!controller.signal.aborted) setError(`Could not save ${name} settings.`);
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

 return { enabled, loaded, saving, error, save };
}

export function ExternalCliInstallationStatus(props: Props) {
 const { name, statusUrl, statusHeaders, minimumVersion, testId, checkAgainTestId, introduction, billing, setupUrl } = props;
 const { enabled, loaded, saving, error, save } = useExternalCliSettings(props);
 const [status, setStatus] = useState<ExternalCliStatus | null>(null);
 const [busy, setBusy] = useState(false);
 const request = useRef<AbortController | null>(null);
	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch(statusUrl, { cache: "no-store", signal: controller.signal, headers: statusHeaders });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as ExternalCliStatus;
			if (!Object.values(EXTERNAL_CLI_STATUS_STATES).includes(value.state)
				|| value.minimumVersion !== minimumVersion
				|| (value.version !== null && (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)))) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled, statusUrl, statusHeaders, minimumVersion]);
	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return <div className="space-y-2" data-testid={testId}>
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">{name}</span>
			<Toggle label={name} checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : externalCliStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid={checkAgainTestId}>Check again</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground">{introduction}</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Checks installation/version only—not authentication, model access, or quota. {billing} Requires v{minimumVersion}+. <a href={setupUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Setup ↗</a></p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
