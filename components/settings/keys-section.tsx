"use client";
/**
 * The Keys section (wave-5 polish, 2026-09-21 — owner design): a MINIMAL
 * key-value table. Provider left, masked key right, no description hints
 * (they took too much space), the "Get a key ↗" link a tiny muted guest.
 * Clicking a writable row unfolds a paste field + Save (+ Delete for a
 * file-sourced value) beneath it; Esc or a second click folds it away.
 * The Add-provider control is the LAST ROW of the table and uses the
 * app's shared dropdown look (ProviderMenuList — fuzzy search over the
 * 33 pi-ai providers).
 *
 * Owner rulings carried in:
 *  - Env-owned rows (a real environment variable owns the name — dev
 *    .env.local or launch env) render READ-ONLY + dimmed, no paste field:
 *    a paste box on a key the UI cannot make live would mislead.
 *  - OpenRouter is NOT special: one provider among 33, a row only when
 *    stored, otherwise it lives in the Add dropdown like everyone else.
 *  - Providers groups API keys, subscriptions, dictation and search.
 *    Unknown variables stay masked/read-only at the end of Model API keys.
 *
 * API: GET /api/keys (masked statuses + the providers array), PUT
 * /api/keys/:id (shape-gated 400s land inline), DELETE. Saves take
 * effect immediately. Plaintext never returns from the store.
 */

import { useEffect, useRef, useState } from "react";
import {
	AUTH_KEYS,
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	CUSTOM_PROVIDER,
	normalizeBaseUrl,
	type AuthKeyStatus,
	type CustomModel,
	type CustomModelOverride,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { SubscriptionConnections } from "./subscription-connections.tsx";
import { ClaudeCodeInstallationStatus } from "./claude-code-status.tsx";
import { ProviderMenuList } from "./model-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { DictationLanguageSetting } from "@/components/dictation-language";

/** One pi-ai provider with plain API-key auth (the Platform seam —
 *  derived from pi-ai's own env-key table; no drift possible). */
export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
}

interface KeysResponse {
	keys: AuthKeyStatus[];
	providers?: ProviderKeyInfo[];
}

/** The custom endpoint's non-secret status (GET /api/custom-provider). */
interface CustomStatus {
	keyReuseRequired: boolean;
	revision: string;
	authMode: "keyless" | "apiKey";
	keySource: "env" | "file" | "none";
	baseUrl: string;
	models: CustomModel[];
	/** User pins by model id (context / max output / thinking). */
	overrides: Record<string, CustomModelOverride>;
	manualModels: string[];
	keyPresent: boolean;
}

async function readCustomStatus(inspectKey = false): Promise<CustomStatus> {
	const response = await fetch(`/api/custom-provider${inspectKey ? "?authMode=apiKey" : ""}`);
	if (!response.ok) throw new Error("Unable to load custom configuration.");
	const cp = await response.json() as Partial<CustomStatus>;
	return { keyReuseRequired: Boolean(cp.keyReuseRequired), revision: response.headers.get("etag") ?? "", authMode: cp.authMode ?? "keyless", keySource: cp.keySource ?? "none", baseUrl: cp.baseUrl ?? "", models: cp.models ?? [], overrides: cp.overrides ?? {}, manualModels: cp.manualModels ?? [], keyPresent: Boolean(cp.keyPresent) };
}

/** The curated tools group, pinned by id (the catalog owns the copy;
 *  these ids are the contract). Derived from the catalog (search wave,
 *  2026-09-20: the Google CSE pair retired, Tavily + Brave joined) — the
 *  section can never drift from core/auth-keys.ts again. */
const TOOL_IDS = AUTH_KEYS.map((k) => k.id) as readonly string[];

/** The custom endpoint's synthetic Add-provider entry (offered only while unconfigured). */
export const CUSTOM_PROVIDER_INFO: ProviderKeyInfo = {
	id: CUSTOM_PROVIDER.id,
	envVar: CUSTOM_PROVIDER.envVar,
	label: CUSTOM_PROVIDER.label,
};

/** The classification driving the table groups. Pure — exported for
 *  tests. OpenRouter is un-pinned (wave-5 owner ruling): no synthesis,
 *  no special row — it rides the same provider classification. */
export function classifyKeys(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): {
	/** Stored provider keys (env or file), in GET order. */
	providerRows: AuthKeyStatus[];
	/** The curated tools rows (synthesized when absent — always shown,
	 *  they carry the docs links a first boot needs). */
	toolRows: AuthKeyStatus[];
	/** Unknown file vars — preserved, read-only. */
	unknownRows: AuthKeyStatus[];
	/** Providers without a stored key — the Add dropdown's options. */
	addable: ProviderKeyInfo[];
} {
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const isTool = (id: string) => (TOOL_IDS as readonly string[]).includes(id);
	const providerEnv = new Set((providers ?? []).map((p) => p.envVar));
	const synth = (id: string): AuthKeyStatus => ({
		id,
		info: null,
		present: false,
		masked: null,
		source: "none",
		shadowedByEnv: false,
	});
	const providerRows: AuthKeyStatus[] = [];
	const unknownRows: AuthKeyStatus[] = [];
	for (const s of statuses) {
		if (isTool(s.id)) continue;
		// The custom endpoint's key has its OWN home (the Custom endpoint
		// section), so it never shows here — not as a provider row, not as an
		// "other stored variable".
		if (s.id === CUSTOM_PROVIDER.envVar) continue;
		if (providerEnv.has(s.id) || (!s.info && providers === undefined)) providerRows.push(s);
		else if (!s.info) unknownRows.push(s);
		// (pre-interlude catalogs: a curated-but-unclassified status still
		// renders as a provider row so nothing disappears)
		else providerRows.push(s);
	}
	return {
		providerRows,
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows,
		addable: (providers ?? []).filter((p) => !byId.has(p.envVar)),
	};
}

/** A key row names its credential, not whichever provider sorts first.
 * Pi exposes Zen and Go separately but both read OPENCODE_API_KEY. */
export function providerKeyLabel(id: string, providers: readonly ProviderKeyInfo[] | undefined): string | undefined {
	const matches = providers?.filter((p) => p.envVar === id);
	if (matches?.some((p) => p.id === "opencode") && matches.some((p) => p.id === "opencode-go")) return "OpenCode (Zen / Go)";
	return matches?.[0]?.label;
}

/** The minimal status line, e.g. "…ab12 · 64 chars" (" · env" marks an
 *  environment-owned value — the row itself is read-only then). Pure. */
export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}

/** One table row: label left, tiny docs link + status right. Writable
 *  rows click-unfold an editor beneath (owner interaction); env-owned
 *  rows are dimmed and read-only (a paste box there would mislead). */
function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
}: {
	label: string;
	/** The "Get a key ↗" target — curated keys carry one. */
	docsUrl?: string;
	status: AuthKeyStatus;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	/** Folds the editor (owner, fix wave: the way OUT of a paste prompt
	 *  must be visible — Cancel beside Save/Delete, not only Esc). */
	onCancel: () => void;
	testid: string;
}) {
	const envOwned = status.source === "env";
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	// INLINE editing (owner, fix wave: "type the keys in line — more
	// table-like"): the expanded row becomes the editor itself — label
	// left, the paste field filling the middle, Save | Cancel (| Delete)
	// right — instead of a second line beneath the row.
	if (expanded && !envOwned) {
		return (
			<div data-testid={testid}>
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
					<span className="shrink-0 font-ui text-xs text-foreground">{label}</span>
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder="Paste key…"
						aria-label={`${label} key`}
						data-testid={`${testid}-input`}
						disabled={busy}
						autoFocus
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !value.trim()}
						data-testid={`${testid}-save`}
						className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Cancel
					</button>
					{status.present && status.source === "file" && onDelete && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Delete
						</button>
					)}
				</div>
				{error && (
					<p role="alert" data-testid={`${testid}-error`} className="px-1 text-xs text-red-500">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div data-testid={testid} className={envOwned ? "opacity-40" : undefined}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={() => !envOwned && onToggle()}
				className={`flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left ${
					envOwned ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent/50"
				}`}
			>
				<span className="font-ui text-xs text-foreground">{label}</span>
				<span className="flex items-center gap-2">
					{docsUrl && (
						<a
							href={docsUrl}
							target="_blank"
							rel="noreferrer"
							onClick={(e) => e.stopPropagation()}
							className="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
						>
							key ↗
						</a>
					)}
					<span data-testid={`${testid}-status`} className="font-mono text-[11px] text-muted-foreground">
						{keyStatusLine(status)}
					</span>
				</span>
			</button>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="pl-6 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}

/** The Add-provider control — the table's last row, the app's shared
 *  dropdown look (portaled menu, the search + arrow-walk machine). */
function AddProviderRow({
	addable,
	onPick,
}: {
	addable: ProviderKeyInfo[];
	onPick: (p: ProviderKeyInfo) => void;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={anchorRef} className="relative">
			<button
				type="button"
				aria-expanded={open}
				data-testid="add-provider"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<span>+ Add a provider</span>
				{addable.length > 0 && <span className="font-mono text-[11px]">{addable.length}</span>}
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="add-provider-menu"
					preferredSide="down"
					menuClass="flex w-72 flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
				>
					{/* Close on pick (owner, fix wave): a chosen provider ends
					    the dropdown — the paste row is the next step. */}
					<ProviderMenuList
						providers={addable}
						onPick={(p) => {
							setOpen(false);
							onPick(p);
						}}
					/>
				</MenuShell>
			)}
		</div>
	);
}

export function KeysSection({
	/** A deep-linked row to unfold on arrival (zero-keys wave): the
	 *  dictation error's click lands here on DEEPGRAM_API_KEY. Followed
	 *  while mounted too — the settings dialog's while-open retarget
	 *  pattern. undefined = nothing seeded. */
	initialRow,
}: {
	initialRow?: string;
}) {
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [providers, setProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	/** The unfolded row (its id), null = all folded. Seeded by the
	 *  deep-link (initialRow) and re-followed when it retargets. */
	const [openRow, setOpenRow] = useState<string | null>(initialRow ?? null);
	/** The paste editor for a freshly chosen Add-provider target. */
	const [adding, setAdding] = useState<ProviderKeyInfo | null>(null);
	const [addError, setAddError] = useState<string | null>(null);
	/** The custom endpoint's status + whether its connect editor is open. */
	const [custom, setCustom] = useState<CustomStatus | null>(null);
	const [addingCustom, setAddingCustom] = useState(false);

	// Escape folds any open editor (unfolded row or the Add-provider paste)
	// WITHOUT closing the dialog. Claimed at document CAPTURE phase — the
	// only stopPropagation that outruns both the input's React handler and
	// the dialog's window-level listener.
	useEffect(() => {
		if (openRow === null && adding === null && !addingCustom) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// A language dropdown above this editor in the dismissal stack owns
			// the first Escape; do not swallow it at document capture phase.
			if (document.querySelector('[data-testid="dictation-language-menu"]')) return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
			setAdding(null);
			setAddingCustom(false);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow, adding, addingCustom]);

	const reload = async () => {
		try {
			const body = (await fetch("/api/keys").then((r) => r.json())) as KeysResponse;
			setStatuses(body.keys ?? []);
			if (body.providers) setProviders(body.providers);
		} catch {
			setStatuses([]);
		} finally {
			setLoading(false);
		}
		// Best-effort and independent: the custom endpoint's status must never
		// blank the provider-key list above if its fetch fails.
		try {
			setCustom(await readCustomStatus());
		} catch {
			/* custom status unavailable — leave it unset */
		}
	};

	useEffect(() => {
		void reload();
	}, []);

	// The deep-link follow: a retarget while the section is open (the
	// same while-open pattern the dialog's section nav uses) unfolds the
	// named row; a fresh mount seeds it via the useState initializer.
	useEffect(() => {
		if (initialRow !== undefined) setOpenRow(initialRow);
	}, [initialRow]);

	async function saveKey(id: string, value: string): Promise<string | null> {
		const res = await fetch(`/api/keys/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return body.error ?? `Save failed (${res.status})`;
		}
		await reload();
		// The cross-surface keys signal (zero-keys wave): the zero-keys pill,
		// the setup dialog's stage advance, and any other keys reader hear
		// that a key landed — deletions included (see deleteKey below).
		notifySettingsSaved("keys");
		return null;
	}

	async function deleteKey(id: string): Promise<void> {
		await fetch(`/api/keys/${id}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		notifySettingsSaved("keys");
	}

	/** Forget the custom endpoint (config + key server-side), same rhythm as
	 *  deleteKey: fire, re-read, broadcast so the catalog narrows everywhere. */
	async function disconnectCustom(revision: string): Promise<string | null> {
		const res = await fetch("/api/custom-provider", { method: "DELETE", headers: { "content-type": "application/json", "if-match": revision }, body: JSON.stringify({}) }).catch(() => null);
		if (!res?.ok) return res ? ((await res.json().catch(() => ({}))).error ?? "Disconnect failed.") : "Disconnect failed. Check your connection.";
		setAddingCustom(false);
		await reload();
		notifySettingsSaved("keys");
		return null;
	}

	if (loading || statuses === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading keys…</p>;
	}

	const { providerRows, toolRows, unknownRows, addable } = classifyKeys(statuses, providers);

	async function saveNewProvider(p: ProviderKeyInfo, value: string) {
		const err = await saveKey(p.envVar, value);
		if (err) setAddError(err);
		else {
			setAdding(null);
			setAddError(null);
		}
	}

	return (
		<>
			<SettingsGroup label="Model API keys" testid="group-provider-keys">
				{providerRows.map((status) => (
					<KeyTableRow
						key={status.id}
						label={providerKeyLabel(status.id, providers) ?? status.info?.label ?? status.id}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await saveKey(status.id, v);
							if (!err) setOpenRow(null); // fold on success — rest state
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => deleteKey(status.id)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				))}
				{custom?.baseUrl && (
					<CustomEndpointRow
						status={custom}
						expanded={addingCustom}
						onToggle={() => setAddingCustom((v) => !v)}
					/>
				)}
				{addingCustom && (
					<CustomEndpointEditor
						revision0={custom?.revision ?? ""}
						authMode0={custom?.authMode ?? "keyless"}
						keySource0={custom?.keySource ?? "none"}
						keyReuseRequired0={custom?.keyReuseRequired ?? false}
						onReload={async () => { await reload(); setAddingCustom(false); }}
						baseUrl0={custom?.baseUrl ?? ""}
						keyPresent={custom?.keyPresent ?? false}
						models={custom?.models ?? []}
						overrides={custom?.overrides ?? {}}
						manualModels0={custom?.manualModels ?? []}
						onSaved={async () => {
							setAddingCustom(false);
							await reload();
							notifySettingsSaved("keys");
						}}
						onPinsSaved={async () => {
							await reload();
							notifySettingsSaved("keys");
						}}
						onDelete={disconnectCustom}
						onCancel={() => setAddingCustom(false)}
					/>
				)}
				{providers !== undefined && (
					<AddProviderRow
						addable={custom?.baseUrl ? addable : [...addable, CUSTOM_PROVIDER_INFO]}
						onPick={(p) => {
							setAddError(null);
							if (p.id === CUSTOM_PROVIDER.id) {
								setAdding(null);
								setAddingCustom(true);
							} else {
								setAddingCustom(false);
								setAdding(p);
							}
						}}
					/>
				)}
				{adding && (
					<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`key-${adding.id}-editor`}>
						<span className="shrink-0 font-ui text-xs text-foreground">{adding.label}</span>
						<AddProviderEditor provider={adding} onSave={(v) => void saveNewProvider(adding, v)} onCancel={() => setAdding(null)} error={addError} />
					</div>
				)}
				{unknownRows.length > 0 && <div data-testid="group-unknown-keys">
					{unknownRows.map((status) => <div key={status.id} data-testid={`unknown-${status.id}`} className="flex items-center justify-between gap-3 px-1 py-1.5 opacity-40">
						<span className="font-mono text-xs text-foreground">{status.id}</span>
						<span className="font-mono text-[11px] text-muted-foreground">{status.masked}</span>
					</div>)}
				</div>}
			</SettingsGroup>

			<SettingsGroup label="Subscriptions" testid="group-subscriptions">
				<SubscriptionConnections />
			</SettingsGroup>

			<SettingsGroup label="External CLI" testid="group-external-cli">
				<ClaudeCodeInstallationStatus />
			</SettingsGroup>

			{(["Dictation", "Search"] as const).map((label) => <SettingsGroup key={label} label={label} testid={label === "Dictation" ? "group-dictation" : "group-search"}>
				{toolRows.filter((status) => label === "Dictation" ? status.id === "DEEPGRAM_API_KEY" : status.id !== "DEEPGRAM_API_KEY").map((status) => (
					<KeyTableRow
						key={status.id}
						label={status.info?.label ?? status.id}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await saveKey(status.id, v);
							if (!err) setOpenRow(null);
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => deleteKey(status.id)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				))}
				{label === "Dictation" && <>
					<DictationLanguageSetting />
					<p data-testid="dictation-setup-hint" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
						Create a <a
							href="https://console.deepgram.com/"
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2 hover:text-foreground"
						>Deepgram API key</a> with the Member role or higher, then add it above.
					</p>
				</>}
			</SettingsGroup>)}

		</>
	);
}

/** The paste field for a provider chosen in the Add dropdown — rendered
 *  beneath the Add row until saved or cancelled. */
function AddProviderEditor({
	provider,
	onSave,
	onCancel,
	error,
}: {
	provider: ProviderKeyInfo;
	onSave: (value: string) => void;
	onCancel: () => void;
	error: string | null;
}) {
	const [value, setValue] = useState("");
	return (
		<>
			<input
				type="text"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) onSave(value);
				}}
				placeholder="Paste key…"
				aria-label={`${provider.label} key`}
				data-testid={`key-${provider.id}-input`}
				autoFocus
				className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
			/>
			<button
				type="button"
				onClick={() => value.trim() && onSave(value)}
				disabled={!value.trim()}
				data-testid={`key-${provider.id}-save`}
				className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
			>
				Save
			</button>
			<button
				type="button"
				onClick={onCancel}
				data-testid={`key-${provider.id}-cancel`}
				className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
			>
				Cancel
			</button>
			{error && (
				<p role="alert" className="w-full pl-0 text-xs text-red-500" data-testid={`key-${provider.id}-error`}>
					{error}
				</p>
			)}
		</>
	);
}

/** One donor editor for first setup and Settings; setup omits offline pin and
 * disconnect controls, while authentication/revisions/manual IDs stay identical. */
export function CustomEndpointSetup({ onSaved }: { onSaved: () => void | Promise<void> }) {
	const [status, setStatus] = useState<CustomStatus | null>(null);
	const [error, setError] = useState(false);
	async function reload() {
		try { setStatus(await readCustomStatus()); setError(false); }
		catch { setError(true); }
	}
	useEffect(() => { void reload(); }, []);
	if (!status || error) return <div className="text-xs">{error ? "Unable to load custom configuration." : "Loading custom configuration…"}{error && <button onClick={() => void reload()}>Retry</button>}</div>;
	return <CustomEndpointEditor key={status.revision} setup revision0={status.revision} authMode0={status.authMode} keySource0={status.keySource} keyReuseRequired0={status.keyReuseRequired} baseUrl0={status.baseUrl} keyPresent={status.keyPresent} models={status.models} overrides={status.overrides} manualModels0={status.manualModels} onSaved={onSaved} onPinsSaved={reload} onReload={reload} onCancel={reload} />;
}

/** The custom endpoint's status row (shown once configured); clicking re-opens the editor. */
function CustomEndpointRow({
	status,
	expanded,
	onToggle,
}: {
	status: CustomStatus;
	expanded: boolean;
	onToggle: () => void;
}) {
	const count = status.models.length;
	const line = `${status.baseUrl} · ${count} model${count === 1 ? "" : "s"} · ${status.authMode === "keyless" ? "keyless" : status.keyPresent ? "API key" : "API key missing"}`;
	return (
		<div data-testid="custom-endpoint-row">
			<button
				type="button"
				data-testid="custom-endpoint-row-btn"
				aria-expanded={expanded}
				onClick={onToggle}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left cursor-pointer transition-colors hover:bg-accent/50"
			>
				<span className="font-ui text-xs text-foreground">Custom endpoint</span>
				<span data-testid="custom-endpoint-status" className="max-w-[60%] truncate font-mono text-[11px] text-muted-foreground">
					{line}
				</span>
			</button>
		</div>
	);
}

/** A pin row's raw input state — "" means "no pin": the endpoint's own value,
 *  then the compiled default, decides. `reasoning` is tri-state. */
interface PinDraft {
	context: string;
	maxTokens: string;
	reasoning: "" | "on" | "off";
}

const pinDraft = (pin: CustomModelOverride | undefined): PinDraft => ({
	context: pin?.context === undefined ? "" : String(pin.context),
	maxTokens: pin?.maxTokens === undefined ? "" : String(pin.maxTokens),
	reasoning: pin?.reasoning === undefined ? "" : pin.reasoning ? "on" : "off",
});

/** One draft row per discovered model, seeded from the stored pins. */
function draftsFor(
	models: readonly CustomModel[],
	overrides: Record<string, CustomModelOverride>,
): Record<string, PinDraft> {
	return Object.fromEntries(models.map((m) => [m.id, pinDraft(overrides[m.id])]));
}

/** Drafts → the PATCH payload (replace-whole): a blank field sends nothing and
 *  a fully blank model is absent — which IS the un-pin. */
function pinsPayload(drafts: Record<string, PinDraft>): Record<string, CustomModelOverride> {
	const out: Record<string, CustomModelOverride> = {};
	for (const [id, d] of Object.entries(drafts)) {
		const pin: CustomModelOverride = {};
		if (d.context.trim()) pin.context = Number(d.context);
		if (d.maxTokens.trim()) pin.maxTokens = Number(d.maxTokens);
		if (d.reasoning !== "") pin.reasoning = d.reasoning === "on";
		if (Object.keys(pin).length) Object.defineProperty(out, id, { value: pin, enumerable: true });
	}
	return out;
}

/** testids must survive ids carrying slashes, colons, dots. */
const pinTestid = (prefix: string, id: string) => `${prefix}-${id.replace(/[^a-z0-9-]/gi, "_")}`;

/** The custom endpoint's connect editor: base URL + key → POST /api/custom-provider
 *  (validate + discover + register), and the per-model limits form → PATCH (pins,
 *  no probe, so it works with the local server switched off). Image capability is
 *  detected automatically. */
function CustomEndpointEditor({
	setup = false,
	revision0, authMode0, keySource0, keyReuseRequired0, onReload,
	baseUrl0,
	keyPresent: initialKeyPresent,
	models,
	overrides,
	manualModels0,
	onSaved,
	onPinsSaved,
	onCancel,
	onDelete,
}: {
	setup?: boolean;
	revision0: string;
	authMode0: "keyless" | "apiKey";
	keySource0: "env" | "file" | "none";
	keyReuseRequired0: boolean;
	onReload: () => void | Promise<void>;
	baseUrl0: string;
	keyPresent: boolean;
	/** The discovered models — one limits row each. */
	models: readonly CustomModel[];
	/** Their stored user pins. */
	overrides: Record<string, CustomModelOverride>;
	manualModels0: readonly string[];
	onSaved: () => void | Promise<void>;
	/** Pins saved — the editor stays open (a form, not a connect). */
	onPinsSaved: () => void | Promise<void>;
	onCancel: () => void;
	onDelete?: (revision: string) => Promise<string | null>;
}) {
	const [revision, setRevision] = useState(revision0);
	const [authMode, setAuthMode] = useState(authMode0);
	const [keySource, setKeySource] = useState(keySource0);
	const [keyPresent, setKeyPresent] = useState(initialKeyPresent);
	const [keyReuseRequired, setKeyReuseRequired] = useState(keyReuseRequired0);
	const [authLoading, setAuthLoading] = useState(false);
	const [reuseKey, setReuseKey] = useState(false);
	useEffect(() => {
		if (authMode !== "apiKey") return;
		let cancelled = false;
		setAuthLoading(true);
		readCustomStatus(true).then((status) => {
			if (cancelled) return;
			setKeySource(status.keySource);
			setKeyPresent(status.keyPresent);
			setKeyReuseRequired(status.keyReuseRequired);
			if (status.keySource === "env") setKey("");
		}).catch(() => { if (!cancelled) setError("Unable to inspect effective key. Reload configuration and retry."); })
			.finally(() => { if (!cancelled) setAuthLoading(false); });
		return () => { cancelled = true; };
	}, [authMode]);
	const [baseUrl, setBaseUrl] = useState(baseUrl0);
	const [key, setKey] = useState("");
	const [keyTouched, setKeyTouched] = useState(false);
	const [manualModels, setManualModels] = useState(manualModels0.join(", "));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The limits form: edited drafts over the stored pins, plus the last saved
	// payload as the dirty baseline (the server's echo is what gets stored).
	const [drafts, setDrafts] = useState<Record<string, PinDraft>>(() => draftsFor(models, overrides));
	const [baseline, setBaseline] = useState(() => JSON.stringify(pinsPayload(draftsFor(models, overrides))));
	const [pinsBusy, setPinsBusy] = useState(false);
	const [pinsError, setPinsError] = useState<string | null>(null);
	const changedTarget = normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(baseUrl0);
	const canConnect = Boolean(baseUrl.trim()) && (authMode === "keyless" || (!authLoading && ((Boolean(key.trim()) && keySource !== "env") || (keyPresent && (!(changedTarget || keyReuseRequired) || reuseKey)))));

	const draftOf = (m: CustomModel): PinDraft => drafts[m.id] ?? pinDraft(overrides[m.id]);
	const setDraft = (m: CustomModel, patch: Partial<PinDraft>) =>
		setDrafts((prev) => ({ ...prev, [m.id]: { ...draftOf(m), ...patch } }));
	const current = Object.fromEntries(models.map((m) => [m.id, draftOf(m)])) as Record<string, PinDraft>;
	const dirty = JSON.stringify(pinsPayload(current)) !== baseline;

	async function savePins() {
		if (pinsBusy || busy || !dirty) return;
		setPinsBusy(true);
		setPinsError(null);
		const res = await fetch("/api/custom-provider", {
			method: "PATCH",
			headers: { "content-type": "application/json", "if-match": revision },
			body: JSON.stringify({ overrides: pinsPayload(current) }),
		}).catch(() => null);
		if (!res || !res.ok) {
			const b = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setPinsError(res ? (b?.error ?? `Save failed (${res.status})`) : "Save failed. Check your connection.");
			setPinsBusy(false);
			return;
		}
		setRevision(res.headers.get("etag") ?? revision);
		// The server's stored map is the truth — echo it back.
		const body = (await res.json().catch(() => null)) as { overrides?: Record<string, CustomModelOverride> } | null;
		const next = draftsFor(models, body?.overrides ?? pinsPayload(current));
		setDrafts(next);
		setBaseline(JSON.stringify(pinsPayload(next)));
		await onPinsSaved();
		setPinsBusy(false);
	}

	async function save() {
		if (busy || pinsBusy || !canConnect) return;
		setBusy(true);
		setError(null);
		const res = await fetch("/api/custom-provider", {
			method: "POST",
			headers: { "content-type": "application/json", "if-match": revision },
			body: JSON.stringify({ baseUrl, authMode, reuseKey, manualModels, ...(authMode === "apiKey" && keyTouched && key.trim() && keySource !== "env" ? { key } : {}) }),
		}).catch(() => null);
		if (!res || !res.ok) {
			const b = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setError(res ? (b?.error ?? `Connect failed (${res.status})`) : "Connect failed. Check your connection.");
			setBusy(false);
			return;
		}
		await onSaved();
		setBusy(false);
	}

	return (
		<div data-testid="custom-endpoint-editor" className="flex flex-col gap-2 rounded-sm px-1 py-1.5">
			<div className="flex items-center gap-2">
				<span className="shrink-0 font-ui text-xs text-foreground">Custom endpoint</span>
				<input
					type="text"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="Base URL, e.g. http://localhost:11434/v1"
					aria-label="Custom endpoint base URL"
					data-testid="custom-baseurl-input"
					disabled={busy}
					autoFocus
					className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>
			</div>
			<input
				type="text"
				value={manualModels}
				onChange={(e) => setManualModels(e.target.value)}
				placeholder="Model IDs, comma-separated — optional, needed when the endpoint has no /models list"
				aria-label="Custom endpoint model IDs"
				data-testid="custom-models-input"
				disabled={busy}
				className="h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
			/>
			<label className="flex items-center gap-2 text-xs">Authentication
				<select aria-label="Custom endpoint authentication" data-testid="custom-auth-mode" value={authMode} disabled={busy || pinsBusy} onChange={(e) => { setAuthMode(e.target.value as "keyless" | "apiKey"); setReuseKey(false); }}>
					<option value="keyless">Keyless</option><option value="apiKey">API key</option>
				</select>
			</label>
			{authMode === "apiKey" && keySource === "env" && <p className="text-[11px] text-muted-foreground" data-testid="custom-env-owned">Environment supplies the effective key. Change the environment to replace it.</p>}
			{authMode === "apiKey" && keyPresent && (changedTarget || keyReuseRequired) && <label className="text-[11px]"><input type="checkbox" data-testid="custom-reuse-key" checked={reuseKey} onChange={(e) => setReuseKey(e.target.checked)} /> Allow reuse of the effective existing key for this URL</label>}
			<div className="flex items-center gap-2">
				{authMode === "apiKey" && <input
					type="password"
					value={key}
					onChange={(e) => {
						setKey(e.target.value);
						setKeyTouched(true);
						if (!e.target.value.trim()) setAuthMode("keyless");
					}}
					placeholder={keyPresent ? "Leave blank to keep effective key" : "API key"}
					aria-label="Custom endpoint API key"
					data-testid="custom-key-input"
					disabled={busy || pinsBusy || keySource === "env"}
					className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>}
				<button
					type="button"
					onClick={() => void save()}
					disabled={busy || pinsBusy || !canConnect}
					data-testid="custom-save"
					className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
				>
					{busy ? "Connecting…" : "Connect"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={busy}
					data-testid="custom-cancel"
					className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					Cancel
				</button>
				{/* Disconnect rides beside Connect, exactly the stored-key rows' Delete:
				    quiet text, one click, no confirm — and only once there IS an
				    endpoint (a fresh add has nothing to delete). */}
				{onDelete && baseUrl0.trim() && (
					<button
						type="button"
						onClick={async () => { setBusy(true); const err = await onDelete(revision); if (err) setError(err); setBusy(false); }}
						disabled={busy || pinsBusy}
						data-testid="custom-delete"
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
					>
						Disconnect
					</button>
				)}
			</div>
			{!setup && models.length > 0 && (
				<div className="flex flex-col gap-1" data-testid="custom-pins">
					<div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
						{models.map((m) => {
							const d = draftOf(m);
							return (
								<div key={m.id} className="flex items-center gap-2" data-testid={pinTestid("custom-pin-row", m.id)}>
									<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={m.id}>
										{m.id}
										<span className="block text-[10px] text-muted-foreground">Context: {d.context.trim() ? "user pin" : m.context ? `reported ${m.context}` : `fallback ${CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW}`} · Output: {d.maxTokens.trim() ? "user pin" : m.maxTokens ? `reported ${m.maxTokens}` : `fallback ${CUSTOM_MODEL_DEFAULT_MAX_TOKENS}`}</span>
									</span>
									<input
										type="text"
										inputMode="numeric"
										value={d.context}
										onChange={(e) => setDraft(m, { context: e.target.value })}
										placeholder={String(m.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW)}
										aria-label={`${m.id} context window in tokens`}
										data-testid={pinTestid("custom-pin-context", m.id)}
										disabled={pinsBusy}
										className="h-7 w-20 shrink-0 rounded-sm border border-border bg-background px-1.5 text-right font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
									/>
									<input
										type="text"
										inputMode="numeric"
										value={d.maxTokens}
										onChange={(e) => setDraft(m, { maxTokens: e.target.value })}
										placeholder={String(m.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS)}
										aria-label={`${m.id} max output tokens`}
										data-testid={pinTestid("custom-pin-maxtokens", m.id)}
										disabled={pinsBusy}
										className="h-7 w-20 shrink-0 rounded-sm border border-border bg-background px-1.5 text-right font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
									/>
									<select
										value={d.reasoning}
										onChange={(e) => setDraft(m, { reasoning: e.target.value as PinDraft["reasoning"] })}
										aria-label={`${m.id} reasoning effort support`}
										data-testid={pinTestid("custom-pin-reasoning", m.id)}
										disabled={pinsBusy}
										className="h-7 shrink-0 rounded-sm border border-border bg-background px-1 font-ui text-[11px] text-foreground outline-none focus:border-muted-foreground/50"
									>
										<option value="">Reasoning effort: Use reported</option>
										<option value="on">Reasoning effort: Supported</option>
										<option value="off">Reasoning effort: Not supported</option>
									</select>
								</div>
							);
						})}
					</div>
					<div className="flex items-center gap-2">
						{pinsError && (
							<p role="alert" data-testid="custom-pins-error" className="text-[11px] text-red-500">
								{pinsError}
							</p>
						)}
						<button
							type="button"
							onClick={() => void savePins()}
							disabled={pinsBusy || !dirty}
							data-testid="custom-pins-save"
							className="ml-auto shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
						>
							{pinsBusy ? "Saving…" : "Save limits"}
						</button>
					</div>
				</div>
			)}
			<div className="flex flex-col gap-1 text-[11px] text-muted-foreground" data-testid="custom-help">
				{!setup && models.length > 0 && <p data-testid="custom-budget-help">Budget pins do not resize backend context. Blank uses reported limits, then fallback (8192 context / 4096 output). Custom pricing is unknown.</p>}
				<p data-testid="custom-reasoning-help">Reasoning support is a capability declaration. The effort picker’s Off may not disable a custom backend’s default thinking.</p>
			</div>
			{(error || pinsError) && <button type="button" data-testid="custom-reload" onClick={() => void onReload()} className="text-left text-xs underline">Reload configuration</button>}
			{error && (
				<p role="alert" data-testid="custom-error" className="text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}
