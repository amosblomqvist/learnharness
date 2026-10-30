"use client";

import {
	DICTATION_PROVIDERS, isDictationProvider, resolveDictationProvider,
	type DictationProviderId,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

/** Settings → Dictation → Provider, next to Language. A saved choice shows as
 *  itself; with none saved, the picker shows the provider the key-presence
 *  resolver would use right now (the same rule the token route applies). */
export function DictationProviderSetting({ keyPresence }: {
	keyPresence: { deepgram: boolean; elevenlabs: boolean };
}) {
	const { language, provider, saving, error, saveProvider } = useDictationLanguage();
	const active = useDictationActive();
	const resolved = resolveDictationProvider(provider, keyPresence);
	const current: DictationProviderId = "provider" in resolved
		? resolved.provider
		: DICTATION_PROVIDERS.find((p) => p.keyId === resolved.keyless)!.id;
	return <SettingsRow label="Provider" testid="row-dictation-provider" dimmed={active}>
		<Hint label={error ?? "Dictation provider"} side="top">
			<ThinSelect
				value={current}
				ariaLabel="Dictation provider"
				testid="dictation-provider"
				disabled={active || saving || language === undefined}
				onChange={(next) => { if (isDictationProvider(next)) void saveProvider(next); }}
			>
				{DICTATION_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
			</ThinSelect>
		</Hint>
	</SettingsRow>;
}
