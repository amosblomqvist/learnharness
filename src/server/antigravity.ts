import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAntigravityBinary } from "../agent/antigravity/binary.ts";
import { externalCliEnv } from "../core/auth-env.ts";
import type { AntigravityStatus } from "../core/contracts/antigravity.ts";
import { settingsStore } from "../store/settings.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export function antigravityAvailable(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true && getAntigravityBinary() !== null;
}

export async function antigravityInstallationResponse(request: Request): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-antigravity") !== "1" || request.headers.get("sec-fetch-site") === "cross-site"
		|| (request.headers.has("origin") && request.headers.get("origin") !== origin)) {
		return Response.json({ error: "Antigravity checks require a same-origin LearnHarness request." }, { status: 403 });
	}
	const binary = getAntigravityBinary();
	let status: AntigravityStatus = { state: "not-found", version: null };
	if (binary) {
		try {
			const run = promisify(execFile);
			const { stdout: help, stderr } = await run(binary, ["--help"], { timeout: 5000, maxBuffer: 64 * 1024, env: externalCliEnv() });
			const supported = (help + stderr).includes("--settings") && (help + stderr).includes("--json-schema");
			const { stdout: version } = await run(binary, ["--version"], { timeout: 5000, maxBuffer: 4096, env: externalCliEnv() });
			status = { state: supported ? "ready" : "unsupported", version: /^\d+\.\d+\.\d+$/.test(version.trim()) ? version.trim() : null };
		} catch { status = { state: "unsupported", version: null }; }
	}
	return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
