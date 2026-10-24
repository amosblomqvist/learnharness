"use client";
/**
 * LOCAL MODEL SERVERS — the UI (local-models wave, 2026-10-24): one form,
 * two homes. The first-run setup dialog's "Local model" tab connects a
 * first server; Settings → Keys lists every server as a row (click to
 * edit, the same form) with a "+ Connect local model" row last — the
 * keys-table language.
 *
 * The form asks only what the server cannot say about itself: where it
 * is (one address field — host:port or a full URL — with one-click
 * presets for the common engines' default ports), which protocol it
 * speaks, and an optional key. Everything else — which models exist,
 * their context lengths, image input, thinking — is READ FROM THE SERVER
 * on Connect (src/agent/local-models.ts). Any OpenAI- or Anthropic-
 * compatible endpoint works, recognized engine or not; the Model IDs
 * field and the two overrides exist for servers that report nothing (no
 * model list, no limits) or report it wrong.
 *
 * API: POST /api/local-servers (probe first, store only on success —
 * a 502 carries the reason inline), DELETE /api/local-servers/:id, GET
 * ?refresh=1 for the rows. Every landing dispatches the "keys" signal: a
 * local server is a model source exactly like a key (the setup dialog's
 * stage, the "Connect model" pill, and the pickers all re-read on it).
 */

import { useEffect, useState } from "react";
import {
	LOCAL_CONTEXT_WINDOW_FLOOR,
	LOCAL_ENGINE_LABELS,
	LOCAL_SERVER_APIS,
	LOCAL_SERVER_API_LABELS,
	LOCAL_SERVER_PRESETS,
	parseModelIds,
	type LocalServerApi,
	type LocalServerInput,
	type LocalServerStatus,
	type LocalServerView,
} from "@/src/core";
import { formatTokens } from "@/components/usage-format";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup, ThinSelect } from "./controls.tsx";

/** The form's raw field values. */
export interface LocalServerFields {
	address: string;
	api: LocalServerApi;
	/** A newly typed key ("" = leave the stored one alone). */
	apiKey: string;
	/** Edit mode: drop the stored key. */
	forgetKey: boolean;
	/** "" = what the server reports. */
	contextWindow: string;
	vision: "auto" | "yes" | "no";
	/** Named model ids, comma/space separated ("" = the server's list). */
	models: string;
}

/** Fields → the POST body (pure — exported for tests). `editingId` turns
 *  it into an update, where a cleared override must be sent as null (a
 *  new server simply omits it). A context window that is not a whole
 *  number at or above the floor is refused here, before any request. */
export function localServerBody(
	fields: LocalServerFields,
	editingId?: string,
): { ok: true; body: LocalServerInput } | { ok: false; error: string } {
	const body: LocalServerInput = { address: fields.address.trim(), api: fields.api };
	if (editingId !== undefined) body.id = editingId;
	if (fields.apiKey.trim()) body.apiKey = fields.apiKey.trim();
	else if (fields.forgetKey) body.apiKey = null;
	const cw = fields.contextWindow.trim();
	if (cw) {
		if (!/^\d+$/.test(cw) || Number(cw) < LOCAL_CONTEXT_WINDOW_FLOOR) {
			return { ok: false, error: `Context window must be a whole number of at least ${LOCAL_CONTEXT_WINDOW_FLOOR} tokens` };
		}
		body.contextWindow = Number(cw);
	} else if (editingId !== undefined) body.contextWindow = null;
	if (fields.vision !== "auto") body.vision = fields.vision === "yes";
	else if (editingId !== undefined) body.vision = null;
	const models = parseModelIds(fields.models);
	if (models.length) body.models = models;
	else if (editingId !== undefined) body.models = null;
	return { ok: true, body };
}

/** The one-line status for a server row (pure — exported for tests). */
export function localServerStatusLine(status: LocalServerStatus | null): string {
	if (!status) return "not checked";
	if (!status.ok) return status.models.length ? `unreachable · ${status.models.length} known` : "unreachable";
	const n = status.models.length;
	return `${n} model${n === 1 ? "" : "s"}`;
}

/** "mistral-nemo:12b · 16k · images · thinking" — what each model will run with. */
function modelLine(model: LocalServerStatus["models"][number]): string {
	return [model.id, formatTokens(model.contextWindow), model.vision ? "images" : null, model.reasoning ? "thinking" : null]
		.filter(Boolean)
		.join(" · ");
}

const fieldClass =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const labelClass = "w-24 shrink-0 font-ui text-xs text-muted-foreground";
const actionClass =
	"shrink-0 text-xs underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

/** What the server reported on the last connect — shown under the form. */
function DiscoveredModels({ status, testid }: { status: LocalServerStatus; testid: string }) {
	return (
		<div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground" data-testid={`${testid}-models`}>
			{status.models.map((m) => (
				<span key={m.id} className="truncate font-mono">
					{modelLine(m)}
				</span>
			))}
			{status.hidden.map((h) => (
				<span key={h.id} className="truncate font-mono opacity-60">
					{h.id} · hidden: {h.reason}
				</span>
			))}
		</div>
	);
}

/** The connect/edit form. `server` present = edit mode (id fixed, Remove
 *  offered). Resolves through `onSaved` with the stored server's view. */
export function LocalServerForm({
	server,
	onSaved,
	onCancel,
	onRemove,
	testid = "local-server-form",
}: {
	server?: LocalServerView;
	onSaved?: (view: LocalServerView) => void;
	onCancel?: () => void;
	onRemove?: () => Promise<void>;
	testid?: string;
}) {
	const [fields, setFields] = useState<LocalServerFields>({
		address: server?.address ?? "",
		api: server?.api ?? "openai-completions",
		apiKey: "",
		forgetKey: false,
		contextWindow: server?.contextWindow !== undefined ? String(server.contextWindow) : "",
		vision: server?.vision === undefined ? "auto" : server.vision ? "yes" : "no",
		models: server?.models?.join(", ") ?? "",
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState<LocalServerView | null>(null);
	const set = (patch: Partial<LocalServerFields>) => setFields((f) => ({ ...f, ...patch }));

	async function connect() {
		if (busy || !fields.address.trim()) return;
		const built = localServerBody(fields, server?.id);
		if (!built.ok) {
			setError(built.error);
			return;
		}
		setBusy(true);
		setError(null);
		const res = await fetch("/api/local-servers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(built.body),
		}).catch(() => null);
		const answer = (await res?.json().catch(() => null)) as { server?: LocalServerView; error?: string } | null;
		setBusy(false);
		if (!res || !res.ok || !answer?.server) {
			setError(answer?.error ?? (res ? `Connect failed (${res.status})` : "Connect failed. Check your connection and try again."));
			return;
		}
		setConnected(answer.server);
		set({ apiKey: "", forgetKey: false });
		notifySettingsSaved("keys");
		onSaved?.(answer.server);
	}

	return (
		<div className="flex flex-col gap-2 py-1.5" data-testid={testid}>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className={labelClass}>Preset</span>
				{LOCAL_SERVER_PRESETS.map((p) => (
					<button
						key={p.engine}
						type="button"
						data-testid={`${testid}-preset-${p.engine}`}
						onClick={() => set({ address: p.address, api: p.api })}
						className={`rounded-sm border px-1.5 py-0.5 font-ui text-[11px] transition-colors hover:border-muted-foreground/50 hover:text-foreground ${
							fields.address === p.address && fields.api === p.api
								? "border-muted-foreground/50 text-foreground"
								: "border-border text-muted-foreground"
						}`}
					>
						{LOCAL_ENGINE_LABELS[p.engine]}
					</button>
				))}
			</div>
			<label className="flex items-center gap-2">
				<span className={labelClass}>Address</span>
				<input
					type="text"
					value={fields.address}
					onChange={(e) => set({ address: e.target.value })}
					onKeyDown={(e) => {
						if (e.key === "Enter") void connect();
					}}
					placeholder="localhost:11434 or http://host:port/v1"
					aria-label="Server address"
					data-testid={`${testid}-address`}
					disabled={busy}
					autoFocus
					className={`${fieldClass} flex-1`}
				/>
			</label>
			<label className="flex items-center gap-2">
				<span className={labelClass}>API type</span>
				<ThinSelect
					value={fields.api}
					onChange={(next) => set({ api: next as LocalServerApi })}
					ariaLabel="API type"
					testid={`${testid}-api`}
					disabled={busy}
				>
					{LOCAL_SERVER_APIS.map((api) => (
						<option key={api} value={api}>
							{LOCAL_SERVER_API_LABELS[api]}
						</option>
					))}
				</ThinSelect>
			</label>
			<label className="flex items-center gap-2">
				<span className={labelClass}>API key</span>
				<input
					type="text"
					value={fields.apiKey}
					onChange={(e) => set({ apiKey: e.target.value, forgetKey: false })}
					onKeyDown={(e) => {
						if (e.key === "Enter") void connect();
					}}
					placeholder={server?.apiKeySet && !fields.forgetKey ? "saved — paste to replace" : "optional"}
					aria-label="Server API key"
					data-testid={`${testid}-key`}
					disabled={busy}
					className={`${fieldClass} flex-1`}
				/>
				{server?.apiKeySet && !fields.apiKey && (
					<button
						type="button"
						onClick={() => set({ forgetKey: !fields.forgetKey })}
						data-testid={`${testid}-forget-key`}
						className={`${actionClass} text-muted-foreground/70 hover:text-foreground`}
					>
						{fields.forgetKey ? "keep key" : "forget key"}
					</button>
				)}
			</label>
			<label className="flex items-center gap-2">
				<span className={labelClass}>Model IDs</span>
				<input
					type="text"
					value={fields.models}
					onChange={(e) => set({ models: e.target.value })}
					onKeyDown={(e) => {
						if (e.key === "Enter") void connect();
					}}
					placeholder="from server — or name them: model-a, model-b"
					aria-label="Model IDs"
					data-testid={`${testid}-models-field`}
					disabled={busy}
					className={`${fieldClass} flex-1`}
				/>
			</label>
			<div className="flex flex-wrap items-center gap-2">
				<span className={labelClass}>Context</span>
				<input
					type="text"
					inputMode="numeric"
					value={fields.contextWindow}
					onChange={(e) => set({ contextWindow: e.target.value })}
					placeholder="from server"
					aria-label="Context window override (tokens)"
					data-testid={`${testid}-context`}
					disabled={busy}
					className={`${fieldClass} w-28`}
				/>
				<span className="font-ui text-xs text-muted-foreground">Images</span>
				<ThinSelect
					value={fields.vision}
					onChange={(next) => set({ vision: next as LocalServerFields["vision"] })}
					ariaLabel="Image input override"
					testid={`${testid}-vision`}
					disabled={busy}
				>
					<option value="auto">from server</option>
					<option value="yes">accepted</option>
					<option value="no">not accepted</option>
				</ThinSelect>
			</div>
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={() => void connect()}
					disabled={busy || !fields.address.trim()}
					data-testid={`${testid}-connect`}
					className="shrink-0 rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy ? "Connecting…" : server ? "Save & reconnect" : "Connect"}
				</button>
				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className={`${actionClass} text-muted-foreground/70 hover:text-foreground`}
					>
						Cancel
					</button>
				)}
				{onRemove && (
					<button
						type="button"
						onClick={() => void onRemove()}
						disabled={busy}
						data-testid={`${testid}-remove`}
						className={`${actionClass} text-muted-foreground/70 hover:text-red-500`}
					>
						Remove
					</button>
				)}
			</div>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="text-xs text-red-500">
					{error}
				</p>
			)}
			{!error && (connected ?? server)?.status && (
				<DiscoveredModels status={(connected ?? server)!.status!} testid={testid} />
			)}
			<p className="text-[11px] text-muted-foreground/70">
				Works with any OpenAI- or Anthropic-compatible server. Models, context lengths and capabilities are read from it; name models or override limits only if it does not report them.
			</p>
		</div>
	);
}

/** The Settings → Keys group: one row per server, click to edit; the
 *  "+ Connect local model" row last. */
export function LocalServersGroup() {
	const [servers, setServers] = useState<LocalServerView[] | null>(null);
	/** The unfolded editor: a server id, "new", or null. */
	const [open, setOpen] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/local-servers?refresh=1")
			.then((r) => r.json())
			.then((body: { servers?: LocalServerView[] }) => setServers(body.servers ?? []))
			.catch(() => setServers([]));

	useEffect(() => {
		void reload();
	}, []);

	// Escape folds an open editor WITHOUT closing the dialog (the keys
	// section's capture-phase pattern — it must outrun the dialog's own
	// document listener).
	useEffect(() => {
		if (open === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(null);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open]);

	async function remove(id: string) {
		await fetch(`/api/local-servers/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
		setOpen(null);
		await reload();
		notifySettingsSaved("keys");
	}

	return (
		<SettingsGroup label="Local models" testid="group-local-servers">
			{servers === null && <p className="px-1 py-1.5 text-xs text-muted-foreground/70">Checking local servers…</p>}
			{servers?.map((server) =>
				open === server.id ? (
					<div key={server.id} className="px-1" data-testid={`local-server-${server.id}`}>
						<span className="font-ui text-xs text-foreground">{server.name}</span>
						<LocalServerForm
							server={server}
							testid={`local-server-${server.id}-form`}
							onSaved={() => {
								setOpen(null); // fold on success — the keys-table rest state
								void reload();
							}}
							onCancel={() => setOpen(null)}
							onRemove={() => remove(server.id)}
						/>
					</div>
				) : (
					<button
						key={server.id}
						type="button"
						data-testid={`local-server-${server.id}`}
						onClick={() => setOpen(server.id)}
						className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
					>
						<span className="font-ui text-xs text-foreground">{server.name}</span>
						<span className="font-mono text-[11px] text-muted-foreground" data-testid={`local-server-${server.id}-status`}>
							{server.address} · {localServerStatusLine(server.status)}
						</span>
					</button>
				),
			)}
			{open === "new" ? (
				<div className="px-1">
					<LocalServerForm
						testid="local-server-new"
						onSaved={() => {
							setOpen(null);
							void reload();
						}}
						onCancel={() => setOpen(null)}
					/>
				</div>
			) : (
				servers !== null && (
					<button
						type="button"
						data-testid="add-local-server"
						onClick={() => setOpen("new")}
						className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
					>
						<span>+ Connect local model</span>
					</button>
				)
			)}
		</SettingsGroup>
	);
}
