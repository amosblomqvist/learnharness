"use client";
/**
 * The zero-keys surfaces (zero-keys wave, 2026-09-25, owner-locked over
 * Platform's 66dbea9 key-presence gate): when NO model-provider key
 * exists, chat / home / /chat/new hoist a composer pill — "Add a
 * provider key" — that takes PRECEDENCE over the models setup CTA
 * (keys come first in the chain: the model pickers list only what
 * keys unlock). Click opens the SetupDialog, whose stage derives to
 * the first-key screen on its own.
 *
 * Truth: GET /api/keys — a PROVIDER key present (env or file; tool keys
 * like Deepgram do not count — they unlock no models). Live updates ride
 * the lh:settings-saved "keys" signal (keys-section dispatches after
 * save AND delete; the setup dialog's first-key screen dispatches on
 * its own save), the same re-read pattern chat.tsx uses for "models".
 *
 * SUBSCRIPTION AUTHORIZATION (fix for the connected-Codex block,
 * 2026-10-19): a subscription and a provider key are INDEPENDENT
 * authorization sources. Each selected model is authorized by its own
 * provider's source; there is no cross-source fallback (a subscription
 * never authorizes an API-key provider, and a key never authorizes the
 * subscription provider). The zero-keys pill alone is therefore not the
 * whole truth: a page must ask BOTH surfaces before it claims the learner
 * has no way to run a model. GET /api/subscription is the live
 * authorization read; `catalog.authorization` is only static model
 * metadata and never stands in for it. The four-state split below is
 * deliberate:
 *   - connected subscription selected → not blocked (its own provider
 *     source is connected; the server's federated catalog carries it);
 *   - a known disconnected/reconnect/error/authorizing status selected →
 *     blocked with SUBSCRIPTION guidance, never the first-key screen;
 *   - pending first read → a non-actionable "Checking subscription…"
 *     state that blocks creation (no orphan draft) and makes no claim
 *     about keys either way;
 *   - an ordinary API-key pin → the existing zero-keys / strong-keyless
 *     guards, unchanged.
 * The conversation's OWN model override is the selected provider on
 * /chat/[id]; it is not the global strong pin. No branch swaps the
 * learner's pinned model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AuthKeyStatus,
	ModelCatalogResponse,
	SubscriptionStatus,
} from "@/src/core";
import { SUBSCRIPTION_PROVIDER } from "@/src/core";
import { classifyKeys, type ProviderKeyInfo } from "@/components/settings/keys-section";
import { useModelCatalog } from "@/components/model-picker";
import { useSettingsSaved } from "@/components/settings-signal";

/** Same-origin guard on /api/subscription (the settings section uses the
 *  same header). Kept local so the composer path does not import the
 *  whole settings surface. */
export const SUBSCRIPTION_STATUS_PATH = "/api/subscription";
export const SUBSCRIPTION_STATUS_HEADER = "X-LearnHarness-Subscription";

const SUBSCRIPTION_STATES = new Set<SubscriptionStatus["state"]>([
	"disconnected",
	"authorizing",
	"connected",
	"reconnect_required",
	"error",
]);

/** Pure: does a MODEL-PROVIDER key exist among the statuses? Reuses
 *  classifyKeys (the keys section's own classification — no drift):
 *  a status whose id is a provider env-var (or the pre-interlude
 *  fallback shape) with present=true counts, present or file-sourced,
 *  env-owned included (env wins but it EXISTS). Exported for pins. */
export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): boolean {
	return classifyKeys(statuses, providers).providerRows.some((s) => s.present);
}

/** The zero-keys truth for the calling page: TRUE only after a
 *  successful read says no provider key exists (pending and failed
 *  reads render nothing — the pill must never flash on a gap, and a
 *  failed read claiming "zero keys" would be a lie the CTA flow then
 *  leans on). Re-reads on the keys signal. */
export function useZeroKeys(): boolean {
	const [zeroKeys, setZeroKeys] = useState(false);
	const read = useCallback(() => {
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys?: AuthKeyStatus[]; providers?: ProviderKeyInfo[] }) => {
				setZeroKeys(!hasProviderKey(body.keys ?? [], body.providers));
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "keys") read();
	});
	return zeroKeys;
}

/** The pill itself — the models CTA's chrome and placement, the keys
 *  chain's copy. testid "setup-cta-keys" (the models CTA keeps
 *  "setup-cta"; probes can tell them apart). */
export function ZeroKeysPill({ onOpen, inline = false }: { onOpen: () => void; inline?: boolean }) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-keys"
			onClick={onOpen}
			className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
		>
			Add a provider key
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}
/** Pure: the SELECTED provider has no present key. The catalog already
 *  knows both halves: the resolved provider id and providers[] (only
 *  PRESENT-key providers; keyless ones are absent, the same discipline as
 *  the search engines). False when no provider is selected (the models
 *  guard owns that case) or the catalog hasn't loaded (the server gate
 *  remains the belt). Exported for pins. */
export function providerKeyless(
	catalog: ModelCatalogResponse | undefined,
	provider: string | null | undefined,
): boolean {
	if (!catalog || !provider) return false;
	return !catalog.providers.some((p) => p.id === provider && p.keyPresent);
}

/** The strong-slot special case, kept for the draft/home guards. */
export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	return providerKeyless(catalog, catalog?.slots.strong?.model.provider);
}

/** The provider the CONVERSATION turn will resolve (server parity:
 *  resolveConversationSpec(chat.settings, effective.models.strong)). A
 *  per-chat model override wins over the strong slot; no override rides
 *  the strong pin. The Chat gate must use this, never the global strong
 *  pin directly, or it can guide a chat whose own provider is authorized
 *  to a subscription it never uses (and vice versa). */
export function conversationModelProvider(
	conversationSettings: { model?: { provider: string; id: string } } | null | undefined,
	catalog: ModelCatalogResponse | undefined,
): string | null {
	return conversationSettings?.model?.provider ?? catalog?.slots.strong?.model.provider ?? null;
}

/** The strong-slot keyless truth for the PRE-SEND guard (home / /chat/new):
 *  the catalog seam with re-reads on BOTH signals that can flip it — "keys"
 *  (a provider key saved or deleted) and "models" (the strong slot
 *  re-pinned). Live-updates with the page, never mid-send. */
export function useStrongKeyless(): boolean {
	const { catalog, refresh } = useModelCatalog();
	useSettingsSaved((section) => {
		if (section === "keys" || section === "models") refresh();
	});
	return strongKeyless(catalog);
}

// ── Subscription authorization read (the live half of the gate) ─────────

/** Only the sanitized state matters to the gate; the settings section
 *  renders the rest. An unknown/malformed body is NOT "disconnected" —
 *  it is an unknown read and must not be reported as zero keys. */
function readSubscriptionState(value: unknown): SubscriptionStatus | null {
	if (typeof value !== "object" || value === null) return null;
	const state = (value as { state?: unknown }).state;
	if (typeof state !== "string" || !SUBSCRIPTION_STATES.has(state as SubscriptionStatus["state"])) {
		return null;
	}
	return { state: state as SubscriptionStatus["state"] };
}

export interface SubscriptionRead {
	/** The last known sanitized status; null before the first successful
	 *  read (and after a first-read failure). */
	status: SubscriptionStatus | null;
	/** A read is in flight. A previous known status is kept meanwhile. */
	pending: boolean;
	/** The last read failed or returned a malformed body. A known status
	 *  is kept rather than degraded to "disconnected". */
	failed: boolean;
	refresh: () => void;
}

/**
 * GET /api/subscription, the one live authorization source shared by the
 * composer gates. Re-reads on the "subscription" settings signal (the
 * settings section dispatches after a successful connect/cancel/
 * disconnect transition), on window focus, and on visibility return — an
 * external client can change the saved status without this tab writing
 * anything. Every read is epoch-guarded so a slow older response cannot
 * overwrite a newer one.
 */
export function useSubscriptionStatus(): SubscriptionRead {
	const [read, setRead] = useState<{
		status: SubscriptionStatus | null;
		pending: boolean;
		failed: boolean;
	}>({ status: null, pending: true, failed: false });
	const mountedRef = useRef(true);
	const epochRef = useRef(0);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const refresh = useCallback(() => {
		const epoch = ++epochRef.current;
		setRead((current) => ({ ...current, pending: true }));

		fetch(SUBSCRIPTION_STATUS_PATH, {
			headers: { [SUBSCRIPTION_STATUS_HEADER]: "1" },
			cache: "no-store",
			credentials: "same-origin",
		})
			.then(async (response) => {
				let body: unknown = null;
				try {
					body = await response.json();
				} catch {
					body = null;
				}
				if (!response.ok) {
					// Keep a known status: a failed refresh must not disable
					// an authorization that was already confirmed.
					setRead((current) => {
						if (!mountedRef.current || epoch !== epochRef.current) return current;
						return { status: current.status, pending: false, failed: true };
					});
					return;
				}
				const status = readSubscriptionState(body);
				setRead((current) => {
					if (!mountedRef.current || epoch !== epochRef.current) return current;
					return {
						status: status ?? current.status,
						pending: false,
						failed: status === null,
					};
				});
			})
			.catch(() => {
				setRead((current) => {
					if (!mountedRef.current || epoch !== epochRef.current) return current;
					return { status: current.status, pending: false, failed: true };
				});
			});
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useSettingsSaved((section) => {
		if (section === "subscription") refresh();
	});

	useEffect(() => {
		const onFocus = () => refresh();
		const onVisibility = () => {
			if (document.visibilityState !== "hidden") refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [refresh]);

	return { ...read, refresh };
}

export type ModelAccessBlock = "keys" | "subscription" | "subscription_pending" | null;

/** The pure gate truth shared by home / /chat/new / chat. Exported so the
 *  authorization states can be pinned without a render. */
export function modelAccessBlock(input: {
	subscriptionSelected: boolean;
	subscriptionState: SubscriptionStatus["state"] | null;
	subscriptionFailed: boolean;
	zeroKeys: boolean;
	selectedKeyless: boolean;
}): ModelAccessBlock {
	if (input.subscriptionSelected) {
		if (input.subscriptionState === "connected") return null;
		if (input.subscriptionState === null && !input.subscriptionFailed) {
			return "subscription_pending";
		}
		// A known non-connected state, or a failed read with no known
		// status, guides to the Subscription surface.
		return "subscription";
	}
	return input.zeroKeys || input.selectedKeyless ? "keys" : null;
}

export interface ModelAccess {
	blocked: ModelAccessBlock;
	zeroKeys: boolean;
	selectedProvider: string | null;
	selectedKeyless: boolean;
	subscriptionSelected: boolean;
	subscriptionConnected: boolean;
	subscriptionState: SubscriptionStatus["state"] | null;
	subscriptionPending: boolean;
	subscriptionFailed: boolean;
	refreshSubscription: () => void;
}

/**
 * ONE access read for every composer gate: the provider-key truth, the
 * CONVERSATION's resolved provider (chat override over strong), and the
 * live subscription status. Consumers route a blocked send to the matching
 * surface — the first-key SetupDialog for "keys", the Subscription
 * settings section for "subscription". Nothing here changes a model pin or
 * substitutes a provider.
 */
export function useModelAccess(options?: {
	conversationSettings?: { model?: { provider: string; id: string } } | null;
}): ModelAccess {
	const zeroKeys = useZeroKeys();
	const { catalog, refresh } = useModelCatalog();
	useSettingsSaved((section) => {
		if (section === "keys" || section === "models") refresh();
	});
	const subscription = useSubscriptionStatus();
	const selectedProvider = conversationModelProvider(options?.conversationSettings, catalog);
	const keyless = providerKeyless(catalog, selectedProvider);
	const subscriptionSelected = selectedProvider === SUBSCRIPTION_PROVIDER;
	const subscriptionState = subscription.status?.state ?? null;
	const subscriptionConnected = subscriptionState === "connected";
	const blocked = modelAccessBlock({
		subscriptionSelected,
		subscriptionState,
		subscriptionFailed: subscription.failed,
		zeroKeys,
		selectedKeyless: keyless,
	});

	return {
		blocked,
		zeroKeys,
		selectedProvider,
		selectedKeyless: keyless,
		subscriptionSelected,
		subscriptionConnected,
		subscriptionState,
		subscriptionPending: subscription.pending,
		subscriptionFailed: subscription.failed,
		refreshSubscription: subscription.refresh,
	};
}

/** Pure: the subscription guidance copy. Never "Add a provider key" — the
 *  problem is an authorization that is missing or stale, not a missing
 *  API key. */
export function subscriptionCtaLabel(
	state: SubscriptionStatus["state"] | null,
	failed = false,
	pending = false,
): string {
	if (pending) return "Checking subscription…";
	if (state === "connected") return "Subscription connected";
	if (state === "authorizing") return "Finish subscription sign-in";
	if (state === "reconnect_required") return "Reconnect subscription";
	if (state === "disconnected") return "Connect subscription";
	if (state === "error" || failed) return "Check subscription";
	return "Check subscription";
}

/** The subscription guidance pill. Its testid is distinct from both the
 *  key pill and the models CTA so probes and tests can tell the three
 *  authorization states apart. */
export function SubscriptionPill({
	state,
	failed = false,
	pending = false,
	onOpen,
	inline = false,
}: {
	state: SubscriptionStatus["state"] | null;
	failed?: boolean;
	pending?: boolean;
	onOpen: () => void;
	inline?: boolean;
}) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-subscription"
			onClick={onOpen}
			disabled={pending}
			aria-disabled={pending ? true : undefined}
			className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer disabled:cursor-default disabled:opacity-60"
		>
			{subscriptionCtaLabel(state, failed, pending)}
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}
