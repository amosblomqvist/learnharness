import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const KILL_GRACE_MS = 1000;
const STDERR_LIMIT = 65_536;

export type ChildEvents = {
	onLine(line: string): void;
	/** The child closed; `message` is the exit message. */
	onExit(message: string): void;
	/** The child could not be spawned or failed; already logged. */
	onError(): void;
};

/** Stdio, abort signal and kill of one child process. */
export class ChildControl {
	stopping = false;
	closed = false;
	private stderr = "";
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly label: string,
		private readonly onAbort: () => void,
	) {}

	attach(events: ChildEvents): void {
		this.child.once("close", (code: number | null) => events.onExit(`${this.label} exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error(`${this.label} process failed:`, error);
			events.onError();
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT); });
		this.child.stdin.on("error", (error) => console.error(`${this.label} stdin closed early:`, error));
		createInterface({ input: this.child.stdout }).on("line", (line) => events.onLine(line));
	}

	write(line: string): void { this.child.stdin.write(`${line}\n`); }

	endInput(): void { this.child.stdin.end(); }

	setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	/** Marks the child as stopping; false when it was already stopping or closed. */
	beginStop(): boolean {
		if (this.stopping || this.closed) return false;
		this.stopping = true;
		return true;
	}

	/** Sends SIGTERM, then SIGKILL after a grace period. */
	terminate(): void {
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
		this.killTimer.unref();
	}

	/** Marks the child as closed; false when it already was. */
	markClosed(): boolean {
		if (this.closed) return false;
		this.closed = true;
		clearTimeout(this.killTimer);
		this.signal?.removeEventListener("abort", this.abort);
		return true;
	}

	logStderr(): void {
		if (this.stderr.trim()) console.error(`${this.label} stderr:`, this.stderr.trim());
	}

	private readonly abort = () => this.onAbort();
}
