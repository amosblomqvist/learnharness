/**
 * THE NOTIFICATION CHANNEL (push-architecture slice 1): GET /api/events is
 * an SSE response over the core event bus — one connection per open
 * window, held open until the view goes away, fed by every emitter
 * (turn lifecycle, job/chat stores, extraction registry).
 *
 * NOTIFY → FETCH (the architecture's whole trick): frames carry only the
 * event type + a tiny payload; consumers respond by fetching truth
 * (/api/chats/:id, /api/jobs, /api/activity). No payload versioning, no
 * replay protocol — a reconnect resyncs with one ordinary fetch per
 * consumer. This is a DESKTOP app talking to localhost: holding N≈1-3
 * connections costs one socket pair each and zero traffic while idle
 * (owner ruling 2026-10-02 — polling's cloud economics don't exist at
 * loopback; the poll lattice it left behind is what this replaces).
 *
 * Wire dialect mirrors the turn stream (pi/ui-stream.ts): text/event-stream,
 * no-cache/no-transform, X-Accel-Buffering off — plus a `: ping` comment
 * every 25s to keep any intermediary from idling the socket out (locally
 * unnecessary, harmless, and it makes dead-connection detection cheap).
 *
 * The DIFFERENCE from the turn stream is lifetime: a turn's stream ends at
 * settle ([DONE]); this channel ends when the CLIENT goes away — cancel()
 * is the only end, and it must leave the bus untouched for other windows.
 * The closure shape (teardown assigned in start, called in cancel) is the
 * ui-stream subscribe() pattern.
 */
import { subscribe, type ServerEvent } from "../core/events.ts";

/** One window's subscription as an SSE Response. */
export function eventsResponse(): Response {
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;

			const stop = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
			};
			// Enqueue is the ONLY place the socket can reject us (the reader
			// died) — any failure routes through stop() so the listener and
			// the heartbeat never outlive the connection.
			const frame = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};

			// Attach FIRST, synchronously: no event can fall between
			// construction and subscription (single-threaded — the same
			// attach-then-replay law as ui-stream's subscribe()).
			unsubscribe = subscribe((event: ServerEvent) => {
				const { type, ...payload } = event;
				frame(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
			});
			heartbeat = setInterval(() => frame(": ping\n\n"), 25_000);

			teardown = stop;
		},
		cancel() {
			// The view went away: drop the listener + timer. The bus keeps
			// serving every other window untouched.
			teardown?.();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
