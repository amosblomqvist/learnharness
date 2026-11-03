"use client";

import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { saveEngine, useDictationEngine, type DictationEngine } from "@/components/whisper-dictation";

/** Settings → Providers → Dictation: local Whisper or Deepgram's cloud stream. */
export function DictationEngineSetting() {
	const engine = useDictationEngine();
	const active = useDictationActive();
	return (
		<SettingsRow
			label="Engine"
			hint={engine === "whisper" ? "Runs on this computer — no key needed." : "Streams to Deepgram — needs the key above."}
			testid="row-dictation-engine"
			dimmed={active}
		>
			<ThinSelect
				value={engine}
				ariaLabel="Dictation engine"
				testid="dictation-engine"
				disabled={active}
				onChange={(next) => void saveEngine(next as DictationEngine)}
			>
				<option value="whisper">Whisper (local)</option>
				<option value="deepgram">Deepgram (cloud)</option>
			</ThinSelect>
		</SettingsRow>
	);
}
