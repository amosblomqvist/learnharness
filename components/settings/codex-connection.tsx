"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Toggle } from "./controls";

export function CodexConnection() {
	const [status, setStatus] = useState<CodexStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const mounted = useRef(false), pending = useRef(false);
	const signature = useRef("");
	const request = useCallback(async (op?: string) => {
		if (pending.current) return;
		pending.current = true;
		if (op) setBusy(true);
		try {
			const response = await fetch("/api/codex", { method: op ? "POST" : "GET", cache: "no-store",
				headers: { "x-learnharness-codex": "1", ...(op ? { "Content-Type": "application/json" } : {}) },
				...(op ? { body: JSON.stringify({ op }) } : {}) });
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? "Could not read Codex status.");
			if (mounted.current) { setStatus(body); setError(undefined); }
			const next = JSON.stringify([body.enabled, body.state, body.modelCount]);
			if (op || (signature.current && signature.current !== next)) notifySettingsSaved("keys");
			signature.current = next;
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Codex connection failed."); }
		finally { pending.current = false; if (mounted.current) setBusy(false); }
	}, []);
	useEffect(() => { mounted.current = true; void request(); return () => { mounted.current = false; }; }, [request]);
	useEffect(() => {
		if (status?.state !== "signing-in") return;
		const timer = setInterval(() => { void request(); }, 2000);
		return () => clearInterval(timer);
	}, [status?.state, request]);
	const label = status?.state === "connected" ? `Connected · ${status.modelCount} models`
		: status?.state === "signing-in" ? "Complete sign-in in your browser"
		: status?.state === "not-found" ? "Codex CLI not found" : status?.state === "signed-out" ? "Signed out"
		: status?.state === "error" ? "Connection unavailable" : status ? "Disabled" : "Checking…";
	return <div className="space-y-2" data-testid="codex-connection">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Codex</span>
			<Toggle label="Codex" checked={status?.enabled === true} disabled={!status || busy} onChange={(enabled) => void request(enabled ? "enable" : "disable")} />
		</div>
		{status?.enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{label}</span>
				{status.state === "signing-in" ? <>
					<a href={status.authUrl} target="_blank" rel="noreferrer" className="text-xs text-foreground underline underline-offset-2">Open Codex sign-in</a>
					<Button size="xs" variant="outline" disabled={busy} onClick={() => void request("cancel")}>Cancel</Button>
				</> : <>
					{status.state === "connected" ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void request("logout")}>Sign out</Button>
						: <Button size="xs" variant="outline" disabled={busy || status.state === "not-found"} onClick={() => void request("login")}>Sign in with Codex</Button>}
					<Button size="xs" variant="outline" disabled={busy} onClick={() => void request("refresh")}>Check again</Button>
				</>}
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground">Install Codex CLI v0.163.0+, sign in with ChatGPT, then choose Codex in your session or agent model settings. Selected background tasks can use it too.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Uses your ChatGPT plan and its limits. This login is stored locally for LearnHarness. Disable pauses use; Sign out removes the connection.</p>
			<a href="https://developers.openai.com/codex/cli" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">Codex setup ↗</a>
		</>}
		{(error || status?.error) && <p role="alert" className="text-xs text-destructive">{error ?? status?.error}</p>}
	</div>;
}
