/** The app's only path to the sandbox runner: loopback + token, never the
 *  browser. GET reports availability so the card is honest before Run. */
import { readFileSync } from "node:fs";
import { RUNNER_LANGUAGES, runnerLanguageFor } from "@/src/core";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.LH_RUNNER_URL ?? "http://127.0.0.1:3212";
const RUNNER_ENABLED = process.env.LH_RUNNER_ENABLED !== "0";
/** Each run may take 200% CPU; the box also serves the app, so cap in-flight
 *  sandbox jobs rather than letting a Run-spamming tab starve everything. */
const MAX_CONCURRENT = Number(process.env.LH_RUNNER_MAX_CONCURRENT ?? 2);
let inFlight = 0;

function runnerToken(): string {
	if (process.env.LH_RUNNER_TOKEN) return process.env.LH_RUNNER_TOKEN;
	const file = process.env.LH_RUNNER_TOKEN_FILE ?? "/etc/learnharness-runner/token";
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

interface RunnerHealth {
	languages: Array<{ id: string; label: string; available: boolean; version: string | null }>;
}

/** Availability flaps if every paint re-probes the runner; a short cache keeps
 *  the card's badge stable without hiding a real outage for long. */
let healthCache: { at: number; value: RunnerHealth | null } = { at: 0, value: null };
async function health(): Promise<RunnerHealth | null> {
	if (!RUNNER_ENABLED) return null;
	if (Date.now() - healthCache.at < 15_000) return healthCache.value;
	try {
		const res = await fetch(`${RUNNER_URL}/health`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
		if (!res.ok) return null;
		const value = (await res.json()) as RunnerHealth;
		healthCache = { at: Date.now(), value };
		return value;
	} catch {
		healthCache = { at: Date.now(), value: null };
		return null;
	}
}

export async function GET() {
	const h = await health();
	const available = new Set((h?.languages ?? []).filter((l) => l.available).map((l) => l.id));
	return Response.json(
		{
			runnerAvailable: available.size > 0,
			versions: Object.fromEntries((h?.languages ?? []).map((l) => [l.id, l.version])),
			languages: Object.fromEntries(
				Object.entries(RUNNER_LANGUAGES).map(([canonical, runnerId]) => [canonical, available.has(runnerId)]),
			),
		},
		{ headers: { "cache-control": "no-store" } },
	);
}

export async function POST(req: Request) {
	let body: { language?: unknown; code?: unknown; stdin?: unknown; checks?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	const language = typeof body.language === "string" ? body.language : "";
	const code = typeof body.code === "string" ? body.code : "";
	// Manifest ids only — never a client-supplied string.
	const runnerLanguage = runnerLanguageFor(language);
	if (!runnerLanguage) {
		return Response.json({ error: `not a runner language: ${language}` }, { status: 400 });
	}
	if (!code.trim()) return Response.json({ error: "code required" }, { status: 400 });
	if (!RUNNER_ENABLED) {
		return Response.json(
			{ error: "Sandbox runner is disabled on this deployment.", code: "code_runner_not_configured" },
			{ status: 503 },
		);
	}

	if (inFlight >= MAX_CONCURRENT) {
		return Response.json(
			{ error: "The sandbox is busy — try again in a moment.", code: "code_runner_busy" },
			{ status: 429, headers: { "retry-after": "2" } },
		);
	}
	inFlight += 1;
	try {
		const res = await fetch(`${RUNNER_URL}/execute`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-lh-runner-token": runnerToken() },
			body: JSON.stringify({
				language: runnerLanguage,
				code,
				stdin: body.stdin,
				checks: Array.isArray(body.checks) ? body.checks.slice(0, 12) : undefined,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (res.status === 401) {
			return Response.json(
				{ error: "Sandbox runner rejected the app's token.", code: "code_runner_unauthorized" },
				{ status: 503 },
			);
		}
		if (!res.ok) {
			return Response.json(
				{ error: `Sandbox runner error (${res.status}).`, code: "code_runner_error" },
				{ status: 502 },
			);
		}
		return new Response(await res.text(), {
			status: 200,
			headers: { "content-type": "application/json", "cache-control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "Sandbox runner unreachable.", code: "code_runner_unreachable" },
			{ status: 503 },
		);
	} finally {
		inFlight -= 1;
	}
}
