/** Where the Cursor CLI lives, and whether this machine is signed in.
 * Tests never spawn it: NODE_ENV=test reads LH_CURSOR_CONNECTED instead. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	join(homedir(), ".local", "bin", "agent"),
	"/usr/local/bin/agent",
	"/usr/bin/agent",
];

/** CURSOR_AGENT_BIN, else a well-known install path, else `agent` on PATH.
 * The packaged app's PATH often misses ~/.local/bin. */
export function cursorAgentBin(): string {
	const override = process.env.CURSOR_AGENT_BIN?.trim();
	if (override) return override;
	for (const path of CANDIDATES) {
		if (existsSync(path)) return path;
	}
	return "agent";
}

let cached: boolean | null = null;

/** `agent status` prints "Logged in as …" when the subscription is usable,
 * and "Not logged in" when it is not. The negative line contains the
 * positive words, so a bare search would treat signed-out as signed-in.
 * The result is cached for the process; sign in, then restart LearnHarness. */
export function cursorStatusLooksLoggedIn(text: string): boolean {
	if (/not logged in/i.test(text)) return false;
	return /logged in as /i.test(text) || /login successful/i.test(text) || /logged in \(user details not available\)/i.test(text);
}

export function cursorConnected(): boolean {
	if (process.env.NODE_ENV === "test") return process.env.LH_CURSOR_CONNECTED === "1";
	if (cached !== null) return cached;
	try {
		const out = execFileSync(cursorAgentBin(), ["status"], {
			timeout: 8_000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		cached = cursorStatusLooksLoggedIn(out);
	} catch {
		cached = false;
	}
	return cached;
}
