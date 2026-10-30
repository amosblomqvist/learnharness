"use client";

import { useSyncExternalStore } from "react";
import { sanitizeUserSettings, type ReadAloudSettings, type UserSettings } from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

/** The saved read-aloud choices, shared by Settings → Read aloud and the
 *  Listen button (ElevenLabs voice slice 9). Absent fields stay absent: the
 *  server resolves the default voice and model. */
const INITIAL = {
	voiceId: undefined as string | undefined,
	modelId: undefined as string | undefined,
	/** Absent until chosen; the hook reads absent as off. */
	autoRead: undefined as boolean | undefined,
	/** False until the record has been read once. */
	loaded: false,
	saving: false,
	error: null as string | null,
};

/** One confirmed preference and one write in flight. The factory keeps
 *  transport tests isolated from the window singleton below.
 *
 *  A section PUT replaces the WHOLE section, so every write carries every
 *  field: voice, model and auto-read each read the other two from the snapshot. */
export function createReadAloudStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<void> | null = null;
	let writing = false;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(): Promise<void> {
		if (reading) return reading;
		reading = (async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				const record = sanitizeUserSettings(body.settings);
				if (writing) return; // the write's confirmed answer is newer
				publish({ voiceId: record?.readAloud?.voiceId, modelId: record?.readAloud?.modelId, autoRead: record?.readAloud?.autoRead, loaded: true, error: null });
			} catch {
				// Stay on the defaults: a failed read must not block Listen.
				publish({ loaded: true, error: "Could not load the read-aloud settings." });
			} finally {
				reading = null;
			}
		})();
		return reading;
	}

	function put(next: ReadAloudSettings): Promise<boolean> {
		if (writing) return Promise.resolve(false);
		writing = true;
		publish({ saving: true, error: null });
		return (async () => {
			try {
				const res = await request("/api/settings/readAloud", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.readAloud;
				if (!confirmed || confirmed.voiceId !== next.voiceId || confirmed.modelId !== next.modelId || confirmed.autoRead !== next.autoRead) throw new Error();
				publish({ voiceId: confirmed.voiceId, modelId: confirmed.modelId, autoRead: confirmed.autoRead, loaded: true, error: null });
				saved();
				return true;
			} catch {
				publish({ error: "Could not save the read-aloud settings. Try again." });
				return false;
			} finally {
				writing = false;
				publish({ saving: false });
			}
		})();
	}

	return {
		load,
		saveVoice: (voiceId: string) => put({ voiceId, modelId: snapshot.modelId, autoRead: snapshot.autoRead }),
		saveModel: (modelId: string) => put({ voiceId: snapshot.voiceId, modelId, autoRead: snapshot.autoRead }),
		saveAutoRead: (autoRead: boolean) => put({ voiceId: snapshot.voiceId, modelId: snapshot.modelId, autoRead }),
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createReadAloudStore((...args) => fetch(...args), () => {
	// Our readers already hold the confirmed answer; announce for other surfaces.
	announcingSave = true;
	try { notifySettingsSaved("readAloud"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "readAloud" && !announcingSave) void store.load();
		});
		void store.load();
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useReadAloudSettings() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, autoRead: snapshot.autoRead === true, saveVoice: store.saveVoice, saveModel: store.saveModel, saveAutoRead: store.saveAutoRead };
}
