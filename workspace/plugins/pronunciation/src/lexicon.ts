/**
 * Chinese text → Kokoro token ids, using the files shipped with the model:
 * tokens.txt (symbol → id), lexicon-zh.txt (word → phoneme symbols, with tone
 * changes already applied inside each word) and the jieba dictionaries (word
 * frequencies, used only to choose between competing segmentations).
 */

/** Content tokens must stay below the model's 510-row style table. */
export const MAX_TOKENS = 509;
const MAX_WORD_CHARS = 16;

const lines = (text: string): string[] => text.split(/\r?\n/).filter(line => line.length > 0);

export function parseTokens(text: string): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const line of lines(text)) {
    // The space symbol itself is a token, so split on the last space only.
    const split = line.lastIndexOf(" ");
    const id = Number(line.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid tokens.txt line: ${JSON.stringify(line)}`);
    tokens.set(line.slice(0, split), id);
  }
  return tokens;
}

export interface LexiconFiles { tokens: string; lexicon: string; dictionaries: string[] }

export class Lexicon {
  private readonly words = new Map<string, number[]>();
  private readonly logFrequency = new Map<string, number>();
  private readonly fallbackLog: number;
  private readonly maxWordChars: number;

  constructor(files: LexiconFiles) {
    const tokens = parseTokens(files.tokens);
    let longest = 1;
    for (const line of lines(files.lexicon)) {
      const [word, ...symbols] = line.split(" ");
      if (!word || !symbols.length) continue;
      const ids: number[] = [];
      for (const symbol of symbols) {
        const id = tokens.get(symbol);
        if (id !== undefined) ids.push(id);
      }
      if (!ids.length) continue;
      if (!this.words.has(word)) this.words.set(word, ids);
      longest = Math.max(longest, [...word].length);
    }
    if (!this.words.size) throw new Error("The Chinese lexicon is empty.");

    // Segmentation uses jieba's whole vocabulary. The lexicon lists only words
    // whose reading differs from their characters read one by one, so a jieba
    // word missing from it (生命, 起源) is still one word, read per character.
    const frequency = new Map<string, number>();
    let total = 0, smallest = Infinity;
    for (const dictionary of files.dictionaries) {
      for (const line of lines(dictionary)) {
        const [word, count] = line.split(" ");
        const value = Number(count);
        if (!word || !Number.isFinite(value) || value <= 0) continue;
        total += value;
        smallest = Math.min(smallest, value);
        frequency.set(word, Math.max(frequency.get(word) ?? 0, value));
        longest = Math.max(longest, [...word].length);
      }
    }
    if (!(total > 0)) throw new Error("The jieba dictionary is empty.");
    const logTotal = Math.log(total);
    for (const [word, value] of frequency) this.logFrequency.set(word, Math.log(value) - logTotal);
    this.fallbackLog = Math.log(smallest) - logTotal;
    this.maxWordChars = Math.min(longest, MAX_WORD_CHARS);
  }

  /** Jieba-style segmentation: the most probable path through known words (no HMM). */
  segment(phrase: string): string[] {
    const characters = [...phrase];
    const n = characters.length;
    const best = new Array<number>(n + 1).fill(-Infinity);
    const next = new Array<number>(n + 1).fill(n);
    best[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      let word = "";
      for (let k = i + 1; k <= Math.min(n, i + this.maxWordChars); k++) {
        word += characters[k - 1];
        // A single character is always a candidate, even when it is unknown.
        if (k > i + 1 && !this.logFrequency.has(word) && !this.words.has(word)) continue;
        const score = (this.logFrequency.get(word) ?? this.fallbackLog) + best[k]!;
        if (score > best[i]!) { best[i] = score; next[i] = k; }
      }
    }
    const words: string[] = [];
    for (let i = 0; i < n; i = next[i]!) words.push(characters.slice(i, next[i]).join(""));
    return words;
  }

  /** Content token ids (no padding). Unknown characters are skipped. */
  tokenize(phrase: string): number[] {
    const ids: number[] = [];
    for (const word of this.segment(phrase)) {
      const known = this.words.get(word);
      const piece = known ? [...known] : [...word].flatMap(character => this.words.get(character) ?? []);
      if (ids.length + piece.length > MAX_TOKENS) break;
      ids.push(...piece);
    }
    return ids;
  }
}
