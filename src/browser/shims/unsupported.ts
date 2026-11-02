/**
 * Stand-in for Node modules that have no phone equivalent (child_process,
 * http, worker_threads, readline, ...). They are only reached by desktop
 * features the phone build does not offer (the Claude CLI, subscription
 * bridges, headless Chrome). Importing is harmless; calling throws.
 */

function unavailable(name: string): never {
	throw new Error(`${name} is not available in the LearnHarness phone app`);
}

function stub(name: string): unknown {
	const fn = function () {
		return unavailable(name);
	};
	return new Proxy(fn, {
		get: (_t, prop) => (prop === "then" ? undefined : stub(`${name}.${String(prop)}`)),
		apply: () => unavailable(name),
		construct: () => unavailable(name),
	});
}

const mod = stub("node module") as Record<string, unknown>;

/** A real class (other modules `extends` these at load time); constructing
 *  one is what throws. */
class Unavailable {
	constructor() {
		unavailable(this.constructor.name);
	}
}

// http / https
export class Agent extends Unavailable {}
export const globalAgent = undefined;
export const get = stub("http.get");
// events
export class EventEmitter extends Unavailable {}
export const once = stub("events.once");
export const on = stub("events.on");
// @hono/node-server (MCP's HTTP transport)
export const getRequestListener = stub("@hono/node-server.getRequestListener");
// @smithy/node-http-handler (AWS Bedrock)
export class NodeHttpHandler extends Unavailable {}
export class NodeHttp2Handler extends Unavailable {}
export const streamCollector = stub("@smithy/node-http-handler.streamCollector");

export const spawn = stub("child_process.spawn");
export const execFile = stub("child_process.execFile");
export const exec = stub("child_process.exec");
export const fork = stub("child_process.fork");
export const createServer = stub("http.createServer");
export const request = stub("http.request");
export const Worker = stub("worker_threads.Worker");
export const parentPort = null;
export const isMainThread = true;
export const workerData = undefined;
export const createInterface = stub("readline.createInterface");
export const createRequire = stub("module.createRequire");
export const isDeepStrictEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const promisify = (fn: (...args: unknown[]) => unknown) => fn;
export const inspect = (v: unknown) => {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
};
export class AsyncLocalStorage<T> {
	private store: T | undefined;
	getStore(): T | undefined {
		return this.store;
	}
	run<R>(store: T, fn: () => R): R {
		const prev = this.store;
		this.store = store;
		try {
			return fn();
		} finally {
			this.store = prev;
		}
	}
}

export default mod;
