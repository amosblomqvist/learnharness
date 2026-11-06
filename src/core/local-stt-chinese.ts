/**
 * The pure rules for the Chinese script preference on on-device dictation.
 * Ported from pi-voice src/chinese.ts (MIT, Copyright (c) 2026 Earendil Works
 * contributors): https://github.com/earendil-works/pi-voice. The OpenCC
 * conversion itself runs on the server (src/server/local-stt/chinese.ts).
 */

/** Simplified is the default. Traditional uses OpenCC's Taiwan standard (see the server). */
export const LOCAL_CHINESE_OUTPUTS = ["simplified", "traditional"] as const;
export type LocalChineseOutput = (typeof LOCAL_CHINESE_OUTPUTS)[number];
export const DEFAULT_LOCAL_CHINESE_OUTPUT: LocalChineseOutput = "simplified";

export function isLocalChineseOutput(value: unknown): value is LocalChineseOutput {
	return LOCAL_CHINESE_OUTPUTS.some((output) => output === value);
}

export function isChineseLanguage(language: string): boolean {
	const base = language.toLowerCase().split("-", 1)[0];
	return base === "zh" || base === "yue";
}

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Whether a transcript gets the Chinese script preference. The text decides,
 * not language detection: on short clips the detector often says English for
 * Mandarin, which used to leave the model's Simplified output unconverted.
 * Kana means Japanese, whose kanji OpenCC would mangle (学→學, 図書館→图书馆).
 */
export function shouldConvertChinese(
	text: string,
	{ chineseEnabled, language }: { chineseEnabled: boolean; language: string },
): boolean {
	if (!HAN.test(text) || KANA.test(text)) return false;
	return chineseEnabled || isChineseLanguage(language);
}
