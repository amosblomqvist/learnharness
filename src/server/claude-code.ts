import { inspectClaudeInstallation } from "../agent/claude-code/installation.ts";
import type { ClaudeCodeProfilesResponse } from "../core/contracts/claude-code.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { claudeCodeEnabled, configuredClaudeConfigDir } from "./claude-code-config.ts";
import { discoverClaudeCodeProfiles } from "./claude-code-profiles.ts";

const CLAUDE_CODE_RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
} as const;

/** The Settings status seam: initialize provenance before any child env is copied. */
export async function claudeCodeInstallationStatus() {
	initAuthEnv();
	return inspectClaudeInstallation();
}

/** Non-secret profile directory discovery only; never inspects credentials. */
export function claudeCodeProfilesStatus(): ClaudeCodeProfilesResponse {
	initAuthEnv();
	return discoverClaudeCodeProfiles({ configuredDir: configuredClaudeConfigDir() ?? null });
}

function claudeCodeRequestRejection(request: Request, enabled: () => boolean): Response | null {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-claude-code") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json(
			{ error: "Claude Code checks require a same-origin LearnHarness request." },
			{ status: 403, headers: CLAUDE_CODE_RESPONSE_HEADERS },
		);
	}
	if (!enabled()) {
		return Response.json(
			{ error: "Claude Code is disabled." },
			{ status: 403, headers: CLAUDE_CODE_RESPONSE_HEADERS },
		);
	}
	return null;
}

/** Same-origin browser intent, not user authentication. No CORS grants.
 * A public/shared server still requires its own access-control boundary. */
export async function claudeCodeInstallationResponse(
	request: Request,
	inspect = claudeCodeInstallationStatus,
	enabled = claudeCodeEnabled,
): Promise<Response> {
	const rejection = claudeCodeRequestRejection(request, enabled);
	if (rejection) return rejection;
	return Response.json(await inspect(), { headers: CLAUDE_CODE_RESPONSE_HEADERS });
}

/** Same-origin guarded endpoint for non-secret Claude Code profile directory discovery. */
export async function claudeCodeProfilesResponse(
	request: Request,
	discover: () => ClaudeCodeProfilesResponse | Promise<ClaudeCodeProfilesResponse> = claudeCodeProfilesStatus,
	enabled = claudeCodeEnabled,
): Promise<Response> {
	const rejection = claudeCodeRequestRejection(request, enabled);
	if (rejection) return rejection;
	return Response.json(await discover(), { headers: CLAUDE_CODE_RESPONSE_HEADERS });
}
