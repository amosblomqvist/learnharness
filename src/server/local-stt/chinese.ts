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

async function createConverter(output: LocalChineseOutput): Promise<Converter> {
	const { default: OpenCC } = await import("opencc-js");
	return output === "simplified"
		? OpenCC.Converter({ from: "t", to: "cn" })
		: OpenCC.Converter({ from: "cn", to: "tw" });
}

function converterFor(output: LocalChineseOutput): Promise<Converter> {
	const existing = converters.get(output);
	if (existing) return existing;
	const loading = createConverter(output);
	converters.set(output, loading);
	void loading.catch(() => {
		if (converters.get(output) === loading) converters.delete(output);
	});
	return loading;
}

export async function convertChineseOutput(text: string, output: LocalChineseOutput): Promise<string> {
	return (await converterFor(output))(text);
}
