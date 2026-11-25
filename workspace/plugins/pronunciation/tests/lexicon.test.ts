import test from "node:test";
import assert from "node:assert/strict";
import { Lexicon, parseTokens } from "../src/lexicon.ts";
import { DICTIONARY, LEXICON, TOKENS, USER_DICTIONARY } from "./fixtures.ts";

const lexicon = () => new Lexicon({ tokens: TOKENS, lexicon: LEXICON, dictionaries: [DICTIONARY, USER_DICTIONARY] });

test("tokens.txt keeps the space symbol and refuses malformed lines", () => {
  const tokens = parseTokens(TOKENS);
  assert.equal(tokens.get(" "), 0);
  assert.equal(tokens.get("_"), 1);
  assert.equal(tokens.get("yin2"), 10);
  assert.equal(lexicon().tokenId("_"), 1);
  assert.equal(lexicon().tokenId("nope"), undefined);
  assert.throws(() => parseTokens("a x"));
  assert.throws(() => parseTokens("17"));
});

test("segmentation takes the most probable path, not the longest match", () => {
  assert.deepEqual(lexicon().segment("研究生命"), ["研究", "生命"]);
  assert.deepEqual(lexicon().segment("银行你好"), ["银行", "你好"]);
  assert.deepEqual(lexicon().segment("行"), ["行"]);
});

test("tokens come from whole words, with in-word tone changes from the lexicon", () => {
  // 你好 uses the word entry (ni2 hao3), not 你 (ni3) + 好 (hao3).
  assert.deepEqual(lexicon().tokenize("你好"), [14, 15]);
  // 银行 reads 行 as hang2; alone it is xing2.
  assert.deepEqual(lexicon().tokenize("银行"), [10, 12]);
  assert.deepEqual(lexicon().tokenize("行"), [11]);
});

test("a dictionary word missing from the lexicon stays one word, read per character", () => {
  assert.deepEqual(lexicon().tokenize("研究生命"), [16, 17, 18, 19]);
});

test("unknown symbols and characters are skipped", () => {
  assert.deepEqual(lexicon().tokenize("怪"), [10, 11], "the unknown ? symbol is dropped");
  assert.deepEqual(lexicon().tokenize("银猫行"), [10, 11], "an unknown character is skipped");
  assert.deepEqual(lexicon().tokenize("猫"), []);
});

test("empty model files are refused", () => {
  assert.throws(() => new Lexicon({ tokens: TOKENS, lexicon: "", dictionaries: [DICTIONARY] }), /lexicon is empty/);
  assert.throws(() => new Lexicon({ tokens: TOKENS, lexicon: LEXICON, dictionaries: [""] }), /jieba dictionary is empty/);
});
