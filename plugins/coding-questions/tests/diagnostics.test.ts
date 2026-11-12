import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { syntaxTreeAvailable } from "@codemirror/language";
import { findLanguage } from "../src/editor.ts";
import { supportsSyntaxDiagnostics, syntaxDiagnostics } from "../src/diagnostics.ts";

const examples = [
  ["Python", "def example():\n    return 1\n", "def example(:\n    return 1\n"],
  ["JavaScript", "const value = 1;", "const value = ;"],
  ["TypeScript", "const value: number = 1;", "const value: = 1;"],
  ["C", "int main() { return 0; }", "int main( { return 0; }"],
  ["C++", "template<class T> T square(T x) { return x * x; }", "int main( { return 0; }"],
  ["Java", "class Example { int value = 1; }", "class Example { int value = ; }"],
  ["Rust", "fn main() {}", "fn main( {}"],
  ["Go", "package main\nfunc main() {}", "package main\nfunc main( {}"],
  ["JSON", '{"value":1}', '{"value":}'],
] as const;

for (const [name, valid, invalid] of examples) {
  test(`${name}: syntax feedback finds malformed code, clears on correction, and never edits code`, async () => {
    const description = findLanguage(name)!;
    assert.equal(supportsSyntaxDiagnostics(description.name), true);
    const support = await description.load();
    const state = EditorState.create({ doc: invalid, extensions: [support.language] });
    const diagnostics = syntaxDiagnostics(state);
    assert.ok(diagnostics.length > 0);
    assert.equal(state.doc.toString(), invalid);
    const positions = new Set<string>();
    for (const diagnostic of diagnostics) {
      assert.ok(diagnostic.from >= 0 && diagnostic.from <= diagnostic.to && diagnostic.to <= invalid.length);
      assert.equal(diagnostic.severity, "error");
      assert.equal(diagnostic.message, "Syntax problem.");
      assert.equal("actions" in diagnostic, false);
      positions.add(`${diagnostic.from}:${diagnostic.to}`);
    }
    assert.equal(positions.size, diagnostics.length, "Do not repeat identical recovery positions");
    const corrected = state.update({ changes: { from: 0, to: state.doc.length, insert: valid } }).state;
    assert.deepEqual(syntaxDiagnostics(corrected), []);
    assert.equal(corrected.doc.toString(), valid);
    assert.deepEqual(syntaxDiagnostics(state), diagnostics, "Results belong to their immutable document snapshot");
  });
}

test("catalog aliases inherit the canonical language policy, without enabling unverified languages", () => {
  for (const alias of ["python", "js", "ts", "cpp", "go", " JAVA ", "json"]) {
    const description = findLanguage(alias);
    assert.ok(description, alias);
    assert.equal(supportsSyntaxDiagnostics(description.name), true, alias);
  }
  for (const name of ["SQL", "Ruby", "Shell", "HTML", "XML", "JSX", "TSX", "YAML", "CSS", "Markdown"]) {
    assert.equal(supportsSyntaxDiagnostics(findLanguage(name)!.name), false, name);
  }
  assert.equal(supportsSyntaxDiagnostics("unbundled-language"), false);
});

test("no parser and parser-valid semantic mistakes produce no invented diagnostics", async () => {
  assert.deepEqual(syntaxDiagnostics(EditorState.create({ doc: "not code" })), []);
  for (const [name, doc] of [["JavaScript", "missingFunction();"], ["TypeScript", 'const value: number = "not a number";']] as const) {
    const support = await findLanguage(name)!.load();
    assert.deepEqual(syntaxDiagnostics(EditorState.create({ doc, extensions: [support.language] })), []);
  }
});

test("large partial parses retain early errors without inventing unfinished-boundary errors", async () => {
  const support = await findLanguage("JavaScript")!.load();
  const filler = "let value = 1;\n".repeat(16000);
  const invalid = EditorState.create({ doc: `const broken = ;\n${filler}`, extensions: [support.language] });
  assert.equal(syntaxTreeAvailable(invalid), false, "Fixture exceeds the initial parse budget");
  assert.ok(syntaxDiagnostics(invalid).some(diagnostic => diagnostic.from === 15));
  const valid = EditorState.create({ doc: `function example() {\n${filler}}\n`, extensions: [support.language] });
  assert.equal(syntaxTreeAvailable(valid), false);
  assert.deepEqual(syntaxDiagnostics(valid), [], "An incomplete tree is not an incomplete learner program");
});

test("EOF/zero-width and Unicode error positions remain valid CodeMirror document offsets", async () => {
  const support = await findLanguage("JSON")!.load();
  for (const doc of ['{"emoji":"🧪","value":}', '{"emoji":"🧪"']) {
    const diagnostics = syntaxDiagnostics(EditorState.create({ doc, extensions: [support.language] }));
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.every(({ from, to }) => from >= 0 && from <= to && to <= doc.length));
  }
});
