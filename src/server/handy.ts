import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HandyModel } from "../core/dictation.ts";

const execFileAsync = promisify(execFile);

const COMMON_HANDY_PATHS = [
	"/usr/sbin/handy",
	"/usr/bin/handy",
	"/usr/local/bin/handy",
];

function isExecutableFile(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findHandyBinary(): string | null {
	if (process.env.LH_HANDY_BIN && isExecutableFile(process.env.LH_HANDY_BIN)) {
		return process.env.LH_HANDY_BIN;
	}
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const candidates = [
		...COMMON_HANDY_PATHS,
		...pathDirs.map((dir) => path.join(dir, "handy")),
	];
	for (const candidate of candidates) {
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return null;
}

export function isHandyAvailable(): boolean {
	return findHandyBinary() !== null;
}

function extractJsonOutput<T>(stdout: string, isArray: boolean): T | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	const openChar = isArray ? "[" : "{";
	const closeChar = isArray ? "]" : "}";
	const start = trimmed.indexOf(openChar);
	const end = trimmed.lastIndexOf(closeChar);
	if (start === -1 || end === -1 || end < start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}

export async function listHandyModels(): Promise<{ available: boolean; models: HandyModel[] }> {
	const bin = findHandyBinary();
	if (!bin) return { available: false, models: [] };

	try {
		const { stdout } = await execFileAsync(bin, ["--list-models", "--json"], {
			maxBuffer: 10 * 1024 * 1024,
			timeout: 10_000,
		});
		const rawList = extractJsonOutput<HandyModel[]>(stdout, true);
		if (!Array.isArray(rawList)) return { available: true, models: [] };

		const models = rawList
			.filter((m) => m && typeof m.id === "string")
			.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				filename: m.filename,
				is_downloaded: Boolean(m.is_downloaded),
			}));
		return { available: true, models };
	} catch {
		return { available: true, models: [] };
	}
}

export async function transcribeWithHandy(
	wavBytes: Uint8Array,
	options?: { model?: string; signal?: AbortSignal },
): Promise<{ text: string }> {
	const bin = findHandyBinary();
	if (!bin) {
		throw new Error("Handy binary not found. Install Handy or configure DEEPGRAM_API_KEY.");
	}

	const tempPath = path.join(
		os.tmpdir(),
		`lh-handy-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
	);

	try {
		await fs.promises.writeFile(tempPath, wavBytes);
		const args = ["-f", tempPath, "--json"];
		if (options?.model && options.model.trim()) {
			args.push("--model", options.model.trim());
		}

		let stdout: string;
		try {
			const out = await execFileAsync(bin, args, {
				maxBuffer: 20 * 1024 * 1024,
				timeout: 60_000,
				signal: options?.signal,
			});
			stdout = out.stdout;
		} catch (err) {
			if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
				throw err;
			}
			const execErr = err as { killed?: boolean; stderr?: string; stdout?: string; message?: string };
			if (execErr.killed) {
				throw new Error("Handy transcription timed out");
			}
			const jsonErr = extractJsonOutput<{ error?: string; message?: string }>(
				execErr.stdout || execErr.stderr || "",
				false,
			);
			if (jsonErr?.error || jsonErr?.message) {
				throw new Error(jsonErr.error ?? jsonErr.message);
			}
			const stderrLine = (execErr.stderr ?? "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.at(-1);
			throw new Error(stderrLine || "Handy transcription failed");
		}

		const res = extractJsonOutput<{ text?: string; error?: string }>(stdout, false);
		if (!res || typeof res.text !== "string") {
			throw new Error(res?.error || "Handy returned invalid transcription output");
		}
		return { text: res.text.trim() };
	} finally {
		try {
			await fs.promises.unlink(tempPath);
		} catch {}
	}
}
