"use client";
/**
 * The Connections section: custom OpenAI/Anthropic-compatible providers.
 * Subscription accounts (ChatGPT, Claude, Grok) live in the native
 * subscription UI, not here.
 *
 * Credentials stay on the server; the API key field is write-only.
 * API: GET/PUT/DELETE /api/connections/custom. Every mutation is JSON
 * with the X-LearnHarness-Connections header.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type CustomModelDefinition,
	type CustomProviderApi,
	type CustomProviderDefinition,
	type CustomProviderStatus,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

const MUTATION_HEADERS = { "Content-Type": "application/json", "X-LearnHarness-Connections": "1" };
const GENERIC_ERROR = "Something went wrong. Try again.";

/** Pure: the id the user typed, namespaced with custom-. */
export function namespaceCustomId(raw: string): string {
	const slug = raw
		.trim()
		.toLowerCase()
		.replace(/^custom-/, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `custom-${slug}` : "";
}

export interface ModelDraft {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	image: boolean;
	reasoning: boolean;
	costInput: string;
	costOutput: string;
	costCacheRead: string;
	costCacheWrite: string;
}
export interface CustomDraft {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	keyless: boolean;
	apiKey: string;
	models: ModelDraft[];
}

export function emptyModelDraft(): ModelDraft {
	return {
		id: "",
		name: "",
		contextWindow: "",
		maxTokens: "",
		image: false,
		reasoning: false,
		costInput: "",
		costOutput: "",
		costCacheRead: "",
		costCacheWrite: "",
	};
}
export function emptyCustomDraft(): CustomDraft {
	return { id: "", name: "", baseUrl: "", api: "openai-completions", keyless: false, apiKey: "", models: [emptyModelDraft()] };
}
export function draftFromStatus(p: CustomProviderStatus): CustomDraft {
	return {
		id: p.id,
		name: p.name,
		baseUrl: p.baseUrl,
		api: p.api,
		keyless: p.keyless,
		apiKey: "",
		models: p.models.map((m) => ({
			id: m.id,
			name: m.name,
			contextWindow: String(m.contextWindow),
			maxTokens: String(m.maxTokens),
			image: m.input.includes("image"),
			reasoning: m.reasoning,
			costInput: m.cost ? String(m.cost.input) : "",
			costOutput: m.cost ? String(m.cost.output) : "",
			costCacheRead: m.cost ? String(m.cost.cacheRead) : "",
			costCacheWrite: m.cost ? String(m.cost.cacheWrite) : "",
		})),
	};
}

function positiveInt(s: string): number | null {
	const n = Number(s);
	return s.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}
function nonNegative(s: string): number | null {
	if (s.trim() === "") return 0;
	const n = Number(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Pure: validate a draft into the PUT body, or one readable error.
 *  `keyAlreadyStored` lets an edit keep its write-only key. */
export function buildCustomRequest(
	draft: CustomDraft,
	keyAlreadyStored: boolean,
): { ok: true; body: { provider: CustomProviderDefinition; apiKey?: string } } | { ok: false; error: string } {
	const id = namespaceCustomId(draft.id);
	if (!id) return { ok: false, error: "Enter an id." };
	if (!draft.name.trim()) return { ok: false, error: "Enter a name." };
	try {
		const u = new URL(draft.baseUrl.trim());
		if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
	} catch {
		return { ok: false, error: "Base URL must start with http:// or https://." };
	}
	if (!draft.keyless && !draft.apiKey.trim() && !keyAlreadyStored) return { ok: false, error: "Enter an API key or choose keyless." };
	if (draft.models.length === 0) return { ok: false, error: "Add at least one model." };
	const models: CustomModelDefinition[] = [];
	const seen = new Set<string>();
	for (const [i, m] of draft.models.entries()) {
		const label = `Model ${i + 1}`;
		const mid = m.id.trim();
		if (!mid) return { ok: false, error: `${label}: enter an id.` };
		if (seen.has(mid)) return { ok: false, error: `${label}: duplicate id.` };
		seen.add(mid);
		const contextWindow = positiveInt(m.contextWindow);
		const maxTokens = positiveInt(m.maxTokens);
		if (contextWindow === null) return { ok: false, error: `${label}: context window must be a whole number above 0.` };
		if (maxTokens === null) return { ok: false, error: `${label}: max tokens must be a whole number above 0.` };
		const model: CustomModelDefinition = {
			id: mid,
			name: m.name.trim() || mid,
			contextWindow,
			maxTokens,
			input: m.image ? ["text", "image"] : ["text"],
			reasoning: m.reasoning,
		};
		const costFields = [m.costInput, m.costOutput, m.costCacheRead, m.costCacheWrite];
		if (costFields.some((c) => c.trim() !== "")) {
			const [input, output, cacheRead, cacheWrite] = [nonNegative(costFields[0]!), nonNegative(costFields[1]!), nonNegative(costFields[2]!), nonNegative(costFields[3]!)];
			if (input === null || output === null || cacheRead === null || cacheWrite === null)
				return { ok: false, error: `${label}: costs must be numbers, 0 or above.` };
			model.cost = { input, output, cacheRead, cacheWrite };
		}
		models.push(model);
	}
	const body: { provider: CustomProviderDefinition; apiKey?: string } = {
		provider: { id, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), api: draft.api, keyless: draft.keyless, models },
	};
	if (!draft.keyless && draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
	return { ok: true, body };
}

async function mutate(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error: string | null }> {
	try {
		const res = await fetch(url, {
			method,
			headers: MUTATION_HEADERS,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const data = await res.json().catch(() => null);
		if (res.ok) return { ok: true, data, error: null };
		const msg = (data as { error?: unknown } | null)?.error;
		return { ok: false, data, error: typeof msg === "string" && msg.length > 0 && msg.length <= 200 ? msg : GENERIC_ERROR };
	} catch {
		return { ok: false, data: null, error: "Request failed. Check your connection and try again." };
	}
}

const inputClass =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:opacity-50";
const linkBtn =
	"shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const quietBtn = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
			{label}
			{children}
		</label>
	);
}

/** The inline custom provider editor. */
export function CustomProviderEditor({
	initial,
	keyStored,
	onSaved,
	onCancel,
}: {
	initial: CustomDraft;
	keyStored: boolean;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<CustomDraft>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof CustomDraft>(k: K, v: CustomDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
	const setModel = (i: number, patch: Partial<ModelDraft>) =>
		setDraft((d) => ({ ...d, models: d.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

	async function save() {
		if (busy) return;
		const built = buildCustomRequest(draft, keyStored);
		if (!built.ok) return setError(built.error);
		setBusy(true);
		setError(null);
		const r = await mutate("PUT", "/api/connections/custom", built.body);
		setBusy(false);
		if (!r.ok) return setError(r.error);
		set("apiKey", "");
		onSaved();
	}

	return (
		<form
			className="flex flex-col gap-2 rounded-sm border border-border/60 p-2"
			data-testid="custom-editor"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="grid grid-cols-2 gap-2">
				<Field label="Id (prefixed with custom-)">
					<input
						className={inputClass}
						value={draft.id}
						onChange={(e) => set("id", e.target.value)}
						onBlur={() => set("id", namespaceCustomId(draft.id))}
						readOnly={keyStored || initial.id !== ""}
						data-testid="custom-id"
						placeholder="custom-local"
					/>
				</Field>
				<Field label="Name">
					<input className={inputClass} value={draft.name} onChange={(e) => set("name", e.target.value)} data-testid="custom-name" />
				</Field>
				<Field label="Base URL">
					<input className={inputClass} value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://host/v1" data-testid="custom-base-url" />
				</Field>
				<Field label="Dialect">
					<select className={inputClass} value={draft.api} onChange={(e) => set("api", e.target.value as CustomProviderApi)} data-testid="custom-api">
						<option value="openai-completions">OpenAI chat completions</option>
						<option value="openai-responses">OpenAI responses</option>
						<option value="anthropic-messages">Anthropic messages</option>
					</select>
				</Field>
			</div>
			<label className="flex items-center gap-2 text-xs text-foreground">
				<input type="checkbox" checked={draft.keyless} onChange={(e) => set("keyless", e.target.checked)} data-testid="custom-keyless" />
				No API key needed (local endpoint)
			</label>
			{!draft.keyless && (
				<Field label={keyStored ? "API key (leave blank to keep the saved key)" : "API key"}>
					<input
						type="password"
						autoComplete="off"
						className={`${inputClass} font-mono`}
						value={draft.apiKey}
						onChange={(e) => set("apiKey", e.target.value)}
						data-testid="custom-api-key"
					/>
				</Field>
			)}
			<p className="text-xs uppercase tracking-widest text-muted-foreground">Models</p>
			{draft.models.map((m, i) => (
				<fieldset key={i} className="flex flex-col gap-1.5 border-t border-border/60 pt-2" data-testid={`custom-model-${i}`}>
					<legend className="sr-only">Model {i + 1}</legend>
					<div className="grid grid-cols-4 gap-2">
						<Field label="Model id">
							<input className={inputClass} value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} />
						</Field>
						<Field label="Display name">
							<input className={inputClass} value={m.name} onChange={(e) => setModel(i, { name: e.target.value })} />
						</Field>
						<Field label="Context window">
							<input className={inputClass} inputMode="numeric" value={m.contextWindow} onChange={(e) => setModel(i, { contextWindow: e.target.value })} />
						</Field>
						<Field label="Max tokens">
							<input className={inputClass} inputMode="numeric" value={m.maxTokens} onChange={(e) => setModel(i, { maxTokens: e.target.value })} />
						</Field>
					</div>
					<div className="flex items-center gap-4 text-xs text-foreground">
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked={m.image} onChange={(e) => setModel(i, { image: e.target.checked })} />
							Accepts images
						</label>
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked={m.reasoning} onChange={(e) => setModel(i, { reasoning: e.target.checked })} />
							Reasoning
						</label>
						{draft.models.length > 1 && (
							<button type="button" className={quietBtn} onClick={() => set("models", draft.models.filter((_, j) => j !== i))}>
								Remove model
							</button>
						)}
					</div>
					<div className="grid grid-cols-4 gap-2">
						<Field label="Cost in, per M tokens (optional)">
							<input className={inputClass} inputMode="decimal" value={m.costInput} onChange={(e) => setModel(i, { costInput: e.target.value })} />
						</Field>
						<Field label="Cost out">
							<input className={inputClass} inputMode="decimal" value={m.costOutput} onChange={(e) => setModel(i, { costOutput: e.target.value })} />
						</Field>
						<Field label="Cache read">
							<input className={inputClass} inputMode="decimal" value={m.costCacheRead} onChange={(e) => setModel(i, { costCacheRead: e.target.value })} />
						</Field>
						<Field label="Cache write">
							<input className={inputClass} inputMode="decimal" value={m.costCacheWrite} onChange={(e) => setModel(i, { costCacheWrite: e.target.value })} />
						</Field>
					</div>
				</fieldset>
			))}
			<div>
				<button type="button" className={linkBtn} onClick={() => set("models", [...draft.models, emptyModelDraft()])} data-testid="custom-add-model">
					Add model
				</button>
			</div>
			{error && (
				<p role="alert" data-testid="custom-error" className="text-xs text-red-400">
					{error}
				</p>
			)}
			<div className="flex items-center gap-3">
				<button type="submit" disabled={busy} className={linkBtn} data-testid="custom-save">
					{busy ? "Saving…" : "Save provider"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy} className={quietBtn} data-testid="custom-cancel">
					Cancel
				</button>
			</div>
		</form>
	);
}

function CustomGroup() {
	const [providers, setProviders] = useState<CustomProviderStatus[] | null>(null);
	const [readFailed, setReadFailed] = useState(false);
	const [editing, setEditing] = useState<{ draft: CustomDraft; keyStored: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const alive = useRef(true);

	const load = useCallback(async () => {
		const gen = ++generation.current;
		try {
			const res = await fetch("/api/connections/custom");
			const body = (await res.json()) as { providers?: CustomProviderStatus[] };
			if (!alive.current || gen !== generation.current) return;
			if (!res.ok || !Array.isArray(body.providers)) throw new Error("bad read");
			setProviders(body.providers);
			setReadFailed(false);
		} catch {
			if (alive.current && gen === generation.current) setReadFailed(true);
		}
	}, []);
	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);

	function changed() {
		setEditing(null);
		void load();
		notifySettingsSaved("keys");
		notifySettingsSaved("models");
	}
	async function remove(id: string) {
		generation.current++;
		setError(null);
		const r = await mutate("DELETE", "/api/connections/custom", { id });
		if (!r.ok) setError(r.error);
		else {
			setProviders((p) => (p ? p.filter((x) => x.id !== id) : p));
			notifySettingsSaved("keys");
			notifySettingsSaved("models");
		}
		void load();
	}

	return (
		<SettingsGroup label="Custom providers" testid="connections-custom">
			{readFailed && (
				<p role="alert" className="text-xs text-red-400" data-testid="custom-read-error">
					Could not read custom providers.{" "}
					<button type="button" onClick={() => void load()} className={linkBtn}>
						Retry
					</button>
				</p>
			)}
			{providers?.length === 0 && !editing && <p className="text-xs text-muted-foreground">No custom providers.</p>}
			{providers?.map((p) => (
				<div key={p.id} className="flex items-center gap-2 py-1" data-testid={`custom-row-${p.id}`}>
					<span className="min-w-0 flex-1 truncate font-ui text-xs text-foreground">
						{p.name} <span className="text-muted-foreground">{p.id}</span>
					</span>
					<span className="text-xs text-muted-foreground">{p.keyless ? "keyless" : p.keyPresent ? "key saved" : "no key"}</span>
					<button type="button" className={linkBtn} onClick={() => setEditing({ draft: draftFromStatus(p), keyStored: p.keyPresent })} data-testid={`custom-edit-${p.id}`}>
						Edit
					</button>
					<button type="button" className={quietBtn} onClick={() => void remove(p.id)} data-testid={`custom-delete-${p.id}`}>
						Delete
					</button>
				</div>
			))}
			{error && (
				<p role="alert" className="text-xs text-red-400">
					{error}
				</p>
			)}
			{editing ? (
				<CustomProviderEditor
					key={editing.draft.id || "new"}
					initial={editing.draft}
					keyStored={editing.keyStored}
					onSaved={changed}
					onCancel={() => setEditing(null)}
				/>
			) : (
				<div>
					<button type="button" className={linkBtn} onClick={() => setEditing({ draft: emptyCustomDraft(), keyStored: false })} data-testid="custom-add">
						Add custom provider
					</button>
				</div>
			)}
		</SettingsGroup>
	);
}

export function ConnectionsSection() {
	return (
		<div data-testid="connections-section" className="flex flex-col gap-2">
			<CustomGroup />
		</div>
	);
}
