import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
	discoverLoginShellPath,
	hydrateProcessPath,
	mergePathValues,
} = require("../electron/shell-environment.cjs") as {
	discoverLoginShellPath: (options: Record<string, unknown>) => Promise<string | null>;
	hydrateProcessPath: (options: Record<string, unknown>) => Promise<boolean>;
	mergePathValues: (primary: string, secondary: string, delimiter?: string) => string;
};

const START = "__LEARNHARNESS_PATH_START__";
const END = "__LEARNHARNESS_PATH_END__";

function markedPath(value: string): string {
	return `shell noise\n${START}\n${value}\n${END}\n`;
}

test("discovers PATH from the first successful login shell", async () => {
	const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
	const path = await discoverLoginShellPath({
		platform: "darwin",
		env: { SHELL: "/bin/zsh", PATH: "/usr/bin", ANTHROPIC_API_KEY: "private", HOMEBREW_PREFIX: "/opt/homebrew" },
		shellCandidates: ["/bin/zsh", "/bin/bash"],
		run: async (command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
			calls.push({ command, args, env: options.env });
			return command === "/bin/zsh" ? markedPath("/Users/test/.local/bin:/usr/bin") : null;
		},
	});
	assert.equal(path, "/Users/test/.local/bin:/usr/bin");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.command, "/bin/zsh");
	assert.equal(calls[0]!.args[0], "-ilc");
	assert.match(calls[0]!.args[1]!, /PATH_START|LEARNHARNESS_PATH_START/);
	assert.equal(calls[0]!.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(calls[0]!.env.HOMEBREW_PREFIX, "/opt/homebrew");
});

test("falls back to launchctl when login shells provide no PATH", async () => {
	const calls: string[] = [];
	const path = await discoverLoginShellPath({
		platform: "darwin",
		env: { SHELL: "/bin/zsh" },
		shellCandidates: ["/bin/zsh"],
		run: async (command: string) => {
			calls.push(command);
			return command === "/bin/launchctl" ? "/Users/test/.local/bin:/usr/bin\n" : null;
		},
	});
	assert.equal(path, "/Users/test/.local/bin:/usr/bin");
	assert.deepEqual(calls, ["/bin/zsh", "/bin/launchctl"]);
});

test("merges discovered PATH before inherited entries without duplicates", async () => {
	const env = { PATH: "/usr/bin:/bin" };
	assert.equal(await hydrateProcessPath({
		platform: "darwin",
		env,
		shellCandidates: ["/bin/zsh"],
		run: async () => markedPath("/Users/test/.local/bin:/usr/bin"),
	}), true);
	assert.equal(env.PATH, "/Users/test/.local/bin:/usr/bin:/bin");
	assert.equal(mergePathValues("/a:/b", "/b:/c"), "/a:/b:/c");
});

test("does not probe a login shell on Windows", async () => {
	let called = false;
	assert.equal(await discoverLoginShellPath({
		platform: "win32",
		shellCandidates: ["powershell.exe"],
		run: async () => { called = true; return markedPath("C:\\bin"); },
	}), null);
	assert.equal(called, false);
});
