const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Deliberately bounded, not a shell/desktop-command interpreter. Desktop Exec
// values have both string escaping and command quoting rules. Leave escaped
// paths, field codes in executable names, and unfamiliar forms untouched.
function supportedPath(value) {
	return typeof value === "string" && path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f\\%"`$]/.test(value);
}
const needsQuotes = /[ \t'<>~|&;*?#()]/;

function rewriteExec(value, oldPath, newPath) {
	const quoted = value.startsWith('"');
	const match = quoted ? /^"([^"]+)"(?=$|[ \t])/.exec(value) : /^([^ \t]+)(?=$|[ \t])/.exec(value);
	if (!match || !supportedPath(match[1]) || (!quoted && needsQuotes.test(match[1])) || match[1] !== oldPath) return value;
	const executable = quoted || needsQuotes.test(newPath) ? `"${newPath}"` : newPath;
	return executable + value.slice(match[0].length);
}

/** Rewrite exact direct executable references only; preserve all other bytes,
 * including arguments, field codes, comments, line endings and other groups. */
function rewriteDesktopEntry(text, oldPath, newPath) {
	if (!supportedPath(oldPath) || !supportedPath(newPath) || oldPath === newPath) return text;
	let group = "";
	return text.split("\n").map((raw) => {
		const cr = raw.endsWith("\r") ? "\r" : "";
		const line = cr ? raw.slice(0, -1) : raw;
		if (line.startsWith("[")) {
			group = line === "[Desktop Entry]" ? "entry" : /^\[Desktop Action [^\[\]]+\]$/.test(line) ? "action" : "";
			return raw;
		}
		if ((group === "entry" || group === "action") && line.startsWith("Exec=")) {
			return "Exec=" + rewriteExec(line.slice(5), oldPath, newPath) + cr;
		}
		// TryExec is a single string path, not an Exec command with arguments
		// or command quoting. Escaped/quoted/ambiguous forms remain unchanged.
		if (group === "entry" && line === `TryExec=${oldPath}`) return `TryExec=${newPath}${cr}`;
		return raw;
	}).join("\n");
}

/** Called in the OLD process during a future update's filename-change event.
 * No startup migration: a version without this listener cannot repair its
 * transition into the first version that includes it. Never scan system dirs,
 * the Desktop folder, or an integration tool's private directories. */
function updateAppImageShortcuts({ oldPath, newPath, home, dataHome, log = () => {}, io = fs }) {
	if (!supportedPath(oldPath) || !supportedPath(newPath) || oldPath === newPath) return;
	const report = (message) => { try { log(message); } catch { /* Never interrupt installation for logging. */ } };
	// The XDG spec ignores relative data homes. Never resolve one against the
	// application's working directory (which can be the read-only mount).
	const root = typeof dataHome === "string" && path.isAbsolute(dataHome) ? dataHome :
		typeof home === "string" && path.isAbsolute(home) ? path.join(home, ".local", "share") : null;
	if (!root) return;
	const directory = path.join(root, "applications");
	let names;
	try {
		names = io.readdirSync(directory);
	} catch (err) {
		if (err.code !== "ENOENT") report(`auto-update: desktop directory skipped (${err.message})`);
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".desktop")) continue;
		const file = path.join(directory, name);
		let temporary, fd;
		let created = false;
		try {
			const before = io.lstatSync(file);
			if (!before.isFile() || before.isSymbolicLink()) continue;
			const bytes = io.readFileSync(file);
			const original = bytes.toString("utf8");
			if (!Buffer.from(original, "utf8").equals(bytes)) continue; // Invalid UTF-8 is an unfamiliar entry.
			const next = rewriteDesktopEntry(original, oldPath, newPath);
			if (next === original) continue;
			io.accessSync(file, fs.constants.W_OK);
			// Same-directory rename is atomic. Never truncate the original file;
			// a failed open/write/chmod/close/rename leaves it in place.
			temporary = path.join(directory, `.learnharness-${randomUUID()}.tmp`);
			fd = io.openSync(temporary, "wx", before.mode & 0o777);
			created = true;
			io.writeFileSync(fd, next, "utf8");
			io.fchmodSync(fd, before.mode & 0o777);
			io.closeSync(fd);
			fd = undefined;
			// Don't overwrite an entry edited/replaced while we prepared its
			// replacement, or follow a newly introduced symlink.
			const current = io.lstatSync(file);
			if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
				current.mode !== before.mode || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs ||
				io.readFileSync(file, "utf8") !== original) throw new Error("desktop entry changed during rewrite");
			io.renameSync(temporary, file);
			created = false;
			report(`auto-update: desktop entry ${name} → ${newPath}`);
		} catch (err) {
			report(`auto-update: desktop entry ${name} skipped (${err.message})`);
		} finally {
			if (fd !== undefined) { try { io.closeSync(fd); } catch { /* Best effort cleanup. */ } }
			if (created) { try { io.unlinkSync(temporary); } catch { /* Never touch an unowned temporary. */ } }
		}
	}
}

module.exports = { rewriteDesktopEntry, updateAppImageShortcuts };
