/** Opt-in behavioral captures: one last request/reply pair per background worker run.
 * LH_BACKGROUND_CAPTURE=auditor,extractor (or all). Private diagnostic content;
 * never a credential/header recorder, retention policy, or worker recovery store.
 */
import * as fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import path from "node:path";
import { PATHS, type ModelRole } from "../../config.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, ToolResultMessage } from "@earendil-works/pi-ai";

type CaptureModel = Pick<Model<Api>, "provider" | "id" | "api">;
interface Timing {
	turn: number;
	startedAt: number;
	headersReceivedAt?: number;
	responseStatus?: number;
	finishedAt?: number;
}
interface CaptureRecord {
	version: 1;
	runId: string;
	role: ModelRole;
	sourceId?: string;
	startedAt: number;
	finishedAt?: number;
	timings: Timing[];
	request: {
		turn: number;
		model: CaptureModel;
		thinkingLevel: string;
		format: "context" | "provider";
		payload: unknown;
	} | null;
	response: { receivedAt: number; message: unknown } | null;
	toolResults: unknown[];
	error: unknown;
}

/** Test seam; production always follows the configured app data root. */
export const backgroundCaptureDir = { current: path.join(PATHS.debug, "background-captures") };

export function backgroundCaptureEnabled(role: ModelRole): boolean {
	const selected = process.env.LH_BACKGROUND_CAPTURE?.split(",").map((value) => value.trim());
	return selected?.includes("all") === true || selected?.includes(role) === true;
}

// Headers and credential fields are not part of behavioral inspection, including
// when a provider nests HTTP options inside its payload. Never read auth/env keys.
const PRIVATE_FIELD = /^(?:headers|authorization|proxyauthorization|apikey|accesstoken|refreshtoken|clientsecret|credentials|password|token)$/i;
function snapshot(value: unknown): unknown {
	try {
		const json = JSON.stringify(value, (key, item: unknown) =>
			PRIVATE_FIELD.test(key.replace(/[-_]/g, "")) ? "[redacted]" : item);
		return json === undefined ? null : JSON.parse(json) as unknown;
	} catch {
		return { captureError: "Value could not be serialized." };
	}
}
function describeError(value: unknown, depth = 0): unknown {
	if (!(value instanceof Error)) return snapshot(value);
	return {
		name: value.name,
		message: value.message,
		...("code" in value ? { code: snapshot(value.code) } : {}),
		...(value.cause === undefined ? {} : { cause: depth < 4 ? describeError(value.cause, depth + 1) : "[cause omitted]" }),
	};
}

export function createBackgroundCapture(input: { role: ModelRole; runId: string; sourceId?: string }) {
	if (!backgroundCaptureEnabled(input.role)) return undefined;
	const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
	const file = path.join(backgroundCaptureDir.current, `${safe(input.role)}-${safe(input.runId)}.json`);
	const temporary = `${file}.tmp`;
	const record: CaptureRecord = {
		version: 1, ...input, startedAt: Date.now(), timings: [],
		request: null, response: null, toolResults: [], error: null,
	};
	let warned = false;
	function write() {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(temporary, file);
		} catch {
			try { fs.unlinkSync(temporary); } catch { /* Nothing to remove. */ }
			if (!warned) {
				warned = true;
				console.warn("Background capture could not be saved; the worker will continue normally.");
			}
		}
	}
	const modelIdentity = (model: CaptureModel): CaptureModel => ({ provider: model.provider, id: model.id, api: model.api });
	return {
		begin(model: CaptureModel, context: unknown, thinkingLevel?: string) {
			const turn = record.timings.length + 1;
			record.timings.push({ turn, startedAt: Date.now() });
			record.request = { turn, model: modelIdentity(model), thinkingLevel: thinkingLevel ?? "off", format: "context", payload: snapshot(context) };
			// Never pair a new failed request with the previous turn's successful reply.
			record.response = null;
			record.toolResults = [];
			record.error = null;
			write();
		},
		payload(payload: unknown, model: CaptureModel) {
			if (!record.request) return;
			record.request.model = modelIdentity(model);
			record.request.format = "provider";
			record.request.payload = snapshot(payload);
			write();
		},
		headers(status: number) {
			const timing = record.timings.at(-1);
			if (timing) { timing.headersReceivedAt = Date.now(); timing.responseStatus = status; }
			write();
		},
		reply(message: AssistantMessage) {
			const at = Date.now();
			record.response = { receivedAt: at, message: snapshot(message) };
			const timing = record.timings.at(-1);
			if (timing) timing.finishedAt = at;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				record.error = { name: message.stopReason === "aborted" ? "AbortError" : "Error", message: message.errorMessage ?? message.stopReason };
			}
			write();
		},
		toolResult(message: ToolResultMessage) {
			record.toolResults.push(snapshot(message));
			write();
		},
		finish(error?: unknown) {
			record.finishedAt = Date.now();
			if (error !== undefined) record.error = describeError(error);
			const timing = record.timings.at(-1);
			if (timing && timing.finishedAt === undefined) timing.finishedAt = record.finishedAt;
			write();
		},
	};
}

export type BackgroundCapture = NonNullable<ReturnType<typeof createBackgroundCapture>>;
// Next dev can instantiate callers/adapters in different route modules. Keep
// their association process-wide, like the app's extraction/event registries.
const captureGlobal = globalThis as typeof globalThis & { __lhBackgroundCaptureContext?: AsyncLocalStorage<BackgroundCapture> };
const activeCapture = captureGlobal.__lhBackgroundCaptureContext ??= new AsyncLocalStorage<BackgroundCapture>();
const preparedPayloadProviders = new Set(["chatgpt", ...NATIVE_SUBSCRIPTIONS.map((provider) => provider.logicalId)]);

/** Observe an app adapter's FINAL prepared body, after caller replacement and
 * local restrictions. Async-local association keeps concurrent workers isolated
 * without changing provider options or exposing auth/transport metadata. */
export function capturePreparedBackgroundPayload(payload: unknown, model: CaptureModel): void {
	activeCapture.getStore()?.payload(payload, model);
}

/** Shared by the native Agent runner and the hand-written PDF/visual loops.
 * Caller callbacks retain their awaited replacement/exception semantics. */
export function backgroundCaptureStream(streamFn: StreamFunction, capture: BackgroundCapture | undefined): StreamFunction<Api, SimpleStreamOptions> {
	if (!capture) return streamFn;
	return (model, context, options) => {
		capture.begin(model, context, options?.reasoning);
		return activeCapture.run(capture, () => streamFn(model, context, {
			...options,
			onPayload: async (raw, nativeModel) => {
				const replacement = await options?.onPayload?.(raw, nativeModel);
				// App subscription adapters still rewrite this payload. They call
				// the final prepared-body observer themselves; until then retain
				// the honestly labeled context (also on pre-dispatch failures).
				if (!preparedPayloadProviders.has(model.provider)) capture.payload(replacement === undefined ? raw : replacement, nativeModel);
				return replacement;
			},
			onResponse: async (response, nativeModel) => {
				capture.headers(response.status);
				await options?.onResponse?.(response, nativeModel);
			},
		}));
	};
}
