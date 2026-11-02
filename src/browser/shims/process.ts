/**
 * The `process` global for the phone build. Server code reads env vars
 * (LH_DATA_DIR etc.), NODE_ENV, and occasionally registers exit/message
 * listeners that never fire in a browser.
 */

/** Virtual app root: config.ts's ROOT resolves here (see ./url.ts). */
export const BROWSER_ROOT = "/lh/app";
export const BROWSER_CWD = BROWSER_ROOT;
/** Mutable data lives under one virtual directory, mirroring LH_DATA_DIR. */
export const BROWSER_DATA_DIR = "/lh/data";
export const BROWSER_HOME = "/lh/home";

const listeners = () => browserProcess;

export const browserProcess = {
	env: {
		NODE_ENV: "production",
		LH_DATA_DIR: BROWSER_DATA_DIR,
		LH_AUTH_FILE: `${BROWSER_DATA_DIR}/auth.json`,
		// The phone has no shell environment: keys come only from the
		// on-device auth.json, never from process env.
		LH_IGNORE_ENV_KEYS: "1",
	} as Record<string, string | undefined>,
	platform: "browser" as string,
	versions: {} as Record<string, string | undefined>,
	argv: [] as string[],
	execPath: "",
	pid: 1,
	browser: true,
	cwd: () => BROWSER_CWD,
	on: listeners,
	once: listeners,
	off: listeners,
	removeListener: listeners,
	emitWarning: (...args: unknown[]) => console.warn(...args),
	nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
	hrtime: Object.assign(
		(prev?: [number, number]): [number, number] => {
			const now = performance.now();
			const s = Math.floor(now / 1000);
			const ns = Math.floor((now % 1000) * 1e6);
			return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
		},
		{ bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
	),
	memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
	exit: () => {
		throw new Error("process.exit is not available in the phone build");
	},
};

// pi-ai resolves provider keys from `globalThis.process.env` (not a free
// `process` reference the bundler could rewrite), and the server's key store
// reflects saved keys into this env — so the one object must be global too.
// `versions.node` stays absent: libraries keep treating this as a browser.
const g = globalThis as { process?: unknown };
g.process ??= browserProcess;

export const process = browserProcess;
export default browserProcess;
