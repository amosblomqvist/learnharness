"use client";

import { useEffect, useRef, useState } from "react";
import { ACP_AGENTS, type AcpConnectionConfig, type AcpConnectionStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

type AgentInfo = (typeof ACP_AGENTS)[number];

/** Shared by Settings and first-run setup so a subscription-only user can
 * reach the model slots without ever entering an API key. */
export function SubscriptionConnections() {
	const [connections, setConnections] = useState<AcpConnectionStatus[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/acp", { signal: controller.signal })
			.then((response) => { if (!response.ok) throw new Error("Connections could not be loaded"); return response.json(); })
			.then((body: { connections: AcpConnectionStatus[] }) => setConnections(body.connections))
			.catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
		return () => controller.abort();
	}, []);
	return (
		<div className="flex flex-col gap-3" data-testid="subscription-connections">
			<p className="text-xs text-muted-foreground">Use your ChatGPT or Claude subscription through its local agent. Your plan’s limits apply. Sign in with your subscription in the CLI before connecting.</p>
			{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
			{!connections && !error && <p className="text-xs text-muted-foreground">Loading connections…</p>}
			{connections && ACP_AGENTS.map((agent) => (
				<SubscriptionConnection key={agent.id} agent={agent} initial={connections.find((connection) => connection.id === agent.id)?.config ?? {}} />
			))}
		</div>
	);
}

/** Exported for render checks without invoking a live CLI. */
export function SubscriptionConnection({ agent, initial }: { agent: AgentInfo; initial: AcpConnectionConfig }) {
	const [enabled, setEnabled] = useState(initial.enabled ?? false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => request.current?.abort(), []);

	async function connect() {
		if (busy) return;
		setError(null);
		setBusy(true);
		const controller = new AbortController();
		request.current = controller;
		try {
			const response = await fetch(`/api/acp/${agent.id}`, {
				method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
				body: "{}",
			});
			const body = await response.json() as { error?: string };
			if (!response.ok) throw new Error(body.error ?? `Connection failed (${response.status})`);
			setEnabled(true);
			notifySettingsSaved("acp");
		} catch (error) {
			if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
		} finally { setBusy(false); request.current = null; }
	}

	async function disconnect() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/acp/${agent.id}`, { method: "DELETE" });
			if (!response.ok) throw new Error("Could not disconnect. Try again.");
			setEnabled(false);
			notifySettingsSaved("acp");
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	}

	return (
		<div className="rounded-sm border border-border p-3" data-testid={`subscription-${agent.id}`}>
			<div className="mb-2 flex items-center justify-between gap-2">
				<span className="font-ui text-sm">{agent.label}</span>
				<span className="text-xs text-muted-foreground">{enabled ? "Connected" : "Not connected"}</span>
			</div>
			<p className="text-xs text-muted-foreground">Install the adapter, then sign in:</p>
			<pre className="my-2 overflow-x-auto rounded-sm bg-background p-2 text-xs"><code>{`npm install -g ${agent.cliPackage} ${agent.package}\n${agent.login}`}</code></pre>
			<details className="mb-3 text-xs text-muted-foreground">
				<summary className="cursor-pointer">Adapter location</summary>
				<pre className="mt-2 overflow-x-auto">{initial.command ?? agent.command}{initial.args?.length ? ` ${JSON.stringify(initial.args)}` : ""}</pre>
				<p className="mt-2">Custom paths are configured locally in the host file selected by LH_ACP_HOST_CONFIG. Restart the app after editing it.</p>
			</details>
			<div className="flex gap-2">
				<button type="button" disabled={busy} onClick={() => void connect()} className="rounded-sm border border-border px-3 py-1.5 font-ui text-xs disabled:opacity-40">{busy ? "Checking…" : enabled ? "Check connection" : "Connect"}</button>
				{busy && <button type="button" onClick={() => request.current?.abort()} className="px-2 text-xs">Cancel</button>}
				{enabled && !busy && <button type="button" onClick={() => void disconnect()} className="px-2 text-xs text-muted-foreground">Disconnect</button>}
			</div>
			{error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
		</div>
	);
}
