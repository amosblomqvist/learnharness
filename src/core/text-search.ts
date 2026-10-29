/** Unicode search folding, without changing stored text. */
const NON_ASCII = /[^\x00-\x7F]/;
/** Marks that are part of the letter in their script (バ is not ハ, पानी is not
 * पन): kana voicing, Indic vowel signs and virama, Thai, Lao, Tibetan, Myanmar
 * and Khmer vowels and tones. Every other mark (accents, tashkeel, niqqud) goes.
 * The kana voicing marks are Script=Inherited, so they are named; matching by
 * Script_Extensions instead would also keep Latin diacritics (U+0303, U+0323). */
const LETTER_MARKS = "\\p{sc=Hira}\\p{sc=Kana}\\p{sc=Deva}\\p{sc=Beng}\\p{sc=Guru}\\p{sc=Gujr}\\p{sc=Orya}\\p{sc=Taml}\\p{sc=Telu}\\p{sc=Knda}\\p{sc=Mlym}\\p{sc=Sinh}\\p{sc=Thai}\\p{sc=Laoo}\\p{sc=Tibt}\\p{sc=Mymr}\\p{sc=Khmr}\\u3099\\u309A";
// NFKD turns a spacing accent (´ ¨ ﹷ) into a space carrying the mark; the
// carrier goes with the mark, or a dead-key accent would match every space.
// Class subtraction (the v flag) scans faster than a lookahead per mark.
const STRIPPED_MARKS = new RegExp(` ?[\\p{M}--[${LETTER_MARKS}]]`, "gv");
const ANY_MARK = /\p{M}/u;
const MARKED_LETTERS = /[^\p{M}]?\p{M}+/gu;
const CARRIER_SPACES = / (?=\p{M})/gu;
const IGNORABLE_CHARACTERS = /[\p{Default_Ignorable_Code_Point}\u0640]/gu;
const SCRIPT_EQUIVALENCES = {
	Arabic: { "ٱ": "ا", "ى": "ي", "ة": "ه" },
	// Lowercasing is contextual: a final sigma in the text must meet the
	// query's medial one.
	Greek: { "ς": "σ" },
};
const LETTER_EQUIVALENCES = new Map(Object.values(SCRIPT_EQUIVALENCES).flatMap(Object.entries));
const EQUIVALENT_LETTERS = new RegExp([...LETTER_EQUIVALENCES.keys()].join("|"), "gu");

function foldForSearch(text: string): string {
	const stripped = text.normalize("NFKD")
		// Compatibility forms decompose to capitals (𝐀, ℝ, ™): lowercase again.
		.toLowerCase()
		.replace(STRIPPED_MARKS, "");
	// Only letter marks are left. They recompose to the usual form, chunked by
	// letter so Hangul jamo stay apart and the per-cluster map agrees; the
	// carrier space of a spacing form goes once nothing can fuse across it.
	const recomposed = ANY_MARK.test(stripped)
		? stripped.replace(MARKED_LETTERS, (letter) => letter.normalize("NFC")).replace(CARRIER_SPACES, "")
		: stripped;
	return recomposed
		.replace(IGNORABLE_CHARACTERS, "")
		.replace(EQUIVALENT_LETTERS, (letter) => LETTER_EQUIVALENCES.get(letter)!);
}

/** Clusters repeat (a letter with its marks), so their folds are kept. */
const CLUSTER_FOLD_LIMIT = 4096;
const clusterFolds = new Map<string, string>();

function foldCluster(cluster: string): string {
	let value = clusterFolds.get(cluster);
	if (value === undefined) {
		value = foldForSearch(cluster);
		if (clusterFolds.size >= CLUSTER_FOLD_LIMIT) clusterFolds.clear();
		clusterFolds.set(cluster, value);
	}
	return value;
}

export function normalizeForSearch(text: string): string {
	// ASCII folds to its own lowercase; skip the Unicode passes.
	if (!NON_ASCII.test(text)) return text.toLowerCase();
	return foldForSearch(text.toLowerCase());
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface NormalizedSearchText {
	text: string;
	/** Original UTF-16 start and exclusive end for each normalized code unit.
	 * Removed trailing marks belong to the preceding retained character. */
	map: number[];
	ends: number[];
}

export function normalizeWithMap(text: string): NormalizedSearchText {
	// Lowercase the whole string to preserve contextual mappings such as sigma.
	const lower = text.toLowerCase();
	const chunks: string[] = [];
	const map: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	let lowerOffset = 0;
	let previousSpan = 0;
	// Fold per grapheme cluster: a letter and its marks reorder and recompose
	// together, and every folded unit maps back to the cluster it came from.
	for (const { segment } of GRAPHEMES.segment(text)) {
		const lowerLength = segment.toLowerCase().length;
		const lowerSegment = lower.slice(lowerOffset, lowerOffset + lowerLength);
		const value = foldCluster(lowerSegment);
		const end = offset + segment.length;
		// Marks after an expansion belong to every output unit of that source span.
		if (!value) {
			for (let i = previousSpan; i < ends.length; i++) ends[i] = end;
		} else previousSpan = map.length;
		const sameUnits = value === lowerSegment && value.length === segment.length;
		for (let i = 0; i < value.length; i++) {
			map.push(sameUnits ? offset + i : offset);
			ends.push(sameUnits ? offset + i + 1 : end);
		}
		chunks.push(value);
		offset = end;
		lowerOffset += lowerLength;
	}
	return { text: chunks.join(""), map, ends };
}
