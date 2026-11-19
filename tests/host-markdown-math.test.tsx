import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { HostMarkdown } from "../components/host-markdown.tsx";
import { ToolContentResponse } from "../components/ai-elements/message.tsx";

// Exact learner-facing strings from the reported determinant question. Recovery
// is display-only: neither persisted source nor option/answer identities change.
const determinant = String.raw`Expand the determinant $\\det\\begin{pmatrix} 1-\\lambda & 2 \\\\ 3 & 4-\\lambda \\end{pmatrix}$ and simplify.`;
const options = [String.raw`$\lambda^2 - 5\lambda + 4$`, String.raw`$\lambda^2 + 5\lambda + 2$`,
  String.raw`$\lambda^2 - 5\lambda + 14$`, String.raw`$\lambda^2 - 5\lambda - 2$`];
function render(text: string, host = true) {
  return parseHTML(`<html><body>${renderToStaticMarkup(host ? <HostMarkdown text={text} />
    : <ToolContentResponse mode="static" controls={false} isAnimating={false} linkSafety={{ enabled: false }}>{text}</ToolContentResponse>)}</body></html>`).document;
}
const annotations = (doc: Document) => [...doc.querySelectorAll("annotation")].map(node => node.textContent);
function displayOnly(doc: Document) {
  assert.equal(doc.querySelector("button,details,summary,input,[role='button'],[data-plugin-renderer]"), null);
}
it("plugin Markdown matches native question presentation for the exact overescaped determinant and all four normally escaped options", () => {
  const source = [determinant, ...options].join("\n\n");
  const host = render(source), native = render(source, false);
  assert.equal(native.querySelectorAll(".katex").length, 5);
  assert.equal(host.querySelectorAll(".katex").length, 5);
  assert.equal(host.querySelector(".katex-error"), null);
  assert.deepEqual(annotations(host), annotations(native));
  assert.equal(annotations(host)[0], String.raw`\det\begin{pmatrix} 1-\lambda & 2 \\ 3 & 4-\lambda \end{pmatrix}`);
  displayOnly(host);
});
it("valid matrix rows, inline/display math and literal code retain the existing shared Markdown behavior", () => {
  const valid = String.raw`Compute the determinant $\det\begin{pmatrix} 3 & 1 \\ 2 & 4 \end{pmatrix}$.

$x^2$ and \(y^2\).

$$
\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}
$$`;
  const literal = String.raw`$\\det\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$`;
  const host = render(valid + "\n\n`" + literal + "`\n\n```text\n" + literal + "\n```"), native = render(valid, false);
  assert.equal(host.querySelectorAll(".katex").length, 4); assert.equal(host.querySelector(".katex-error"), null);
  assert.deepEqual(annotations(host), annotations(native));
  assert.equal(host.querySelector("[data-streamdown='inline-code']")?.textContent, literal);
  assert.ok(host.querySelector("[data-streamdown='code-block-body']")?.textContent?.includes(literal));
  displayOnly(host);
});
