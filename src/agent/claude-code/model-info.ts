import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { externalCliEnv } from "../../core/auth-env.ts";

/** One alias row from the CLI's own model list. */
export type ClaudeModelInfo = { alias: string; resolvedModel: string; displayName?: string };

const MODEL_INFO_TIMEOUT_MS = 5_000;

/** The `initialize` control response lists the CLI's models; rows carry the
 * canonical ID each alias currently resolves to (`resolvedModel`). Rows
 * without one are skipped: no ID is ever guessed from a display name. */
export function parseInitializeModels(body: unknown): ClaudeModelInfo[] {
	if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) return [];
	return body.models.flatMap((row: unknown) => {
		if (!row || typeof row !== "object") return [];
		const { value, resolvedModel, displayName } = row as Record<string, unknown>;
		if (typeof value !== "string" || !value || typeof resolvedModel !== "string" || !resolvedModel) return [];
		return [{ alias: value, resolvedModel, ...(typeof displayName === "string" && displayName ? { displayName } : {}) }];
	});
}

/** Metadata-only CLI query: start a process, send `initialize`, read the
 * model list, and stop. No user message is sent, so no model request runs.
 * Any failure or timeout yields an empty list (labels stay plain aliases). */
export async function readClaudeModels(
	binary: string,
	{ spawnProcess = spawn as unknown as (cmd: string, args: string[], options: object) => ChildProcessWithoutNullStreams, timeoutMs = MODEL_INFO_TIMEOUT_MS } = {},
): Promise<ClaudeModelInfo[]> {
	const cwd = await mkdtemp(join(tmpdir(), "lh-claude-models-"));
	try {
		const child = spawnProcess(binary, [
			"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
			"--tools", "", "--setting-sources", "user",
			"--settings", JSON.stringify({ disableAllHooks: true, env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }),
			"--disable-slash-commands", "--no-session-persistence", "--permission-prompts", "none",
		], { cwd, env: externalCliEnv(), stdio: "pipe", windowsHide: true });
		const requestId = randomUUID();
		return await new Promise<ClaudeModelInfo[]>((resolve) => {
			let settled = false;
			const finish = (models: ClaudeModelInfo[]) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				lines.close();
				child.stdin.end();
				child.kill("SIGKILL");
				resolve(models);
			};
			const timer = setTimeout(() => finish([]), timeoutMs);
			timer.unref();
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let value: unknown;
				try { value = JSON.parse(line); } catch { return; }
				if (!value || typeof value !== "object") return;
				const { type, response } = value as { type?: unknown; response?: Record<string, unknown> };
				if (type !== "control_response" || !response || response.request_id !== requestId) return;
				finish(response.subtype === "success" ? parseInitializeModels(response.response) : []);
			});
			child.on("error", () => finish([]));
			child.on("close", () => finish([]));
			child.stdin.on("error", () => finish([]));
			child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
		});
	} catch {
		return [];
	} finally {
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}
