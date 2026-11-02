/**
 * EventSource for the phone build. The browser's native EventSource goes
 * straight to the network and would bypass the on-device `/api/*` backend,
 * so same-origin `/api/` streams are read through `fetch` (which the backend
 * intercepts) and parsed as server-sent events here. Other URLs use the
 * native class. Reconnects after `retry` (default 3 s) like the real thing.
 */

const NativeEventSource = globalThis.EventSource;

type Listener = (ev: MessageEvent) => void;

export class ApiEventSource extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;

	readyState = 0;
	readonly url: string;
	readonly withCredentials = false;
	onopen: ((ev: Event) => void) | null = null;
	onmessage: Listener | null = null;
	onerror: ((ev: Event) => void) | null = null;

	private controller: AbortController | null = null;
	private retryMs = 3000;
	private lastEventId = "";

	constructor(url: string | URL) {
		super();
		this.url = new URL(url, location.href).href;
		void this.connect();
	}

	close(): void {
		this.readyState = 2;
		this.controller?.abort();
	}

	private async connect(): Promise<void> {
		if (this.readyState === 2) return;
		this.readyState = 0;
		this.controller = new AbortController();
		try {
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;
			const res = await fetch(this.url, { headers, signal: this.controller.signal });
			if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
			this.readyState = 1;
			this.fire("open", new Event("open"));
			await this.read(res.body);
		} catch {
			// fall through to reconnect
		}
		if (this.readyState === 2) return;
		this.readyState = 0;
		this.fire("error", new Event("error"));
		setTimeout(() => void this.connect(), this.retryMs);
	}

	private async read(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += value.replace(/\r\n?/g, "\n");
			let cut: number;
			while ((cut = buffer.indexOf("\n\n")) !== -1) {
				this.dispatchFrame(buffer.slice(0, cut));
				buffer = buffer.slice(cut + 2);
			}
		}
	}

	private dispatchFrame(frame: string): void {
		let event = "message";
		const data: string[] = [];
		for (const line of frame.split("\n")) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") event = value;
			else if (field === "data") data.push(value);
			else if (field === "id") this.lastEventId = value;
			else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
		}
		if (data.length === 0) return;
		this.fire(event, new MessageEvent(event, { data: data.join("\n"), lastEventId: this.lastEventId, origin: location.origin }));
	}

	private fire(type: string, ev: Event): void {
		this.dispatchEvent(ev);
		if (type === "open") this.onopen?.(ev);
		else if (type === "error") this.onerror?.(ev);
		else if (type === "message") this.onmessage?.(ev as MessageEvent);
	}
}

/** Route same-origin `/api/*` EventSources through the on-device backend. */
export function installApiEventSource(): void {
	const Patched = function (this: unknown, url: string | URL, init?: EventSourceInit) {
		const resolved = new URL(url, location.href);
		if (resolved.origin === location.origin && resolved.pathname.startsWith("/api/")) return new ApiEventSource(resolved);
		return new NativeEventSource(url, init);
	} as unknown as typeof EventSource;
	Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
	globalThis.EventSource = Patched;
}
