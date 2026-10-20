/**
 * Subscription credential shapes and strict validators.
 *
 * The approved implementation plan (2026-10-19, issue #8) fixes a single
 * OAuth credential shape for the legacy Codex route. This module is the
 * one place that decides whether bytes on disk are a valid envelope or
 * refresh journal; every read and every save goes through it. Unknown
 * versions, unknown fields and malformed values are storage errors, never
 * coerced into "no credential yet".
 *
 * No validator message contains a field value. Field names are included
 * only as ordinary identifiers, so a corrupt file cannot smuggle a token
 * into an error message or log line.
 */

export const SUBSCRIPTION_STATE_FILE = "subscription-auth.json";
export const SUBSCRIPTION_JOURNAL_FILE = "subscription-refresh-journal.json";
export const SUBSCRIPTION_LOCK_DIR = ".subscription-auth.lock";

export type SubscriptionStorageErrorCode =
	| "invalid_directory"
	| "unsafe_permissions"
	| "unsafe_file_type"
	| "invalid_json"
	| "invalid_state"
	| "invalid_journal"
	| "io"
	| "lock_unavailable"
	| "lock_ownership"
	| "transaction_nested"
	| "no_credential"
	| "journal_exists"
	| "journal_required"
	| "journal_mismatch"
	| "not_disconnected";

/**
 * A safe storage failure. `message` is deliberately fixed prose: raw
 * filesystem messages, paths and persisted values never reach callers.
 * `systemCode` carries only a code-shaped errno such as EACCES.
 */
export class SubscriptionStorageError extends Error {
	readonly code: SubscriptionStorageErrorCode;
	readonly systemCode: string | undefined;

	constructor(code: SubscriptionStorageErrorCode, message: string, systemCode?: string) {
		super(message);
		this.name = "SubscriptionStorageError";
		this.code = code;
		this.systemCode = systemCode;
	}

	static fromSystem(
		error: unknown,
		code: SubscriptionStorageErrorCode,
		message: string,
	): SubscriptionStorageError {
		return new SubscriptionStorageError(code, message, systemCodeOf(error));
	}
}

function systemCodeOf(error: unknown): string | undefined {
	const candidate = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return typeof candidate === "string" && /^[A-Z0-9_]+$/.test(candidate) ? candidate : undefined;
}

/** Stable local process identity used by the lock and persisted attempts. */
export interface StoreOwner {
	readonly host: string;
	readonly pid: number;
	readonly nonce: string;
	readonly processBirth: string;
}

export type SubscriptionLoginMethod = "browser" | "device_code";

/**
 * The only accepted credential. The approved route is legacy
 * `openai-codex`; there is no provider discriminator or second shape.
 */
export interface OAuthCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly accountId: string;
}

export interface SubscriptionAttempt {
	readonly id: string;
	readonly generation: string;
	readonly owner: StoreOwner;
	readonly expiresAt: number;
	readonly method: SubscriptionLoginMethod;
}

/**
 * The complete durable state. A tombstone is this exact shape with no
 * credential (and normally no attempt) and a new generation: generation
 * survives disconnect so a late commit cannot reuse an old fence.
 */
export interface SubscriptionEnvelope {
	readonly version: 1;
	readonly generation: string;
	readonly credential?: OAuthCredential;
	readonly attempt?: SubscriptionAttempt;
}

/**
 * Nonsecret evidence that a refresh may have rotated the remote token.
 * It contains no access token, refresh token or account identifier.
 */
export interface RefreshJournal {
	readonly version: 1;
	readonly generation: string;
	readonly operationId: string;
}

const ENVELOPE_KEYS = ["version", "generation", "credential", "attempt"] as const;
const CREDENTIAL_KEYS = ["type", "access", "refresh", "expires", "accountId"] as const;
const ATTEMPT_KEYS = ["id", "generation", "owner", "expiresAt", "method"] as const;
const OWNER_KEYS = ["host", "pid", "nonce", "processBirth"] as const;
const JOURNAL_KEYS = ["version", "generation", "operationId"] as const;
const LOGIN_METHODS: readonly SubscriptionLoginMethod[] = ["browser", "device_code"];

function plainObject(
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new SubscriptionStorageError("invalid_state", `${label} is not an object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new SubscriptionStorageError("invalid_state", `${label} is not a plain object.`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new SubscriptionStorageError("invalid_state", `${label} has an unknown field.`);
		}
	}
}

function requiredString(value: unknown, field: string, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new SubscriptionStorageError("invalid_state", `${label} field ${field} is invalid.`);
	}
	return value;
}

function requiredFiniteNumber(value: unknown, field: string, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new SubscriptionStorageError("invalid_state", `${label} field ${field} is invalid.`);
	}
	return value;
}

function requiredVersion(value: unknown, label: string): 1 {
	if (value !== 1) {
		throw new SubscriptionStorageError("invalid_state", `${label} version is unsupported.`);
	}
	return 1;
}

export function validateStoreOwner(value: unknown): StoreOwner {
	const object = plainObject(value, "Subscription owner");
	rejectUnknownKeys(object, OWNER_KEYS, "Subscription owner");
	const pid = requiredFiniteNumber(object.pid, "pid", "Subscription owner");
	if (!Number.isInteger(pid)) {
		throw new SubscriptionStorageError("invalid_state", "Subscription owner field pid is invalid.");
	}
	return Object.freeze({
		host: requiredString(object.host, "host", "Subscription owner"),
		pid,
		nonce: requiredString(object.nonce, "nonce", "Subscription owner"),
		processBirth: requiredString(object.processBirth, "processBirth", "Subscription owner"),
	});
}

export function validateOAuthCredential(value: unknown): OAuthCredential {
	const object = plainObject(value, "Subscription credential");
	rejectUnknownKeys(object, CREDENTIAL_KEYS, "Subscription credential");
	if (object.type !== "oauth") {
		throw new SubscriptionStorageError(
			"invalid_state",
			"Subscription credential type is unsupported.",
		);
	}
	return Object.freeze({
		type: "oauth" as const,
		access: requiredString(object.access, "access", "Subscription credential"),
		refresh: requiredString(object.refresh, "refresh", "Subscription credential"),
		expires: requiredFiniteNumber(object.expires, "expires", "Subscription credential"),
		accountId: requiredString(object.accountId, "accountId", "Subscription credential"),
	});
}

export function validateSubscriptionAttempt(value: unknown): SubscriptionAttempt {
	const object = plainObject(value, "Subscription attempt");
	rejectUnknownKeys(object, ATTEMPT_KEYS, "Subscription attempt");
	const method = object.method;
	if (typeof method !== "string" || !LOGIN_METHODS.includes(method as SubscriptionLoginMethod)) {
		throw new SubscriptionStorageError("invalid_state", "Subscription attempt method is invalid.");
	}
	return Object.freeze({
		id: requiredString(object.id, "id", "Subscription attempt"),
		generation: requiredString(object.generation, "generation", "Subscription attempt"),
		owner: validateStoreOwner(object.owner),
		expiresAt: requiredFiniteNumber(object.expiresAt, "expiresAt", "Subscription attempt"),
		method: method as SubscriptionLoginMethod,
	});
}

export function validateEnvelope(value: unknown): SubscriptionEnvelope {
	const object = plainObject(value, "Subscription state");
	rejectUnknownKeys(object, ENVELOPE_KEYS, "Subscription state");
	const version = requiredVersion(object.version, "Subscription state");
	const generation = requiredString(object.generation, "generation", "Subscription state");
	const credential =
		object.credential === undefined ? undefined : validateOAuthCredential(object.credential);
	const attempt =
		object.attempt === undefined ? undefined : validateSubscriptionAttempt(object.attempt);
	if (attempt && attempt.generation !== generation) {
		throw new SubscriptionStorageError(
			"invalid_state",
			"Subscription attempt generation does not match the state generation.",
		);
	}
	return Object.freeze({
		version,
		generation,
		...(credential ? { credential } : {}),
		...(attempt ? { attempt } : {}),
	});
}

export function validateJournal(value: unknown): RefreshJournal {
	const object = plainObject(value, "Refresh journal");
	rejectUnknownKeys(object, JOURNAL_KEYS, "Refresh journal");
	const version = requiredVersion(object.version, "Refresh journal");
	return Object.freeze({
		version,
		generation: requiredString(object.generation, "generation", "Refresh journal"),
		operationId: requiredString(object.operationId, "operationId", "Refresh journal"),
	});
}
