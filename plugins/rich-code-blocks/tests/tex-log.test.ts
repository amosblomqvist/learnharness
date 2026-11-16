import test from "node:test";
import assert from "node:assert/strict";
import { withTexLog } from "../src/tex-log.ts";

// What isomorphic-tikzjax 0.1.1 throws whenever TeX runs but writes no DVI.
const ENGINE_FAILURE = "TeX engine render failed. Set `options.showConsole` to `true` to see logs.";
// Console output recorded from that engine with showConsole enabled, one entry
// per console.log call: its echo of the input, then TeX's log line by line.
const DOCUMENTCLASS_LOG = [
  "TikZJax: Rendering input:",
  "\n\\documentclass[tikz]{standalone}\n\\begin{document}\n\\begin{tikzpicture}\\node {A};\\end{tikzpicture}\n\\end{document}",
  "This is e-TeX, Version 3.14159265-2.6 (preloaded format=latex 2022.5.1)",
  "**entering extended mode",
  "(input.tex",
  "LaTeX2e <2020-02-02> patch level 2",
  "! LaTeX Error: Two \\documentclass or \\documentstyle commands.",
  "See the LaTeX manual or LaTeX Companion for explanation.",
  "Type  H <return>  for immediate help.",
  " ...                                      ",
  "                                          ",
  "l.2 \\documentclass[tikz]{",
  "                         standalone}",
  "? Type <return> to proceed, S to scroll future error messages,",
  "R to run without stopping, Q to run quietly,",
  "I to insert something, E to edit your file,",
  "1 or ... or 9 to ignore the next 1 to 9 tokens of input,",
  "H for help, X to quit.",
  "? ",
  "! Emergency stop.",
  " ...                                      ",
  "                                          ",
  "l.2 \\documentclass[tikz]{",
  "                         standalone}",
];
// Same recording for \pgfplotsset{compat=1.18}; most of the package file list
// is left out. TeX breaks its output at 79 columns, mid-word.
const PGFPLOTS_COMPAT_LOG = [
  "TikZJax: Rendering input:",
  "\n\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\begin{document}\n\\begin{tikzpicture}\\begin{axis}\\addplot{x^2};\\end{axis}\\end{tikzpicture}\n\\end{document}",
  "This is e-TeX, Version 3.14159265-2.6 (preloaded format=latex 2022.5.1)",
  "**entering extended mode",
  "(input.tex",
  "LaTeX2e <2020-02-02> patch level 2",
  "(\"pgfplots.sty\" (pgfplots.revision.tex) (pgfplots.code.tex",
  "(pgfplotscore.code.tex (pgfplotssysgeneric.code.tex)) (pgfplotslibrary.code.tex",
  "(pgflibraryplotmarks.code.tex)))",
  "! Package pgfplots Error: Sorry, 'compat=1.18' is unknown in this context. Plea",
  "se use at most 'compat=1.16'.",
  "See the pgfplots package documentation for explanation.",
  "Type  H <return>  for immediate help.",
  " ...                                      ",
  "                                          ",
  "l.3 \\pgfplotsset{compat=1.18}",
  "                             ",
  "? Type <return> to proceed, S to scroll future error messages,",
  "R to run without stopping, Q to run quietly,",
  "I to insert something, E to edit your file,",
  "1 or ... or 9 to ignore the next 1 to 9 tokens of input,",
  "H for help, X to quit.",
  "? ",
  "! Emergency stop.",
  " ...                                      ",
  "                                          ",
  "l.3 \\pgfplotsset{compat=1.18}",
  "                             ",
];

/** Stands in for the engine: prints a recorded log the way it does, then fails. */
const engine = (log: readonly string[], failure: unknown = new Error(ENGINE_FAILURE)) => async (): Promise<never> => {
  for (const line of log) console.log(line);
  throw failure;
};

test("a failed compile names TeX's first error instead of the engine's showConsole hint", async () => {
  await assert.rejects(withTexLog(engine(DOCUMENTCLASS_LOG)), { message: "TeX engine render failed: LaTeX Error: Two \\documentclass or \\documentstyle commands." });
});

test("an error that TeX broke at its 79-column line width is rejoined", async () => {
  await assert.rejects(withTexLog(engine(PGFPLOTS_COMPAT_LOG)), { message: "TeX engine render failed: Package pgfplots Error: Sorry, 'compat=1.18' is unknown in this context. Please use at most 'compat=1.16'." });
});

test("without a TeX error line the failure stays generic and drops the hint", async () => {
  await assert.rejects(withTexLog(engine(["TikZJax: Rendering input:", "\n\\begin{document}\\end{document}", "No pages of output."])), { message: "TeX engine render failed." });
});

test("a failure that is not the engine's compile failure passes through untouched", async () => {
  const missingAsset = new Error("Failed to fetch http://local/assets/tex/tex.wasm.gz: 404 Not Found");
  await assert.rejects(withTexLog(engine([], missingAsset)), error => error === missingAsset);
});

test("console.log is captured only while a compile runs", async () => {
  const outer = console.log, printed: unknown[] = [];
  const probe = (...values: unknown[]) => { printed.push(values); };
  console.log = probe;
  try {
    assert.equal(await withTexLog(async () => { console.log("This is e-TeX, Version 3.14159265-2.6"); return "dvi"; }), "dvi");
    assert.equal(console.log, probe, "restored after a successful compile");
    await assert.rejects(withTexLog(engine(DOCUMENTCLASS_LOG)));
    assert.equal(console.log, probe, "restored after a failed compile");
    assert.deepEqual(printed, [], "TeX's log never reaches the real console");
  } finally { console.log = outer; }
});

test("a runaway error message is cut at 300 characters", async () => {
  const runaway = ["! " + "x".repeat(77), ...Array.from({ length: 50 }, () => "y".repeat(79))];
  const text = "x".repeat(77) + "y".repeat(79 * 50);
  await assert.rejects(withTexLog(engine(runaway)), { message: `TeX engine render failed: ${text.slice(0, 300)}…` });
});

test("console output that is not a line of text is ignored", async () => {
  const compile = async (): Promise<never> => { console.log({ not: "a log line" }); console.log("! Undefined control sequence."); throw new Error(ENGINE_FAILURE); };
  await assert.rejects(withTexLog(compile), { message: "TeX engine render failed: Undefined control sequence." });
});
