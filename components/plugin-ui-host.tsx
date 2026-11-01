"use client";

import { Component, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginDialogProps, PluginMenuProps, PluginUi, PluginWidgetHandle, PluginWidgetOptions } from "@/src/core";
import type { Dictation } from "@/components/dictation";
import { PluginComposer, PluginDictation, PluginStandardComposer } from "@/components/plugin-composer";
import { PluginModelPicker, PluginThinkingPicker } from "@/components/plugin-model-picker";
import { PluginKnowledgePicker } from "@/components/plugin-knowledge-picker";
import { PluginSettingsRows } from "@/components/plugin-settings-rows";
import { Button } from "@/components/ui/button";
import { PluginWorkerResultSurface } from "@/components/plugin-worker-result";
import { MenuShell } from "@/components/menu-shell";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { focusKnowledgePickerElement, useKnowledgePickerModal } from "@/components/knowledge-picker-foreground";
export { PluginSettingsRows } from "@/components/plugin-settings-rows";

export interface PluginUiFactoryOptions { signal: AbortSignal; onError?: (error: unknown) => void }
interface Runtime {
	signal: AbortSignal;
	report(error: unknown): void;
	dispose(): void;
}
interface WidgetEntry {
	id: number;
	target: HTMLElement;
	props: unknown;
	runtime: Runtime;
	render(props: never, runtime: Runtime): ReactNode;
}

function invoke(callback: (() => void | Promise<void>) | undefined, report: Runtime["report"]) {
	try { void Promise.resolve(callback?.()).catch(report); } catch (error) { report(error); }
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
		createUi({ signal: lifetime, onError }: PluginUiFactoryOptions): PluginUi {
			const report = (error: unknown) => {
				if (lifetime.aborted) return;
				try { if (onError) onError(error); else console.error("Plugin UI failed", error); }
				catch (reportError) { console.error("Plugin UI error reporter failed", reportError); }
			};
			function mount<Props>(container: HTMLElement, props: Props, options: PluginWidgetOptions, render: (props: Props, runtime: Runtime) => ReactNode): PluginWidgetHandle<Props> {
				const scope = new AbortController();
				const target = container.ownerDocument.createElement("div");
				target.dataset.pluginUiWidget = "";
				let current = props;
				let disposed = false;
				const id = ++serial;
				const dispose = () => {
					if (disposed) return;
					disposed = true;
					lifetime.removeEventListener("abort", dispose);
					options.signal.removeEventListener("abort", dispose);
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
						return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, protect(child, [...path, key])]));
					}
					return value;
				}
				const entry = (): WidgetEntry => ({ id, target, props: protect(current), runtime, render: render as WidgetEntry["render"] });
				if (lifetime.aborted || options.signal.aborted) { disposed = true; scope.abort(); }
				else {
					container.append(target);
					lifetime.addEventListener("abort", dispose, { once: true });
					options.signal.addEventListener("abort", dispose, { once: true });
					snapshot = [...snapshot, entry()];
					publish();
				}
				return {
					update(next) {
						if (disposed) return;
						current = { ...current, ...next };
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
				mountButton: (target, props, options) => mount(target, props, options, (props, runtime) => <Button type="button" variant={props.variant} size={props.size} disabled={props.disabled} title={props.title} onClick={() => invoke(props.onClick, runtime.report)}>{props.label}</Button>),
				mountSettingsRows: (target, props, options) => mount(target, props, options, (schema, runtime) => <PluginSettingsRows schema={schema} onError={runtime.report} />),
				mountWorkerResult: (target, props, options) => mount(target, props, options, (props, runtime) => <PluginWorkerResultSurface label={props.label} status={props.status} text={props.text} presentation={props.presentation}>
					{props.content && <PluginContent content={props.content} runtime={runtime} />}
				</PluginWorkerResultSurface>),
				openMenu: (anchor, props, options) => mount(anchor.ownerDocument.body, props, options, (props, runtime) => <PluginMenu anchor={anchor} {...props} runtime={runtime} />),
				openDialog: (props, options) => mount(document.body, props, options, (props, runtime) => <PluginDialog {...props} runtime={runtime} />),
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

function PluginMenu({ anchor, items, label, preferredSide = "down", onClose, runtime }: PluginMenuProps & { anchor: HTMLElement; runtime: Runtime }) {
	const root = useRef<HTMLDivElement>(null);
	const anchorRef = useRef(anchor);
	const close = () => { invoke(onClose, runtime.report); runtime.dispose(); };
	useEffect(() => {
		const pointer = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target) && !anchor.contains(event.target)) close();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault(); event.stopPropagation(); close(); anchor.focus();
		};
		document.addEventListener("pointerdown", pointer);
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key, true); };
	});
	return <MenuShell anchorRef={anchorRef} testid="plugin-menu" preferredSide={preferredSide} menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
		<div ref={root} role="menu" aria-label={label}>{items.map((item) => <button type="button" role="menuitem" key={item.key} disabled={item.disabled}
			className="flex w-full rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted disabled:opacity-40"
			onClick={() => {
				try { void Promise.resolve(item.onSelect()).then(close).catch(runtime.report); } catch (error) { runtime.report(error); }
			}}>{item.label}</button>)}</div>
	</MenuShell>;
}

function PluginContent({ content, runtime }: Pick<PluginDialogProps, "content"> & { runtime: Runtime }) {
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
	return <div ref={root} />;
}

function PluginDialog({ title, content, onClose, runtime }: PluginDialogProps & { runtime: Runtime }) {
	const foreground = useKnowledgePickerModal();
	const { frame, modal } = foreground;
	const closing = useRef(false);
	const latestOnClose = useRef(onClose);
	latestOnClose.current = onClose;
	const close = () => {
		if (closing.current || runtime.signal.aborted) return;
		closing.current = true;
		invoke(latestOnClose.current, runtime.report);
		runtime.dispose();
	};
	const backdropDismiss = useBackdropDismiss(close);
	useLayoutEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		modal?.activate();
		if (foreground.canHandle()) focusKnowledgePickerElement(frame.current);
		return () => {
			modal?.close();
			if (!modal || modal.canRestoreFocus()) focusKnowledgePickerElement(previous);
		};
	}, [modal, frame]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (!foreground.canHandle()) return;
			// Only the uppermost plugin modal owns dismissal. A menu above it
			// gets first refusal, and core dialogs never consume the same Esc.
			const dialogs = document.querySelectorAll("[data-plugin-ui-dialog]:not([hidden])");
			if (document.querySelector("[data-lh-menu]") || dialogs.item(dialogs.length - 1) !== frame.current) return;
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
			if (event.key !== "Tab") return;
			if (foreground.store?.hasActivePicker()) event.stopPropagation();
			const controls = Array.from(frame.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"],[contenteditable="true"]') ?? []);
			const first = controls[0]; const last = controls.at(-1);
			if (!first) { event.preventDefault(); frame.current?.focus(); return; }
			if (event.shiftKey && (document.activeElement === first || document.activeElement === frame.current)) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && (document.activeElement === last || document.activeElement === frame.current)) { event.preventDefault(); first.focus(); }
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); };
	});
	return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" hidden={foreground.suspended} inert={foreground.suspended} style={foreground.suspended ? { display: "none" } : undefined} {...backdropDismiss}>
		<div ref={frame} hidden={foreground.suspended} inert={foreground.suspended} style={foreground.suspended ? { display: "none" } : undefined} data-plugin-ui-dialog="" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto rounded-xl border bg-card p-5 shadow-lg outline-none">
			<div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
				<Button type="button" variant="ghost" size="sm" aria-label="Close dialog" onClick={close}>Close</Button></div>
			<PluginContent content={content} runtime={runtime} />
		</div>
	</div>, document.body);
}
