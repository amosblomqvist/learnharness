"use client";

import { Component, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginBadgeProps, PluginButtonProps, PluginDialogProps, PluginMenuProps, PluginSurfaceProps, PluginSurfaceTarget, PluginUi, PluginWidgetHandle, PluginWidgetOptions } from "@/src/core";
import type { Dictation } from "@/components/dictation";
import { PluginComposer, PluginDictation, PluginStandardComposer } from "@/components/plugin-composer";
import { PluginModelPicker, PluginThinkingPicker } from "@/components/plugin-model-picker";
import { PluginKnowledgePicker } from "@/components/plugin-knowledge-picker";
import { PluginSettingsRows } from "@/components/plugin-settings-rows";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { PluginWorkerResultSurface } from "@/components/plugin-worker-result";
import { HostMarkdown } from "@/components/host-markdown";
import { PluginTree, validatePluginTree } from "@/components/plugin-tree";
import { MenuShell } from "@/components/menu-shell";
import { HostDialog } from "@/components/host-dialog";
import { findCurrentSurfaceBoundary, requireSurfaceBoundary } from "./plugin-surface-targets";
import { PluginSurface } from "./plugin-surface-shell";
import { isInteractionElementVisible, useInteractionLayers, type CloseOutcome, type CloseReason } from "@/components/interaction-layers";
export { PluginSettingsRows } from "@/components/plugin-settings-rows";

export interface PluginUiFactoryOptions { signal: AbortSignal; pluginId?: string; onError?: (error: unknown) => void }
interface Runtime {
	signal: AbortSignal;
	report(error: unknown): void;
	dispose(): void;
}
interface WidgetEntry {
	id: number;
	surface: boolean;
	target: HTMLElement;
	props: unknown;
	runtime: Runtime;
	render(props: never, runtime: Runtime): ReactNode;
}

function invoke(callback: (() => void | Promise<void>) | undefined, report: Runtime["report"]) {
	try { void Promise.resolve(callback?.()).catch(report); } catch (error) { report(error); }
}

function validateButtonColors(colors: PluginButtonProps["colors"]) {
	if (colors === undefined) return;
	const states = ["hover", "active", "focusVisible", "disabled"];
	function validate(value: unknown, path: string, root = false, focus = false) {
		if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
			throw new TypeError(`${path} must be a color object.`);
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") throw new TypeError(`${path} has an unsupported color slot.`);
			const slot = (value as Record<string, unknown>)[key];
			if (root && states.includes(key)) {
				if (slot !== undefined) validate(slot, `${path}.${key}`, false, key === "focusVisible");
			} else if (["background", "text", "border"].includes(key) || (focus && key === "ring")) {
				if (slot !== undefined && (typeof slot !== "string" || !slot.trim() || !globalThis.CSS?.supports("color", slot))) {
					throw new TypeError(`${path}.${key} must be a valid CSS color.`);
				}
			} else throw new TypeError(`${path}.${key} is not a supported color slot.`);
		}
	}
	validate(colors, "Button colors", true);
}

function validateButton({ icon, iconOnly, label, colors }: PluginButtonProps) {
	if (icon !== undefined && typeof icon !== "string") throw new TypeError("Button icon must be SVG markup.");
	if (iconOnly !== undefined && typeof iconOnly !== "boolean") throw new TypeError("Button iconOnly must be a boolean.");
	if (iconOnly && (!icon?.trim() || typeof label !== "string" || !label.trim())) {
		throw new TypeError("Icon-only buttons require a nonblank label and icon.");
	}
	validateButtonColors(colors);
}

function validateBadge({ text, color }: PluginBadgeProps) {
	if (typeof text !== "string") throw new TypeError("Badge text must be a string.");
	if (color !== undefined && (typeof color !== "string" || !color.trim() ||
		!globalThis.CSS?.supports("color", color) ||
		!globalThis.CSS.supports("background-color", `color-mix(in oklab, ${color} 15%, transparent)`))) {
		throw new TypeError("Badge color must be a valid CSS color supporting a background tint.");
	}
}

function validateSurfaceBackground({ background }: PluginSurfaceProps) {
	if (background !== undefined && background !== "dimmed" && background !== "opaque") {
		throw new TypeError('Surface background must be "dimmed" or "opaque".');
	}
}

/** Imperative plugin calls become portals in the host tree, never isolated React roots. */
export function createPluginUiStore() {
	let serial = 0;
	let snapshot: readonly WidgetEntry[] = [];
	const listeners = new Set<() => void>();
	const publish = () => { for (const listener of listeners) listener(); };
	const store = {
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot() { return snapshot; },
		createUi({ signal: lifetime, pluginId, onError }: PluginUiFactoryOptions): PluginUi {
			const report = (error: unknown) => {
				if (lifetime.aborted) return;
				try { if (onError) onError(error); else console.error("Plugin UI failed", error); }
				catch (reportError) { console.error("Plugin UI error reporter failed", reportError); }
			};
			// Identity is this UI owner's exact element, not a plugin id or selector.
			const menus = new WeakMap<HTMLElement, { close(): boolean }>();
			function mount<Props>(container: HTMLElement, props: Props, options: PluginWidgetOptions, render: (props: Props, runtime: Runtime) => ReactNode, nativeSignal?: AbortSignal, surface = false, validate?: (props: Props) => void, contentRecords: readonly string[] = [], onMount?: (runtime: Runtime, current: () => Props) => void): PluginWidgetHandle<Props> {
				const scope = new AbortController();
				const target = container.ownerDocument.createElement("div");
				target.dataset.pluginUiWidget = "";
				// Surface portal wrappers are transparent to the shared local paint stack.
				if (surface) target.style.display = "contents";
				let current = props;
				let disposed = false;
				const id = ++serial;
				const dispose = () => {
					if (disposed) return;
					disposed = true;
					lifetime.removeEventListener("abort", dispose);
					options.signal.removeEventListener("abort", dispose);
					nativeSignal?.removeEventListener("abort", dispose);
					scope.abort();
					snapshot = snapshot.filter((entry) => entry.id !== id);
					target.remove();
					publish();
				};
				const runtime: Runtime = { signal: scope.signal, report, dispose };
				// Resolve callbacks from the latest controlled props, even when update()
				// happens inside an async transcript callback before React's next render.
				type CallbackPathPart = string | number | { key: string };
				function protect(value: unknown, path: CallbackPathPart[] = []): unknown {
					if (typeof value === "function" && String(path.at(-1)).startsWith("on")) {
						return (...args: unknown[]) => {
							if (scope.signal.aborted) return;
							let callback: unknown = current;
							for (const part of path) {
								if (typeof part === "object") {
									callback = Array.isArray(callback) ? callback.find((item: unknown) =>
										item !== null && typeof item === "object" && "key" in item && item.key === part.key) : undefined;
								} else {
									callback = callback !== null && (typeof callback === "object" || typeof callback === "function")
										? (callback as Record<string | number, unknown>)[part] : undefined;
								}
							}
							return typeof callback === "function" ? callback(...args) : undefined;
						};
					}
					if (Array.isArray(value)) return value.map((child: unknown, index) => {
						// Rendered rows/menu items retain their identity across synchronous
						// reorders. A removed item's old control must never invoke its successor.
						const identity = child !== null && typeof child === "object" && "key" in child && typeof child.key === "string"
							? { key: child.key } : index;
						return protect(child, [...path, identity]);
					});
					if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
						// Content dictionaries have arbitrary author-defined keys. An
						// "on..." cell is a mount function, not an event callback.
						return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, contentRecords.includes(key) ? child : protect(child, [...path, key])]));
					}
					return value;
				}
				const entry = (): WidgetEntry => ({ id, surface, target, props: protect(current), runtime, render: render as WidgetEntry["render"] });
				if (lifetime.aborted || options.signal.aborted || nativeSignal?.aborted) { disposed = true; scope.abort(); }
				else {
					validate?.(current);
					onMount?.(runtime, () => current);
					container.append(target);
					lifetime.addEventListener("abort", dispose, { once: true });
					options.signal.addEventListener("abort", dispose, { once: true });
					nativeSignal?.addEventListener("abort", dispose, { once: true });
					snapshot = [...snapshot, entry()];
					publish();
				}
				return {
					update(next) {
						if (disposed) return;
						const updated = { ...current, ...next };
						validate?.(updated);
						current = updated;
						snapshot = snapshot.map((item) => item.id === id ? entry() : item);
						publish();
					},
					dispose,
				};
			}
			return {
				mountModelPicker: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginModelPicker {...props} onError={runtime.report} />),
				mountThinkingPicker: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginThinkingPicker {...props} onError={runtime.report} />),
				mountKnowledgePicker: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginKnowledgePicker {...props} signal={runtime.signal} onError={runtime.report} />),
				mountComposer: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginComposer {...props} onError={runtime.report} />),
				mountStandardComposer: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginStandardComposer {...props} signal={runtime.signal} onError={runtime.report} />),
				mountDictation: (target, props, options) => {
					const actions: { current: Dictation | null } = { current: null };
					const handle = mount(target, props, options, (props, runtime) => <PluginDictation {...props} actionRef={actions} signal={runtime.signal} onError={runtime.report} />);
					return { ...handle,
						toggle: () => { if (!lifetime.aborted && !options.signal.aborted) actions.current?.toggle(); },
						cancel: () => actions.current?.cancel(),
						finish: () => actions.current?.finish() ?? Promise.resolve(),
						dispose: () => { actions.current?.cancel(); actions.current = null; handle.dispose(); },
					};
				},
				mountButton: (target, props, options) => mount(target, props, options, (props, runtime) => <Button type="button"
					variant={props.variant} colors={props.colors} size={props.size} disabled={props.disabled} title={props.title}
					aria-label={props.iconOnly ? props.label : undefined} onClick={() => invoke(props.onClick, runtime.report)}>
					{props.icon && <span data-slot="button-icon" aria-hidden="true" className="inline-flex shrink-0 items-center justify-center" dangerouslySetInnerHTML={{ __html: props.icon }} />}
					{!props.iconOnly && props.label}
				</Button>, undefined, false, validateButton),
				mountBadge: (target, props, options) => mount(target, props, options, props => <StatusBadge {...props} />, undefined, false, validateBadge),
				mountSettingsRows: (target, props, options) => mount(target, props, options, (schema, runtime) => <PluginSettingsRows schema={schema} onError={runtime.report} />),
				mountMarkdown: (target, props, options) => mount(target, props, options, props => <HostMarkdown text={props.text} />),
				mountTree: (target, tree, options) => mount(target, tree, options, (tree, runtime) => <PluginTree {...tree} signal={runtime.signal} onError={runtime.report}
					renderContent={content => <PluginContent content={content} runtime={runtime} />} />, undefined, false, validatePluginTree, ["cells"]),
				mountWorkerResult: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginWorkerResultSurface label={props.label} status={props.status} text={props.text} presentation={props.presentation}>
					{props.content && <PluginContent content={props.content} runtime={runtime} />}
				</PluginWorkerResultSurface>),
				openMenu: (anchor, props, options) => {
					// A menu is an anchored interactive child, not another visual stack
					// sibling. It cannot outlive its surface and reportal to the body.
					if (lifetime.aborted || options.signal.aborted || !anchor.isConnected) return { update() {}, dispose() {} };
					const existing = menus.get(anchor);
					if (existing) { existing.close(); return { update() {}, dispose() {} }; }
					const owner = [...snapshot].reverse().find(entry => entry.surface && entry.target.contains(anchor));
					let closeMenu = () => false;
					return mount(anchor.ownerDocument.body, props, options, (props, runtime) => <PluginMenu anchor={anchor} {...props} runtime={runtime} closeMenu={closeMenu} />, owner?.runtime.signal, false, undefined, [], (runtime, current) => {
						let closing = false;
						const forget = () => { if (menus.get(anchor) === menu) menus.delete(anchor); };
						const menu = { close() {
							if (closing || runtime.signal.aborted) return false;
							closing = true;
							// Release before callbacks: reentrant opens own a fresh entry, and
							// disposing this old widget must not erase their registration.
							forget();
							invoke(current().onClose, runtime.report);
							runtime.dispose();
							return true;
						} };
						closeMenu = menu.close;
						menus.set(anchor, menu); // Before publish, including synchronous subscribers.
						runtime.signal.addEventListener("abort", forget, { once: true });
					});
				},
				openDialog: (props, options) => {
					const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
					return mount(document.body, props, options, (props, runtime) => <PluginDialog {...props} opener={opener} runtime={runtime} />);
				},
				openSurface: (targetOrProps: PluginSurfaceTarget | PluginSurfaceProps, propsOrOptions: PluginSurfaceProps | PluginWidgetOptions, explicitOptions?: PluginWidgetOptions) => {
					const options = explicitOptions ?? propsOrOptions as PluginWidgetOptions;
					// Abort wins over page capture and validation, matching existing inert handles.
					if (lifetime.aborted || options.signal.aborted) return { update() {}, dispose() {} };
					const props = (explicitOptions ? propsOrOptions : targetOrProps) as PluginSurfaceProps;
					const boundary = requireSurfaceBoundary(explicitOptions ? targetOrProps as PluginSurfaceTarget : findCurrentSurfaceBoundary(document)?.target);
					const opener = boundary.body.ownerDocument.activeElement;
					const handle = mount(boundary.stack!.querySelector<HTMLElement>("[data-session-surface-mounts]")!, props, options,
						(props, runtime) => <PluginSurface pluginId={pluginId} title={props.title} background={props.background} onClose={props.onClose} runtime={runtime} boundary={boundary}
							opener={opener instanceof HTMLElement ? opener : null}>
							<PluginContent content={props.content} runtime={runtime} className="h-full w-full" />
						</PluginSurface>, boundary.signal, true, validateSurfaceBackground);
					return handle;
				},
			};
		},
	};
	return store;
}
export type PluginUiStore = ReturnType<typeof createPluginUiStore>;

class WidgetErrorBoundary extends Component<{ children: ReactNode; runtime: Runtime }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	componentDidCatch(error: unknown) { this.props.runtime.report(error); this.props.runtime.dispose(); }
	render() { return this.state.failed ? null : this.props.children; }
}

function WidgetRender({ entry }: { entry: WidgetEntry }) {
	return entry.render(entry.props as never, entry.runtime);
}

export function PluginUiHost({ store }: { store: PluginUiStore }) {
	const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	return <>{entries.map((entry) => createPortal(
		<WidgetErrorBoundary key={entry.id} runtime={entry.runtime}><WidgetRender entry={entry} /></WidgetErrorBoundary>,
		entry.target, String(entry.id),
	))}</>;
}

function PluginMenu({ anchor, items, label, preferredSide = "down", closeMenu, runtime }: PluginMenuProps & { anchor: HTMLElement; runtime: Runtime; closeMenu(): boolean }) {
	const root = useRef<HTMLDivElement>(null);
	const anchorRef = useRef(anchor);
	const controller = useInteractionLayers();
	const close = (reason: CloseReason = "action"): CloseOutcome => {
		if (!closeMenu()) return "closed";
		const owner = controller.ownerOf(anchor);
		if (reason === "escape" && isInteractionElementVisible(anchor) && (!owner || controller.isLayerEligible(owner.id))) anchor.focus();
		return "closed";
	};
	useEffect(() => {
		const pointer = (event: PointerEvent) => {
			if (!controller.isElementEligible(root.current)) return;
			if (event.target instanceof Node && !root.current?.contains(event.target) && !anchor.contains(event.target)) close("outside");
		};
		document.addEventListener("pointerdown", pointer);
		return () => document.removeEventListener("pointerdown", pointer);
	});
	return <MenuShell anchorRef={anchorRef} testid="plugin-menu" onClose={close} preferredSide={preferredSide} menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
		<div ref={root} role="menu" aria-label={label}>{items.map((item) => <button type="button" role="menuitem" key={item.key} disabled={item.disabled}
			className="flex w-full rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted disabled:opacity-40"
			onClick={() => {
				try { void Promise.resolve(item.onSelect()).then(() => close()).catch(runtime.report); } catch (error) { runtime.report(error); }
			}}>{item.label}</button>)}</div>
	</MenuShell>;
}

function PluginContent({ content, runtime, className }: Pick<PluginDialogProps, "content"> & { runtime: Runtime; className?: string }) {
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const scope = new AbortController();
		let cleanup: void | (() => void);
		let cleaned = false;
		const dispose = () => {
			if (cleaned) return;
			cleaned = true; scope.abort();
			try { cleanup?.(); } catch (error) { runtime.report(error); }
			root.current?.replaceChildren();
		};
		runtime.signal.addEventListener("abort", dispose, { once: true });
		if (runtime.signal.aborted) dispose();
		else if (typeof content === "function") {
			try {
				void Promise.resolve(content(root.current!, scope.signal)).then((result) => {
					if (cleaned) { try { result?.(); } catch (error) { runtime.report(error); } }
					else cleanup = result;
				}).catch(runtime.report);
			} catch (error) { runtime.report(error); }
		} else root.current!.append(content);
		return () => { runtime.signal.removeEventListener("abort", dispose); dispose(); };
	}, [content, runtime]);
	return <div ref={root} className={className} />;
}

function PluginDialog({ title, content, onClose, runtime, opener }: PluginDialogProps & { runtime: Runtime; opener: HTMLElement | null }) {
	const controller = useInteractionLayers();
	const ownerId = useRef(controller.ownerOf(opener)?.id ?? null);
	const closing = useRef(false);
	const latestOnClose = useRef(onClose);
	latestOnClose.current = onClose;
	const close = (): CloseOutcome => {
		if (closing.current || runtime.signal.aborted) return "closed";
		closing.current = true;
		invoke(latestOnClose.current, runtime.report);
		runtime.dispose();
		return "closed";
	};
	return <HostDialog open onClose={close} ownerId={ownerId.current} aria-label={title}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}
		frame={<div data-plugin-ui-dialog="" tabIndex={-1} className="relative mx-4 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-lg outline-none" />}>
		<div data-plugin-ui-dialog-scroll="" className="min-h-0 overflow-y-auto p-5">
			<PluginContent content={content} runtime={runtime} />
		</div>
		<button type="button" aria-label="Close dialog" title="Close" onClick={close}
			className="absolute right-2 top-2 z-10 size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
			<svg viewBox="0 0 16 16" className="mx-auto size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M4 4l8 8M12 4l-8 8" />
			</svg>
		</button>
	</HostDialog>;
}
