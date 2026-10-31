import { randomUUID } from "node:crypto";

const INITIALIZE_TIMEOUT_MS = 5_000;

/** A best-effort, local-only CLI control query. Wire contract matches the
 * official SDK0.3.259 source; this does not import or execute the SDK.
 * Summary deliberately avoids the default full mode's token-count requests.
 * CLI maxTokens is an effective/auto-compaction budget, not a nominal model max. */
export class ContextWindowProbe {
	private readonly initializeId = randomUUID();
	private summaryId: string | undefined;
	private initialized = false;
	private timer: NodeJS.Timeout | undefined;
	private ready = false;
	private closed = false;

	constructor(
		private readonly write: (line: string) => void,
		private readonly sendPrompt: () => void,
		private readonly onWindow: (tokens: number) => void,
	) {}

	start(): void {
		this.timer = setTimeout(() => this.proceed(false), INITIALIZE_TIMEOUT_MS);
		this.timer.unref();
		this.request(this.initializeId, { subtype: "initialize" });
	}

	/** Consume control replies separately from model/tool output, including
	 * late/foreign replies while a native question tool is already waiting. */
	handle(value: unknown): boolean {
		if (!value || typeof value !== "object" || !("type" in value) || value.type !== "control_response") return false;
		if (this.closed || !("response" in value) || !value.response || typeof value.response !== "object") return true;
		const response = value.response as Record<string, unknown>;
		if (response.request_id === this.initializeId) this.proceed(response.subtype === "success");
		else if (this.summaryId && response.request_id === this.summaryId) {
			this.summaryId = undefined;
			if (response.subtype !== "success") return true;
			const body = response.response as Record<string, unknown> | undefined;
			const tokens = body?.maxTokens;
			if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0) this.onWindow(tokens);
		}
		return true;
	}

	/** Retry when the CLI has begun a model response: pre-first-turn metadata
	 * is not guaranteed by the protocol. Refresh also follows later responses
	 * within the same held process, without opening a second process. */
	refresh(): void {
		if (!this.initialized || this.closed) return;
		this.summaryId = randomUUID();
		this.request(this.summaryId, { subtype: "get_context_usage", detail: "summary" });
	}

	close(): void { this.closed = true; clearTimeout(this.timer); }

	private proceed(query: boolean): void {
		if (this.ready || this.closed) return;
		this.ready = true;
		clearTimeout(this.timer);
		this.initialized = query;
		if (query) this.refresh();
		// Never wait for metadata to run the actual user request. No support,
		// no response, or malformed metadata simply leaves the window unknown.
		this.sendPrompt();
	}

	private request(id: string, request: Record<string, string>): void {
		this.write(JSON.stringify({ type: "control_request", request_id: id, request }));
	}
}
