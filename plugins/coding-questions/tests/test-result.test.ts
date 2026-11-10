import assert from "node:assert/strict";
import { test } from "node:test";
import { readTestResult, type CodingTestResult } from "../src/test-result.ts";

const passed: CodingTestResult = { status: "passed", exitCode: 0, stdout: " exact output  \n", stderr: "", stdoutTruncated: false, stderrTruncated: false };

test("reads passed, failed, and run errors without coercion or changing captured text", () => {
  for (const result of [passed, { ...passed, status: "failed" as const, exitCode: 7 }, { ...passed, status: "error" as const, exitCode: null, message: "Executable missing" }]) {
    assert.equal(readTestResult(result), result);
  }
  assert.equal(readTestResult(passed)?.stdout, " exact output  \n");
});

test("does not mistake generic JSON or malformed/contradictory saved data for a test outcome", () => {
  for (const value of [undefined, null, false, true, 0, "passed", [], {}, { ...passed, status: "correct" }, { ...passed, exitCode: 1 }, { ...passed, status: "failed", exitCode: 0 }, { ...passed, status: "failed", exitCode: null }, { ...passed, exitCode: "0" }, { ...passed, stdout: null }, { ...passed, stderrTruncated: "false" }, { ...passed, message: {} }, { ...passed, exitCode: Infinity }]) {
    assert.equal(readTestResult(value), null);
  }
});
