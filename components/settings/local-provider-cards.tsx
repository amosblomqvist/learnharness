"use client";

import { useEffect, useState } from "react";
import { Toggle } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";
import type { LocalProvidersSettings, ModelCatalogEntry } from "@/src/core";

export function LocalProviderCards() {
	const [settings, setSettings] = useState<LocalProvidersSettings>({
		ollama: { enabled: false, baseUrl: "http://localhost:11434", defaultContextWindow: 32768 },
		custom: { enabled: false, baseUrl: "http://localhost:8000/v1", defaultContextWindow: 32768 },
	});

	// Ollama form state
	const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
	const [ollamaTesting, setOllamaTesting] = useState(false);
	const [ollamaSaved, setOllamaSaved] = useState(false);
	const [ollamaResult, setOllamaResult] = useState<{ ok: boolean; models: ModelCatalogEntry[]; error?: string } | null>(null);

	// Custom form state
	const [customUrl, setCustomUrl] = useState("http://localhost:8000/v1");
	const [customKey, setCustomKey] = useState("");
	const [hasSavedKey, setHasSavedKey] = useState(false);
	const [customCtx, setCustomCtx] = useState(32768);
	const [customTesting, setCustomTesting] = useState(false);
	const [customSaved, setCustomSaved] = useState(false);
	const [customResult, setCustomResult] = useState<{ ok: boolean; models: ModelCatalogEntry[]; error?: string } | null>(null);

	// Fetch initial settings
	useEffect(() => {
		fetch("/api/settings")
			.then((r) => r.json())
			.then((data: Record<string, unknown>) => {
				// Support top-level, data.settings, or data.effective response shapes
				const root = (data.effective ?? data.settings ?? data) as { localProviders?: LocalProvidersSettings };
				if (root.localProviders) {
					setSettings((prev) => ({
						ollama: { ...prev.ollama, ...root.localProviders?.ollama },
						custom: { ...prev.custom, ...root.localProviders?.custom },
					}));
					if (root.localProviders.ollama?.baseUrl) setOllamaUrl(root.localProviders.ollama.baseUrl);
					if (root.localProviders.custom?.baseUrl) setCustomUrl(root.localProviders.custom.baseUrl);
					if (root.localProviders.custom?.defaultContextWindow) setCustomCtx(root.localProviders.custom.defaultContextWindow);
				}
			})
			.catch(() => undefined);

		fetch("/api/keys")
			.then((r) => r.json())
			.then((data: unknown) => {
				// Support array response or { keys / rows / statuses } object wrapper
				const list = Array.isArray(data)
					? data
					: ((data as { keys?: unknown[]; rows?: unknown[]; statuses?: unknown[] })?.keys ??
					   (data as { rows?: unknown[] })?.rows ??
					   (data as { statuses?: unknown[] })?.statuses ??
					   []);
				const found = (list as Array<{ id?: string; present?: boolean }>).find(
					(k) => k.id === "LOCAL_AI_API_KEY",
				);
				if (found?.present) {
					setHasSavedKey(true);
					setCustomKey("••••••••");
				}
			})
			.catch(() => undefined);
	}, []);

	async function saveLocalSettings(updated: LocalProvidersSettings) {
		setSettings(updated);
		await fetch("/api/settings/localProviders", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(updated),
		});
		notifySettingsSaved("models");
	}

	async function saveOllama(url?: string, enabled?: boolean) {
		const nextUrl = (url ?? ollamaUrl).trim();
		let updated: LocalProvidersSettings = settings;
		setSettings((prev) => {
			const nextEnabled = enabled ?? Boolean(prev.ollama?.enabled);
			updated = {
				...prev,
				ollama: { ...prev.ollama, enabled: nextEnabled, baseUrl: nextUrl },
			};
			return updated;
		});
		await saveLocalSettings(updated);
		setOllamaSaved(true);
		setTimeout(() => setOllamaSaved(false), 2000);
	}

	async function saveCustom(url?: string, key?: string, ctx?: number, enabled?: boolean) {
		const nextUrl = (url ?? customUrl).trim();
		const nextKey = key ?? customKey;
		const nextCtx = ctx ?? customCtx;

		const promises: Promise<unknown>[] = [];

		if (nextKey && nextKey !== "••••••••") {
			promises.push(
				fetch("/api/keys/LOCAL_AI_API_KEY", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: nextKey }),
				})
					.then((res) => {
						if (res.ok) {
							setHasSavedKey(true);
							setCustomKey("••••••••");
							notifySettingsSaved("keys");
						}
					})
					.catch(() => undefined),
			);
		} else if (nextKey === "" && hasSavedKey) {
			promises.push(
				fetch("/api/keys/LOCAL_AI_API_KEY", { method: "DELETE" })
					.then(() => {
						setHasSavedKey(false);
						notifySettingsSaved("keys");
					})
					.catch(() => undefined),
			);
		}

		let updated: LocalProvidersSettings = settings;
		setSettings((prev) => {
			const nextEnabled = enabled ?? Boolean(prev.custom?.enabled);
			updated = {
				...prev,
				custom: { ...prev.custom, enabled: nextEnabled, baseUrl: nextUrl, defaultContextWindow: nextCtx },
			};
			return updated;
		});
		promises.push(saveLocalSettings(updated));

		await Promise.all(promises);
		setCustomSaved(true);
		setTimeout(() => setCustomSaved(false), 2000);
	}

	async function testOllama() {
		setOllamaTesting(true);
		setOllamaResult(null);
		try {
			const res = await fetch("/api/local-providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					provider: "ollama",
					baseUrl: ollamaUrl,
				}),
			});
			const data = (await res.json()) as { ok: boolean; models: ModelCatalogEntry[]; error?: string };
			setOllamaResult(data);
			if (data.ok) {
				await saveOllama(ollamaUrl, true);
			}
		} catch (err) {
			setOllamaResult({ ok: false, models: [], error: String(err) });
		} finally {
			setOllamaTesting(false);
		}
	}

	async function testCustom() {
		setCustomTesting(true);
		setCustomResult(null);
		try {
			const payload: { provider: "custom"; baseUrl: string; apiKey?: string; defaultContextWindow: number } = {
				provider: "custom",
				baseUrl: customUrl,
				defaultContextWindow: customCtx,
			};
			if (customKey && customKey !== "••••••••") {
				payload.apiKey = customKey;
			}
			const res = await fetch("/api/local-providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = (await res.json()) as { ok: boolean; models: ModelCatalogEntry[]; error?: string };
			setCustomResult(data);
			if (data.ok) {
				await saveCustom(customUrl, customKey, customCtx, true);
			}
		} catch (err) {
			setCustomResult({ ok: false, models: [], error: String(err) });
		} finally {
			setCustomTesting(false);
		}
	}

	const isCustomDirty = () =>
		customUrl.trim() !== (settings.custom?.baseUrl ?? "http://localhost:8000/v1") ||
		customCtx !== (settings.custom?.defaultContextWindow ?? 32768) ||
		customKey !== (hasSavedKey ? "••••••••" : "");

	return (
		<div className="flex flex-col gap-4" data-testid="local-provider-cards">
			{/* Ollama Card */}
			<div className="rounded-lg border border-border/70 bg-card/40 p-4 transition-colors" data-testid="card-ollama">
				<div className="flex items-center justify-between pb-2">
					<div>
						<h3 className="font-ui text-sm font-medium text-foreground">Ollama</h3>
						<p className="text-xs text-muted-foreground">Local model runner with automatic model discovery</p>
					</div>
					<Toggle
						checked={Boolean(settings.ollama?.enabled)}
						label="Enable Ollama"
						onChange={(enabled) => void saveOllama(undefined, enabled)}
					/>
				</div>

				<div className="mt-3 flex flex-col gap-2.5">
					<div className="flex items-center gap-2">
						<input
							type="text"
							value={ollamaUrl}
							onChange={(e) => setOllamaUrl(e.target.value)}
							onBlur={() => {
								if (!ollamaTesting && ollamaUrl.trim() !== (settings.ollama?.baseUrl ?? "http://localhost:11434")) {
									void saveOllama();
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveOllama();
							}}
							placeholder="http://localhost:11434"
							className="h-8 flex-1 rounded border border-border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
							data-testid="input-ollama-url"
						/>
						<button
							type="button"
							onClick={() => void saveOllama()}
							className="h-8 rounded border border-border bg-background px-3 font-ui text-xs font-medium text-foreground hover:bg-accent/50"
							data-testid="btn-save-ollama"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => void testOllama()}
							disabled={ollamaTesting}
							className="h-8 rounded bg-secondary px-3 font-ui text-xs font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
							data-testid="btn-test-ollama"
						>
							{ollamaTesting ? "Connecting…" : "Test & Discover"}
						</button>
						{ollamaSaved && <span className="font-ui text-xs text-emerald-400">✓ Saved</span>}
					</div>

					<p className="text-[11px] text-muted-foreground/80">
						💡 Note: Ollama runtime context defaults to 2048/4096 tokens unless <code className="font-mono text-[10px]">OLLAMA_CONTEXT_LENGTH</code> or Modelfile <code className="font-mono text-[10px]">num_ctx</code> is configured.
					</p>

					{ollamaResult && (
						<div className="mt-1 rounded border border-border/50 bg-background/50 p-2.5" data-testid="ollama-probe-result">
							{ollamaResult.ok ? (
								<div>
									<p className="font-ui text-xs text-emerald-400">
										✓ Connected · {ollamaResult.models.length} {ollamaResult.models.length === 1 ? "model" : "models"} discovered
									</p>
									{ollamaResult.models.length > 0 && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{ollamaResult.models.map((m) => (
												<span
													key={m.id}
													className="inline-flex items-center rounded bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-foreground"
													title={`Context: ${m.contextWindow} tokens · Max tokens: ${m.maxTokens}`}
												>
													{m.id}
													{m.input.includes("image") && <span className="ml-1 text-[10px] text-sky-400">👁</span>}
													{m.reasoning && <span className="ml-1 text-[10px] text-amber-400">🧠</span>}
												</span>
											))}
										</div>
									)}
								</div>
							) : (
								<p className="font-ui text-xs text-destructive">✕ {ollamaResult.error || "Connection failed"}</p>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Custom (vLLM / LM Studio) Card */}
			<div className="rounded-lg border border-border/70 bg-card/40 p-4 transition-colors" data-testid="card-custom-vllm">
				<div className="flex items-center justify-between pb-2">
					<div>
						<h3 className="font-ui text-sm font-medium text-foreground">OpenAI-Compatible (vLLM / LM Studio)</h3>
						<p className="text-xs text-muted-foreground">Local or custom OpenAI-compatible server endpoints</p>
					</div>
					<Toggle
						checked={Boolean(settings.custom?.enabled)}
						label="Enable Custom Provider"
						onChange={(enabled) => void saveCustom(undefined, undefined, undefined, enabled)}
					/>
				</div>

				<div className="mt-3 flex flex-col gap-2.5">
					<div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
						<input
							type="text"
							value={customUrl}
							onChange={(e) => setCustomUrl(e.target.value)}
							onBlur={() => {
								if (!customTesting && isCustomDirty()) {
									void saveCustom();
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveCustom();
							}}
							placeholder="http://localhost:8000/v1"
							className="h-8 flex-1 rounded border border-border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
							data-testid="input-custom-url"
						/>
						<input
							type="password"
							value={customKey}
							onChange={(e) => setCustomKey(e.target.value)}
							onBlur={() => {
								if (!customTesting && isCustomDirty()) {
									void saveCustom();
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveCustom();
							}}
							placeholder="Optional API key"
							className="h-8 w-full sm:w-44 rounded border border-border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
							data-testid="input-custom-key"
						/>
					</div>

					<div className="flex items-center gap-2">
						<label className="text-xs text-muted-foreground">Default context window:</label>
						<input
							type="number"
							value={customCtx}
							onChange={(e) => setCustomCtx(Number(e.target.value) || 32768)}
							onBlur={() => {
								if (!customTesting && isCustomDirty()) {
									void saveCustom();
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveCustom();
							}}
							step={1024}
							min={1024}
							className="h-7 w-28 rounded border border-border bg-background px-2 font-mono text-xs text-foreground focus:border-foreground/40 focus:outline-none"
						/>
						<div className="flex-1" />
						<button
							type="button"
							onClick={() => void saveCustom()}
							className="h-8 rounded border border-border bg-background px-3 font-ui text-xs font-medium text-foreground hover:bg-accent/50"
							data-testid="btn-save-custom"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => void testCustom()}
							disabled={customTesting}
							className="h-8 rounded bg-secondary px-3 font-ui text-xs font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
							data-testid="btn-test-custom"
						>
							{customTesting ? "Connecting…" : "Test & Discover"}
						</button>
						{customSaved && <span className="font-ui text-xs text-emerald-400">✓ Saved</span>}
					</div>

					{customResult && (
						<div className="mt-1 rounded border border-border/50 bg-background/50 p-2.5" data-testid="custom-probe-result">
							{customResult.ok ? (
								<div>
									<p className="font-ui text-xs text-emerald-400">
										✓ Connected · {customResult.models.length} {customResult.models.length === 1 ? "model" : "models"} discovered
									</p>
									{customResult.models.length > 0 && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{customResult.models.map((m) => (
												<span
													key={m.id}
													className="inline-flex items-center rounded bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-foreground"
													title={`Context: ${m.contextWindow} tokens · Max tokens: ${m.maxTokens}`}
												>
													{m.id}
													<span className="ml-1 text-[10px] text-muted-foreground">({Math.round(m.contextWindow / 1024)}k)</span>
													{m.input.includes("image") && <span className="ml-1 text-[10px] text-sky-400">👁</span>}
													{m.reasoning && <span className="ml-1 text-[10px] text-amber-400">🧠</span>}
												</span>
											))}
										</div>
									)}
								</div>
							) : (
								<p className="font-ui text-xs text-destructive">✕ {customResult.error || "Connection failed"}</p>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
