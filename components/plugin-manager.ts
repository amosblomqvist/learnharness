import type {
	PluginAction, PluginCleanup, PluginFrontendContext, PluginFrontendModule, PluginInfo,
	PluginNotification, PluginView, ServerEvent, PluginCodeBlockRenderer, PluginToolRenderer,
} from "@/src/core";

export type PluginMount = (container: HTMLElement, signal: AbortSignal) => ReturnType<PluginView["mount"]>;
export interface PluginRendererRegistration<T> {
	readonly pluginId: string;
	readonly renderer: T;
}
export type CodeBlockRegistration = PluginRendererRegistration<PluginCodeBlockRenderer>;
export type ToolRendererRegistration = PluginRendererRegistration<PluginToolRenderer>;
export interface FrontendPlugin {
	info: PluginInfo;
	phase: "disabled" | "loading" | "active" | "error";
	error?: string;
	views: PluginView[];
	actions: PluginAction[];
	settings?: PluginMount;
	busy: boolean;
}
export interface PluginSnapshot {
	plugins: FrontendPlugin[];
	readonly codeBlocks: readonly CodeBlockRegistration[];
	readonly toolRenderers: readonly ToolRendererRegistration[];
	directory: string;
	loading: boolean;
	refreshing: boolean;
	error?: string;
}
interface Lifecycle {
	id: string;
	revision: string;
	controller: AbortController;
	cleanups: Set<PluginCleanup>;
	/** Activation and every cooperative mount/cleanup must settle before reuse. */
	activation: Promise<void>;
	tasks: Set<Promise<void>>;
	teardown?: Promise<void>;
	views: Map<string, PluginView>;
	actions: Map<string, PluginAction>;
	codeBlocks: Map<string, CodeBlockRegistration>;
	toolRenderers: Map<string, ToolRendererRegistration>;
	settings?: PluginMount;
	notifications: Set<(event: PluginNotification) => void>;
	events: Set<(event: ServerEvent) => void>;
	resyncs: Set<() => void>;
	phase: "loading" | "active" | "error";
	error?: string;
}
export interface PluginHost {
	/** Exclusive claims supplied by the actual host UI, not backend tool lists. */
	reservedCodeBlockLanguages?: readonly string[];
	reservedToolNames?: readonly string[];
	fetch: typeof fetch;
	importModule(url: string): Promise<PluginFrontendModule>;
	pathname(): string;
	navigate(path: string): void;
	style?(url: string, onError: () => void): PluginCleanup;
}

export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
}
export function pluginAssetUrl(info: PluginInfo, path: string): string {
	return `/api/plugins/${encodeURIComponent(info.id)}/assets/${encodeURIComponent(path)}?revision=${encodeURIComponent(info.revision)}`;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Pure per-window lifecycle owner. No React, polling, or additional SSE source.
 * A lifecycle object IS its activation generation: every async continuation must
 * still own that exact object before registering or publishing anything. */
export class PluginFrontendManager {
	private infos: PluginInfo[] = [];
	private lives = new Map<string, Lifecycle>();
	private teardowns = new Map<string, Promise<void>>();
	private listeners = new Set<() => void>();
	private pending = new Set<string>();
	private cleanupErrors = new Map<string, string>();
	private rendererMounts = new WeakMap<object, Set<() => void>>();
	private requestGeneration = 0;
	private mutations = 0;
	private disposed = false;
	private started = false;
	private snapshot: PluginSnapshot = { plugins: [], codeBlocks: [], toolRenderers: [], directory: "", loading: true, refreshing: false };
	constructor(private host: PluginHost) {}
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private publish(patch: Partial<PluginSnapshot> = {}) {
		if (this.disposed) return;
		this.snapshot = { ...this.snapshot, ...patch,
			codeBlocks: Object.freeze([...this.lives.values()].flatMap(life => [...life.codeBlocks.values()])),
			toolRenderers: Object.freeze([...this.lives.values()].flatMap(life => [...life.toolRenderers.values()])),
			plugins: this.infos.map(info => {
			const life = this.lives.get(info.id);
			return {
				info, phase: life?.phase ?? (info.enabled ? (info.status === "error" ? "error" : "active") : "disabled"),
				error: life?.error ?? this.cleanupErrors.get(info.id) ?? info.error, views: [...(life?.views.values() ?? [])],
				actions: [...(life?.actions.values() ?? [])], settings: life?.settings, busy: this.pending.has(info.id),
			};
		}) };
		for (const listener of [...this.listeners]) listener();
	}
	start() {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.reload();
	}
	private current(life: Lifecycle): boolean {
		return !this.disposed && !life.controller.signal.aborted && this.lives.get(life.id) === life;
	}
	private report(life: Lifecycle, error: unknown) {
		if (!this.current(life)) return;
		life.error = message(error);
		this.publish();
	}
	private disposeCallback(life: Lifecycle, cleanup: PluginCleanup) {
		const failed = (error: unknown) => {
			// Teardown errors remain visible while a replacement is waiting,
			// but an old orphan must not overwrite a newer active generation.
			const current = this.lives.get(life.id);
			if (this.disposed || (current && current !== life && current.phase !== "loading")) return;
			this.cleanupErrors.set(life.id, message(error)); this.publish();
		};
		try { this.track(life, Promise.resolve(cleanup()).catch(failed)); }
		catch (error) { failed(error); }
	}
	private track(life: Lifecycle, task: Promise<void>) {
		const settled = task.catch(error => this.report(life, error));
		life.tasks.add(settled);
		void settled.then(() => { life.tasks.delete(settled); });
	}
	private addCleanup(life: Lifecycle, cleanup: PluginCleanup): () => void {
		if (!this.current(life)) {
			this.disposeCallback(life, cleanup);
			return () => {};
		}
		life.cleanups.add(cleanup);
		return () => {
			if (life.cleanups.delete(cleanup)) this.disposeCallback(life, cleanup);
		};
	}
	private stop(life: Lifecycle) {
		// Invalidate synchronously BEFORE abort dispatches plugin listeners.
		// An inert activation-error placeholder may be stopped a second time.
		if (this.lives.get(life.id) === life) this.lives.delete(life.id);
		if (life.teardown) return life.teardown;
		life.controller.abort();
		life.views.clear(); life.actions.clear(); life.settings = undefined;
		life.codeBlocks.clear(); life.toolRenderers.clear();
		life.notifications.clear(); life.events.clear(); life.resyncs.clear();
		const cleanups = [...life.cleanups].reverse();
		life.cleanups.clear();
		for (const cleanup of cleanups) this.disposeCallback(life, cleanup);
		// Activation may still RETURN a cleanup after abort, and mounts may
		// likewise finish late. Their continuations immediately dispose orphan
		// callbacks and add those promises to this generation's task set.
		const teardown = (async () => {
			await life.activation;
			while (life.tasks.size) await Promise.all([...life.tasks]);
		})();
		life.teardown = teardown;
		this.teardowns.set(life.id, teardown);
		void teardown.then(() => {
			if (this.teardowns.get(life.id) === teardown) this.teardowns.delete(life.id);
		});
		return teardown;
	}
	private async json(url: string, init?: RequestInit): Promise<unknown> {
		const response = await this.host.fetch(url, init);
		const body = await response.json();
		if (!response.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
		return body;
	}
	async reload(clearError = true) {
		if (this.disposed || this.mutations) return;
		const generation = ++this.requestGeneration;
		try {
			const body = await this.json("/api/plugins") as { plugins: PluginInfo[]; directory: string };
			if (this.disposed || generation !== this.requestGeneration) return;
			this.reconcile(body.plugins);
			this.publish({ directory: body.directory, loading: false, ...(clearError ? { error: undefined } : {}) });
		} catch (error) {
			if (generation === this.requestGeneration) this.publish({ loading: false, error: message(error) });
		}
	}
	/** Also the test seam for server-truth lifecycle transitions. */
	reconcile(infos: PluginInfo[]) {
		if (this.disposed) return;
		this.infos = infos;
		for (const life of [...this.lives.values()]) {
			const info = infos.find(item => item.id === life.id);
			if (!info?.enabled || info.status !== "active" || !info.manifest?.main || info.revision !== life.revision) this.stop(life);
		}
		for (const info of infos) {
			if (!info.enabled || info.status !== "active" || !info.manifest?.main || this.lives.has(info.id)) continue;
			const life: Lifecycle = {
				id: info.id, revision: info.revision, controller: new AbortController(), cleanups: new Set(),
				activation: Promise.resolve(), tasks: new Set(),
				views: new Map(), actions: new Map(), codeBlocks: new Map(), toolRenderers: new Map(),
				notifications: new Set(), events: new Set(), resyncs: new Set(), phase: "loading",
			};
			this.cleanupErrors.delete(info.id);
			this.lives.set(info.id, life);
			const previousTeardown = this.teardowns.get(info.id);
			// Store the task before executing ANY plugin code (even styles can
			// throw). Serialization is per package, never a window-wide queue.
			life.activation = Promise.resolve().then(async () => {
				await previousTeardown;
				if (!this.current(life)) return;
				await this.activate(info, life);
			});
		}
		this.publish();
	}
	private async activate(info: PluginInfo, life: Lifecycle) {
		const manifest = info.manifest!;
		const register = <T extends PluginView | PluginAction>(map: Map<string, T>, item: T, callback: "mount" | "run") => {
			if (!this.current(life)) return () => {};
			if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id)) {
				throw new Error("Plugin registration id must be a route-safe string of 1–128 characters, starting with a letter or number");
			}
			if (typeof item.name !== "string" || !item.name.trim()) throw new Error("Plugin registration name must be a nonempty string");
			const handler = callback === "mount" ? (item as PluginView).mount : (item as PluginAction).run;
			if (typeof handler !== "function") throw new Error(`Plugin registration ${callback} must be a function`);
			if (map.has(item.id)) throw new Error(`Duplicate plugin registration: ${item.id}`);
			map.set(item.id, item); this.publish();
			let registered = true;
			return () => {
				if (!registered) return;
				registered = false;
				if (map.get(item.id) === item) { map.delete(item.id); this.publish(); }
			};
		};
		const rejectRenderer = (text: string): never => {
			const error = new Error(text);
			this.report(life, error);
			throw error;
		};
		const registerRenderer = <T extends PluginCodeBlockRenderer | PluginToolRenderer>(
			map: Map<string, PluginRendererRegistration<T>>, renderer: T, kind: "language" | "toolName",
		) => {
			if (!this.current(life)) return () => {};
			const key = renderer && (kind === "language" ? (renderer as PluginCodeBlockRenderer).language : (renderer as PluginToolRenderer).toolName);
			if (typeof key !== "string" || !key.trim()) rejectRenderer(`Plugin renderer ${kind} must be a nonempty string`);
			if (typeof renderer.mount !== "function") rejectRenderer("Plugin renderer mount must be a function");
			const reserved = kind === "language" ? this.host.reservedCodeBlockLanguages : this.host.reservedToolNames;
			if (reserved?.includes(key)) rejectRenderer(`Plugin renderer ${kind} is reserved by the host: ${key}`);
			const existing = kind === "language" ? this.getCodeBlock(key) : this.getToolRenderer(key);
			if (existing) rejectRenderer(`Duplicate plugin renderer ${kind}: ${key}`);
			// Snapshot the key/callback without losing class-method receivers.
			const ownedRenderer = Object.freeze({ [kind]: key, mount: renderer.mount.bind(renderer) }) as unknown as T;
			const registration: PluginRendererRegistration<T> = Object.freeze({ pluginId: life.id, renderer: ownedRenderer });
			const mounts = new Set<() => void>();
			this.rendererMounts.set(registration, mounts);
			map.set(key, registration); this.publish();
			let registered = true;
			return () => {
				if (!registered) return;
				registered = false;
				if (map.get(key) === registration) map.delete(key);
				for (const off of [...mounts]) off();
				this.publish();
			};
		};
		const listen = <T>(set: Set<T>, listener: T) => {
			if (!this.current(life)) return () => {};
			set.add(listener);
			return () => { set.delete(listener); };
		};
		const context: PluginFrontendContext = {
			manifest, signal: life.controller.signal,
			cleanup: cleanup => { this.addCleanup(life, cleanup); },
			registerView: view => register(life.views, view, "mount"),
			registerAction: action => register(life.actions, action, "run"),
			registerCodeBlock: renderer => registerRenderer(life.codeBlocks, renderer, "language"),
			registerToolRenderer: renderer => registerRenderer(life.toolRenderers, renderer, "toolName"),
			registerSettings: mount => {
				if (!this.current(life)) return () => {};
				if (typeof mount !== "function") throw new Error("Plugin settings mount must be a function");
				if (life.settings) throw new Error("Plugin settings are already registered");
				life.settings = mount; this.publish();
				let registered = true;
				return () => {
					if (!registered) return;
					registered = false;
					if (life.settings === mount) { life.settings = undefined; this.publish(); }
				};
			},
			call: async <T>(operation: string, input?: unknown) => {
				if (!this.current(life)) throw new Error("Plugin is no longer active");
				const body = await this.json(`/api/plugins/${encodeURIComponent(info.id)}/call`, {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ operation, ...(input === undefined ? {} : { input }) }), signal: life.controller.signal,
				}) as { result: T };
				if (!this.current(life)) throw new Error("Plugin is no longer active");
				return body.result;
			},
			onNotification: listener => listen(life.notifications, listener),
			onAppEvent: listener => listen(life.events, listener),
			onResync: listener => listen(life.resyncs, listener),
			app: {
				pathname: () => this.host.pathname(),
				openHome: () => { if (this.current(life)) this.host.navigate("/"); },
				openSession: id => { if (this.current(life)) this.host.navigate(`/chat/${encodeURIComponent(id)}`); },
				openView: id => { if (this.current(life)) this.host.navigate(pluginViewPath(info.id, id)); },
			},
		};
		try {
			if (manifest.styles && this.host.style) {
				this.addCleanup(life, this.host.style(pluginAssetUrl(info, manifest.styles), () => this.report(life, new Error("Plugin stylesheet could not be loaded"))));
			}
			const frontend = await this.host.importModule(pluginAssetUrl(info, manifest.main!));
			if (!this.current(life)) return;
			if (typeof frontend.activate !== "function") throw new Error("Plugin frontend must export activate(context)");
			const cleanup = await frontend.activate(context);
			if (typeof cleanup === "function") this.addCleanup(life, cleanup);
			if (!this.current(life)) return;
			life.phase = "active"; this.publish();
		} catch (error) {
			if (!this.current(life)) return;
			// A failed activation is not retried on every SSE/refetch. Keep an
			// inert error generation until explicitly disabled or revised.
			this.stop(life);
			life.phase = "error"; life.error = message(error);
			this.lives.set(life.id, life); this.publish();
		}
	}
	async setEnabled(id: string, enabled: boolean) {
		if (this.disposed || this.pending.has(id)) return;
		this.pending.add(id); this.mutations++; this.requestGeneration++;
		if (!enabled) this.reconcile(this.infos.map(info => info.id === id ? { ...info, enabled: false, status: "disabled" } : info));
		this.publish({ error: undefined });
		try {
			await this.json(`/api/plugins/${encodeURIComponent(id)}`, {
				method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
			});
		} catch (error) { this.publish({ error: message(error) }); }
		finally {
			this.requestGeneration++; this.pending.delete(id); this.mutations--;
			this.publish(); await this.reload(false);
		}
	}
	async refresh() {
		if (this.disposed || this.snapshot.refreshing || this.mutations) return;
		this.mutations++; this.requestGeneration++;
		this.publish({ refreshing: true, error: undefined });
		try { await this.json("/api/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) }); }
		catch (error) { this.publish({ error: message(error) }); }
		finally {
			this.requestGeneration++; this.mutations--; this.publish({ refreshing: false }); await this.reload(false);
		}
	}
	private deliver<T>(life: Lifecycle, listeners: Set<(event: T) => void>, event: T) {
		for (const listener of [...listeners]) {
			if (!this.current(life)) break;
			try { void Promise.resolve(listener(event)).catch(error => this.report(life, error)); }
			catch (error) { this.report(life, error); }
		}
	}
	notify(event: PluginNotification) {
		const life = this.lives.get(event.pluginId);
		if (life) this.deliver(life, life.notifications, event);
	}
	appEvent(event: ServerEvent) {
		// Plugin messages have their own scoped channel, not a second delivery
		// through onAppEvent (nor a cross-plugin notification leak).
		if (event.type === "plugin-message") return;
		for (const life of this.lives.values()) this.deliver(life, life.events, event);
	}
	resync() {
		void this.reload();
		for (const life of this.lives.values()) {
			for (const listener of [...life.resyncs]) {
				if (!this.current(life)) break;
				try { void Promise.resolve(listener()).catch(error => this.report(life, error)); }
				catch (error) { this.report(life, error); }
			}
		}
	}
	async runAction(id: string, action: PluginAction) {
		const life = this.lives.get(id);
		if (!life || !this.current(life) || life.actions.get(action.id) !== action) return;
		try { await action.run(); } catch (error) { this.report(life, error); }
	}
	getCodeBlock(language: string): CodeBlockRegistration | undefined {
		for (const life of this.lives.values()) {
			const registration = life.codeBlocks.get(language);
			if (this.current(life) && registration) return registration;
		}
	}
	getToolRenderer(toolName: string): ToolRendererRegistration | undefined {
		for (const life of this.lives.values()) {
			const registration = life.toolRenderers.get(toolName);
			if (this.current(life) && registration) return registration;
		}
	}
	/** Bind a renderer mount to the registration as well as its activation.
	 * Unregistering aborts these mounts immediately, not just after React renders. */
	mountRenderer(registration: CodeBlockRegistration | ToolRendererRegistration, mount: PluginMount, container: HTMLElement, onError: (error: string) => void): () => void {
		const isRegistered = () => "language" in registration.renderer
			? this.getCodeBlock(registration.renderer.language) === registration
			: this.getToolRenderer(registration.renderer.toolName) === registration;
		if (!isRegistered()) return () => {};
		const mounts = this.rendererMounts.get(registration)!;
		const off = this.mount(registration.pluginId, (child, signal) => {
			if (isRegistered()) return mount(child, signal);
		}, container, onError);
		const release = () => { mounts.delete(release); off(); };
		mounts.add(release);
		return release;
	}
	/** Each mount gets a private child. A late cleanup can never erase a new
	 * view's DOM, including when navigating away and immediately back. */
	mount(id: string, mount: PluginMount, container: HTMLElement, onError: (error: string) => void): () => void {
		const life = this.lives.get(id);
		if (!life || !this.current(life)) return () => {};
		let alive = true;
		const controller = new AbortController();
		let returned: PluginCleanup | undefined;
		const child = container.ownerDocument.createElement("div");
		child.className = "min-h-0 min-w-0 flex-1";
		container.appendChild(child);
		const off = this.addCleanup(life, () => {
			alive = false; controller.abort(); child.remove();
			if (returned) { const cleanup = returned; returned = undefined; this.disposeCallback(life, cleanup); }
		});
		// Deferring to a microtask makes StrictMode's probe an inert mount.
		this.track(life, Promise.resolve().then(async () => {
			if (!alive || !this.current(life)) return;
			try {
				const cleanup = await mount(child, controller.signal);
				if (typeof cleanup === "function") {
					if (!alive || !this.current(life)) this.disposeCallback(life, cleanup);
					else returned = cleanup;
				}
			} catch (error) {
				if (alive && this.current(life)) { onError(message(error)); this.report(life, error); off(); }
			}
		}));
		return off;
	}
	/** Invalidation is immediate; callers may also await cooperative teardown. */
	dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true; this.requestGeneration++;
			for (const life of [...this.lives.values()]) this.stop(life);
			this.listeners.clear();
		}
		return Promise.all([...this.teardowns.values()]).then(() => {});
	}
}
