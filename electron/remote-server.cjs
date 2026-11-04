"use strict";
/**
 * Remote server choice (self-hosting): the desktop app either spawns its
 * bundled server ("local", the default) or opens a self-hosted LearnHarness
 * server ("remote", docs/self-hosting.md). The choice lives in
 * userData/server.json; switching relaunches the app. In remote mode the
 * shell spawns nothing and never sends the desktop API capability — the
 * remote server authenticates with its own sign-in cookie.
 */
const fs = require("node:fs");
const { version } = require("../package.json");

/** Appended to every request's User-Agent so a server in apps-only mode
 *  (LH_APPS_ONLY, src/server/remote-access.ts) lets this app in. */
const APP_USER_AGENT_TOKEN = `LearnHarnessDesktop/${version}`;

/** Typed address → server origin, or a user-facing error. A bare host gets
 *  http:// when it names a port (LAN / Tailscale), https:// otherwise. */
function normalizeServerUrl(input) {
	const text = String(input ?? "").trim();
	if (!text) return { error: "Enter your server's address." };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${/:\d+(\/|$)/.test(text) ? "http" : "https"}://${text}`;
	let parsed;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { error: "That doesn't look like a web address." };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "Use an http:// or https:// address." };
	if (parsed.username || parsed.password) return { error: "Leave the username and password out of the address." };
	return { url: parsed.origin };
}

// Home-network and Tailscale names that never resolve on the public internet.
const PRIVATE_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa", ".ts.net"];

/** Plain HTTP is fine on loopback, private LAN ranges and Tailscale; anywhere
 *  else the password and session cookie would cross the internet unencrypted. */
function insecureRemote(url) {
	const { protocol, hostname } = new URL(url);
	if (protocol === "https:") return false;
	if (hostname === "localhost" || hostname === "[::1]" || !hostname.includes(".")) return false;
	if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = octets;
	return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

function readServerChoice(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw?.mode === "remote") {
			const { url } = normalizeServerUrl(raw.url);
			if (url) return { mode: "remote", url };
		}
	} catch { /* absent or unreadable: local */ }
	return { mode: "local" };
}

function writeServerChoice(file, choice) {
	const record = choice.mode === "remote" ? { mode: "remote", url: choice.url } : { mode: "local" };
	fs.writeFileSync(file, JSON.stringify(record, null, "\t") + "\n", { mode: 0o600 });
}

/** Checks the address answers with a LearnHarness server-mode sign-in page. */
async function probeServer(url, fetchImpl = fetch, timeoutMs = 8000) {
	let response;
	try {
		response = await fetchImpl(`${url}/login`, {
			redirect: "manual",
			headers: { "User-Agent": `LearnHarness ${APP_USER_AGENT_TOKEN}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const reason = err?.name === "TimeoutError" ? "it didn't answer in time" : "nothing answered";
		return { ok: false, error: `Couldn't reach ${url} (${reason}). Check the address and that the server is running.` };
	}
	const body = response.status === 200 ? await response.text().catch(() => "") : "";
	if (body.includes('action="/api/auth/login"')) return { ok: true };
	return { ok: false, error: `${url} answered, but it isn't a LearnHarness server with server mode (the self-hosting branch).` };
}

module.exports = { APP_USER_AGENT_TOKEN, normalizeServerUrl, insecureRemote, readServerChoice, writeServerChoice, probeServer };
