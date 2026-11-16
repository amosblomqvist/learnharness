import test from "node:test";
import assert from "node:assert/strict";
import { prepareTexSource } from "../src/tex-source.ts";

const body = String.raw`\begin{document}\begin{tikzpicture}\node {$F_{\text{applied}}$};\end{tikzpicture}\end{document}`;
const amsmath = String.raw`\usepackage{amsmath}`;

test("compilation supplies amsmath after authored packages, preserving original source and package options", () => {
  for (const preamble of ["", String.raw`\usepackage{tikz}`, String.raw`\usepackage[fleqn]{amsmath}`, String.raw`\usepackage{tikz,amsmath}`, String.raw`\usepackage{mathtools}`]) {
    const source = preamble + "\n" + body;
    assert.equal(prepareTexSource(source), preamble + "\n" + amsmath + body);
    assert.equal(source, preamble + "\n" + body);
  }
});

test("redundant standalone/article class and legacy style declarations are blanked only in the compilation preamble", () => {
  for (const declaration of [String.raw`\documentclass{standalone}`, String.raw`\documentclass[12pt]{article}`, String.raw`\documentclass{article}[2020/01/01]`, String.raw`\documentstyle[tikz]{article}`,
    "\\documentclass % wrapper\n [key={]}] % options\r\n {standalone}"]) {
    const source = declaration + "\n" + body;
    assert.equal(prepareTexSource(source), declaration.replace(/[^\r\n]/g, " ") + "\n" + amsmath + body);
    assert.equal(prepareTexSource(source).split(/\r\n|[\r\n]/).length, source.split(/\r\n|[\r\n]/).length);
  }
  const source = String.raw`\documentclass{standalone}\documentstyle{article}` + body;
  assert.equal(prepareTexSource(source), " ".repeat(source.length - body.length) + amsmath + body);
});

test("comments, escaped commands, grouped macro bodies and the actual document body are not rewritten", () => {
  const preamble = String.raw`% \documentclass{article} \begin{document}
\newcommand{\sample}{\documentclass{book}\begin{document}}
\newcommand{\example}[1][\documentclass{book}\begin{document}]{#1}
\renewcommand*\documentclass[1]{#1}
\\documentclass{report}
\usepackage{tikz} % \documentstyle{article}
`;
  const document = String.raw`\begin{document}\verb|\documentclass{article}|\end{document}`;
  assert.equal(prepareTexSource(preamble + document), preamble + amsmath + document);
  const commented = "% no document\n% \\begin{document}\n";
  assert.equal(prepareTexSource(commented), commented);
  const escapedPercent = String.raw`\%` + body;
  assert.equal(prepareTexSource(escapedPercent), String.raw`\%` + amsmath + body);
});

test("malformed declarations and token-changing primitives are left for honest TeX diagnostics", () => {
  for (const source of [String.raw`\documentclass[12pt{article}` + body, String.raw`\documentclass{article` + body,
    String.raw`\catcode` + body, String.raw`\def\wrapper{\documentclass{article}}` + body,
    String.raw`\let\wrapper\documentclass{article}` + body, String.raw`\string\documentclass{article}` + body,
    String.raw`\begin{verbatim}\documentclass{article}` + body, "{" + body]) {
    assert.equal(prepareTexSource(source), source);
  }
});
