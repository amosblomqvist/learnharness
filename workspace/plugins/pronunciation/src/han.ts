import { MAX_PHRASE_CHARS } from "./contract.ts";

const HAN = /^\p{Script=Han}$/u;

/** True for a single Han code point (Chinese character). */
export function isHan(character: string): boolean {
  return HAN.test(character);
}

/** True when the whole string is 1..MAX_PHRASE_CHARS Han characters. */
export function isHanPhrase(text: string): boolean {
  const characters = [...text];
  return characters.length > 0 && characters.length <= MAX_PHRASE_CHARS && characters.every(isHan);
}

/** The Han character starting at UTF-16 `index`, or undefined. */
export function hanAt(text: string, index: number): string | undefined {
  if (index < 0 || index >= text.length) return undefined;
  const code = text.codePointAt(index);
  if (code === undefined) return undefined;
  // A low surrogate is the middle of a character, not its start.
  const unit = text.charCodeAt(index);
  if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
  const character = String.fromCodePoint(code);
  return isHan(character) ? character : undefined;
}

/**
 * The unbroken run of Han characters containing the character that starts at
 * UTF-16 `index`, as UTF-16 [start, end). Any non-Han character (punctuation,
 * space, Latin, digit) ends the run. A run longer than MAX_PHRASE_CHARS is
 * trimmed to a window around the clicked character.
 */
export function hanRunAt(text: string, index: number): { start: number; end: number } | undefined {
  if (!hanAt(text, index)) return undefined;
  const before: number[] = [];
  for (let at = index; at > 0;) {
    const unit = text.charCodeAt(at - 1);
    const previous = unit >= 0xdc00 && unit <= 0xdfff && at >= 2 ? at - 2 : at - 1;
    if (!hanAt(text, previous)) break;
    before.push(previous);
    at = previous;
  }
  const after: number[] = []; // starts of characters after the clicked one
  for (let at = index + hanAt(text, index)!.length; hanAt(text, at); at += hanAt(text, at)!.length) after.push(at);
  const total = before.length + 1 + after.length;
  let left = before.length, right = after.length;
  if (total > MAX_PHRASE_CHARS) {
    const budget = MAX_PHRASE_CHARS - 1;
    left = Math.min(left, Math.max(Math.floor(budget / 2), budget - right));
    right = budget - left;
  }
  const start = left ? before[left - 1]! : index;
  const last = right ? after[right - 1]! : index;
  return { start, end: last + hanAt(text, last)!.length };
}
