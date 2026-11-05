"use client";

import { useSyncExternalStore } from "react";
import {
	dictationSettingsBody, FACTORY_SETTINGS, isDictationLanguage, sanitizeUserSettings,
	type DictationLanguage, type DictationProvider, type GroqWhisperModel, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	/** The engine and its Whisper model travel with the language: the settings
	 * section is replaced whole, so every write must describe all three. */
	provider: undefined as DictationProvider | undefined,
	groqModel: undefined as GroqWhisperModel | undefined,
	saving: false,
	error: null as string | null,
};

export type DictationEnginePatch = { provider?: DictationProvider; groqModel?: GroqWhisperModel };

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 * Besides the language it carries the dictation engine (Deepgram or Groq) and
 * the Groq model; the language contract (load/save/getLanguage) is unchanged.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
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
				const groqModel = record?.dictation?.groqModel ?? FACTORY_SETTINGS.dictation.groqModel;
				needsRead = false;
				publish({ language, provider, groqModel, error: null });
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

	function save(language: DictationLanguage): Promise<boolean> {
		return write({ language }, "Could not save dictation language. Try again.");
	}

	function saveEngine(patch: DictationEnginePatch): Promise<boolean> {
		return write(patch, "Could not save dictation engine. Try again.");
	}

	/** Replace the whole dictation section with the confirmed values plus `patch`. */
	function write(patch: DictationEnginePatch & { language?: DictationLanguage }, failure: string): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		const next = { language: snapshot.language, provider: snapshot.provider, groqModel: snapshot.groqModel, ...patch };
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(dictationSettingsBody(next)),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation;
				if (!isDictationLanguage(confirmed?.language)) throw new Error();
				needsRead = false;
				publish({
					language: confirmed.language,
					provider: confirmed.provider ?? FACTORY_SETTINGS.dictation.provider,
					groqModel: confirmed.groqModel ?? FACTORY_SETTINGS.dictation.groqModel,
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

	/** Wait until nothing is reading or writing, then return the confirmed snapshot. */
	async function settled(): Promise<typeof snapshot & { language: DictationLanguage }> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return snapshot as typeof snapshot & { language: DictationLanguage };
		}
	}

	async function getLanguage(): Promise<DictationLanguage> {
		return (await settled()).language;
	}

	/** What a run needs, read from one settled snapshot (never half old, half new). */
	async function getPreference() {
		const { language, provider, groqModel } = await settled();
		return {
			language,
			provider: provider ?? FACTORY_SETTINGS.dictation.provider,
			groqModel: groqModel ?? FACTORY_SETTINGS.dictation.groqModel,
		};
	}

	return {
		load, save, saveEngine, getLanguage, getPreference,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
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
		...snapshot, load: store.load, save: store.save, saveEngine: store.saveEngine,
		getLanguage: store.getLanguage, getPreference: store.getPreference,
	};
}
