/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import path from "node:path";
import { PATHS } from "../../config.ts";
import { createSubscriptionStore, type SubscriptionStore } from "../store/subscription-credentials.ts";
import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};

export type Stores = typeof stores;

/** Lazy instance-local adapter wiring; no credential files are read on import. */
const subscriptionStores = globalThis as typeof globalThis & { __lhSubscriptionStores?: Map<string, SubscriptionStore> };
export function subscriptionStore(): SubscriptionStore {
	const directory = path.resolve(PATHS.data, "subscription");
	const registry = subscriptionStores.__lhSubscriptionStores ??= new Map();
	let store = registry.get(directory);
	if (!store) {
		store = createSubscriptionStore(directory);
		registry.set(directory, store);
	}
	return store;
}

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
