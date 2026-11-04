import assert from "node:assert/strict";
import { test } from "node:test";
import { codePlaygroundTool } from "../src/agent/tools/code-playground.ts";

const run = (input: unknown) => codePlaygroundTool().execute("call_1", input as never);

test("a runnable language is accepted without ceremony", async () => {
	const res = await run({ language: "C++", task: "print the size", starter: "int main(){}" });
	assert.equal((res.details as { problems?: string[] } | null)?.problems, undefined);
});

test("a language with no runtime is refused for implement/bug-hunt — never a dead Run button", async () => {
	for (const language of ["zig", "elixir", "ocaml"]) {
		const res = await run({ language, task: "t", starter: "x" });
		const problems = (res.details as { problems?: string[] } | null)?.problems ?? [];
		assert.equal(problems.length, 1, language);
		assert.match(problems[0]!, /No runtime for/);
		assert.match(problems[0]!, /error-read/);
	}
});

test("read-only drills are allowed for any coding language", async () => {
	for (const mode of ["error-read", "syntax"]) {
		const res = await run({ mode, language: "zig", task: "t", starter: "const x = 1;" });
		assert.equal((res.details as { problems?: string[] } | null)?.problems, undefined, mode);
	}
});

test("a non-language gets no card in any mode", async () => {
	for (const mode of ["implement", "bug-hunt", "error-read", "syntax"]) {
		const res = await run({ mode, language: "spanish", task: "t", starter: "hola" });
		const problems = (res.details as { problems?: string[] } | null)?.problems ?? [];
		assert.equal(problems.length, 1, mode);
		assert.match(problems[0]!, /not a programming language/);
	}
});
