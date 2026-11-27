"use strict";

const net = require("node:net");

/** Stable default localhost port for the packaged desktop server so the
 *  Chromium origin (and renderer localStorage) persists across launches. */
const DEFAULT_DESKTOP_PORT = 43127;
const FALLBACK_CODES = new Set(["EADDRINUSE", "EACCES"]);
const PROBE_CONNECT_TIMEOUT_MS = 200;

/** Parse an optional LH_PORT override (integer 1..65535), falling back to
 *  DEFAULT_DESKTOP_PORT when unset or invalid. */
function parsePreferredPort(env = process.env) {
	const raw = typeof env?.LH_PORT === "string" ? env.LH_PORT.trim() : "";
	if (!/^\d+$/.test(raw)) return DEFAULT_DESKTOP_PORT;
	const port = Number(raw);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_DESKTOP_PORT;
}

/** Bind and immediately release a loopback TCP socket to confirm availability. */
function probePort(port, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		let settled = false;
		const srv = net.createServer();
		const fail = (err) => {
			if (settled) return;
			settled = true;
			try { srv.close(); } catch { /* not listening */ }
			reject(err);
		};
		srv.on("error", fail);
		srv.listen(port, host, () => {
			const addr = srv.address();
			const bound = typeof addr === "object" && addr ? addr.port : port;
			srv.close((err) => {
				if (settled) return;
				settled = true;
				if (err) reject(err);
				else resolve(bound);
			});
		});
	});
}

/** On Windows, Winsock allows binding 127.0.0.1:<port> even when another
 *  process already listens on 0.0.0.0:<port>. A short loopback connect check
 *  detects any active listener so we never attach to a foreign server. */
function hasActiveListener(port, host = "127.0.0.1", timeoutMs = PROBE_CONNECT_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const sock = net.connect({ host, port });
		const done = (active) => {
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve(active);
		};
		sock.setTimeout(timeoutMs, () => done(true));
		sock.once("connect", () => done(true));
		sock.once("error", (err) => done(err?.code !== "ECONNREFUSED" && err?.code !== "EHOSTUNREACH" && err?.code !== "ENETUNREACH"));
	});
}

/** Prefer the stable desktop port on 127.0.0.1; fall back to an ephemeral
 *  port if it is already occupied or restricted so launch never fails. */
async function pickDesktopPort({ preferredPort, env = process.env, host = "127.0.0.1" } = {}) {
	const target = preferredPort === undefined ? parsePreferredPort(env) : preferredPort;
	if (Number.isInteger(target) && target >= 1 && target <= 65535) {
		try {
			const bound = await probePort(target, host);
			if (!(await hasActiveListener(bound, host))) return bound;
		} catch (err) {
			if (!FALLBACK_CODES.has(err?.code)) throw err;
		}
	}
	return probePort(0, host);
}

module.exports = { DEFAULT_DESKTOP_PORT, parsePreferredPort, pickDesktopPort };
