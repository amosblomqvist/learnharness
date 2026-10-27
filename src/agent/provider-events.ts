/**
 * provider-events — the raw-wire recorder (owner, 2026-10-04).
 *
 * pi-ai 1.0's onProviderStreamEvent observer fires for each PARSED
 * provider stream event BEFORE pi normalizes it — the exact layer where
 * our provider-quirk incident class lives and where nothing else in the
 * app can see: GLM-flash truncating tool-call arguments mid-JSON
 * (2026-09-25), DeepSeek resetting tool-call ids every response
 * (2026-10-04, the Lacan session). This module turns that observer into
 * an inspectable artifact.
 *
 * Gating (owner choice, 2026-10-04): env var only —
 *   LH_PROVIDER_EVENTS=1 npm run dev
 * Default off: raw events carry full prompts (privacy) and unbounded
 * volume (disk). No app surface; a debugging feature, not a feature.
 *
 * Artifact: one JSONL file per chat at
 *   data/debug/provider-events/<chatId>.jsonl
 * (data/ is disposable scratch — no retention system). Each line:
 *   {"t":<epoch ms>,"ctx":"teacher|prober|job:<role>","provider":…,"model":…,"event":<raw>}
 * plus {"note":…} run markers. A per-file byte cap (CAPPED at ~20 MB)
 * writes one truncation marker and stops — a runaway turn must not fill
 * the disk. Event payloads are adapter-owned; a non-serializable event
 * degrades to a type note, never throws (an observer exception must not
 * kill a stream).
 */

import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

/** Max bytes per chat's JSONL before recording stops (with a marker). */
const CAP_BYTES = 20 * 1024 * 1024;

/** Test seam (the toolTimeoutMs idiom): shrink the cap to exercise it. */
export const providerEventsCap = { current: CAP_BYTES };

/** Test seam (the toolTimeoutMs idiom): redirect the output directory.
 *  null = the active profile's debug/provider-events. */
export const providerEventsDir: { current: string | null } = { current: null };

/** The model shape the observer receives (structural — pi passes Model). */
export interface ProviderEventModel {
	provider?: string;
	id?: string;
}

export type ProviderEventObserver = (data: unknown, model: ProviderEventModel) => void;

/** Per-file accounting so the cap marker writes exactly once. */
const files = new Map<string, { bytes: number; capped: boolean }>();

function fileFor(chatId: string): string {
	// chat ids are app-minted (chat_<base36>) — sanitize against any future
	// id scheme putting path-hostile characters in here.
	const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(providerEventsDir.current ?? path.join(PATHS.debug, "provider-events"), `${safe}.jsonl`);
}

function writeLine(file: string, line: Record<string, unknown>): void {
	const state = files.get(file);
	if (state?.capped) return;
	const text = `${JSON.stringify({ t: Date.now(), ...line })}\n`;
	try {
		const before = state?.bytes ?? (fs.existsSync(file) ? fs.statSync(file).size : 0);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, text, "utf-8");
		const bytes = before + Buffer.byteLength(text);
		if (bytes > providerEventsCap.current) {
			files.set(file, { bytes, capped: true });
			fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), note: `cap ${providerEventsCap.current} bytes reached — recording stopped` })}\n`, "utf-8");
		} else {
			files.set(file, { bytes, capped: false });
		}
	} catch {
		// The debug recorder must never take a run down with it.
	}
}

/** Encode an adapter-owned event safely: JSON when it cooperates, a type
 *  note when it does not (cyclic/BigInt payloads). */
function encodeEvent(data: unknown): unknown {
	try {
		JSON.stringify(data);
		return data;
	} catch {
		return { __nonSerializable: typeof data };
	}
}

/** True when recording is on (read per call — toggling needs no restart
 *  beyond the next turn's agent construction). */
export function providerEventsEnabled(): boolean {
	return !!process.env.LH_PROVIDER_EVENTS;
}

/**
 * The observer for one agent run, or undefined when disabled. Pass the
 * result as the Agent's onProviderStreamEvent (both construction sites —
 * teacher-agent's baseAgentOptions and pi-run's runSubagent — build it
 * from a chatId in hand).
 */
export function providerEventObserver(chatId: string, context: string): ProviderEventObserver | undefined {
	if (!providerEventsEnabled()) return undefined;
	return (data, model) => {
		writeLine(fileFor(chatId), {
			ctx: context,
			provider: model?.provider,
			model: model?.id,
			event: encodeEvent(data),
		});
	};
}

/** A run marker (start/end/abort notes) so events correlate with the
 *  persisted record; no-op when disabled. */
export function providerEventNote(chatId: string, context: string, text: string): void {
	if (!providerEventsEnabled()) return;
	writeLine(fileFor(chatId), { ctx: context, note: text });
}
