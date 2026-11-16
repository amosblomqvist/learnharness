import { AntigravityAuthError, createAntigravityAuthManager } from "../agent/antigravity/auth.ts";
import {
	createAntigravityInstallerManager,
	resolveAntigravityRuntime,
	type AntigravityResolutionResult,
} from "../agent/antigravity/installation.ts";
import { shutdownAntigravityProcesses } from "../agent/antigravity/live-processes.ts";
import { piModels } from "../agent/models.ts";
import type { AntigravityStatus } from "../core/contracts/antigravity.ts";
import { antigravityBinaryPath, antigravityEnabled } from "./antigravity-config.ts";
import { createAntigravityModelsManager } from "./antigravity-provider.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export { shutdownAntigravityProcesses };

const INSTALLER_KEY = Symbol.for("lh.antigravityInstaller");
const AUTH_KEY = Symbol.for("lh.antigravityAuth");
const MODELS_KEY = Symbol.for("lh.antigravityModels");
const MAX_AUTH_BODY_BYTES = 16_384;

export type AntigravityInstallerManager = ReturnType<typeof createAntigravityInstallerManager>;
export type AntigravityAuthManager = ReturnType<typeof createAntigravityAuthManager>;
export type AntigravityModelsManager = ReturnType<typeof createAntigravityModelsManager>;

export function antigravityInstaller(): AntigravityInstallerManager {
	const g = globalThis as Record<symbol, AntigravityInstallerManager | undefined>;
	if (!g[INSTALLER_KEY]) {
		g[INSTALLER_KEY] = createAntigravityInstallerManager();
	}
	return g[INSTALLER_KEY];
}

export function antigravityModels(): AntigravityModelsManager {
	const g = globalThis as Record<symbol, AntigravityModelsManager | undefined>;
	if (!g[MODELS_KEY]) {
		g[MODELS_KEY] = createAntigravityModelsManager();
	}
	return g[MODELS_KEY];
}

export function antigravityAuth(): AntigravityAuthManager {
	const g = globalThis as Record<symbol, AntigravityAuthManager | undefined>;
	if (!g[AUTH_KEY]) {
		const models = antigravityModels();
		g[AUTH_KEY] = createAntigravityAuthManager({
			onSignedIn: async (runtime) => {
				await models.refresh(runtime);
			},
		});
	}
	return g[AUTH_KEY];
}

const HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function isAuthorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	return Boolean(
		origin &&
			request.headers.get("x-learnharness-antigravity") === "1" &&
			request.headers.get("sec-fetch-site") !== "cross-site" &&
			(supplied === null || supplied === origin),
	);
}

async function readBoundedJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
		return { ok: false, status: 415, error: "Expected application/json." };
	}
	if (Number(request.headers.get("content-length")) > MAX_AUTH_BODY_BYTES) {
		return { ok: false, status: 413, error: "Request body too large." };
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return { ok: false, status: 400, error: "Expected JSON body." };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_AUTH_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, status: 413, error: "Request body too large." };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return { ok: false, status: 400, error: "Invalid JSON body." };
	}
}

/** Initialize credential provenance before any child env is copied. */
export async function antigravityStatus(
	installer: AntigravityInstallerManager = antigravityInstaller(),
	auth: AntigravityAuthManager = antigravityAuth(),
	models: AntigravityModelsManager = antigravityModels(),
): Promise<AntigravityStatus> {
	initAuthEnv();
	const base = await installer.getStatus({
		enabled: antigravityEnabled(),
		binaryPath: antigravityBinaryPath() ?? null,
		auth: auth.getState(),
	});
	return { ...base, models: models.getStatus() };
}

export async function antigravityStatusResponse(
	request: Request,
	inspect: () => Promise<AntigravityStatus> = () => antigravityStatus(),
	enabled: () => boolean = antigravityEnabled,
): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Unsupported method." }, { status: 405, headers: HEADERS });
	}
	if (!isAuthorized(request)) {
		return Response.json(
			{ error: "Antigravity checks require a same-origin LearnHarness request." },
			{ status: 403, headers: HEADERS },
		);
	}
	if (!enabled()) {
		return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers: HEADERS });
	}
	return Response.json(await inspect(), { headers: HEADERS });
}

export async function antigravityInstallResponse(
	request: Request,
	deps: {
		enabled?: () => boolean;
		binaryPath?: () => string | undefined;
		installer?: AntigravityInstallerManager;
		auth?: AntigravityAuthManager;
		models?: AntigravityModelsManager;
	} = {},
): Promise<Response> {
	if (request.method !== "POST" && request.method !== "DELETE") {
		return Response.json({ error: "Unsupported method." }, { status: 405, headers: HEADERS });
	}
	if (!isAuthorized(request)) {
		return Response.json(
			{ error: "Antigravity actions require a same-origin LearnHarness request." },
			{ status: 403, headers: HEADERS },
		);
	}
	const enabled = deps.enabled ?? antigravityEnabled;
	if (!enabled()) {
		return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers: HEADERS });
	}

	initAuthEnv();
	const installer = deps.installer ?? antigravityInstaller();
	const auth = deps.auth ?? antigravityAuth();
	const models = deps.models ?? antigravityModels();
	const getBinaryPath = deps.binaryPath ?? antigravityBinaryPath;

	if (request.method === "POST") {
		installer.startInstall();
		const status = await installer.getStatus({
			enabled: true,
			binaryPath: getBinaryPath() ?? null,
			auth: auth.getState(),
		});
		return Response.json({ ...status, models: models.getStatus() }, { status: 202, headers: HEADERS });
	}

	const removed = installer.remove();
	if (removed.conflict) {
		return Response.json({ error: "Installation is currently in progress." }, { status: 409, headers: HEADERS });
	}
	piModels();
	const status = await installer.getStatus({
		enabled: true,
		binaryPath: getBinaryPath() ?? null,
		auth: auth.getState(),
	});
	return Response.json({ ...status, models: models.getStatus(), removed: removed.removed }, { headers: HEADERS });
}

export async function antigravityAuthResponse(
	request: Request,
	deps: {
		enabled?: () => boolean;
		binaryPath?: () => string | undefined;
		installer?: AntigravityInstallerManager;
		auth?: AntigravityAuthManager;
		models?: AntigravityModelsManager;
		resolveRuntime?: (binaryPath?: string) => Promise<AntigravityResolutionResult>;
	} = {},
): Promise<Response> {
	if (request.method !== "POST" && request.method !== "DELETE") {
		return Response.json({ error: "Unsupported method." }, { status: 405, headers: HEADERS });
	}
	if (!isAuthorized(request)) {
		return Response.json(
			{ error: "Antigravity auth actions require a same-origin LearnHarness request." },
			{ status: 403, headers: HEADERS },
		);
	}
	const enabled = deps.enabled ?? antigravityEnabled;
	if (!enabled()) {
		return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers: HEADERS });
	}

	initAuthEnv();
	const installer = deps.installer ?? antigravityInstaller();
	const auth = deps.auth ?? antigravityAuth();
	const models = deps.models ?? antigravityModels();
	const getBinaryPath = deps.binaryPath ?? antigravityBinaryPath;
	const resolveRuntime = deps.resolveRuntime ?? ((bin?: string) => resolveAntigravityRuntime({ binaryPath: bin }));

	const respondWithStatus = async (authState: ReturnType<AntigravityAuthManager["getState"]>, httpStatus = 200) => {
		const status = await installer.getStatus({
			enabled: true,
			binaryPath: getBinaryPath() ?? null,
			auth: authState,
		});
		return Response.json({ ...status, models: models.getStatus() }, { status: httpStatus, headers: HEADERS });
	};

	const performLogout = async () => {
		try {
			const resolution = await resolveRuntime(getBinaryPath());
			const authState = await auth.logout(resolution.runtime);
			return respondWithStatus(authState, 200);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Could not sign out of Antigravity.";
			return Response.json({ error: msg }, { status: 502, headers: HEADERS });
		} finally {
			models.clearError();
			piModels();
		}
	};

	if (request.method === "DELETE") {
		return performLogout();
	}

	const parsed = await readBoundedJsonBody(request);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: parsed.status, headers: HEADERS });
	}
	if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
		return Response.json({ error: "Invalid JSON command." }, { status: 400, headers: HEADERS });
	}

	const body = parsed.body as Record<string, unknown>;
	const action = body.action;
	const attemptId = typeof body.attemptId === "string" && body.attemptId.trim() ? body.attemptId.trim() : undefined;

	if (action === "start") {
		const resolution = await resolveRuntime(getBinaryPath());
		if (!resolution.runtime) {
			return Response.json(
				{ error: resolution.error ?? "Install or configure an Antigravity runtime before signing in." },
				{ status: 409, headers: HEADERS },
			);
		}
		const authState = await auth.startAuth(resolution.runtime);
		const httpStatus = authState.phase === "starting" || authState.phase === "waiting" ? 202 : 200;
		return respondWithStatus(authState, httpStatus);
	}

	if (action === "callback") {
		if (typeof body.callbackUrl !== "string") {
			return Response.json({ error: "callbackUrl must be a string." }, { status: 400, headers: HEADERS });
		}
		try {
			const authState = await auth.submitCallback(body.callbackUrl, attemptId);
			return respondWithStatus(authState, 200);
		} catch (err) {
			if (err instanceof AntigravityAuthError) {
				return Response.json({ error: err.message }, { status: err.statusCode, headers: HEADERS });
			}
			const msg = err instanceof Error ? err.message : "Failed forwarding OAuth callback.";
			return Response.json({ error: msg }, { status: 500, headers: HEADERS });
		}
	}

	if (action === "cancel") {
		try {
			const authState = await auth.cancelAuth(attemptId);
			return respondWithStatus(authState, 200);
		} catch (err) {
			if (err instanceof AntigravityAuthError) {
				return Response.json({ error: err.message }, { status: err.statusCode, headers: HEADERS });
			}
			const msg = err instanceof Error ? err.message : "Could not cancel Antigravity sign-in.";
			return Response.json({ error: msg }, { status: 500, headers: HEADERS });
		}
	}

	if (action === "logout") {
		return performLogout();
	}

	return Response.json({ error: "Unsupported Antigravity auth action." }, { status: 400, headers: HEADERS });
}

export async function antigravityModelsResponse(
	request: Request,
	deps: {
		enabled?: () => boolean;
		binaryPath?: () => string | undefined;
		installer?: AntigravityInstallerManager;
		auth?: AntigravityAuthManager;
		models?: AntigravityModelsManager;
		resolveRuntime?: (binaryPath?: string) => Promise<AntigravityResolutionResult>;
	} = {},
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Unsupported method." }, { status: 405, headers: HEADERS });
	}
	if (!isAuthorized(request)) {
		return Response.json(
			{ error: "Antigravity model refresh requires a same-origin LearnHarness request." },
			{ status: 403, headers: HEADERS },
		);
	}
	const enabled = deps.enabled ?? antigravityEnabled;
	if (!enabled()) {
		return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers: HEADERS });
	}

	initAuthEnv();
	const installer = deps.installer ?? antigravityInstaller();
	const auth = deps.auth ?? antigravityAuth();
	const models = deps.models ?? antigravityModels();
	const getBinaryPath = deps.binaryPath ?? antigravityBinaryPath;
	const resolveRuntime = deps.resolveRuntime ?? ((bin?: string) => resolveAntigravityRuntime({ binaryPath: bin }));

	const authState = auth.getState();
	if (!authState.signedIn) {
		return Response.json(
			{ error: "Sign in with Google before refreshing Antigravity models." },
			{ status: 409, headers: HEADERS },
		);
	}

	const resolution = await resolveRuntime(getBinaryPath());
	if (!resolution.runtime) {
		return Response.json(
			{ error: resolution.error ?? "Install or configure an Antigravity runtime before refreshing models." },
			{ status: 409, headers: HEADERS },
		);
	}

	const result = await models.refresh(resolution.runtime);
	const status = await installer.getStatus({
		enabled: true,
		binaryPath: getBinaryPath() ?? null,
		auth: auth.getState(),
	});

	if (!result.ok) {
		return Response.json(
			{ ...status, models: result.status, error: result.error },
			{ status: 502, headers: HEADERS },
		);
	}

	return Response.json({ ...status, models: result.status }, { status: 200, headers: HEADERS });
}
