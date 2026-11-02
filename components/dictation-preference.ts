"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationLanguage, isDictationProvider, sanitizeUserSettings,
	type DictationLanguage, type DictationProvider, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	provider: FACTORY_SETTINGS.dictation.provider as DictationProvider,
	saving: false, error: null as string | null,
};

/** The dictation section as stored: PUT replaces the whole section, so every
 * write carries the field it is not changing. */
type StoredDictation = { language?: DictationLanguage; provider?: DictationProvider };

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationLanguageStore(
	request: typeof fetch, saved: () => void = () => {}, providerChanged: () => void = () => {},
) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	let stored: StoredDictation = {};
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		// A confirmed switch from one loaded provider to another; the first load
		// (language still undefined) only replaces the factory default.
		const switched = patch.provider !== undefined && snapshot.language !== undefined
			&& patch.provider !== snapshot.provider;
		snapshot = { ...snapshot, ...patch };
		if (switched) providerChanged();
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const language = record?.dictation?.language ?? FACTORY_SETTINGS.dictation.language;
				const provider = record?.dictation?.provider ?? FACTORY_SETTINGS.dictation.provider;
				stored = { ...record?.dictation };
				needsRead = false;
				publish({ language, provider, error: null });
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** Replace the section with `next`; `field` names what the caller changed. */
	function write(next: StoredDictation, field: "language" | "provider", failure: string): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation;
				if (field === "language" ? !isDictationLanguage(confirmed?.language) : !isDictationProvider(confirmed?.provider)) throw new Error();
				stored = { ...confirmed };
				needsRead = false;
				publish({
					language: confirmed?.language ?? FACTORY_SETTINGS.dictation.language,
					provider: confirmed?.provider ?? FACTORY_SETTINGS.dictation.provider,
					error: null,
				});
				saved();
				return true;
			} catch {
				publish({ error: failure });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	function save(language: DictationLanguage): Promise<boolean> {
		const next: StoredDictation = { language };
		if (stored.provider !== undefined) next.provider = stored.provider;
		return write(next, "language", "Could not save dictation language. Try again.");
	}

	function saveProvider(provider: DictationProvider): Promise<boolean> {
		const next: StoredDictation = {};
		if (stored.language !== undefined) next.language = stored.language;
		next.provider = provider;
		return write(next, "provider", "Could not save dictation provider. Try again.");
	}

	async function getLanguage(): Promise<DictationLanguage> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return snapshot.language;
		}
	}

	async function getProvider(): Promise<DictationProvider> {
		await getLanguage(); // settles reads and writes; provider rides the same record
		return snapshot.provider;
	}

	return {
		load, save, saveProvider, getLanguage, getProvider,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

const providerListeners = new Set<() => void>();

/** Run `listener` whenever the confirmed provider changes from one value to
 *  another, whichever components are mounted. Returns the unsubscribe. */
export function onDictationProviderChange(listener: () => void): () => void {
	providerListeners.add(listener);
	return () => { providerListeners.delete(listener); };
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
}, () => { for (const listener of [...providerListeners]) listener(); });
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return {
		...snapshot, load: store.load, save: store.save, saveProvider: store.saveProvider,
		getLanguage: store.getLanguage, getProvider: store.getProvider,
	};
}
