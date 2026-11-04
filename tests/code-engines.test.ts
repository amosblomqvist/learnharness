import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { canonicalLanguage, classifyRun, engineKindFor, formatReport, modeNeedsExecution, modeRequirements, predictionMatches, resolveEngine, runnerLanguageFor, RUNNER_LANGUAGES } from "../src/core/code-playground.ts";

test("aliases resolve to canonical ids", () => {
	const cases: Array<[string, string]> = [
		["JS", "javascript"], ["ts", "typescript"], ["Python3", "python"],
		["c++", "cpp"], ["C#", "csharp"], ["golang", "go"], ["psql", "sql"], ["shell", "bash"],
	];
	for (const [input, expected] of cases) assert.equal(canonicalLanguage(input), expected, input);
});

test("browser engines are always runnable; unknown languages never claim to run", () => {
	assert.equal(resolveEngine("javascript").kind, "native");
	// python/sql have no client runtime yet: they must resolve to the sandbox
	// (never to "runnable" with nothing to run them).
	assert.equal(resolveEngine("python", false).kind, "none");
	assert.equal(resolveEngine("python", true).kind, "runner");
	assert.equal(resolveEngine("sql", true).kind, "runner");
	const braincraft = resolveEngine("braincraft");
	assert.equal(braincraft.kind, "none");
	assert.equal(braincraft.runnable, false);
	assert.match(braincraft.reason ?? "", /No engine/);
});

test("a runner language without a runner degrades to none with a reason", () => {
	const c = resolveEngine("c", false);
	assert.equal(c.kind, "none");
	assert.equal(c.runnable, false);
	assert.match(c.reason ?? "", /sandbox runner/);
	const live = resolveEngine("c", true, "gcc 13.3.0");
	assert.equal(live.kind, "runner");
	assert.equal(live.runnerLanguage, "c");
});

test("every runner language the app can name exists in the runner manifest", () => {
	const manifest = JSON.parse(readFileSync(new URL("../runner/languages.json", import.meta.url), "utf8"));
	for (const runnerId of Object.values(RUNNER_LANGUAGES)) {
		assert.ok(manifest.languages[runnerId], `missing manifest entry: ${runnerId}`);
	}
});

test("the report the teacher receives carries code, failure and attempts", () => {
	const text = formatReport({
		language: "c", engine: "runner", code: "int main(){return 0}", attempts: 3,
		sentAt: "2026-10-27T00:00:00Z",
		runs: [{ ok: false, errorKind: "syntax", compileError: "main.c:1: error: expected ';'" }],
	});
	assert.match(text, /after 3 attempt\(s\)/);
	assert.match(text, /int main\(\)\{return 0\}/);
	assert.match(text, /does not compile/);
	assert.match(text, /Failure kind: syntax/);
});

test("classifyRun maps every engine's signals onto one vocabulary", () => {
	assert.equal(classifyRun({ ran: false }), "not-run");
	assert.equal(classifyRun({ compileOk: false, exit: null }), "syntax");
	assert.equal(classifyRun({ timedOut: true, exit: 124 }), "timeout");
	assert.equal(classifyRun({ errName: "SyntaxError" }), "syntax");
	assert.equal(classifyRun({ errName: "TypeError", exit: 1 }), "runtime");
	assert.equal(classifyRun({ exit: 0, checks: [{ pass: false }] }), "checks");
	assert.equal(classifyRun({ exit: 0, checks: [{ pass: true }] }), "none");
	assert.equal(classifyRun({ exit: 0 }), "none");
});

test("prediction matching tolerates formatting but not wrong answers", () => {
	assert.equal(predictionMatches("470", "470"), true);
	assert.equal(predictionMatches("470", "470.0"), true, "numeric equality");
	assert.equal(predictionMatches("  hello   world ", "hello world"), true);
	assert.equal(predictionMatches("'d'", "d"), true, "quotes stripped");
	assert.equal(predictionMatches("470", "0"), false);
	assert.equal(predictionMatches("", "470"), false, "no guess is not a match");
});

test("the report tells the teacher what was predicted", () => {
	const text = formatReport({
		language: "python", engine: "runner", code: "print(1)", attempts: 2, sentAt: "x",
		runs: [{ ok: true, errorKind: "none", stdout: "2", prediction: "1", predictionMatch: false }],
	});
	assert.match(text, /I predicted: "1"/);
	assert.match(text, /did not match/);
});

test("each mode declares what the card must contain", () => {
	assert.deepEqual(modeRequirements("implement"), { needsStarter: true, needsPair: false, needsErrorText: false, editable: true });
	assert.deepEqual(modeRequirements("bug-hunt"), { needsStarter: true, needsPair: false, needsErrorText: false, editable: true });
	assert.deepEqual(modeRequirements("error-read"), { needsStarter: true, needsPair: false, needsErrorText: true, editable: false });
	assert.deepEqual(modeRequirements("syntax"), { needsStarter: true, needsPair: true, needsErrorText: false, editable: false });
});

test("every spelling a teacher might use reaches the same runner entry", () => {
	const cases: Array<[string, string]> = [
		["C++", "cpp"], ["c++", "cpp"], ["cpp", "cpp"], ["cxx", "cpp"],
		["C#", "csharp"], ["csharp", "csharp"], ["cs", "csharp"],
		["Python3", "python"], ["py", "python"], ["Golang", "go"],
		["shell", "bash"], ["F90", "fortran"],
	];
	for (const [input, expected] of cases) assert.equal(runnerLanguageFor(input), expected, input);
	assert.equal(runnerLanguageFor("javascript"), null, "native engines are not runner languages");
	assert.equal(runnerLanguageFor("spanish"), null, "non-languages never resolve");
});

test("a card that must run is only authored for languages with an engine", () => {
	assert.equal(engineKindFor("javascript"), "native");
	assert.equal(engineKindFor("C++"), "runner");
	assert.equal(engineKindFor("Python3"), "runner");
	assert.equal(engineKindFor("zig"), null, "no zig runtime installed");
	assert.equal(engineKindFor("spanish"), null);

	// read-only drills need no runtime, so they stay available everywhere
	assert.equal(modeNeedsExecution("implement"), true);
	assert.equal(modeNeedsExecution("bug-hunt"), true);
	assert.equal(modeNeedsExecution("error-read"), false);
	assert.equal(modeNeedsExecution("syntax"), false);
});
