"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationLanguage, sanitizeUserSettings,
	type DictationLanguage, type DictationSettings, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

/** The confirmed dictation preferences + one write in flight, shared by every
 *  surface. `language === undefined` is the NOT-LOADED sentinel (the read
 *  gates on it); once loaded, an absent inputDeviceId means "system default". */
const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	inputDeviceId: undefined as string | undefined,
	inputDeviceLabel: undefined as string | undefined,
	saving: false,
	error: null as string | null,
};

/** What `save` may change — any subset of the section. An empty-string
 *  inputDeviceId is the explicit "clear to system default" (drops the id AND
 *  its label). */
export type DictationPatch = Partial<Pick<DictationSettings, "language" | "inputDeviceId" | "inputDeviceLabel">>;

/** ONE store for the WHOLE dictation section (input-device selection wave):
 * the section is replace-whole on PUT, so language and the input device MUST
 * be written together — the merge below carries the untouched fields so one
 * control's save never wipes the other's. The factory keeps transport tests
 * isolated without a second persistence path.
 */
export function createDictationStore(request: typeof fetch, saved: () => void = () => {}) {
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
				const dictation = record?.dictation ?? {};
				const language = dictation.language ?? FACTORY_SETTINGS.dictation.language;
				needsRead = false;
				publish({
					language,
					inputDeviceId: dictation.inputDeviceId,
					inputDeviceLabel: dictation.inputDeviceLabel,
					error: null,
				});
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation settings. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** Merge the patch over the confirmed section and PUT the WHOLE section.
	 *  An empty-string inputDeviceId (or an absent one after merge) drops both
	 *  the id and the label — system default. */
	function save(patch: DictationPatch): Promise<boolean> {
		// A different selection must never inherit the previous write's
		// success; nothing to merge over until the section has loaded.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		const merged = { ...snapshot, ...patch };
		const section: DictationSettings = { language: merged.language };
		if (merged.inputDeviceId) {
			section.inputDeviceId = merged.inputDeviceId;
			if (merged.inputDeviceLabel) section.inputDeviceLabel = merged.inputDeviceLabel;
		}
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(section),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation ?? {};
				if (!isDictationLanguage(confirmed.language)) throw new Error();
				needsRead = false;
				publish({
					language: confirmed.language,
					inputDeviceId: confirmed.inputDeviceId,
					inputDeviceLabel: confirmed.inputDeviceLabel,
					error: null,
				});
				saved();
				return true;
			} catch {
				publish({ error: "Could not save dictation settings. Try again." });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function getLanguage(): Promise<DictationLanguage> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return snapshot.language;
		}
	}

	/** The capture path's read (dictation.tsx): ensure the section is loaded,
	 *  then hand back the pinned deviceId (undefined = system default). */
	async function getInputDeviceId(): Promise<string | undefined> {
		await getLanguage();
		return snapshot.inputDeviceId;
	}

	return {
		load, save, getLanguage, getInputDeviceId,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationStore((...args) => fetch(...args), () => {
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

/** The language control's view — `save(code)` targets the `language` field
 *  (the merge carries the untouched device fields). */
export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return {
		language: snapshot.language, saving: snapshot.saving, error: snapshot.error,
		load: store.load, getLanguage: store.getLanguage,
		save: (language: DictationLanguage) => store.save({ language }),
	};
}

/** The input-device control's view — `save(deviceId, label)` targets the
 *  device fields (an empty deviceId clears the pin to system default). */
export function useDictationInputDevice() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return {
		inputDeviceId: snapshot.inputDeviceId, inputDeviceLabel: snapshot.inputDeviceLabel,
		language: snapshot.language, saving: snapshot.saving, error: snapshot.error,
		load: store.load, getInputDeviceId: store.getInputDeviceId,
		save: (deviceId: string, label?: string) =>
			store.save(deviceId ? { inputDeviceId: deviceId, inputDeviceLabel: label } : { inputDeviceId: "" }),
	};
}
