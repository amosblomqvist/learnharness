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
 *  - Env-owned rows (a real environment variable owns the name — dev .env.local or launch env) show no paste field: a paste box on a key the UI cannot make live would mislead. They still unfold to their base-URL lines (settings.json, so those CAN go live).
 *  - OpenRouter is NOT special: one provider among 33, a row only when
 *    stored, otherwise it lives in the Add dropdown like everyone else.
 *  - Providers groups API keys, subscriptions, dictation and search.
 *    Unknown variables stay masked/read-only at the end of Model API keys.
 *
 * API: GET /api/keys (masked statuses + the providers array), PUT
 * /api/keys/:id (shape-gated 400s land inline), DELETE. Saves take
 * effect immediately. Plaintext never returns from the store.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AUTH_KEYS, normalizeBaseUrl, type AuthKeyStatus, type ProvidersSettings } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { SubscriptionConnections } from "./subscription-connections.tsx";
import { ProviderMenuList } from "./model-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";

/** One pi-ai provider with plain API-key auth (the Platform seam —
 *  derived from pi-ai's own env-key table; no drift possible). */
export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
	defaultBaseUrl?: string;
}

interface KeysResponse {
	keys: AuthKeyStatus[];
	providers?: ProviderKeyInfo[];
}

/** The curated tools group, pinned by id (the catalog owns the copy;
 *  these ids are the contract). Derived from the catalog (search wave,
 *  2026-09-20: the Google CSE pair retired, Tavily + Brave joined) — the
 *  section can never drift from core/auth-keys.ts again. */
const TOOL_IDS = AUTH_KEYS.map((k) => k.id) as readonly string[];

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

/** The minimal status line, e.g. "…ab12 · 64 chars" (" · env" marks an
 *  environment-owned value — the row itself is read-only then). Pure. */
export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}

export const BASE_URL_INVALID = "Base URL must be an http(s) URL with no query or hash";

/** Compose: one provider's base URL set (null drops it), the rest carried verbatim. Pure — exported for tests. */
export function composeBaseUrl(
	current: ProvidersSettings | undefined,
	providerId: string,
	baseUrl: string | null,
): ProvidersSettings {
	const next = { ...current };
	if (baseUrl === null) delete next[providerId];
	else next[providerId] = { baseUrl };
	return next;
}

/** One table row: label left, tiny docs link + status right. Writable rows click-unfold an editor beneath (owner interaction); env-owned rows unfold only to their base-URL lines, else stay dimmed and read-only. */
function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	baseUrlLines = [],
	customUrl = false,
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
	baseUrlLines?: ReactNode[];
	customUrl?: boolean;
	testid: string;
}) {
	const envOwned = status.source === "env";
	const editable = !envOwned || baseUrlLines.length > 0;
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
	if (expanded && editable) {
		return (
			<div data-testid={testid}>
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
					<span className="shrink-0 font-ui text-xs text-foreground">{label}</span>
					{envOwned ? (
						<span data-testid={`${testid}-env-note`} className="min-w-0 flex-1 text-xs text-muted-foreground/70">
							key comes from the environment
						</span>
					) : (
						<>
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
						</>
					)}
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
				{baseUrlLines}
			</div>
		);
	}

	return (
		<div data-testid={testid} className={editable ? undefined : "opacity-40"}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={() => editable && onToggle()}
				className={`flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left ${
					editable ? "cursor-pointer transition-colors hover:bg-accent/50" : "cursor-default"
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
						{customUrl && " · custom URL"}
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

/** One provider's base-URL line in an unfolded row. The parent keys it on the saved value, so a landed write re-seeds the field. */
function BaseUrlLine({
	label,
	placeholder,
	saved,
	onSave,
	testid,
}: {
	label: string;
	placeholder: string;
	saved: string | undefined;
	onSave: (baseUrl: string | null) => Promise<void>;
	testid: string;
}) {
	const [value, setValue] = useState(saved ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const dirty = value.trim() !== "" && value.trim() !== saved;

	async function save(next: string | null) {
		if (busy) return;
		const baseUrl = next === null ? null : normalizeBaseUrl(next);
		if (next !== null && baseUrl === null) {
			setError(BASE_URL_INVALID);
			return;
		}
		setBusy(true);
		setError(null);
		await onSave(baseUrl);
		setBusy(false);
	}

	return (
		<div data-testid={testid}>
			<div className="flex items-center gap-2 rounded-sm px-1 py-1.5">
				<span className="shrink-0 font-ui text-xs text-muted-foreground">{label}</span>
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && dirty) void save(value);
					}}
					placeholder={placeholder}
					aria-label={`${label} base URL`}
					data-testid={`${testid}-input`}
					disabled={busy}
					className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>
				<button
					type="button"
					onClick={() => void save(value)}
					disabled={busy || !dirty}
					data-testid={`${testid}-save`}
					className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
				>
					Save
				</button>
				{saved !== undefined && (
					<button
						type="button"
						onClick={() => void save(null)}
						disabled={busy}
						data-testid={`${testid}-reset`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Reset
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
				<span>+ Add provider key</span>
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
	baseUrls,
	onBaseUrlsChange,
}: {
	initialRow?: string;
	baseUrls: ProvidersSettings | undefined;
	onBaseUrlsChange: (next: ProvidersSettings) => Promise<void>;
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

	// Escape folds any open editor (unfolded row or the Add-provider paste)
	// WITHOUT closing the dialog. Claimed at document CAPTURE phase — the
	// only stopPropagation that outruns both the input's React handler and
	// the dialog's window-level listener.
	useEffect(() => {
		if (openRow === null && adding === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
			setAdding(null);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow, adding]);

	const reload = () =>
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: KeysResponse) => {
				setStatuses(body.keys ?? []);
				if (body.providers) setProviders(body.providers);
			})
			.catch(() => setStatuses([]))
			.finally(() => setLoading(false));

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

	if (loading || statuses === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading keys…</p>;
	}

	const { providerRows, toolRows, unknownRows, addable } = classifyKeys(statuses, providers);

	async function saveNewProvider(p: ProviderKeyInfo, value: string, baseUrlInput: string) {
		const baseUrl = baseUrlInput.trim() ? normalizeBaseUrl(baseUrlInput) : null;
		if (baseUrlInput.trim() && !baseUrl) {
			setAddError(BASE_URL_INVALID);
			return;
		}
		if (baseUrl) await onBaseUrlsChange(composeBaseUrl(baseUrls, p.id, baseUrl));
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
				{providerRows.map((status) => {
					const urlProviders = (providers ?? []).filter((p) => p.envVar === status.id && p.defaultBaseUrl);
					return (
						<KeyTableRow
							key={status.id}
							label={providers?.find((p) => p.envVar === status.id)?.label ?? status.info?.label ?? status.id}
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
							customUrl={urlProviders.some((p) => baseUrls?.[p.id]?.baseUrl !== undefined)}
							baseUrlLines={urlProviders.map((p) => (
								<BaseUrlLine
									key={`${p.id}:${baseUrls?.[p.id]?.baseUrl ?? ""}`}
									label={urlProviders.length > 1 ? p.label : "Base URL"}
									placeholder={p.defaultBaseUrl!}
									saved={baseUrls?.[p.id]?.baseUrl}
									onSave={(baseUrl) => onBaseUrlsChange(composeBaseUrl(baseUrls, p.id, baseUrl))}
									testid={`base-url-${p.id}`}
								/>
							))}
							testid={`key-${status.id.toLowerCase()}`}
						/>
					);
				})}
				{providers !== undefined && (
					<AddProviderRow
						addable={addable}
						onPick={(p) => {
							setAdding(p);
							setAddError(null);
						}}
					/>
				)}
				{adding && (
					<AddProviderEditor provider={adding} onSave={(v, baseUrl) => void saveNewProvider(adding, v, baseUrl)} onCancel={() => setAdding(null)} error={addError} />
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
	onSave: (value: string, baseUrl: string) => void;
	onCancel: () => void;
	error: string | null;
}) {
	const [value, setValue] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	return (
		<div data-testid={`key-${provider.id}-editor`}>
			<div className="flex items-center gap-2 rounded-sm px-1 py-1.5">
				<span className="shrink-0 font-ui text-xs text-foreground">{provider.label}</span>
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && value.trim()) onSave(value, baseUrl);
					}}
					placeholder="Paste key…"
					aria-label={`${provider.label} key`}
					data-testid={`key-${provider.id}-input`}
					autoFocus
					className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>
				<button
					type="button"
					onClick={() => value.trim() && onSave(value, baseUrl)}
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
			</div>
			{provider.defaultBaseUrl && (
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5">
					<span className="shrink-0 font-ui text-xs text-muted-foreground">Base URL (optional)</span>
					<input
						type="text"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && value.trim()) onSave(value, baseUrl);
						}}
						placeholder={provider.defaultBaseUrl}
						aria-label={`${provider.label} base URL`}
						data-testid={`key-${provider.id}-base-url`}
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
				</div>
			)}
			{error && (
				<p role="alert" className="px-1 text-xs text-red-500" data-testid={`key-${provider.id}-error`}>
					{error}
				</p>
			)}
		</div>
	);
}
