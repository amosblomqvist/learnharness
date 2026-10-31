"use strict";

/**
 * Linux server mode: the packaged standalone server in browser-only mode,
 * listening on a chosen host and port, with no Electron window, loopback
 * bind, or desktop API secret. The Linux launcher installed by
 * scripts/after-pack.cjs runs, for `learnharness --headless ...`:
 *
 *   ELECTRON_RUN_AS_NODE=1 learnharness.bin resources/server-mode.cjs --headless ...
 *
 * Browser-only mode has no login: a non-loopback --host exposes chats,
 * settings, and API keys to anyone who can reach the port.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USAGE = "usage: learnharness --headless [--host <address>] [--port <1-65535>] [--pid-file <path>]";
const DEFAULTS = { host: "127.0.0.1", port: 3000 };
/** The AppImage's FUSE helper keeps the original command line, so matching
 *  this title (`pkill -f "learnharness --headless"`) never hits the helper. */
const TITLE = "learnharness --headless";

/** --flag value and --flag=value. AppRun adds --no-sandbox on hosts
 *  without user namespaces, so it is accepted and ignored. */
function parseArgs(argv) {
	const options = { ...DEFAULTS };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--headless" || arg === "--no-sandbox") continue;
		const match = /^--(host|port|pid-file)(?:=(.*))?$/.exec(arg);
		if (!match) throw new Error(`unknown argument: ${arg}`);
		const [, name, inline] = match;
		const value = inline ?? argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
		if (name === "host") {
			options.host = value;
		} else if (name === "pid-file") {
			// Resolved now: the server later changes directory into the package.
			options.pidFile = path.resolve(value);
		} else {
			const port = Number(value);
			if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error(`invalid port: ${value}`);
			options.port = port;
		}
	}
	return options;
}

/** Electron's Linux userData for "LearnHarness" (app.getPath("userData")),
 *  so server mode and the desktop app share data and keys. */
function profileDir(env = process.env, home = os.homedir()) {
	return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "LearnHarness");
}

/** The server's environment. The desktop gate variables are removed: with
 *  either one set, every browser request to /api/* is refused. */
function serverEnv({ host, port }, env = process.env, home = os.homedir()) {
	const profile = profileDir(env, home);
	const out = {
		...env,
		NODE_ENV: "production",
		HOSTNAME: host,
		PORT: String(port),
		LH_DATA_DIR: env.LH_DATA_DIR || path.join(profile, "data"),
		LH_AUTH_FILE: env.LH_AUTH_FILE || path.join(profile, "auth.json"),
	};
	delete out.LH_DESKTOP_SERVER;
	delete out.LH_DESKTOP_API_SECRET;
	return out;
}

/** Writes the PID. The returned cleanup removes the file only while it still
 *  names this process, so a newer server's file survives an old one's exit. */
function writePidFile(file, pid = process.pid) {
	fs.writeFileSync(file, `${pid}\n`);
	return () => {
		try {
			if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
		} catch {}
	};
}

module.exports = { DEFAULTS, TITLE, parseArgs, profileDir, serverEnv, writePidFile };

if (require.main === module) {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`${err.message}\n${USAGE}`);
		process.exit(2);
	}
	const env = serverEnv(options);
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
	if (options.pidFile) {
		let removePidFile;
		try {
			removePidFile = writePidFile(options.pidFile);
		} catch (err) {
			console.error(`cannot write --pid-file: ${err.message}`);
			process.exit(1);
		}
		process.on("exit", removePidFile);
	}
	const entry = path.join(__dirname, "server", "standalone", "server.js");
	console.log(`LearnHarness server mode on ${options.host}:${options.port} (pid ${process.pid}, data: ${env.LH_DATA_DIR})`);
	// Next's graceful shutdown waits on open connections, and every open tab
	// holds /api/events. The desktop shell SIGKILLs its child after 3s;
	// server mode has no parent to do that.
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => setTimeout(() => process.exit(0), 3000).unref());
	}
	process.chdir(path.dirname(entry));
	require(entry);
	// Next renames the process to `next-server (vX)` while server.js loads.
	process.title = TITLE;
}
