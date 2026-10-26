/**
 * The local agent preference adapter (docs/architecture.md §8.2):
 * data/local-agents.json (config.LOCAL_AGENTS_FILE), under the LH_DATA_DIR
 * seam. Holds only the learner's enabled/background-use choices per
 * locally installed runtime — never a credential (the runtimes own their
 * sign-in). Absent/corrupt file = no choices yet; unknown providers are
 * dropped on read; writes are atomic (tmp + rename).
 */

import fs from "node:fs";
import path from "node:path";
import { LOCAL_AGENTS_FILE } from "../../config.ts";
import { LOCAL_AGENTS, type LocalAgentPreferences, type LocalAgentProviderId } from "../core/contracts/local-agents.ts";
import type { LocalAgentPreferenceStore } from "../core/ports.ts";

type Record_ = Partial<Record<LocalAgentProviderId, LocalAgentPreferences>>;

function read(): Record_ {
	let parsed: unknown;
	try { parsed = JSON.parse(fs.readFileSync(LOCAL_AGENTS_FILE, "utf-8")); } catch { return {}; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const out: Record_ = {};
	for (const { providerId } of LOCAL_AGENTS) {
		const entry = (parsed as Record<string, unknown>)[providerId] as Partial<LocalAgentPreferences> | undefined;
		if (!entry || typeof entry !== "object") continue;
		out[providerId] = { enabled: entry.enabled === true, allowBackgroundUse: entry.allowBackgroundUse !== false };
	}
	return out;
}

function write(providerId: LocalAgentProviderId, preferences: LocalAgentPreferences): void {
	const next = { ...read(), [providerId]: { enabled: preferences.enabled === true, allowBackgroundUse: preferences.allowBackgroundUse !== false } };
	const dir = path.dirname(LOCAL_AGENTS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.local-agents.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, LOCAL_AGENTS_FILE);
}

export const localAgentPreferenceStore: LocalAgentPreferenceStore = { read, write };
