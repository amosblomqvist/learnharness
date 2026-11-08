import type { LhMessage, PluginSubmission, PluginSubmissionContext, PluginSubmissionInterceptor, PluginSubmissionTarget } from "../src/core/index.ts";
import { copyPluginSubmissionHistory, copyPluginSubmissionTarget, preparePluginSubmission } from "../src/core/index.ts";

/** Captured registration identity, not just an interceptor ID. */
export interface SubmissionInterceptorRegistration {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly interceptor: Readonly<PluginSubmissionInterceptor>;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	report(error: unknown): void;
}
export function orderSubmissionInterceptors(a: SubmissionInterceptorRegistration, b: SubmissionInterceptorRegistration): number {
	return (b.interceptor.priority ?? 0) - (a.interceptor.priority ?? 0) || (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0) || (a.interceptor.id < b.interceptor.id ? -1 : a.interceptor.id > b.interceptor.id ? 1 : 0);
}
const aborted = () => new DOMException("Submission preparation canceled", "AbortError");
function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise((resolve, reject) => {
		const abort = () => reject(aborted());
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
/** Observe the host control's known route only; no parallel model resolver.
 * Initial/unresolved reads and credential/catalog refreshes are not changes. */
export class SubmissionModelEpoch {
	private known: string | undefined;
	private revision = 0;
	observe(model: string | undefined) {
		if (model === undefined) return;
		if (this.known !== undefined && model !== this.known) this.revision++;
		this.known = model;
	}
	capture() { return this.revision; }
	isCurrent(revision: number) { return revision === this.revision; }
}

/** One native-view lease. Reservation precedes STT/editor awaits; release is
 * HTTP acknowledgment/refusal, deliberately NOT model stream completion. */
export class PluginSubmissionRunner {
	private active: SubmissionAttempt | null = null;
	constructor(private changed: () => void = () => {}) {}
	get preparing() { return this.active?.phase === "preparing"; }
	get occupied() { return this.active !== null; }
	begin(target: PluginSubmissionTarget, registrations: readonly SubmissionInterceptorRegistration[], isCurrent: () => boolean): SubmissionAttempt | null {
		if (this.active) return null;
		const attempt = new SubmissionAttempt(copyPluginSubmissionTarget(target), [...registrations].sort(orderSubmissionInterceptors), isCurrent, () => {
			if (this.active === attempt) { this.active = null; this.changed(); }
		}, this.changed);
		this.active = attempt; this.changed();
		return attempt;
	}
	cancel = () => { if (this.active?.phase === "preparing") this.active.cancel(); };
	dispose() { this.active?.cancel(); }
}
export class SubmissionAttempt {
	private controller = new AbortController();
	private callbacks: { owner: SubmissionInterceptorRegistration; callback: () => void | Promise<void> }[] = [];
	private cleanups: (() => void)[] = [];
	private finished = false;
	private lastOwner?: SubmissionInterceptorRegistration;
	phase: "preparing" | "delivering" | "finished" = "preparing";
	constructor(readonly target: PluginSubmissionTarget, private registrations: readonly SubmissionInterceptorRegistration[], private current: () => boolean, private release: () => void, private changed: () => void) {
		for (const owner of registrations) {
			const abort = () => this.cancel();
			owner.signal.addEventListener("abort", abort, { once: true });
			this.cleanups.push(() => owner.signal.removeEventListener("abort", abort));
		}
	}
	get signal() { return this.controller.signal; }
	check() {
		if (this.signal.aborted || !this.current() || this.registrations.some(owner => !owner.isCurrent())) { this.cancel(); throw aborted(); }
	}
	async finalize<T>(callback: () => T | Promise<T>): Promise<T> {
		this.check();
		const result = await abortable(callback(), this.signal);
		this.check(); return result;
	}
	async prepare(input: PluginSubmission, messages: readonly LhMessage[]): Promise<PluginSubmission | null> {
		this.check();
		let result = preparePluginSubmission(input, this.target);
		const history = copyPluginSubmissionHistory(messages);
		for (const owner of this.registrations) {
			this.check(); let open = true;
			const context = Object.freeze({ ...this.target, messages: history, signal: this.signal, onAccepted: (callback: () => void | Promise<void>) => {
				if (open && !this.signal.aborted && owner.isCurrent() && typeof callback === "function") this.callbacks.push({ owner, callback });
			} }) as PluginSubmissionContext;
			try {
				this.lastOwner = owner;
				const returned = owner.interceptor.intercept(result, context);
				if (!returned || typeof (returned as Promise<unknown>).then !== "function") open = false;
				const next = await abortable(returned, this.signal);
				open = false; this.check();
				if (next === null) { this.cancel(); return null; }
				if (next !== undefined) result = preparePluginSubmission(next, this.target);
			} catch (error) {
				open = false;
				if (this.signal.aborted || !owner.isCurrent() || !this.current()) { this.cancel(); throw aborted(); }
				owner.report(error); this.cancel();
				throw new Error(`Could not prepare submission (${owner.pluginName}): ${error instanceof Error ? error.message : String(error)}. Your input has been kept.`);
			}
		}
		this.check(); return result;
	}
	preparationFailure(error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("Could not prepare submission (")) return error as Error;
		if (this.lastOwner) {
			this.lastOwner.report(error);
			return new Error(`Could not prepare submission (${this.lastOwner.pluginName}): ${message}. Your input has been kept.`);
		}
		return new Error(`${message}${message.includes("Your input has been kept.") ? "" : ". Your input has been kept."}`);
	}
	/** Freeze observer registration before the first POST. */
	deliver() { this.check(); this.phase = "delivering"; this.changed(); }
	accepted = () => {
		if (this.finished) return;
		const callbacks = [...this.callbacks]; this.finish();
		for (const { owner, callback } of callbacks) {
			if (!owner.isCurrent()) continue;
			try { void Promise.resolve(callback()).catch(error => owner.report(error)); }
			catch (error) { owner.report(error); }
		}
	};
	refused = () => this.finish();
	cancel() { if (this.phase !== "preparing") return; this.controller.abort(); this.finish(); }
	private finish() {
		if (this.finished) return; this.finished = true; this.phase = "finished";
		for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; this.callbacks = []; this.release();
	}
}
