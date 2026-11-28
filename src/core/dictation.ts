import { tr } from "./i18n.ts";
/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */

const NOVA_3_LANGUAGES = [
	[tr("南非荷兰语", "Afrikaans"), ["af", "af-ZA"]],
	[tr("阿拉伯语", "Arabic"), ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	[tr("亚美尼亚语", "Armenian"), ["hy"]],
	[tr("阿萨姆语", "Assamese"), ["as", "as-IN"]],
	[tr("白俄罗斯语", "Belarusian"), ["be"]],
	[tr("孟加拉语", "Bengali"), ["bn"]],
	[tr("波斯尼亚语", "Bosnian"), ["bs"]],
	[tr("保加利亚语", "Bulgarian"), ["bg"]],
	[tr("加泰罗尼亚语", "Catalan"), ["ca"]],
	[tr("中文（粤语，繁体）", "Chinese (Cantonese, Traditional)"), ["zh-HK"]],
	[tr("中文（普通话，简体）", "Chinese (Mandarin, Simplified)"), ["zh", "zh-CN", "zh-Hans"]],
	[tr("中文（普通话，繁体）", "Chinese (Mandarin, Traditional)"), ["zh-TW", "zh-Hant"]],
	[tr("克罗地亚语", "Croatian"), ["hr"]],
	[tr("捷克语", "Czech"), ["cs", "cs-CZ"]],
	[tr("丹麦语", "Danish"), ["da", "da-DK"]],
	[tr("荷兰语", "Dutch"), ["nl"]],
	[tr("英语", "English"), ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	[tr("爱沙尼亚语", "Estonian"), ["et"]],
	[tr("芬兰语", "Finnish"), ["fi"]],
	[tr("佛兰芒语", "Flemish"), ["nl-BE"]],
	[tr("法语", "French"), ["fr", "fr-CA"]],
	[tr("格鲁吉亚语", "Georgian"), ["ka", "ka-GE"]],
	[tr("德语", "German"), ["de"]],
	[tr("德语（瑞士）", "German (Switzerland)"), ["de-CH"]],
	[tr("希腊语", "Greek"), ["el"]],
	[tr("古吉拉特语", "Gujarati"), ["gu", "gu-IN"]],
	[tr("希伯来语", "Hebrew"), ["he"]],
	[tr("印地语", "Hindi"), ["hi"]],
	[tr("匈牙利语", "Hungarian"), ["hu"]],
	[tr("印度尼西亚语", "Indonesian"), ["id"]],
	[tr("意大利语", "Italian"), ["it"]],
	[tr("日语", "Japanese"), ["ja"]],
	[tr("卡纳达语", "Kannada"), ["kn"]],
	[tr("哈萨克语", "Kazakh"), ["kk", "kk-KZ"]],
	[tr("韩语", "Korean"), ["ko", "ko-KR"]],
	[tr("拉脱维亚语", "Latvian"), ["lv"]],
	[tr("立陶宛语", "Lithuanian"), ["lt"]],
	[tr("马其顿语", "Macedonian"), ["mk"]],
	[tr("马来语", "Malay"), ["ms"]],
	[tr("马拉地语", "Marathi"), ["mr"]],
	[tr("蒙古语", "Mongolian"), ["mn"]],
	[tr("尼泊尔语", "Nepali"), ["ne"]],
	[tr("挪威语", "Norwegian"), ["no"]],
	[tr("普什图语", "Pashto"), ["ps", "ps-AF"]],
	[tr("波斯语", "Persian"), ["fa"]],
	[tr("波兰语", "Polish"), ["pl"]],
	[tr("葡萄牙语", "Portuguese"), ["pt", "pt-BR", "pt-PT"]],
	[tr("旁遮普语", "Punjabi"), ["pa", "pa-IN"]],
	[tr("罗马尼亚语", "Romanian"), ["ro"]],
	[tr("俄语", "Russian"), ["ru"]],
	[tr("塞尔维亚语", "Serbian"), ["sr"]],
	[tr("斯洛伐克语", "Slovak"), ["sk"]],
	[tr("斯洛文尼亚语", "Slovenian"), ["sl"]],
	[tr("西班牙语", "Spanish"), ["es", "es-419"]],
	[tr("瑞典语", "Swedish"), ["sv", "sv-SE"]],
	[tr("他加禄语", "Tagalog"), ["tl"]],
	[tr("泰米尔语", "Tamil"), ["ta"]],
	[tr("泰卢固语", "Telugu"), ["te"]],
	[tr("泰语", "Thai"), ["th", "th-TH"]],
	[tr("土耳其语", "Turkish"), ["tr", "tr-TR"]],
	[tr("乌克兰语", "Ukrainian"), ["uk"]],
	[tr("乌尔都语", "Urdu"), ["ur"]],
	[tr("越南语", "Vietnamese"), ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: tr("多语言", "Multilingual") },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : tr(`${name}（${code}）`, `${name} (${code})`) })),
	).sort((a, b) => a.label.localeCompare(b.label, tr("zh-Hans", "en"))),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
