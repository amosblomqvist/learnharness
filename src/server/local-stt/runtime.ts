/**
 * Parent side of the on-device transcriber: starts worker.cjs as a child
 * process on first use, sends it one clip at a time, and stops it after a
 * quiet period so the ~670 MB model leaves memory. A child that dies fails
 * only the request in flight; the next request starts a fresh one.
 *
 * In the packaged app the server runs as Electron with ELECTRON_RUN_AS_NODE,
 * so process.execPath is the app binary and the child inherits that mode
 * through the environment passed below. In dev it is plain node.
 */
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import path from "node:path";

/** Stop the child after this long without a request. */
export const LOCAL_STT_IDLE_MS = 5 * 60_000;

export const LOCAL_STT_CRASHED = "On-device dictation stopped unexpectedly";

/** Only what the child needs: no keys, no desktop API secret. */
export function transcriberEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: Record<string, string> = {};
	for (const name of ["ELECTRON_RUN_AS_NODE", "PATH", "Path", "SystemRoot", "TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "NODE_ENV"]) {
		const value = env[name];
		if (value !== undefined) out[name] = value;
	}
	return out as NodeJS.ProcessEnv;
}

type Reply = { id?: number; type?: string; text?: string; error?: string };

export interface LocalTranscriberOptions {
	/** Absolute path to worker.cjs. */
	workerPath?: string;
	idleMs?: number;
	forkImpl?: (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;
}

export function createLocalTranscriber(options: LocalTranscriberOptions = {}) {
	// Resolved from the server's working directory, like the image-resize
	// worker: the packaged server's cwd is the standalone root.
	const workerPath = options.workerPath ?? path.join(/* turbopackIgnore: true */ process.cwd(), "src/server/local-stt/worker.cjs");
	const idleMs = options.idleMs ?? LOCAL_STT_IDLE_MS;
	const spawn = options.forkImpl ?? fork;
	let child: ChildProcess | null = null;
	let nextId = 1;
	const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	};

	function failAll(error: Error) {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	}

	function start(): ChildProcess {
		if (child && child.exitCode === null && child.signalCode === null) return child;
		const proc = spawn(/* turbopackIgnore: true */ workerPath, [], {
			env: transcriberEnv(process.env),
			execArgv: [],
			serialization: "advanced",
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2000);
		});
		proc.on("message", (message: Reply) => {
			if (typeof message?.id !== "number") return;
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (typeof message.error === "string") waiter.reject(new Error(message.error));
			else waiter.resolve(typeof message.text === "string" ? message.text : "");
		});
		const onGone = (detail: string) => {
			if (child === proc) child = null;
			const last = stderr.trim().split("\n").pop();
			failAll(new Error(last ? `${LOCAL_STT_CRASHED} (${detail}): ${last.slice(0, 200)}` : `${LOCAL_STT_CRASHED} (${detail})`));
		};
		proc.on("exit", (code, signal) => onGone(signal ? `signal ${signal}` : `exit code ${code}`));
		proc.on("error", (error) => onGone(error.message));
		child = proc;
		return proc;
	}

	function run(dir: string, pcm: Uint8Array): Promise<string> {
		clearIdle();
		const proc = start();
		const id = nextId++;
		return new Promise<string>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			proc.send({ id, type: "transcribe", dir, pcm }, (error) => {
				if (!error) return;
				pending.delete(id);
				reject(error);
			});
		}).finally(() => {
			clearIdle();
			idleTimer = setTimeout(() => {
				idleTimer = null;
				child?.kill();
			}, idleMs);
			idleTimer.unref?.();
		});
	}

	return {
		/** `pcm`: mono 16 kHz signed 16-bit little-endian samples. */
		transcribe(dir: string, pcm: Uint8Array): Promise<string> {
			const job = queue.then(() => run(dir, pcm));
			queue = job.catch(() => {});
			return job;
		},
		/** Wait for the clip in flight, then stop the child, so the model files
		 *  can be removed while nothing has them open. */
		stop(): Promise<void> {
			const job = queue.then(() => {
				clearIdle();
				const proc = child;
				child = null;
				if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
				return new Promise<void>((resolve) => {
					proc.once("exit", () => resolve());
					proc.kill();
				});
			});
			queue = job.catch(() => {});
			return job;
		},
	};
}

export type LocalTranscriber = ReturnType<typeof createLocalTranscriber>;
