/**
 * What the app may PRINT about anything Claude Code reports (Local Claude
 * route, owner decisions 2026-10-28). Claude Code's own text — an error
 * result's `errors`, an API error's `result`, a control request's error,
 * a startup failure (whose `errors` the SDK documents as "the same text as
 * stderr") — can carry anything it prints about its login, and every
 * server log line persists (Electron copies the server's output into
 * main.log). So logs and the card's status.error carry only values the
 * SDK itself chose, each checked against its documented set or a strict
 * shape here; the raw text stays in memory for the wording classifiers
 * (run.ts claudeLocalError, the probe's sign-in regex) and is discarded.
 *
 * The same discipline covers the short strings Claude Code reports that
 * the SDK types as enums but never checks at runtime (subscriptionType,
 * apiKeySource, apiProvider, model ids, MCP status, rate-limit fields).
 */

/** The `errorClass` values the SDK stamps on its own errors (sdk.mjs). */
const ERROR_CLASSES = new Set(["aborted", "control_request_failed", "error_result", "executable_not_found", "executable_launch_failed", "initialize_timeout", "process_exited_nonzero", "process_killed_by_signal", "spawn_failed", "process_error"]);
/** SDKResultMessage subtypes. */
const RESULT_SUBTYPES = new Set(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);
/** TerminalReason (sdk.d.ts). */
const TERMINAL_REASONS = new Set(["blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error", "model_error", "api_error", "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools", "stop_hook_prevented", "hook_stopped", "tool_deferred", "max_turns", "background_requested", "completed", "budget_exhausted", "structured_output_retry_exhausted", "tool_deferred_unavailable", "turn_setup_failed"]);
/** SDKStartupFailureReason (sdk.d.ts). */
const STARTUP_FAILURE_REASONS = new Set(["org_pin_api_key_conflict", "provider_not_allowed", "org_verify_failed", "org_pin_mismatch", "managed_settings_invalid", "remote_settings_required_unavailable", "gateway_signin_required", "gateway_access_denied", "proxy_invalid", "temp_dir_unusable", "cwd_unavailable", "shell_tool_missing", "session_held_by_background", "worktree_resume_refused", "worktree_unverified", "cli_version_too_old", "bypass_root", "org_config_required_unavailable", "org_config_refused"]);
/** SDKAssistantMessageError (sdk.d.ts): the class of a synthetic API-failure message. */
const ASSISTANT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"]);
/** ApiKeySource and AccountInfo.apiProvider (sdk.d.ts). */
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key", "none", "user", "project", "org", "temporary", "oauth"]);
const API_PROVIDERS = new Set(["firstParty", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway"]);
/** McpServerStatus.status (sdk.d.ts). */
const MCP_STATUSES = new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);
/** SDKRateLimitInfo (sdk.d.ts). */
const RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const RATE_LIMIT_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]);

/** What a value outside its documented set or shape reads as. */
export const UNRECOGNIZED = "unrecognized";

const SIGNAL = /^SIG[A-Z0-9]{1,8}$/;
/** Node's system error codes (ENOENT, ERR_MODULE_NOT_FOUND…). */
const NODE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The SDK keeps a CLI-sent control error code only in this shape (sdk.mjs). */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A short identifier Claude Code reports (a plan name, a model id). */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9 ._:[\]-]{0,63}$/;

function member(set: ReadonlySet<string>, value: unknown): string | undefined { return typeof value === "string" && set.has(value) ? value : undefined; }
function shaped(shape: RegExp, value: unknown): string | undefined { return typeof value === "string" && shape.test(value) ? value : undefined; }

/** The stable facts of one failure: nothing here is free text. */
export interface FailureFields {
	errorClass?: string;
	exitCode?: number;
	signal?: string;
	code?: string;
	errorCode?: string;
	subtype?: string;
	terminalReason?: string;
	startupFailureReason?: string;
	apiErrorStatus?: number;
	assistantError?: string;
	/** An Error's class name, used only when nothing else is known. */
	name?: string;
	/** The app's own probe outcomes (src/server/claude-local.ts probeAccount):
	 *  no answer within the bound, or Claude Code ended before answering. */
	probeOutcome?: "timeout" | "exited_before_answering";
	probeTimeoutMs?: number;
}

/** The stable fields of a thrown error (an SDK error carries errorClass,
 *  exitCode, signal, errorCode; a Node error its code). A `fields`
 *  property (a probe failure that saw the startup result) is merged in. */
export function errorFields(error: unknown): FailureFields {
	if (!error || typeof error !== "object") return {};
	const e = error as { errorClass?: unknown; exitCode?: unknown; signal?: unknown; code?: unknown; errorCode?: unknown; name?: unknown; probeOutcome?: unknown; probeTimeoutMs?: unknown; fields?: FailureFields };
	return {
		...(member(ERROR_CLASSES, e.errorClass) ? { errorClass: e.errorClass as string } : {}),
		...(Number.isInteger(e.exitCode) ? { exitCode: e.exitCode as number } : {}),
		...(shaped(SIGNAL, e.signal) ? { signal: e.signal as string } : {}),
		...(shaped(NODE_CODE, e.code) ? { code: e.code as string } : {}),
		...(shaped(ERROR_CODE, e.errorCode) ? { errorCode: e.errorCode as string } : {}),
		...(shaped(/^[A-Za-z]{0,40}Error$/, e.name) ? { name: e.name as string } : {}),
		...(e.probeOutcome === "timeout" || e.probeOutcome === "exited_before_answering" ? { probeOutcome: e.probeOutcome } : {}),
		...(Number.isInteger(e.probeTimeoutMs) ? { probeTimeoutMs: e.probeTimeoutMs as number } : {}),
		...(e.fields ?? {}),
	};
}

/** The stable fields of an SDK result message. */
export function resultFields(message: { subtype?: unknown; terminal_reason?: unknown; startup_failure_reason?: unknown; api_error_status?: unknown } | undefined): FailureFields {
	if (!message) return {};
	return {
		...(member(RESULT_SUBTYPES, message.subtype) ? { subtype: message.subtype as string } : {}),
		...(member(TERMINAL_REASONS, message.terminal_reason) ? { terminalReason: message.terminal_reason as string } : {}),
		...(member(STARTUP_FAILURE_REASONS, message.startup_failure_reason) ? { startupFailureReason: message.startup_failure_reason as string } : {}),
		...(Number.isInteger(message.api_error_status) ? { apiErrorStatus: message.api_error_status as number } : {}),
	};
}

/** A synthetic API-failure assistant message's class, if documented. */
export function assistantErrorField(error: unknown): FailureFields {
	const value = member(ASSISTANT_ERRORS, error);
	return value ? { assistantError: value } : {};
}

/** The server-log rendering: every stable field, e.g.
 *  "process_exited_nonzero, exit code 2" or
 *  "error_during_execution, startup failure: managed_settings_invalid". */
export function describeFailure(fields: FailureFields): string {
	const parts = [
		fields.probeOutcome === "timeout" ? "timeout" : fields.probeOutcome === "exited_before_answering" ? "exited before answering" : undefined,
		fields.errorClass, fields.subtype, fields.assistantError,
		fields.terminalReason && fields.terminalReason !== "completed" ? `terminal reason ${fields.terminalReason}` : undefined,
		fields.startupFailureReason ? `startup failure: ${fields.startupFailureReason}` : undefined,
		fields.apiErrorStatus !== undefined ? `API status ${fields.apiErrorStatus}` : undefined,
		fields.exitCode !== undefined ? `exit code ${fields.exitCode}` : undefined,
		fields.signal ? `signal ${fields.signal}` : undefined,
		fields.code,
		fields.errorCode ? `error code ${fields.errorCode}` : undefined,
	].filter(Boolean);
	if (parts.length === 0) return fields.name ? `unclassified failure (${fields.name})` : "unclassified failure";
	return parts.join(", ");
}

/** The card's suffix for a failure: only the facts a user can act on
 *  ("exit code 2", "startup failure: managed_settings_invalid"), or "" when
 *  there are none. */
export function failureSuffix(fields: FailureFields): string {
	return [
		fields.probeOutcome === "timeout" ? `no answer within ${Math.max(1, Math.round((fields.probeTimeoutMs ?? 20_000) / 1000))} s` : fields.probeOutcome === "exited_before_answering" ? "exited before answering" : undefined,
		fields.startupFailureReason ? `startup failure: ${fields.startupFailureReason}` : undefined,
		fields.errorClass === "control_request_failed" && fields.errorCode ? `control request failed: ${fields.errorCode}` : undefined,
		fields.exitCode !== undefined ? `exit code ${fields.exitCode}` : undefined,
		fields.signal ? `signal ${fields.signal}` : undefined,
		fields.code,
	].filter(Boolean).join(", ");
}

// ─── reported identifiers ───────────────────────────────────────────────────

/** A plan name / short label Claude Code reports, or "unrecognized". */
export function reportedIdentifier(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return shaped(IDENTIFIER, value) ?? UNRECOGNIZED;
}
/** A model id Claude Code reports, or undefined when it is not one. */
export function reportedModelId(value: unknown): string | undefined { return shaped(IDENTIFIER, value); }
export function reportedApiKeySource(value: unknown): string | undefined { return value === undefined || value === null || value === "" ? undefined : member(API_KEY_SOURCES, value) ?? UNRECOGNIZED; }
export function reportedApiProvider(value: unknown): string | undefined { return value === undefined || value === null || value === "" ? undefined : member(API_PROVIDERS, value) ?? UNRECOGNIZED; }
export function reportedMcpStatus(value: unknown): string | undefined { return value === undefined || value === null ? undefined : member(MCP_STATUSES, value) ?? UNRECOGNIZED; }
export function reportedRateLimitStatus(value: unknown): "allowed" | "allowed_warning" | "rejected" | undefined { return member(RATE_LIMIT_STATUSES, value) as "allowed" | "allowed_warning" | "rejected" | undefined; }
export function reportedRateLimitType(value: unknown): string | undefined { return value === undefined || value === null || value === "" ? undefined : member(RATE_LIMIT_TYPES, value) ?? UNRECOGNIZED; }
/** A finite number, or undefined. */
export function reportedNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

// ─── the LH_PROVIDER_EVENTS recorder ───────────────────────────────────────

/** The recorder's placeholder for Claude Code's own diagnostic text. */
export function redacted(value: unknown): { __redacted: "child text"; chars: number } {
	return { __redacted: "child text", chars: typeof value === "string" ? value.length : 0 };
}
const redactAll = (values: unknown): unknown => Array.isArray(values) ? values.map(redacted) : values === undefined ? undefined : redacted(values);
/** Every string anywhere in a value replaced; numbers, booleans and null kept. */
function redactStrings(value: unknown): unknown {
	if (typeof value === "string") return redacted(value);
	if (Array.isArray(value)) return value.map(redactStrings);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactStrings(inner)]));
	return value;
}
/** The text blocks of an `assistant` frame replaced (an API-error message,
 *  or a never-streamed message a failure closed — run.ts). */
export function redactedAssistantText(message: unknown): unknown {
	const m = message as Record<string, unknown>;
	const inner = m.message as { content?: unknown } | undefined;
	const content = Array.isArray(inner?.content) ? inner.content.map((block) => block && typeof block === "object" && "text" in block ? { ...block, text: redacted((block as { text?: unknown }).text) } : block) : inner?.content;
	return { ...m, message: { ...inner, content } };
}
/** The string fields of a `system` frame kept raw: documented enums and ids
 *  only (owner decision 2026-10-28: allowlist, redact the rest — so a new
 *  SDK subtype is redacted by default). */
const SYSTEM_KEEP: Record<string, readonly string[]> = {
	"*": ["type", "subtype", "uuid", "session_id"],
	init: ["model", "apiKeySource", "permissionMode", "cwd", "claude_code_version", "tools", "mcp_servers"],
	api_retry: ["error"],
	status: ["status", "permissionMode"],
};
function redactedSystem(m: Record<string, unknown>): Record<string, unknown> {
	const keep = new Set([...SYSTEM_KEEP["*"]!, ...(SYSTEM_KEEP[String(m.subtype)] ?? [])]);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(m)) {
		if (!keep.has(key)) { out[key] = redactStrings(value); continue; }
		// mcp_servers: each server's name, status and source; anything else it carries is redacted.
		out[key] = key === "mcp_servers" && Array.isArray(value)
			? value.map((server) => Object.fromEntries(Object.entries((server ?? {}) as Record<string, unknown>).map(([field, inner]) => [field, field === "name" || field === "status" || field === "source" ? inner : redactStrings(inner)])))
			: value;
	}
	return out;
}

/** A copy of one raw SDK message for the opt-in LH_PROVIDER_EVENTS recorder
 *  (owner decisions 2026-10-28): Claude Code's own error and diagnostic text
 *  — an error result's `errors`, an API error's `result`, the text of a
 *  synthetic API-error message, auth status output and errors, and every
 *  string of a `system` frame but its documented enums and ids (plugin
 *  errors, hook output, informational and notification text, a mirror
 *  error…) — is replaced by `{ __redacted, chars }`; model output, prompts
 *  and everything else stay raw, as the recorder records every other
 *  provider. (A never-streamed message's frames wait in run.ts until the
 *  message closes: a failure close redacts their text too.) */
export function redactedForRecorder(message: unknown): unknown {
	if (!message || typeof message !== "object") return message;
	const m = message as Record<string, unknown> & { type?: unknown; subtype?: unknown };
	if (m.type === "result") {
		return { ...m, ...(m.errors !== undefined ? { errors: redactAll(m.errors) } : {}), ...(m.is_error === true && m.result !== undefined ? { result: redacted(m.result) } : {}) };
	}
	if (m.type === "assistant" && m.error !== undefined) return redactedAssistantText(m);
	if (m.type === "auth_status") return { ...m, ...(m.output !== undefined ? { output: redactAll(m.output) } : {}), ...(m.error !== undefined ? { error: redacted(m.error) } : {}) };
	if (m.type === "system") return redactedSystem(m);
	return message;
}
