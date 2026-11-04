import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authEnvRecord } from "../src/core/auth-env.ts";
import { codexDictationAuth } from "../src/server/codex-dictation.ts";

test("Codex receives neither LearnHarness credentials nor its desktop capability", { skip: process.platform === "win32" }, async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "lh-codex-env-"));
	const executable = path.join(directory, "codex");
	const capture = path.join(directory, "capture.json");
	const previous = { ...process.env };
	const fillGap = authEnvRecord().fillGap;
	try {
		writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
fs.writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({capability: !!process.env.LH_DESKTOP_API_SECRET, key: !!process.env.TEST_LH_REFLECTED_KEY, electron: !!process.env.ELECTRON_RUN_AS_NODE}));
readline.createInterface({input: process.stdin}).on('line', line => {
 const msg = JSON.parse(line);
 if (msg.id) process.stdout.write(JSON.stringify({id: msg.id, result: msg.method === 'getAuthStatus' ? {authMethod: 'apikey'} : {}}) + '\\n');
});
`);
		chmodSync(executable, 0o700);
		process.env.PATH = `${directory}${path.delimiter}${previous.PATH ?? ""}`;
		process.env.CODEX_TEST_CAPTURE = capture;
		process.env.LH_DESKTOP_API_SECRET = "private-capability";
		process.env.TEST_LH_REFLECTED_KEY = "private-key";
		process.env.ELECTRON_RUN_AS_NODE = "1";
		fillGap.add("TEST_LH_REFLECTED_KEY");
		await assert.rejects(codexDictationAuth(new AbortController().signal), /Sign in to Codex/);
		assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { capability: false, key: false, electron: false });
	} finally {
		fillGap.delete("TEST_LH_REFLECTED_KEY");
		for (const key of ["PATH", "CODEX_TEST_CAPTURE", "LH_DESKTOP_API_SECRET", "TEST_LH_REFLECTED_KEY", "ELECTRON_RUN_AS_NODE"]) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
