import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginTaskRecordStore } from "../core/ports.ts";
import type { PluginTaskRecord } from "../core/plugin-workers.ts";
import { validatePluginInferenceOptions } from "../core/plugin-validation.ts";
import { PLUGIN_ID_PATTERN } from "../core/plugins.ts";

const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const nonnegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function validate(value: unknown, expected: string): PluginTaskRecord {
	const invalid = () => { throw new Error(`Corrupt or unsupported plugin task record: ${expected}`); };
	if (!object(value)) return invalid();
	const r = value;
	if (r.version !== 1 || r.id !== expected || !safeId(r.id) || !safeId(r.definitionId) || typeof r.requestId !== "string" || !r.requestId.length) return invalid();
	if (!timestamp(r.createdAt) || !timestamp(r.updatedAt) || typeof r.prompt !== "string" || !Object.hasOwn(r, "input")) return invalid();
	if (!Number.isSafeInteger(r.maxTurns) || (r.maxTurns as number) < 1 || !Number.isSafeInteger(r.turns) || (r.turns as number) < 0) return invalid();
	if (r.purpose !== "user" && r.purpose !== "background") return invalid();
	if (!object(r.model) || typeof r.model.provider !== "string" || !r.model.provider.trim() || typeof r.model.id !== "string" || !r.model.id.trim()) return invalid();
	if (r.model.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(r.model.thinkingLevel as string)) return invalid();
	if (r.timeoutMs !== undefined && (!Number.isSafeInteger(r.timeoutMs) || (r.timeoutMs as number) < 1)) return invalid();
	try { validatePluginInferenceOptions(r.options as never); } catch { return invalid(); }
	if (r.activity !== undefined && typeof r.activity !== "string") return invalid();
	if (!["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(r.status as string)) return invalid();
	if (r.status === "succeeded") {
		if (!Object.hasOwn(r, "result") || !timestamp(r.completedAt) || r.error !== undefined) return invalid();
	} else if (["failed", "cancelled", "interrupted"].includes(r.status as string)) {
		if (Object.hasOwn(r, "result") || !timestamp(r.completedAt) || !object(r.error) || typeof r.error.message !== "string" || !["no_result", "max_turns", "timeout", "run_error", "storage_error", "cancelled", "interrupted"].includes(r.error.code as string)) return invalid();
		if ((r.status === "cancelled" && r.error.code !== "cancelled") || (r.status === "interrupted" && r.error.code !== "interrupted")) return invalid();
	} else if (Object.hasOwn(r, "result") || r.error !== undefined || r.completedAt !== undefined) return invalid();
	if (!Array.isArray(r.messages) || !r.messages.length || !r.messages.every(m => object(m) && typeof m.role === "string" && ["user", "assistant", "toolResult"].includes(m.role) && nonnegative(m.timestamp) && (typeof m.content === "string" || Array.isArray(m.content)))) return invalid();
	for (const m of r.messages) {
		if (m.role === "assistant" && (typeof m.api !== "string" || typeof m.provider !== "string" || typeof m.model !== "string" || !Array.isArray(m.content) || !object(m.usage) || !["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(m.stopReason))) return invalid();
		if (m.role === "toolResult" && (typeof m.toolCallId !== "string" || typeof m.toolName !== "string" || !Array.isArray(m.content) || typeof m.isError !== "boolean")) return invalid();
	}
	if (r.usage !== undefined) {
		if (!object(r.usage) || typeof r.usage.model !== "string" || !Number.isSafeInteger(r.usage.steps) || (r.usage.steps as number) < 1) return invalid();
		for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cacheWrite1hTokens"]) if (r.usage[key] !== undefined && !nonnegative(r.usage[key])) return invalid();
		if (r.usage.calls !== undefined && (!Array.isArray(r.usage.calls) || !r.usage.calls.every(object))) return invalid();
		if (r.usage.lastStep !== undefined && !object(r.usage.lastStep)) return invalid();
	}
	return r as unknown as PluginTaskRecord;
}

/** Atomic one-file-per-task plugin-local records. One writer per directory;
 * this is not an interprocess lock. Never falls back past corrupt JSON. */
export function createPluginTaskRecordStore(directory: string): PluginTaskRecordStore {
	// Plugin data directories are runtime inputs, never deployment assets.
	const root = path.resolve(/* turbopackIgnore: true */ directory);
	const filename = (id: string) => { if (!safeId(id)) throw new Error("Invalid plugin task id"); return path.join(/* turbopackIgnore: true */ root, `${id}.json`); };
	const directoryExists = () => {
		let stat: fs.Stats;
		try { stat = fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe plugin task store directory");
		return true;
	};
	const get = (id: string): PluginTaskRecord | null => {
		const file = filename(id);
		if (!directoryExists()) return null;
		let raw: string;
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe plugin task file: ${id}`);
			raw = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		let parsed: unknown;
		try { parsed = JSON.parse(raw); } catch { throw new Error(`Corrupt plugin task JSON: ${id}`); }
		return validate(parsed, id);
	};
	return {
		get,
		list() {
			if (!directoryExists()) return [];
			let files: string[];
			try { files = fs.readdirSync(/* turbopackIgnore: true */ root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
			return files.filter(name => name.endsWith(".json")).sort().map(name => {
				const record = get(name.slice(0, -5));
				if (!record) throw new Error(`Plugin task disappeared during list: ${name}`);
				return record;
			});
		},
		save(record) {
			const file = filename(record.id);
			// Serialize first, checking unsupported JSON values instead of silently
			// dropping a result, coercing NaN, or executing custom toJSON methods.
			const seen = new Set<object>();
			const jsonSafe = (v: unknown): void => {
				if (v === undefined || v === null || typeof v === "string" || typeof v === "boolean") return;
				if (typeof v === "number" && Number.isFinite(v)) return;
				if (!v || typeof v !== "object" || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) || seen.has(v)) throw new Error("Plugin task record must contain finite JSON data");
				seen.add(v); for (const child of Object.values(v)) jsonSafe(child); seen.delete(v);
			};
			jsonSafe(record);
			const data = JSON.stringify(record, null, "\t");
			validate(JSON.parse(data), record.id);
			if (!directoryExists()) fs.mkdirSync(root, { recursive: true });
			directoryExists();
			const temp = path.join(root, `.${record.id}.${randomUUID()}.tmp`);
			let descriptor: number | undefined;
			try {
				descriptor = fs.openSync(temp, "wx", 0o600);
				fs.writeFileSync(descriptor, data, "utf8"); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
				fs.renameSync(temp, file);
				if (process.platform !== "win32") {
					const dir = fs.openSync(root, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
				}
			} finally {
				if (descriptor !== undefined) fs.closeSync(descriptor);
				try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
		},
	};
}

function safeTaskDirectory(rootPluginsDirectory: string, pluginId: string): string | null {
	if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) throw new Error("Invalid plugin id");
	const root = path.resolve(/* turbopackIgnore: true */ rootPluginsDirectory);
	let realRoot: string | undefined;
	for (const dir of [root, path.join(root, pluginId), path.join(/* turbopackIgnore: true */ root, pluginId, "data"), path.join(root, pluginId, "data", "tasks")]) {
		let stat: fs.Stats;
		try { stat = fs.lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe plugin task directory: ${dir}`);
		// Installed user data is a runtime lookup, never a build input to trace.
		const real = fs.realpathSync(/* turbopackIgnore: true */ dir); realRoot ??= real;
		const relative = path.relative(realRoot, real);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Plugin task directory escapes root");
	}
	return path.join(root, pluginId, "data", "tasks");
}

/** Recovery-only read: never activates plugin code or creates missing data.
 * taskId is authoritative when present; requestId locates an acceptance whose
 * core-job link was not committed before a crash. Unsafe/corrupt data throws. */
export function readPluginTaskRecord(rootPluginsDirectory: string, pluginId: string, taskId?: string, requestId?: string): PluginTaskRecord | null {
	if (taskId !== undefined && !safeId(taskId)) throw new Error("Invalid plugin task id");
	if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length)) throw new Error("Invalid plugin task request id");
	if (taskId === undefined && requestId === undefined) throw new Error("A task id or request id is required");
	const directory = safeTaskDirectory(rootPluginsDirectory, pluginId);
	if (!directory) return null;
	const store = createPluginTaskRecordStore(directory);
	if (taskId !== undefined) {
		const record = store.get(taskId);
		if (record && requestId !== undefined && record.requestId !== requestId) throw new Error("Plugin task/request identity mismatch");
		return record;
	}
	const matching = store.list().filter(record => record.requestId === requestId);
	if (matching.length > 1) throw new Error("Duplicate plugin task request identity");
	return matching[0] ?? null;
}

/** Exclusive server-bootstrap sweep, before any task services activate. Disabled
 * packages are included. Per-package failures are diagnostic, never rewritten
 * as missing data or allowed to prevent recovery of other valid packages. */
export function recoverPluginTaskRecords(rootPluginsDirectory: string): Record<string, string> {
	const root = path.resolve(/* turbopackIgnore: true */ rootPluginsDirectory);
	let stat: fs.Stats;
	try { stat = fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe plugins recovery root");
	const errors: Record<string, string> = Object.create(null);
	for (const entry of fs.readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			const directory = safeTaskDirectory(root, entry.name); if (!directory) continue;
			const store = createPluginTaskRecordStore(directory);
			// Read/validate the whole package first: corruption must not cause
			// partially reinterpreted task histories within that package.
			const records = store.list();
			const requests = new Set<string>();
			for (const record of records) { if (requests.has(record.requestId)) throw new Error("Duplicate plugin task request identity"); requests.add(record.requestId); }
			for (const record of records) {
				if (record.status !== "queued" && record.status !== "running") continue;
				const now = new Date().toISOString();
				store.save({ ...record, status: "interrupted", completedAt: now, updatedAt: now, error: { code: "interrupted", message: "Task interrupted by server restart; no work was replayed" } });
			}
		} catch (error) { errors[entry.name] = error instanceof Error ? error.message : String(error); }
	}
	return errors;
}
