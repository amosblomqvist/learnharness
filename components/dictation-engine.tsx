"use client";

import { useState } from "react";
import {
	DEFAULT_DICTATION_PROVIDER, GROQ_MAX_RECORDING_SECONDS, GROQ_WHISPER_MODELS, isDictationProvider, isGroqWhisperModel,
	type DictationProvider,
} from "@/src/core";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

const ENGINES: readonly { id: DictationProvider; label: string }[] = [
	{ id: "deepgram", label: "Deepgram" },
	{ id: "groq", label: "Groq (Whisper)" },
	{ id: "local", label: "Local (on this device)" },
];

const LINK = "underline underline-offset-2 hover:text-foreground";

/**
 * Settings → Providers → Dictation: which engine transcribes, and for Groq,
 * which Whisper model (the Local engine's model and language controls are separate). Deepgram stays the default. Like the language picker it
 * locks while a run is live, and a write failure keeps the previous choice.
 */
export function DictationEngineSettings() {
	const { provider, groqModel, saving, error, saveEngine } = useDictationLanguage();
	const active = useDictationActive();
	const [failed, setFailed] = useState(false);
	const disabled = active || saving || provider === undefined;

	return <>
		<SettingsRow label="Engine" testid="row-dictation-engine" dimmed={active} wrap>
			<ThinSelect
				value={provider ?? DEFAULT_DICTATION_PROVIDER}
				ariaLabel="Dictation engine"
				testid="select-dictation-engine"
				disabled={disabled}
				onChange={async (next) => {
					if (!isDictationProvider(next)) return;
					setFailed(!(await saveEngine({ provider: next })));
				}}
			>
				{ENGINES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
			</ThinSelect>
		</SettingsRow>
		{provider === "groq" && <SettingsRow label="Model" testid="row-dictation-groq-model" dimmed={active} wrap>
			<ThinSelect
				value={groqModel ?? GROQ_WHISPER_MODELS[0].id}
				ariaLabel="Groq Whisper model"
				testid="select-dictation-groq-model"
				disabled={disabled}
				onChange={async (next) => {
					if (!isGroqWhisperModel(next)) return;
					setFailed(!(await saveEngine({ groqModel: next })));
				}}
			>
				{GROQ_WHISPER_MODELS.map(({ id, label, hint }) => <option key={id} value={id}>{label} · {hint}</option>)}
			</ThinSelect>
		</SettingsRow>}
		{failed && error && <p role="alert" data-testid="dictation-engine-error" className="px-1 text-xs text-destructive">{error}</p>}
	</>;
}

/** The setup note under the Dictation group, for the selected engine. Deepgram's
 * wording is unchanged; Groq's says plainly that audio passes through this app's
 * server and that the key is the one already used for Groq models; Local's says
 * that nothing leaves this computer. */
export function DictationSetupHint() {
	const { provider } = useDictationLanguage();
	const className = "px-1 text-[11px] leading-relaxed text-muted-foreground/70";
	if (provider === "groq") {
		return (
			<p data-testid="dictation-setup-hint" data-engine="groq" className={className}>
				Groq sends your speech in short pieces while you talk, through this app's local server to Groq,
				and the text appears when you stop (up to {GROQ_MAX_RECORDING_SECONDS / 60} minutes at a time).
				It uses your <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className={LINK}>Groq API key</a>,
				the same one as the Groq model provider. Multilingual lets Whisper detect the language.
			</p>
		);
	}
	if (provider === "local") {
		return (
			<p data-testid="dictation-setup-hint" data-engine="local" className={className}>
				Local transcribes on this computer with a model you download and choose here, so your speech never
				leaves it. It is processed in short pieces while you talk, and the text appears when you stop
				(up to {GROQ_MAX_RECORDING_SECONDS / 60} minutes at a time).
			</p>
		);
	}
	return (
		<p data-testid="dictation-setup-hint" className={className}>
			Create a <a
				href="https://console.deepgram.com/"
				target="_blank"
				rel="noreferrer"
				className={LINK}
			>Deepgram API key</a> with the Member role or higher, then add it above.
		</p>
	);
}
