import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginAgentRecord } from "../core/plugin-agents.ts";
import type { PluginAgentRecordStore } from "../core/ports.ts";

function safeId(id: string): void {
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid plugin agent identifier");
}
function validate(value: unknown, id: string): PluginAgentRecord {
	const r = value as PluginAgentRecord | null;
	if (!r || r.version !== 1 || r.id !== id || typeof r.definitionId !== "string"
		|| !Array.isArray(r.messages) || !Array.isArray(r.pending) || !Array.isArray(r.acceptedInputs)
		|| typeof r.createdAt !== "string" || typeof r.updatedAt !== "string"
		|| !["idle", "running", "waiting", "error", "interrupted"].includes(r.status)
		|| r.acceptedInputs.some((i) => typeof i !== "string")
		|| r.pending.some((p) => !p || typeof p.toolCallId !== "string" || typeof p.toolName !== "string")
		|| r.messages.some((m) => !m || !["user", "assistant", "toolResult", "system"].includes(m.role))) {
		throw new Error(`Invalid plugin agent record: ${id}`);
	}
	safeId(r.definitionId);
	return r;
}

/** One JSON file per plugin-local session (normally <plugin data>/agents).
 * Atomic replacement and fsync before rename: observers are notified by the
 * service only after this synchronous write returns. No global learner paths,
 * chat store imports, silent read failures, or process-wide singleton state.
 * The host must share one service for this directory; this is not an interprocess
 * lock or a multi-process database. */
export function createPluginAgentRecordStore(directory: string): PluginAgentRecordStore {
	// Plugin data directories are runtime inputs, never deployment assets.
	const root = path.resolve(/* turbopackIgnore: true */ directory);
	fs.mkdirSync(root, { recursive: true });
	const filename = (id: string) => { safeId(id); return path.join(/* turbopackIgnore: true */ root, `${id}.json`); };
	const get = (id: string): PluginAgentRecord | null => {
		const file = filename(id);
		let text: string;
		try { text = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try { return validate(JSON.parse(text), id); }
		catch (error) { throw new Error(`Unable to read plugin agent record ${id}`, { cause: error }); }
	};
	return {
		get,
		list() {
			return fs.readdirSync(/* turbopackIgnore: true */ root).filter((name) => name.endsWith(".json")).sort().map((name) => {
				const id = name.slice(0, -5);
				const record = get(id);
				if (!record) throw new Error(`Plugin agent record disappeared while loading: ${id}`);
				return record;
			});
		},
		save(record) {
			const file = filename(record.id);
			// Round-trip and validate before touching disk. Circular/non-JSON values
			// fail the acceptance barrier rather than corrupting an existing record.
			const body = `${JSON.stringify(record, null, "\t")}\n`;
			validate(JSON.parse(body), record.id);
			const temporary = path.join(root, `.${record.id}.${randomUUID()}.tmp`);
			let fd: number | undefined;
			try {
				fd = fs.openSync(temporary, "wx", 0o600);
				fs.writeFileSync(fd, body, "utf8");
				fs.fsyncSync(fd);
				fs.closeSync(fd); fd = undefined;
				fs.renameSync(temporary, file);
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
				try { fs.unlinkSync(temporary); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
		},
	};
}
