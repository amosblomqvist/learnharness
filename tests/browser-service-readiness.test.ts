/**
 * Shipping helper readiness, with real loopback HTTP but no Electron/display.
 *
 * The sockets, the HTTP server and the response parsing are real. The helper's
 * three timers (overall deadline, per-request timeout, retry delay) are driven by
 * a manual clock instead of the wall clock: request counts and the retained
 * failure cause then depend only on what the server answers, not on how long a
 * loaded machine takes to schedule the test process. The durations are virtual
 * and distinct, so the clock also pins which timer the helper arms for which
 * option. One test keeps real timers as a smoke check.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForBrowserService } from "../electron/browser-service-readiness.cjs";

const endpoint = (port: number) => `ws://127.0.0.1:${port}/devtools/browser/test-browser-id`;
const version = (port: number) => JSON.stringify({ webSocketDebuggerUrl: endpoint(port) });
/** Virtual milliseconds: only the manual clock ever "elapses" them. */
const timing = { timeoutMs: 1000, requestTimeoutMs: 100, retryMs: 10 };

/** Hang guard only: a missing event fails the test instead of stalling it. It
 *  counts event-loop turns, not wall time, so a starved machine cannot trip it
 *  and it never decides a passing run. Real progress needs a handful of turns. */
const HANG_GUARD_TURNS = 1_000_000;

/** Waits for a condition by yielding to the event loop, so socket I/O can make progress. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turns = 0; !condition(); turns++) {
		if (turns >= HANG_GUARD_TURNS) assert.fail(`never observed: ${what}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Awaits a promise, but turns a hang into a failure: on the manual clock a
 *  regression would otherwise leave the helper waiting for a deadline that
 *  never arrives. Same turn-counted guard as until(). */
async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
	const box: { result?: PromiseSettledResult<T> } = {};
	void Promise.allSettled([promise]).then(([result]) => { box.result = result; });
	await until(() => box.result !== undefined, `${what} to settle`);
	const result = box.result!;
	if (result.status === "rejected") throw result.reason;
	return result.value;
}

interface ManualClock {
	/** Durations of the timers currently armed, ascending. */
	delays(): number[];
	has(ms: number): boolean;
	/** Expires the earliest armed timer of that duration; fails if the helper armed none. */
	fire(ms: number): void;
	/** Starts the helper with the virtual `timing`. The clock aborts it when the test
	 *  ends, so a failing test cannot leave a poller running on real timers. */
	start(port: number, options?: { signal?: AbortSignal }): Promise<string>;
}

/** Replaces setTimeout/clearTimeout for the helper's three durations only; any
 *  other delay still goes to the real timers. In `finally`, also when an
 *  assertion failed, any helper still running is aborted (it clears its own
 *  timers and request) before the real timers return. A helper that outlives
 *  that abort is a regression in the helper: the manual clock then stays
 *  installed, so its leftover timers stay inert instead of polling on real
 *  timers and keeping the process alive. */
async function withClock(test: (clock: ManualClock) => Promise<void>): Promise<void> {
	const armed = new Set<{ ms: number; run: () => void }>();
	const virtual = new Set<number>(Object.values(timing));
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const patchedSet = mock.method(globalThis, "setTimeout", ((run: () => void, ms?: number, ...args: unknown[]) => {
		if (ms === undefined || !virtual.has(ms)) return Reflect.apply(realSet, globalThis, [run, ms, ...args]);
		const timer = { ms, run };
		armed.add(timer);
		return timer;
	}) as unknown as typeof setTimeout);
	const patchedClear = mock.method(globalThis, "clearTimeout", ((handle?: unknown) => {
		if (armed.delete(handle as { ms: number; run: () => void })) return;
		return Reflect.apply(realClear, globalThis, [handle]);
	}) as unknown as typeof clearTimeout);
	const teardown = new AbortController();
	const started: Promise<unknown>[] = [];
	const clock: ManualClock = {
		delays: () => [...armed].map((timer) => timer.ms).sort((a, b) => a - b),
		has: (ms) => [...armed].some((timer) => timer.ms === ms),
		fire(ms) {
			const timer = [...armed].find((candidate) => candidate.ms === ms);
			assert.ok(timer, `no ${ms}ms timer armed (armed: [${clock.delays()}])`);
			armed.delete(timer);
			timer.run();
		},
		start(port, options = {}) {
			const signal = options.signal ? AbortSignal.any([options.signal, teardown.signal]) : teardown.signal;
			const waiting = waitForBrowserService(port, { ...timing, signal });
			waiting.catch(() => {}); // a teardown abort of an un-awaited helper is not an unhandled rejection
			started.push(waiting);
			return waiting;
		},
	};
	let bodyFailed = false;
	try { await test(clock); }
	catch (error) { bodyFailed = true; throw error; }
	finally {
		teardown.abort(new Error("test finished"));
		// A helper that honours the abort settles within microtasks; one that does not is still pending a macrotask later.
		const outlived = await Promise.race([
			Promise.allSettled(started).then(() => false),
			new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
		]);
		if (!outlived) {
			patchedSet.mock.restore();
			patchedClear.mock.restore();
		} else if (!bodyFailed) {
			throw new Error("readiness outlived the test; the manual clock stays installed so it cannot poll on real timers");
		}
	}
}

/** Fires the helper's retry timer each time it is armed, until readiness
 *  settles. The cap keeps a helper that never accepts an answer from looping. */
async function runRetries(clock: ManualClock, waiting: Promise<unknown>, maxRetries = 50): Promise<void> {
	let settled = false;
	void waiting.then(() => { settled = true; }, () => { settled = true; });
	for (let fired = 0; ; fired++) {
		await until(() => settled || clock.has(timing.retryMs), "a retry timer or settlement");
		if (settled) return;
		if (fired >= maxRetries) assert.fail(`readiness was still retrying after ${maxRetries} retries`);
		clock.fire(timing.retryMs);
	}
}

async function withEndpoint(
	reply: (request: http.IncomingMessage, response: http.ServerResponse, port: number) => void,
	test: (port: number, idle: () => Promise<void>, openSockets: () => number) => Promise<void>,
) {
	let port = 0;
	const sockets = new Set<Socket>();
	const server = http.createServer((request, response) => reply(request, response, port));
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	const idle = async () => {
		await until(() => sockets.size === 0, "every HTTP connection closed");
		assert.equal(sockets.size, 0, "readiness left an HTTP connection open");
	};
	try { await test(port, idle, () => sockets.size); }
	finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("browser-service shipping readiness", () => {
	it("waits for a TCP endpoint that starts listening after readiness began", () => withClock(async (clock) => {
		const server = http.createServer((_req, res) => res.end(version(port)));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		let ready = false;
		const waiting = clock.start(port).then((value) => { ready = true; return value; });
		try {
			// Nothing listens yet: each refused connection arms another retry.
			for (let refused = 0; refused < 3; refused++) {
				await until(() => clock.has(timing.retryMs), "a retry after a refused connection");
				assert.equal(ready, false, "announced readiness before the endpoint listened");
				clock.fire(timing.retryMs);
			}
			await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
			await runRetries(clock, waiting);
			assert.equal(await bounded(waiting, "readiness once the endpoint listens"), endpoint(port));
			assert.deepEqual(clock.delays(), [], "timers left armed after readiness");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}));

	it("waits through delayed/non-200 startup and only accepts the exact CDP endpoint", () => withClock(async (clock) => {
		let requests = 0;
		let delayed: http.ServerResponse | undefined;
		await withEndpoint((req, res, port) => {
			assert.equal(req.url, "/json/version");
			assert.equal(req.headers.host, `127.0.0.1:${port}`);
			if (++requests < 3) { res.writeHead(503); res.end(); }
			else delayed = res; // answered only when the test releases it
		}, async (port, idle) => {
			const waiting = clock.start(port);
			for (const seen of [1, 2]) {
				await until(() => clock.has(timing.retryMs), `a retry after request ${seen}`);
				assert.equal(requests, seen);
				clock.fire(timing.retryMs);
			}
			await until(() => delayed !== undefined, "the delayed third request");
			assert.deepEqual(clock.delays(), [timing.requestTimeoutMs, timing.timeoutMs], "an in-flight attempt arms its request and overall timers only");
			delayed!.end(version(port));
			assert.equal(await bounded(waiting, "readiness after the delayed answer"), endpoint(port));
			assert.equal(requests, 3);
			await idle();
			assert.deepEqual(clock.delays(), [], "polling could continue after readiness");
			assert.equal(requests, 3, "polling continued after readiness");
		});
	}));

	it("retries malformed JSON and a missing browser WebSocket endpoint", () => withClock(async (clock) => {
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			requests++;
			res.end(requests === 1 ? "not json" : requests === 2 ? "{}" : version(port));
		}, async (port, idle) => {
			const waiting = clock.start(port);
			await runRetries(clock, waiting);
			assert.equal(await bounded(waiting, "readiness after malformed answers"), endpoint(port));
			assert.equal(requests, 3);
			await idle();
			assert.deepEqual(clock.delays(), []);
		});
	}));

	it("rejects arbitrary, wrong-port, credentialed, and non-browser WebSocket URLs", () => withClock(async (clock) => {
		const invalid = [
			"ws://example.com:1234/devtools/browser/id",
			"ws://127.0.0.1:1/devtools/browser/id",
			"wss://127.0.0.1:1234/devtools/browser/id",
			"ws://user:password@127.0.0.1:1234/devtools/browser/id",
			"ws://127.0.0.1:1234/devtools/page/id",
			"ws://127.0.0.1:1234/devtools/browser/id?query=1",
			"ws://127.0.0.1:1234/devtools/browser/id#fragment",
			"ws://127.0.0.1:1234/devtools/browser/",
		];
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			const bad = invalid[requests++];
			res.end(bad ? JSON.stringify({ webSocketDebuggerUrl: bad.replaceAll(":1234", `:${port}`) }) : version(port));
		}, async (port, idle) => {
			const waiting = clock.start(port);
			await runRetries(clock, waiting);
			assert.equal(await bounded(waiting, "readiness after invalid endpoints"), endpoint(port));
			assert.equal(requests, invalid.length + 1);
			await idle();
			assert.deepEqual(clock.delays(), []);
		});
	}));

	it("bounds response size at 16 KiB and retries instead of accepting oversized data", () => withClock(async (clock) => {
		const padded = (port: number, bytes: number) => {
			const body = version(port);
			return body + " ".repeat(bytes - Buffer.byteLength(body));
		};
		// Exactly 16 KiB is within the bound and is accepted on the first attempt.
		let requests = 0;
		await withEndpoint((_req, res, port) => { requests++; res.end(padded(port, 16 * 1024)); }, async (port, idle) => {
			const waiting = clock.start(port);
			await runRetries(clock, waiting);
			assert.equal(await bounded(waiting, "readiness with a 16 KiB answer"), endpoint(port));
			assert.equal(requests, 1, "an answer exactly at the bound was refused");
			await idle();
			assert.deepEqual(clock.delays(), []);
		});
		// One byte more is refused and retried.
		requests = 0;
		await withEndpoint((_req, res, port) => {
			res.end(++requests === 1 ? padded(port, 16 * 1024 + 1) : version(port));
		}, async (port, idle) => {
			const waiting = clock.start(port);
			await runRetries(clock, waiting);
			assert.equal(await bounded(waiting, "readiness after an oversized answer"), endpoint(port));
			assert.equal(requests, 2);
			await idle();
			assert.deepEqual(clock.delays(), []);
		});
	}));

	it("fails at the overall deadline and retains the last HTTP failure", () => withClock(async (clock) => {
		let requests = 0;
		await withEndpoint((_req, res) => { requests++; res.writeHead(503); res.end(); }, async (port, idle) => {
			const waiting = clock.start(port);
			const rejected = assert.rejects(bounded(waiting, "the overall deadline"), (error: Error) => {
				assert.match(error.message, /not ready within 1000ms/);
				assert.match(String(error.cause), /CDP HTTP status 503/);
				return true;
			});
			for (const seen of [1, 2, 3]) {
				await until(() => clock.has(timing.retryMs), `a retry after request ${seen}`);
				assert.equal(requests, seen);
				clock.fire(timing.retryMs);
			}
			await until(() => requests === 4 && clock.has(timing.retryMs), "the fourth answer");
			clock.fire(timing.timeoutMs); // the overall budget expires between attempts
			await rejected;
			await idle();
			assert.deepEqual(clock.delays(), [], "polling could continue after timeout");
			assert.equal(requests, 4, "polling continued after timeout");
		});
	}));

	it("destroys hung requests on the per-request and overall timeouts", () => withClock(async (clock) => {
		let requests = 0;
		await withEndpoint(() => { requests++; }, async (port, idle, openSockets) => {
			const waiting = clock.start(port);
			const rejected = assert.rejects(bounded(waiting, "the overall deadline"), (error: Error) => {
				assert.match(error.message, /not ready within 1000ms/);
				assert.match(String(error.cause), /CDP HTTP request timed out/);
				return true;
			});
			await until(() => requests === 1, "the first hung request");
			assert.equal(openSockets(), 1);
			assert.deepEqual(clock.delays(), [timing.requestTimeoutMs, timing.timeoutMs], "the request and overall timers are both armed");

			clock.fire(timing.requestTimeoutMs); // per-request timeout: only this attempt is cut off
			await until(() => openSockets() === 0, "the timed-out request's connection closed");
			await until(() => clock.has(timing.retryMs), "a retry after the per-request timeout");
			assert.deepEqual(clock.delays(), [timing.retryMs, timing.timeoutMs], "the overall budget keeps running across attempts");
			clock.fire(timing.retryMs);
			await until(() => requests === 2, "the second attempt");
			assert.equal(openSockets(), 1);

			clock.fire(timing.timeoutMs); // overall deadline expires while that attempt hangs
			await rejected;
			await idle();
			assert.deepEqual(clock.delays(), [], "timers left armed after the deadline");
			assert.equal(requests, 2);
		});
	}));

	it("aborts a hung request on parent EOF and leaves no polling/connection behind", () => withClock(async (clock) => {
		const controller = new AbortController();
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		let requests = 0;
		await withEndpoint(() => { requests++; started(); }, async (port, idle) => {
			const waiting = clock.start(port, { signal: controller.signal });
			const rejected = assert.rejects(bounded(waiting, "abort on parent EOF"), /parent EOF/);
			await requestStarted;
			controller.abort(new Error("parent EOF"));
			await rejected;
			await idle();
			assert.deepEqual(clock.delays(), [], "abort left a deadline, request or retry timer armed");
			assert.equal(requests, 1);
		});
	}));

	it("does not start any request if the parent already closed", () => withClock(async (clock) => {
		const controller = new AbortController();
		controller.abort(new Error("parent EOF"));
		let requests = 0;
		await withEndpoint(() => { requests++; }, async (port, idle) => {
			await assert.rejects(bounded(clock.start(port, { signal: controller.signal }), "an already-aborted readiness"), /parent EOF/);
			assert.deepEqual(clock.delays(), [], "an already-aborted readiness armed a timer");
			await delay(40); // a request would have reached the server by now
			assert.equal(requests, 0);
			await idle();
		});
	}));

	it("works on real timers too (the manual clock is not hiding a timer problem)", async () => {
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			if (++requests === 1) { res.writeHead(503); res.end(); }
			else res.end(version(port));
		}, async (port, idle) => {
			// Wide budgets: only the retry sequence is under test, so load cannot trip a deadline.
			assert.equal(await waitForBrowserService(port, { timeoutMs: 60_000, requestTimeoutMs: 30_000, retryMs: 5 }), endpoint(port));
			assert.equal(requests, 2);
			await idle();
		});
	});
});
