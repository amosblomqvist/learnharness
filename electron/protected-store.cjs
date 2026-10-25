"use strict";

// Reuses the safeStorage envelope/atomic-write approach previously used by
// chatgpt.cjs (before 24d1dda). Main process only; no plaintext fallback.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const failure = () => Object.assign(new Error("storage"), { code: "storage" });
const FORMAT = "learnharness.safeStorage";

function protectedStore(file, { safeStorage, validate, kind, missing = () => null, io = fs, platform = process.platform }) {
	function secure() {
		try {
			if (!safeStorage?.isEncryptionAvailable()) throw failure();
			if (platform === "linux") {
				const backend = safeStorage.getSelectedStorageBackend?.();
				if (!backend || backend === "basic_text" || backend === "unknown") throw failure();
			}
		} catch { throw failure(); }
	}
	async function write(state) {
		let handle;
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			secure(); validate(state);
			const encrypted = safeStorage.encryptString(JSON.stringify({ kind, state })).toString("base64");
			secure();
			await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			handle = await io.open(temporary, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ format: FORMAT, version: 1, encrypted })}\n`);
			await handle.sync(); await handle.close(); handle = null;
			secure();
			await io.rename(temporary, file);
			if (platform !== "win32") {
				const directory = await io.open(path.dirname(file), "r");
				try { await directory.sync(); } finally { await directory.close(); }
			}
		} catch { throw failure(); }
		finally { await handle?.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
	}
	return {
		secure,
		write,
		async read() {
			try {
				secure();
				let bytes;
				try {
					const stat = await io.lstat(file);
					if (!stat.isFile() || (platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw failure();
					bytes = await io.readFile(file, "utf8");
				} catch (error) { if (error.code === "ENOENT") return missing(); throw error; }
				const value = JSON.parse(bytes);
				if (value?.format === FORMAT) {
					if (value.version !== 1 || typeof value.encrypted !== "string" || !value.encrypted || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.encrypted)) throw failure();
					const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, "base64")));
					if (decoded?.kind !== kind) throw failure();
					validate(decoded.state); secure();
					return decoded.state;
				}
				// Same-app format conversion only. Do not copy credentials between
				// profiles, create plaintext backups, or recover from corrupt data.
				validate(value);
				await write(value); // Original bytes survive any pre-rename failure.
				return value;
			} catch { throw failure(); }
		},
	};
}

module.exports = { protectedStore };
