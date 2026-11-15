import * as fs from "node:fs";
import path from "node:path";

/** Per-machine GitHub Sync state. Lives in this plugin's data folder, which
 *  is inside the synced folder, so the file is listed in .gitignore and
 *  never leaves this computer. */
export interface LocalState {
	/** Automatic sync (startup pull, quit sync, push after work). Default on. */
	autoSync: boolean;
	/** A conflict found by any sync and not resolved yet. Pauses automatic sync. */
	conflict?: { branch: string; remote: string; message: string; at: string };
	/** The last automatic sync's outcome, shown on the settings page. */
	lastAuto?: { at: string; status: string; message: string };
}

export const LOCAL_STATE_FILE = "local.json";

export function createLocalState(dataDirectory: string) {
	const file = path.join(dataDirectory, LOCAL_STATE_FILE);
	function read(): LocalState {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LocalState>;
			const state: LocalState = { autoSync: value.autoSync !== false };
			const c = value.conflict;
			if (c && typeof c.branch === "string" && typeof c.remote === "string" && /^[0-9a-f]{40,64}$/.test(c.remote) && typeof c.message === "string" && typeof c.at === "string") state.conflict = c;
			const l = value.lastAuto;
			if (l && typeof l.at === "string" && typeof l.status === "string" && typeof l.message === "string") state.lastAuto = l;
			return state;
		} catch {
			return { autoSync: true };
		}
	}
	function write(state: LocalState): void {
		fs.mkdirSync(dataDirectory, { recursive: true });
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(state, null, "\t")}\n`);
		fs.renameSync(temp, file);
	}
	return {
		file,
		read,
		update(patch: Partial<LocalState>): LocalState {
			const next: LocalState = { ...read(), ...patch };
			for (const key of Object.keys(patch) as (keyof LocalState)[]) if (patch[key] === undefined) delete next[key];
			write(next);
			return next;
		},
	};
}

export type LocalStateStore = ReturnType<typeof createLocalState>;
