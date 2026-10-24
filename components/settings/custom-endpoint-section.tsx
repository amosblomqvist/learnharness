"use client";
/**
 * Settings → Providers → Custom endpoint (fork addition): the user's own
 * OpenAI-compatible LLM router (llmrouter, LiteLLM, vLLM, Ollama, any
 * gateway speaking /chat/completions). Once the URL verifies, its models
 * federate into every model picker as the `custom` provider.
 *
 * The section is one small form: base URL, API key, Connect. Saving
 * fetches {base}/models with the key — a wrong URL or key fails HERE, with
 * the endpoint's own answer, and nothing is stored. Re-connecting with the
 * URL only re-runs discovery against the key already saved (that is how you
 * pick up new models); Disconnect clears both.
 */

import { useCallback, useEffect, useState } from "react";
import { SettingsSection } from "./controls.tsx";

interface EndpointView {
	baseUrl: string;
	models: { id: string; name: string }[];
	keyPresent: boolean;
}

const INPUT = "w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-foreground/40";

export function CustomEndpointSection() {
	const [view, setView] = useState<EndpointView | null>(null);
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const load = useCallback(() => {
		fetch("/api/custom-endpoint")
			.then((r) => (r.ok ? r.json() : null))
			.then((b: EndpointView | null) => {
				if (!b) return;
				setView(b);
				setUrl((current) => current || b.baseUrl);
			})
			.catch(() => undefined);
	}, []);
	useEffect(load, [load]);

	async function connect() {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const res = await fetch("/api/custom-endpoint", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: url, ...(key.trim() ? { apiKey: key.trim() } : {}) }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setError(body.error ?? `request failed (${res.status})`);
				return;
			}
			setKey("");
			setSaved(true);
			load();
		} catch {
			setError("could not reach the app server");
		} finally {
			setBusy(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		await fetch("/api/custom-endpoint", { method: "DELETE" }).catch(() => undefined);
		setKey("");
		setSaved(false);
		load();
		setBusy(false);
	}

	const connected = Boolean(view?.baseUrl && view.models.length);

	return (
		<SettingsSection
			title="Custom endpoint"
			hint="Any OpenAI-compatible URL (your LLM router, LiteLLM, vLLM, Ollama). Its models appear in every model picker as “Custom endpoint”."
			testid="settings-custom-endpoint"
		>
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">Base URL</span>
				<input
					className={INPUT}
					data-testid="custom-endpoint-url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://llmrouter.boyemma.com/v1"
					spellCheck={false}
					disabled={busy}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">API key{view?.keyPresent ? " (already saved — leave blank to reuse)" : ""}</span>
				<input
					className={INPUT}
					data-testid="custom-endpoint-key"
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={view?.keyPresent ? "••••••••" : "sk-…"}
					spellCheck={false}
					autoComplete="off"
					disabled={busy}
				/>
			</label>
			<div className="flex items-center gap-2">
				<button
					type="button"
					data-testid="custom-endpoint-connect"
					onClick={() => void connect()}
					disabled={busy || !url.trim()}
					className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
				>
					{busy ? "Checking…" : connected ? "Re-check & save" : "Connect"}
				</button>
				{connected && (
					<button type="button" onClick={() => void disconnect()} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
						Disconnect
					</button>
				)}
			</div>
			{error && <p data-testid="custom-endpoint-error" className="text-xs text-red-500">{error}</p>}
			{saved && !error && <p className="text-xs text-muted-foreground">Connected — the models are in your pickers now.</p>}
			{connected && (
				<p data-testid="custom-endpoint-models" className="text-xs text-muted-foreground">
					{view!.models.length} model{view!.models.length === 1 ? "" : "s"} available from this endpoint.
				</p>
			)}
		</SettingsSection>
	);
}