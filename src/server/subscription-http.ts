/**
 * Protected HTTP surface for instance subscription authorization.
 *
 * The browser/desktop settings panel is the only intended caller. This
 * module owns the transport guard, bounded body parsing, safe error
 * projection, and the per-service start-attempt rate window; app/api
 * routes stay one-line delegates so the policy is testable without a live
 * Next server.
 *
 * Security boundary: these routes are protected by same-origin/Host
 * checks plus a custom request header. They are NOT an authentication
 * system and do not make a public service safe. Remote deployments must
 * protect the entire service with VPN/SSH tunneling or authenticated
 * HTTPS, as documented in docs/subscription-deployment.md.
 */
import {
	subscriptionFailure,
	type SubscriptionErrorCode,
	type SubscriptionFailure,
	type SubscriptionMethod,
	type SubscriptionStatus,
} from "../core/subscription.ts";

/** The settings panel's same-origin guard header; the value must be exactly "1". */
export const SUBSCRIPTION_REQUEST_HEADER = "x-learnharness-subscription";
export const SUBSCRIPTION_REQUEST_VALUE = "1";
/** JSON bodies are capped before parsing, regardless of Content-Length. */
export const SUBSCRIPTION_BODY_LIMIT_BYTES = 16 * 1024;
/** Fixed-window cap for starting authorization attempts, per service. */
export const SUBSCRIPTION_START_LIMIT = { max: 10, windowMs: 60_000 } as const;

const JSON_CONTENT_TYPE = "application/json";
const NO_STORE = "no-store";
const SUPPLIER_HOST = "auth.openai.com";
const SUPPLIER_PATHS = new Set(["/oauth/authorize", "/codex/device"]);
const STATUS_STATES = new Set<SubscriptionStatus["state"]>([
	"disconnected",
	"authorizing",
	"connected",
	"reconnect_required",
	"error",
]);

/**
 * The narrow service surface these routes need. The live service gains
 * `reply` with the prompt-flow work; keeping the interface here prevents
 * the routes from reaching into the store or engine.
 */
export interface SubscriptionHttpService {
	status(): Promise<SubscriptionStatus>;
	start(method: SubscriptionMethod): Promise<SubscriptionStatus>;
	reply(id: string, promptId: string, input: string): Promise<SubscriptionStatus | void>;
	cancel(id: string): Promise<SubscriptionStatus>;
	disconnect(): Promise<SubscriptionStatus>;
}

export interface SubscriptionHttpOptions {
	/** Test seam for the fixed rate window. */
	now?: () => number;
	startLimit?: { max: number; windowMs: number };
	/** Shared key for the start window across Next route entries. */
	rateLimitKey?: string;
	/**
	 * Trusted public origin when an authenticated HTTPS proxy fronts the
	 * service. The proxy must preserve the browser Host header. Internal
	 * request URLs may use a different proxy-to-server origin.
	 */
	applicationOrigin?: string;
}

export interface SubscriptionHttpEnvironment {
	LH_SUBSCRIPTION_ORIGIN?: string;
}

export interface SubscriptionHttpHandlers {
	getStatus(request: Request): Promise<Response>;
	disconnect(request: Request): Promise<Response>;
	start(request: Request): Promise<Response>;
	cancel(request: Request, id: string): Promise<Response>;
	reply(request: Request, id: string): Promise<Response>;
}

class HttpProblem extends Error {
	constructor(
		readonly status: number,
		readonly code: SubscriptionErrorCode,
		readonly publicMessage?: string,
		readonly retryAfterSeconds?: number,
	) {
		super(code);
		this.name = "SubscriptionHttpProblem";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
	return /[\u0000-\u001F\u007F]/.test(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !hasControlCharacters(value);
}

function invalidInput(): never {
	throw new HttpProblem(400, "subscription_invalid_input");
}

const APPLICATION_ORIGIN_ERROR =
	"LH_SUBSCRIPTION_ORIGIN must be an http(s) origin without a path, credentials, query, or fragment";

/** Parse and normalize a trusted public origin at composition time. */
function parseApplicationOrigin(value: string): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new RangeError(APPLICATION_ORIGIN_ERROR);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RangeError(APPLICATION_ORIGIN_ERROR);
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!url.hostname ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new RangeError(APPLICATION_ORIGIN_ERROR);
	}
	return url.origin;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): void {
	const actual = Object.keys(value);
	if (actual.length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) invalidInput();
}

function requiredString(value: Record<string, unknown>, field: string, max: number): string {
	const candidate = value[field];
	if (!boundedString(candidate, max)) invalidInput();
	return candidate;
}

function pathIdentifier(value: unknown): string {
	if (!boundedString(value, 200)) invalidInput();
	return value;
}

function safeSupplierUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== SUPPLIER_HOST) return undefined;
		if (!SUPPLIER_PATHS.has(url.pathname)) return undefined;
		if (url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function knownFailure(value: unknown): SubscriptionFailure | null {
	if (typeof value !== "string") return null;
	// The core table is the single source of truth for codes/messages.
	const failure = subscriptionFailure(value as SubscriptionErrorCode);
	return typeof failure.message === "string" ? failure : null;
}

function projectAttempt(value: unknown): NonNullable<SubscriptionStatus["attempt"]> | undefined {
	if (!isRecord(value)) return undefined;
	const id = value.id;
	const method = value.method;
	const expiresAt = value.expiresAt;
	if (!boundedString(id, 200) || (method !== "browser" && method !== "device_code") || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
	const attempt: NonNullable<SubscriptionStatus["attempt"]> = {
		id,
		method,
		expiresAt,
		ownedHere: value.ownedHere === true,
	};
	const authorizationUrl = safeSupplierUrl(value.authorizationUrl);
	if (authorizationUrl) attempt.authorizationUrl = authorizationUrl;
	const verificationUri = safeSupplierUrl(value.verificationUri);
	if (verificationUri) attempt.verificationUri = verificationUri;
	if (boundedString(value.userCode, 64)) attempt.userCode = value.userCode;
	if (boundedString(value.promptId, 200)) attempt.promptId = value.promptId;
	if (typeof value.manualAvailable === "boolean") attempt.manualAvailable = value.manualAvailable;
	if (typeof value.callbackListening === "boolean") attempt.callbackListening = value.callbackListening;
	return attempt;
}

/**
 * Project the service DTO onto the public shape. Unknown fields, unsafe
 * supplier links, and provider-supplied error text never cross this seam.
 */
export function projectSubscriptionStatus(value: unknown): SubscriptionStatus {
	if (!isRecord(value) || typeof value.state !== "string" || !STATUS_STATES.has(value.state as SubscriptionStatus["state"])) {
		throw new HttpProblem(500, "subscription_unknown");
	}
	const status: SubscriptionStatus = { state: value.state as SubscriptionStatus["state"] };
	if (boundedString(value.account, 200)) status.account = value.account;
	const attempt = projectAttempt(value.attempt);
	if (attempt) status.attempt = attempt;
	if (isRecord(value.error)) {
		const failure = knownFailure(value.error.code);
		status.error = failure ?? subscriptionFailure("subscription_unknown");
	}
	return status;
}

import { subscriptionErrorCode as safeSubscriptionCode } from "./subscription-errors.ts";

function statusForCode(code: SubscriptionErrorCode): number {
	switch (code) {
		case "subscription_invalid_input": return 400;
		case "subscription_needs_login": return 401;
		case "subscription_limit": return 429;
		case "subscription_network": return 502;
		case "subscription_storage_error": return 503;
		case "subscription_unknown": return 500;
		default: return 409;
	}
}

function json(body: unknown, status: number, retryAfterSeconds?: number): Response {
	const headers = new Headers({
		"cache-control": NO_STORE,
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	if (retryAfterSeconds !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterSeconds))));
	return new Response(JSON.stringify(body), { status, headers });
}

function failureResponse(error: unknown): Response {
	if (error instanceof HttpProblem) {
		const failure = error.publicMessage
			? { code: error.code, message: error.publicMessage }
			: subscriptionFailure(error.code);
		return json({ error: failure }, error.status, error.retryAfterSeconds);
	}
	const code = safeSubscriptionCode(error);
	return json({ error: subscriptionFailure(code) }, statusForCode(code));
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

function effectivePort(url: URL): string {
	if (url.port) return url.port;
	return url.protocol === "https:" ? "443" : "80";
}

function assertRequestGuard(request: Request, mutation: boolean, applicationOrigin?: string): void {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		throw new HttpProblem(403, "subscription_invalid_input");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new HttpProblem(403, "subscription_invalid_input");
	}
	const host = request.headers.get("host");
	if (!host) throw new HttpProblem(403, "subscription_invalid_input");
	let rawAuthority: URL;
	try {
		// Normalize default ports using the browser-visible scheme, not the
		// internal proxy hop's scheme.
		const protocol = applicationOrigin === undefined ? url.protocol : new URL(applicationOrigin).protocol;
		rawAuthority = new URL(`${protocol}//${host}`);
	} catch {
		throw new HttpProblem(403, "subscription_invalid_input");
	}
	if (
		!rawAuthority.hostname ||
		rawAuthority.username ||
		rawAuthority.password ||
		rawAuthority.pathname !== "/" ||
		rawAuthority.search ||
		rawAuthority.hash
	) {
		throw new HttpProblem(403, "subscription_invalid_input");
	}
	const origin = request.headers.get("origin");
	if (applicationOrigin !== undefined) {
		// The proxy must preserve the browser's raw Host and Origin. The
		// request URL may instead describe the internal proxy-to-server hop.
		const configured = new URL(applicationOrigin);
		if (rawAuthority.host.toLowerCase() !== configured.host.toLowerCase()) {
			throw new HttpProblem(403, "subscription_invalid_input");
		}
		if (mutation) {
			if (!origin || origin !== applicationOrigin) throw new HttpProblem(403, "subscription_invalid_input");
		} else if (origin !== null && origin !== applicationOrigin) {
			throw new HttpProblem(403, "subscription_invalid_input");
		}
	} else {
		// Next normalizes loopback URL authorities (127.0.0.1, [::1]) to
		// localhost while preserving the raw Host header. Accept that
		// documented normalization only for explicit loopback aliases on the
		// same port.
		const sameAuthority = rawAuthority.host.toLowerCase() === url.host.toLowerCase();
		const loopbackAlias =
			isLoopbackHostname(rawAuthority.hostname) &&
			isLoopbackHostname(url.hostname) &&
			effectivePort(rawAuthority) === effectivePort(url);
		if (!sameAuthority && !loopbackAlias) {
			throw new HttpProblem(403, "subscription_invalid_input");
		}
		// Same-origin GETs generally omit Origin; when it is present it must
		// match the raw Host authority and request protocol exactly. The
		// normalized URL authority is never used as the browser origin.
		if (mutation) {
			if (!origin || origin !== rawAuthority.origin) throw new HttpProblem(403, "subscription_invalid_input");
		} else if (origin !== null && origin !== rawAuthority.origin) {
			throw new HttpProblem(403, "subscription_invalid_input");
		}
	}
	if (request.headers.get(SUBSCRIPTION_REQUEST_HEADER) !== SUBSCRIPTION_REQUEST_VALUE) {
		throw new HttpProblem(403, "subscription_invalid_input");
	}
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("content-type");
	if (!contentType || contentType.split(";", 1)[0]!.trim().toLowerCase() !== JSON_CONTENT_TYPE) {
		throw new HttpProblem(415, "subscription_invalid_input");
	}
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0) invalidInput();
		if (length > SUBSCRIPTION_BODY_LIMIT_BYTES) throw new HttpProblem(413, "subscription_invalid_input");
	}
	if (!request.body) invalidInput();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > SUBSCRIPTION_BODY_LIMIT_BYTES) {
				await reader.cancel().catch(() => {});
				throw new HttpProblem(413, "subscription_invalid_input");
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		if (error instanceof HttpProblem) throw error;
		invalidInput();
	}
	if (total === 0) invalidInput();
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		invalidInput();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		invalidInput();
	}
	if (!isRecord(parsed)) invalidInput();
	return parsed;
}

function parseStartBody(body: Record<string, unknown>): SubscriptionMethod {
	exactFields(body, ["method"]);
	const method = body.method;
	if (method !== "browser" && method !== "device_code") invalidInput();
	return method;
}

function parseReplyBody(body: Record<string, unknown>): { promptId: string; value: string } {
	exactFields(body, ["promptId", "value"]);
	const promptId = requiredString(body, "promptId", 200);
	const rawValue = requiredString(body, "value", SUBSCRIPTION_BODY_LIMIT_BYTES);
	const value = rawValue.trim();
	if (!value) invalidInput();
	// The manual browser fallback is a complete loopback callback URL.
	// Reject anything else before the service/SDK sees it.
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		invalidInput();
	}
	if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) invalidInput();
	if (url.port !== "1455" || url.pathname !== "/auth/callback") invalidInput();
	if (url.username !== "" || url.password !== "" || url.hash !== "") invalidInput();
	if (url.searchParams.has("error") || url.searchParams.has("error_description")) invalidInput();
	const codes = url.searchParams.getAll("code");
	const states = url.searchParams.getAll("state");
	if (codes.length !== 1 || !boundedString(codes[0], 4096) || states.length !== 1 || !boundedString(states[0], 4096)) invalidInput();
	return { promptId, value };
}

const limiterRegistry = globalThis as typeof globalThis & { __lhSubscriptionStartLimiters?: Map<string, () => number | null> };

function sharedStartLimiter(options: SubscriptionHttpOptions): () => number | null {
	const key = options.rateLimitKey;
	if (!key) throw new RangeError("rateLimitKey is required");
	const registry = limiterRegistry.__lhSubscriptionStartLimiters ??= new Map();
	let limiter = registry.get(key);
	if (!limiter) {
		limiter = createStartLimiter(options);
		registry.set(key, limiter);
	}
	return limiter;
}

function createStartLimiter(options: SubscriptionHttpOptions): () => number | null {
	const max = options.startLimit?.max ?? SUBSCRIPTION_START_LIMIT.max;
	const windowMs = options.startLimit?.windowMs ?? SUBSCRIPTION_START_LIMIT.windowMs;
	if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
		throw new RangeError("startLimit must contain positive safe integers");
	}
	const now = options.now ?? Date.now;
	let windowStart = now();
	let count = 0;
	return () => {
		const current = now();
		// A backwards clock adjustment starts a fresh window rather than
		// locking the service out indefinitely.
		if (current < windowStart || current - windowStart >= windowMs) {
			windowStart = current;
			count = 0;
		}
		if (count >= max) return Math.max(1, Math.ceil((windowStart + windowMs - current) / 1000));
		count += 1;
		return null;
	};
}

/**
 * Build independent handlers. Tests inject a service and clock; routes use
 * one handler set per live service so the start window is shared.
 */
export function createSubscriptionHttpHandlers(
	service: SubscriptionHttpService,
	options: SubscriptionHttpOptions = {},
): SubscriptionHttpHandlers {
	const consumeStart = options.rateLimitKey ? sharedStartLimiter(options) : createStartLimiter(options);
	const applicationOrigin = options.applicationOrigin === undefined
		? undefined
		: parseApplicationOrigin(options.applicationOrigin);

	async function guarded<T>(request: Request, mutation: boolean, operation: () => Promise<T>): Promise<T> {
		assertRequestGuard(request, mutation, applicationOrigin);
		return operation();
	}

	return {
		async getStatus(request) {
			try {
				return await guarded(request, false, async () => json(projectSubscriptionStatus(await service.status()), 200));
			} catch (error) {
				return failureResponse(error);
			}
		},
		async disconnect(request) {
			try {
				return await guarded(request, true, async () => json(projectSubscriptionStatus(await service.disconnect()), 200));
			} catch (error) {
				return failureResponse(error);
			}
		},
		async start(request) {
			try {
				return await guarded(request, true, async () => {
					const method = parseStartBody(await readJsonObject(request));
					const retryAfter = consumeStart();
					if (retryAfter !== null) {
						throw new HttpProblem(429, "subscription_unknown", "Too many authorization attempts. Try again later.", retryAfter);
					}
					return json(projectSubscriptionStatus(await service.start(method)), 202);
				});
			} catch (error) {
				return failureResponse(error);
			}
		},
		async cancel(request, id) {
			try {
				return await guarded(request, true, async () => {
					const attemptId = pathIdentifier(id);
					return json(projectSubscriptionStatus(await service.cancel(attemptId)), 200);
				});
			} catch (error) {
				return failureResponse(error);
			}
		},
		async reply(request, id) {
			try {
				return await guarded(request, true, async () => {
					const attemptId = pathIdentifier(id);
					const { promptId, value } = parseReplyBody(await readJsonObject(request));
					const result = await service.reply(attemptId, promptId, value);
					const status = result === undefined || result === null ? await service.status() : result;
					return json(projectSubscriptionStatus(status), 200);
				});
			} catch (error) {
				return failureResponse(error);
			}
		},
	};
}

/**
 * Compose handlers once from the explicit deployment environment. This is the
 * only place that reads `LH_SUBSCRIPTION_ORIGIN`; route entries stay thin and
 * cannot silently drift to different proxy policies.
 */
export function createSubscriptionHttpHandlersFromEnvironment(
	service: SubscriptionHttpService,
	options: SubscriptionHttpOptions = {},
	environment: SubscriptionHttpEnvironment = { LH_SUBSCRIPTION_ORIGIN: process.env.LH_SUBSCRIPTION_ORIGIN },
): SubscriptionHttpHandlers {
	const configured = environment.LH_SUBSCRIPTION_ORIGIN;
	return createSubscriptionHttpHandlers(service, {
		...options,
		...(configured === undefined ? {} : { applicationOrigin: configured }),
	});
}

