"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGY_MINIMUM_VERSION, type AgyStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function agyStatusLabel(status: AgyStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "meets-minimum": return `Version ${status.version} · meets minimum`;
		case "update-required": return `Version ${status.version} · update required`;
		default: return "Version could not be checked";
	}
}

export function AgyInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<AgyStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
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
				setEnabled(body.settings?.agy?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Antigravity CLI settings.");
		}
	}, []);
	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);
	useSettingsSaved((section) => { if (section === "agy") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/agy", { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }), signal: controller.signal });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.agy?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.agy.enabled);
				notifySettingsSaved("agy");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Antigravity CLI settings.");
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/agy", { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-agy": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as AgyStatus;
			if (!["not-found", "meets-minimum", "update-required", "version-unchecked"].includes(value.state)
				|| value.minimumVersion !== AGY_MINIMUM_VERSION
				|| (value.version !== null && (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)))) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);
	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return <div className="space-y-2" data-testid="agy-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Antigravity CLI (agy)</span>
			<Toggle label="Antigravity CLI" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : agyStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid="agy-check-again">Check again</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Install and authenticate the Antigravity CLI in your terminal, then select an AGY model here.</strong> LearnHarness starts it when needed - no background process required.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Checks installation/version only - not authentication, model access, or quota. AGY controls billing. Requires v{AGY_MINIMUM_VERSION}+.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently - they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
