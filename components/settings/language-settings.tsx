"use client";

import { useState } from "react";
import { tr, type UiLanguage } from "@/src/core";
import { SettingsRow, SettingsSegmentedControl } from "./controls.tsx";

const OPTIONS: readonly { value: UiLanguage; label: string }[] = [
	{ value: "zh", label: "简体中文" },
	{ value: "en", label: "English" },
];

/** Interface language — also the AI tutor's output language. Strings resolve
 *  once per process, so a change is saved and then the app relaunches; the
 *  label stays bilingual so it can be found from either language. */
export function LanguageSettings({ language, save }: { language: UiLanguage; save: (next: UiLanguage) => Promise<boolean> }) {
	const [saved, setSaved] = useState<UiLanguage | null>(null);
	const choose = async (next: UiLanguage) => {
		if (next === (saved ?? language)) return;
		if (!(await save(next))) return;
		setSaved(next);
		await window.lh?.relaunch?.();
	};
	const restartHint = saved !== null && saved !== language && !window.lh?.relaunch;
	return (
		<SettingsRow
			label="语言 / Language"
			hint={restartHint
				? tr("已保存。重启服务器后生效。", "Saved. Restart the server to apply.")
				: tr("界面语言，也是 AI 老师的教学语言。切换后应用会重启。", "Interface language, also used by the AI tutor. The app restarts to apply.")}
			testid="row-language"
		>
			<SettingsSegmentedControl label="语言 / Language" options={OPTIONS} value={saved ?? language} testidPrefix="language" onChange={(next) => void choose(next)} />
		</SettingsRow>
	);
}
