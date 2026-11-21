import test from "node:test";
import assert from "node:assert/strict";
import { boundTexError, texErrorMessage, TEX_ERROR_BYTES } from "../src/tex-diagnostics.ts";

function failure(log: string) { return Object.assign(new Error("TeX compilation failed."), { texLog: log }); }

test("reports the actual TeX error and original source line, without console instructions or the full log", () => {
  const source = "\\usepackage{tikz}\n\\begin{document}\n\\unknowncommand\n\\end{document}";
  const error = failure("private preamble\n! Undefined control sequence.\nl.4 \\unknowncommand\n? \n! Emergency stop.\nprivate transcript tail");
  assert.equal(texErrorMessage(error, source), "TeX compilation failed: Undefined control sequence. Line 3: \\unknowncommand");
  assert.equal(texErrorMessage(failure("! Undefined control sequence.\r\nl.4 \\unknowncommand"), source.replaceAll("\n", "\r\n")), texErrorMessage(error, source));
});

test("keeps wrapped package diagnostics but omits engine help and unrelated transcript text", () => {
  const error = failure("! Package pgfkeys Error: I do not know the key '/tikz/unknown',\n to which you passed 'abc', and I am going to ignore it.\n\nSee the pgfkeys package documentation for explanation.\nType H <return> for immediate help.\n ...\nl.2 \\begin{tikzpicture}[unknown=abc]\n! Emergency stop.");
  const message = texErrorMessage(error, String.raw`\begin{tikzpicture}[unknown=abc]`);
  assert.match(message, /I do not know the key '\/tikz\/unknown', to which you passed 'abc'/);
  assert.match(message, /Line 1:/);
  assert.doesNotMatch(message, /See the|Type H|Emergency stop/);
});

test("missing logs and loader errors retain an honest bounded message; invalid line numbers invent no source context", () => {
  assert.equal(texErrorMessage(new Error("Failed to fetch local asset: 404"), ""), "Failed to fetch local asset: 404");
  assert.equal(texErrorMessage(failure(""), ""), "TeX compilation failed.");
  assert.equal(texErrorMessage(null, ""), "TeX rendering failed.");
  assert.equal(texErrorMessage(failure("! Package example Error: invalid option.\nl.2 \\packageInternalCommand"), "original source line"), "TeX compilation failed: Package example Error: invalid option.");
  for (const location of ["0", "1", "9999999"]) {
    assert.equal(texErrorMessage(failure(`! Undefined control sequence.\nl.${location} token`), "source"), "TeX compilation failed: Undefined control sequence.");
  }
});

test("diagnostics are bounded in UTF-8, remove control characters, and leave markup inert for the host's text boundary", () => {
  for (const text of ["x".repeat(5000), "🙂".repeat(2000), "é".repeat(2000)]) {
    const bounded = boundTexError(text);
    assert.ok(new TextEncoder().encode(bounded).length <= TEX_ERROR_BYTES);
    assert.ok(bounded.endsWith("…"));
    assert.doesNotMatch(bounded, /�/);
  }
  assert.equal(boundTexError("\u0000\u001b<script>alert(1)</script>\ntext"), "<script>alert(1)</script>\ntext");
  const message = texErrorMessage(failure("! " + "🙂".repeat(2000)), "");
  assert.ok(new TextEncoder().encode(message).length <= TEX_ERROR_BYTES);
});
