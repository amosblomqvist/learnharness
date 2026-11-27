"use strict";

const net = require("node:net");

/** Stable default localhost port for the packaged desktop server so the
 *  Chromium origin (and renderer localStorage) persists across launches. */
const DEFAULT_DESKTOP_PORT = 43127;
const FALLBACK_CODES = new Set(["EADDRINUSE", "EACCES"]);

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
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(port, host, () => {
			srv.off("error", reject);
			const addr = srv.address();
			const bound = typeof addr === "object" && addr ? addr.port : port;
			srv.close((err) => (err ? reject(err) : resolve(bound)));
		});
	});
}

/** Prefer the stable desktop port on 127.0.0.1; fall back to an ephemeral
 *  port if it is already occupied or restricted so launch never fails. */
async function pickDesktopPort({ preferredPort, env = process.env, host = "127.0.0.1" } = {}) {
	const target = preferredPort === undefined ? parsePreferredPort(env) : preferredPort;
	if (Number.isInteger(target) && target >= 1 && target <= 65535) {
		try {
			return await probePort(target, host);
		} catch (err) {
			if (!FALLBACK_CODES.has(err?.code)) throw err;
		}
	}
	return probePort(0, host);
}

module.exports = { DEFAULT_DESKTOP_PORT, parsePreferredPort, pickDesktopPort };
