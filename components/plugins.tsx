"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SERVER_EVENT_TYPES, type PluginFrontendModule, type ServerEvent } from "@/src/core";
import { useNotifyHub } from "@/components/server-events";
import { PluginFrontendManager, type PluginHost, type PluginMount, type PluginSnapshot } from "@/components/plugin-manager";
import { createPluginUiStore, PluginUiHost } from "@/components/plugin-ui-host";
import { BUILTIN_MERMAID_LANGUAGE, reservedToolRendererNames } from "@/components/plugin-renderers";

const EMPTY: PluginSnapshot = { plugins: [], codeBlocks: [], toolRenderers: [], directory: "", conflicts: [], loading: true, refreshing: false };
const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
const PluginsContext = createContext<{ manager: PluginFrontendManager | null; snapshot: PluginSnapshot; uiStore: ReturnType<typeof createPluginUiStore> | null }>({ manager: null, snapshot: EMPTY, uiStore: null });

/** A deferred last-release makes React StrictMode's setup/cleanup/setup one
 * activation lifetime, while a genuine provider teardown still disposes. */
export function createPluginWindowOwner(host: PluginHost) {
	const uiStore = createPluginUiStore();
	const manager = new PluginFrontendManager({ ...host, createUi: host.createUi ?? uiStore.createUi });
	let leases = 0;
	let generation = 0;
	let disposed = false;
	return {
		manager, uiStore,
		get disposed() { return disposed; },
		acquire() {
			leases++; generation++; manager.start();
			let released = false;
			return () => {
				if (released) return;
				released = true; leases--;
				const last = ++generation;
				queueMicrotask(() => {
					if (leases === 0 && generation === last) { disposed = true; manager.dispose(); }
				});
			};
		},
	};
}

declare global {
	interface Window {
		__lhImportPlugin?: (url: string) => Promise<PluginFrontendModule>;
		__lhPluginLoader?: Promise<void>;
		__lhPluginWindow?: ReturnType<typeof createPluginWindowOwner>;
	}
}

/** The external module must be imported by the BROWSER, not rewritten into a
 * Next/Webpack chunk. This public module installs the native import wrapper;
 * await its load event before ever asking it to import a package asset. */
export async function importPluginModule(url: string): Promise<PluginFrontendModule> {
	if (!window.__lhImportPlugin) {
		window.__lhPluginLoader ??= new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.type = "module";
			script.src = "/plugin-loader.js";
			script.onload = () => {
				if (window.__lhImportPlugin) resolve();
				else reject(new Error("Plugin module loader did not initialize"));
			};
			script.onerror = () => { script.remove(); reject(new Error("Plugin module loader could not be loaded")); };
			document.head.appendChild(script);
		}).catch(error => { window.__lhPluginLoader = undefined; throw error; });
		await window.__lhPluginLoader;
	}
	return window.__lhImportPlugin!(url);
}

export function PluginsProvider({ children }: { children: ReactNode }) {
	const hub = useNotifyHub();
	if (!hub) throw new Error("useNotifyHub requires <ServerEventsProvider>");
	const router = useRouter();
	const routerRef = useRef(router);
	routerRef.current = router;
	const [manager, setManager] = useState<PluginFrontendManager | null>(null);
	const [uiStore, setUiStore] = useState<ReturnType<typeof createPluginUiStore> | null>(null);
	useEffect(() => {
		if (!window.__lhPluginWindow || window.__lhPluginWindow.disposed) {
			window.__lhPluginWindow = createPluginWindowOwner({
				reservedCodeBlockLanguages: [BUILTIN_MERMAID_LANGUAGE], reservedToolNames: reservedToolRendererNames(),
				fetch: (...args) => fetch(...args), importModule: importPluginModule,
				pathname: () => window.location.pathname, navigate: path => routerRef.current.push(path),
				openSettings: pluginId => window.dispatchEvent(new CustomEvent("lh:open-plugin-settings", { detail: pluginId })),
				style: (url, onError) => {
					const link = document.createElement("link");
					link.rel = "stylesheet"; link.href = url; link.onerror = onError;
					document.head.appendChild(link);
					return () => { link.onerror = null; link.remove(); };
				},
			});
		}
		const owner = window.__lhPluginWindow;
		setManager(owner.manager);
		setUiStore(owner.uiStore);
		return owner.acquire();
	}, []);
	useEffect(() => {
		if (!manager) return;
		const offs = SERVER_EVENT_TYPES.map(type => hub.subscribe(type, payload => {
			if (type === "plugin-message") manager.notify(payload as Parameters<typeof manager.notify>[0]);
			else manager.appEvent({ type, ...payload } as ServerEvent);
			if (type === "plugins-changed") void manager.reload();
		}));
		offs.push(hub.onResync(() => manager.resync()));
		return () => { for (const off of offs) off(); };
	}, [hub, manager]);
	const snapshot = useSyncExternalStore(manager?.subscribe ?? emptySubscribe, manager?.getSnapshot ?? emptySnapshot, emptySnapshot);
	return <PluginsContext.Provider value={{ manager, snapshot, uiStore }}>{children}</PluginsContext.Provider>;
}

/** Missing-provider fallback is intentional: existing sidebar render tests and
 * independent shells don't need plugin infrastructure to render. */
export function usePlugins() { return useContext(PluginsContext); }

/** Render inside SettingsDialogProvider: host widgets keep the real app contexts. */
export function PluginWidgets() {
	const { uiStore } = usePlugins();
	return uiStore ? <PluginUiHost store={uiStore} /> : null;
}

/** Plugins own this DOM subtree (including their own bundled React root if
 * desired). React owns only the outer frame and its inline error surface. */
export function PluginMountPoint({ pluginId, mount, label }: { pluginId: string; mount: PluginMount; label: string }) {
	const { manager } = usePlugins();
	const container = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string>();
	useEffect(() => {
		setError(undefined);
		if (!manager || !container.current) return;
		return manager.mount(pluginId, mount, container.current, setError);
	}, [manager, pluginId, mount]);
	return <>
		{error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{label}: {error}</p>}
		<div ref={container} aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col" />
	</>;
}
