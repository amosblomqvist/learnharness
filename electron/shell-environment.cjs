/** Recover the user's login-shell PATH for packaged desktop processes. */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PATH_START = "__LEARNHARNESS_PATH_START__";
const PATH_END = "__LEARNHARNESS_PATH_END__";
const POSIX_PATH_DELIMITER = ":";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)/i;

function userLoginShell() {
	try {
		return os.userInfo().shell;
	} catch {
		return undefined;
	}
}

function isExecutableShell(value) {
	if (typeof value !== "string" || !path.isAbsolute(value)) return false;
	try {
		fs.accessSync(value, fs.constants.X_OK);
		return fs.statSync(value).isFile();
	} catch {
		return false;
	}
}

function loginShellCandidates(env, platform) {
	if (platform === "win32") return [];
	const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
	return [...new Set([env.SHELL, userLoginShell(), fallback].filter(isExecutableShell))];
}

function shellEnvironment(env) {
	return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "LH_DESKTOP_API_SECRET"
		&& !name.startsWith("LH_") && !SENSITIVE_ENV_NAME.test(name)));
}

function runCommand(command, args, { env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, {
				env,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			resolve(null);
			return;
		}

		let output = "";
		let settled = false;
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const terminate = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* The process may have exited between the timeout and kill. */
			}
		};

		timer = setTimeout(() => {
			terminate();
			finish(null);
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
				terminate();
				finish(null);
			}
		});
		child.once("error", () => finish(null));
		child.once("close", (code) => finish(code === 0 ? output : null));
	});
}

function extractPath(output) {
	if (typeof output !== "string") return null;
	const match = new RegExp(`${PATH_START}\\n([\\s\\S]*?)\\n${PATH_END}`).exec(output);
	const value = match?.[1]?.trim();
	return value || null;
}

async function discoverLoginShellPath({
	env = process.env,
	platform = process.platform,
	shellCandidates = loginShellCandidates(env, platform),
	run = runCommand,
	timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
	if (platform === "win32") return null;

	const command = `printf '%s\\n%s\\n%s\\n' '${PATH_START}' \"$PATH\" '${PATH_END}'`;
	const startedAt = Date.now();
	const childEnv = shellEnvironment(env);
	for (const shell of shellCandidates) {
		const remainingMs = timeoutMs - (Date.now() - startedAt);
		if (remainingMs <= 0) break;
		const output = await run(shell, ["-ilc", command], { env: childEnv, timeoutMs: remainingMs });
		const discovered = extractPath(output);
		if (discovered) return discovered;
	}

	if (platform === "darwin") {
		const remainingMs = timeoutMs - (Date.now() - startedAt);
		if (remainingMs <= 0) return null;
		const output = await run("/bin/launchctl", ["getenv", "PATH"], { env: childEnv, timeoutMs: Math.min(2_000, remainingMs) });
		return typeof output === "string" ? output.trim() || null : null;
	}
	return null;
}

function mergePathValues(primary, secondary, delimiter = POSIX_PATH_DELIMITER) {
	return [...new Set(`${primary ?? ""}${delimiter}${secondary ?? ""}`.split(delimiter).filter(Boolean))].join(delimiter);
}

async function hydrateProcessPath(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const discovered = await discoverLoginShellPath({ ...options, env, platform });
	if (!discovered) return false;
	env.PATH = mergePathValues(discovered, env.PATH, platform === "win32" ? ";" : POSIX_PATH_DELIMITER);
	return true;
}

module.exports = {
	discoverLoginShellPath,
	hydrateProcessPath,
	mergePathValues,
};
