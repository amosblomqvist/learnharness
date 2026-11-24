import assert from "node:assert/strict";
import { it } from "node:test";
import { cssUrls, fontFamilies } from "../src/fonts.ts";

it("normalizes ordinary, quoted-comma and escaped font families without splitting strings", () => {
  assert.deepEqual(fontFamilies('KaTeX_Main, "Drawing Fixture, Nested", serif'), ["katex_main", "drawing fixture, nested", "serif"]);
  assert.deepEqual(fontFamilies("'One\\'s Font', Other\\,Font, \\46 ont"), ["one's font", "other,font", "font"]);
  assert.deepEqual(fontFamilies('"A  B", A   B, ,'), ["a  b", "a b"]);
});
it("reads quoted/unquoted URL tokens and resolves escaped characters", () => {
  const css = 'local("System Font"), url("../font file.woff2") format("woff2"), URL(plain\\)name.ttf)';
  const tokens = cssUrls(css);
  assert.deepEqual(tokens.map(token => token.url), ["../font file.woff2", "plain)name.ttf"]);
  assert.deepEqual(tokens.map(token => css.slice(token.start, token.end)), ['url("../font file.woff2")', "URL(plain\\)name.ttf)"]);
});
it("does not read URL lookalikes inside local names/strings or other identifiers", () => {
  assert.deepEqual(cssUrls('local("url(not-a-resource)"), local(\'url(nope)\'), noturl(nope), url(real.woff2)').map(token => token.url), ["real.woff2"]);
});
it("retains data URLs and tolerates empty or incomplete declarations without looping", () => {
  assert.deepEqual(cssUrls('url("data:font/woff2;base64,AAAA")').map(token => token.url), ["data:font/woff2;base64,AAAA"]);
  assert.deepEqual(cssUrls(""), []); assert.deepEqual(cssUrls("url("), []); assert.deepEqual(cssUrls('url("unfinished'), []);
});
