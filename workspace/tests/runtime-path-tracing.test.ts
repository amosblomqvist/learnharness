/** Source guard for the experimentally verified Turbopack privacy boundary.
 * Path producers can trace data even without reads, and a later join can
 * reintroduce assets despite an upstream opt-out. Actual deployment behavior
 * is checked by the production payload guard and source-free smoke.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function paths(relative: string) {
	const text = fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
	const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.expression.getText(file) === "path"
			&& ["join", "resolve"].includes(node.expression.name.text)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const ignored = (call: ts.CallExpression) => /\/\*\s*turbopackIgnore:\s*true\s*\*\//.test(
		text.slice(call.expression.end, call.arguments[0]!.getStart(file)),
	);
	return { file, calls, ignored };
}

test("config opts out each mutable path producer, retaining the shipped prompt asset", () => {
	const { file, calls, ignored } = paths("config.ts");
	const prompt = calls.filter(call => ts.isPropertyAssignment(call.parent) && call.parent.name.getText(file) === "teacherPrompt");
	assert.equal(prompt.length, 1);
	assert.equal(ignored(prompt[0]!), false, "the built-in teacher prompt must remain traceable");
	const mutable = calls.filter(call => !prompt.includes(call));
	assert.ok(mutable.length > 0);
	for (const call of mutable) assert.ok(ignored(call), `Runtime path must not ship: ${call.getText(file)}`);
});

test("selected/imported custom theme filenames never become deployment assets", () => {
	const { file, calls, ignored } = paths("src/store/themes.ts");
	assert.equal(calls.length, 1);
	assert.ok(ignored(calls[0]!), `Runtime theme path must not ship: ${calls[0]!.getText(file)}`);
});

test("plugin runtime and background capture paths never become deployment assets", () => {
	for (const relative of ["src/server/plugins.ts", "src/agent/background-capture.ts"]) {
		const { file, calls, ignored } = paths(relative);
		const runtime = calls;
		assert.equal(runtime.length, relative === "src/server/plugins.ts" ? 5 : 2);
		for (const call of runtime) assert.ok(ignored(call), `Runtime path must not ship: ${call.getText(file)}`);
	}
});

test("independent plugin-data and provider-debug filename producers retain their opt-outs", () => {
	for (const [relative, matches, count] of [
		["src/store/plugin-data-paths.ts", (_call: ts.CallExpression) => true, 3],
		["src/store/plugin-task-records.ts", (call: ts.CallExpression) => call.arguments.length === 2 && ts.isStringLiteral(call.arguments[1]!) && call.arguments[1]!.text === "tasks", 2],
		["src/server/plugin-inference.ts", (call: ts.CallExpression) => call.arguments.length === 2 && ts.isStringLiteral(call.arguments[1]!) && call.arguments[1]!.text === "usage.jsonl", 1],
		["src/agent/provider-events.ts", (call: ts.CallExpression, file: ts.SourceFile) => call.arguments[0]?.getText(file) === "providerEventsDir.current", 1],
	] as const) {
		const { file, calls, ignored } = paths(relative);
		const matched = calls.filter(call => matches(call, file));
		assert.equal(matched.length, count, `${relative}: expected independently traced runtime producers`);
		for (const call of matched) assert.ok(ignored(call), `${relative}: runtime data must not be traced`);
	}
});
