"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AntigravityStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function antigravityStatusLabel(status: AntigravityStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "ready": return `Version ${status.version ?? "unknown"} · installed`;
		case "unsupported": return "Update agy to a version supporting --settings and --json-schema";
		default: return "Version could not be checked";
	}
}

export function AntigravityInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
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
				setEnabled(body.settings?.antigravity?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Google Antigravity CLI settings.");
		}
	}, []);
	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);
	useSettingsSaved((section) => { if (section === "antigravity") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/antigravity", { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }), signal: controller.signal });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.antigravity?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.antigravity.enabled);
				notifySettingsSaved("antigravity");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Google Antigravity CLI settings.");
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
			const response = await fetch("/api/antigravity", { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-antigravity": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as AntigravityStatus;
			if (!["not-found", "ready", "unsupported"].includes(value.state)
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

	return <div className="space-y-2" data-testid="antigravity-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Google Antigravity CLI</span>
			<Toggle label="Google Antigravity CLI" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : antigravityStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid="antigravity-check-again">Check again</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Sign in to agy with your Google account, then select an Antigravity model here.</strong> LearnHarness starts it when needed—no background process required.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Uses your Google account subscription quota. AI credit overages are disabled for LearnHarness requests. Installation checks do not verify authentication, model access, or remaining quota. <a href="https://antigravity.google/docs/getting-started?tab=cli" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Setup ↗</a></p>
		</>}
	</div>;
}
