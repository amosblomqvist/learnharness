"use client";

import { FACTORY_SETTINGS, type DictationProvider } from "@/src/core";
import { CommitInput, SettingsRow, SettingsSegmentedControl } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

const PROVIDERS = [
	{ value: "deepgram", label: "Deepgram (cloud)" },
	{ value: "local", label: "Local" },
] as const satisfies readonly { value: DictationProvider; label: string }[];

/** Where dictation is transcribed, plus the local endpoint's URL and model.
 * Empty fields fall back to the factory defaults shown as placeholders. */
export function DictationProviderSetting() {
	const { section, language, saving, error, saveSection } = useDictationLanguage();
	const active = useDictationActive();
	const provider = section?.provider ?? FACTORY_SETTINGS.dictation.provider;
	const unavailable = active || saving || language === undefined;
	return <>
		<SettingsRow label="Provider" testid="row-dictation-provider" dimmed={active}>
			<SettingsSegmentedControl
				label="Dictation provider"
				options={PROVIDERS}
				value={provider}
				disabled={unavailable}
				testidPrefix="dictation-provider"
				onChange={(next) => { if (next !== provider) void saveSection({ provider: next }); }}
			/>
		</SettingsRow>
		{provider === "local" && <>
			<SettingsRow label="Server URL" hint="OpenAI-compatible /audio/transcriptions" testid="row-dictation-local-url" dimmed={active}>
				<CommitInput
					value={section?.localBaseUrl ?? ""}
					placeholder={FACTORY_SETTINGS.dictation.localBaseUrl}
					ariaLabel="Local dictation server URL"
					testid="input-dictation-local-url"
					disabled={unavailable}
					onCommit={(value) => saveSection({ localBaseUrl: value || undefined })}
				/>
			</SettingsRow>
			<SettingsRow label="Model" testid="row-dictation-local-model" dimmed={active}>
				<CommitInput
					value={section?.localModel ?? ""}
					placeholder={FACTORY_SETTINGS.dictation.localModel}
					ariaLabel="Local dictation model"
					testid="input-dictation-local-model"
					disabled={unavailable}
					onCommit={(value) => saveSection({ localModel: value || undefined })}
				/>
			</SettingsRow>
		</>}
		{error && <p role="alert" data-testid="dictation-settings-error" className="px-1 text-[11px] text-destructive">{error}</p>}
	</>;
}
