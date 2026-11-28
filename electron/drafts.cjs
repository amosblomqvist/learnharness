const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const SAVE_DELAY_MS = 800;
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

function createDraftStore(directory, reportError) {
	const pending = new Map();
	let timer;
	const fileFor = key => path.join(directory, createHash("sha256").update(key).digest("hex"));
	const validKey = key => typeof key === "string" && key.length > 0 && key.length <= 2048;

	function flush() {
		clearTimeout(timer);
		timer = undefined;
		for (const [key, text] of pending) {
			const file = fileFor(key);
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				if (text) {
					fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
					fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600, flush: true });
					fs.renameSync(temporary, file);
				} else {
					fs.rmSync(file, { force: true });
				}
				pending.delete(key);
			} catch (error) {
				try { fs.rmSync(temporary, { force: true }); } catch { /* retain the previous draft */ }
				reportError(error);
			}
		}
	}

	return {
		read(key) {
			if (!validKey(key)) return "";
			if (pending.has(key)) return pending.get(key);
			try { return fs.readFileSync(fileFor(key), "utf8"); }
			catch (error) {
				if (error.code !== "ENOENT") reportError(error);
				return "";
			}
		},
		write(key, text) {
			if (!validKey(key) || typeof text !== "string" || Buffer.byteLength(text) > MAX_DRAFT_BYTES) return;
			pending.set(key, text);
			clearTimeout(timer);
			timer = setTimeout(flush, SAVE_DELAY_MS);
		},
		flush,
	};
}

module.exports = { createDraftStore };
