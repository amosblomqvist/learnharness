import test from "node:test";
import assert from "node:assert/strict";
import { Lexicon, MAX_TOKENS, parseTokens } from "../src/lexicon.ts";
import { DICTIONARY, LEXICON, TOKENS, USER_DICTIONARY } from "./fixtures.ts";

const lexicon = () => new Lexicon({ tokens: TOKENS, lexicon: LEXICON, dictionaries: [DICTIONARY, USER_DICTIONARY] });

test("tokens.txt keeps the space symbol and refuses malformed lines", () => {
  const tokens = parseTokens(TOKENS);
  assert.equal(tokens.get(" "), 16);
  assert.equal(tokens.get("a"), 43);
  assert.throws(() => parseTokens("a x"));
  assert.throws(() => parseTokens("17"));
});

test("segmentation takes the most probable path, not the longest match", () => {
  assert.deepEqual(lexicon().segment("研究生命"), ["研究", "生命"]);
  assert.deepEqual(lexicon().segment("银行你好"), ["银行", "你好"]);
  assert.deepEqual(lexicon().segment("行"), ["行"]);
});

test("tokens come from whole words, with in-word tone changes from the lexicon", () => {
  // 你好 uses the word entry (ni2 hao3), not 你 (3) + 好 (3).
  assert.deepEqual(lexicon().tokenize("你好"), [46, 2, 47, 3]);
  assert.deepEqual(lexicon().tokenize("银行"), [43, 2, 45, 2]);
  assert.deepEqual(lexicon().tokenize("行"), [44, 2]);
});

test("a dictionary word missing from the lexicon stays one word, read per character", () => {
  assert.deepEqual(lexicon().tokenize("研究生命"), [48, 2, 49, 1, 50, 1, 43, 4]);
});

test("unknown symbols and characters are skipped", () => {
  assert.deepEqual(lexicon().tokenize("怪"), [43, 44, 45], "the unknown ? symbol is dropped");
  assert.deepEqual(lexicon().tokenize("银猫行"), [43, 2, 44, 2], "an unknown character is skipped");
  assert.deepEqual(lexicon().tokenize("猫"), []);
});

test("the token sequence stays below the style table", () => {
  const ids = lexicon().tokenize("你好".repeat(200));
  assert.ok(ids.length <= MAX_TOKENS);
  assert.equal(ids.length % 4, 0, "truncation happens at a word boundary");
});

test("empty model files are refused", () => {
  assert.throws(() => new Lexicon({ tokens: TOKENS, lexicon: "", dictionaries: [DICTIONARY] }), /lexicon is empty/);
  assert.throws(() => new Lexicon({ tokens: TOKENS, lexicon: LEXICON, dictionaries: [""] }), /jieba dictionary is empty/);
});
