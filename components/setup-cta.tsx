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
 * Truth: GET /api/models availability (provider key, connected
 * subscription, or keyless custom provider; tool keys do not count). Live updates ride
 * the lh:settings-saved "keys" signal (keys-section dispatches after
 * save AND delete; the setup dialog's first-key screen dispatches on
 * its own save), the same re-read pattern chat.tsx uses for "models".
 */

import { useCallback, useEffect, useState } from "react";
import type { AuthKeyStatus } from "@/src/core";
import { classifyKeys, type ProviderKeyInfo } from "@/components/settings/keys-section";
import { useModelCatalog } from "@/components/model-picker";
import type { ModelCatalogResponse } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

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

/** Pure: is any provider available (key present, subscription connected,
 *  or keyless custom)? The catalog reports all of those as keyPresent. */
export function hasAvailableProvider(providers: readonly { keyPresent: boolean }[]): boolean {
	return providers.some((p) => p.keyPresent);
}

/** The zero-keys truth for the calling page: TRUE only after a
 *  successful read says no provider key exists (pending and failed
 *  reads render nothing — the pill must never flash on a gap, and a
 *  failed read claiming "zero keys" would be a lie the CTA flow then
 *  leans on). Re-reads on the keys signal. */
export function useZeroKeys(): boolean {
	const [zeroKeys, setZeroKeys] = useState(false);
	const read = useCallback(() => {
		// /api/models availability covers keys, connected subscriptions and
		// custom providers (keyless included). A failed read changes nothing.
		fetch("/api/models")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("read"))))
			.then((body: { providers?: { keyPresent: boolean }[] }) => {
				if (!Array.isArray(body.providers)) return;
				setZeroKeys(!hasAvailableProvider(body.providers));
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "keys" || section === "models") read();
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
/** Pure: the strong slot is pinned to a provider whose key is GONE (owner
 *  interlude, 2026-09-25 — the original deleted-key scenario). The catalog
 *  already knows both halves: slots.strong is the resolved pin, providers[]
 *  lists only PRESENT-key providers (keyless ones are absent, the same
 *  discipline as the search engines). False when the strong slot is unset
 *  (the models guard owns that case — this check only runs when slots ARE
 *  configured) or the catalog hasn't loaded (the server gate remains the
 *  belt). Exported for pins. */
export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((p) => p.id === strong.model.provider && p.keyPresent);
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
