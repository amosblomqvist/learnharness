"use client";

import {
	TRANSCRIPTION_LANGUAGES,
	transcriptionLanguage,
	isTranscriptionLanguage,
	type TranscriptionLanguage,
} from "@/src/core";
import { SettingsRow, ThinSelect } from "./controls.tsx";

export function DictationSettings({ language, onLanguageChange }: {
	language: TranscriptionLanguage | undefined;
	onLanguageChange: (language: TranscriptionLanguage) => void;
}) {
	return (
		<SettingsRow label="Transcription language" hint="Applies to the next dictation." testid="row-transcription-language">
			<ThinSelect
				value={transcriptionLanguage(language)}
				ariaLabel="Transcription language"
				testid="select-transcription-language"
				onChange={(next) => {
					if (isTranscriptionLanguage(next)) onLanguageChange(next);
				}}
			>
				{TRANSCRIPTION_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
			</ThinSelect>
		</SettingsRow>
	);
}
