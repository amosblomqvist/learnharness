/**
 * Chinese script conversion for on-device dictation (OpenCC). Ported from
 * pi-voice src/chinese.ts (MIT, Copyright (c) 2026 Earendil Works contributors):
 * https://github.com/earendil-works/pi-voice. The rules for when to convert are
 * pure and live in src/core/local-stt-chinese.ts.
 *
 * Models write Chinese in either script, so both outputs convert: Simplified
 * from any Traditional variant, Traditional (Taiwan standard, as pi-voice's
 * default Traditional) from Simplified.
 */
import type { LocalChineseOutput } from "../../core/local-stt-chinese.ts";

type Converter = (text: string) => string;

const converters = new Map<LocalChineseOutput, Promise<Converter>>();

/** One converter per output, built on first use. */
function converterFor(output: LocalChineseOutput): Promise<Converter> {
	let converter = converters.get(output);
	if (!converter) {
		converter = import("opencc-js").then(({ default: OpenCC }) =>
			output === "simplified" ? OpenCC.Converter({ from: "t", to: "cn" }) : OpenCC.Converter({ from: "cn", to: "tw" }));
		converters.set(output, converter);
	}
	return converter;
}

export async function convertChineseOutput(text: string, output: LocalChineseOutput): Promise<string> {
	return (await converterFor(output))(text);
}
