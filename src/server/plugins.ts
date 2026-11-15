import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, GRAPH_FORMAT_FILE, RENDER_SETTINGS_FILE } from "../../config.ts";
import packageJson from "../../package.json";
import { emit, subscribe } from "../core/events.ts";
import { createPluginAgentService } from "../agent/plugin-agents.ts";
import { createPluginWorkerService } from "../agent/plugin-workers.ts";
import { registerJobAbort, unregisterJobAbort } from "../agent/subagents/aborts.ts";
import { createPluginAgentRecordStore } from "../store/plugin-agent-records.ts";
import { createPluginTaskRecordStore, readPluginTaskRecord, recoverPluginTaskRecords } from "../store/plugin-task-records.ts";
import corePluginIds from "../../core-plugins.json";
import { assertGraphFormat } from "../store/graph-format.ts";
import { createPluginLearningData } from "./plugin-learning.ts";
import { createPluginInference } from "./plugin-inference.ts";
import { createPluginBackgroundTool, recoverPluginBackgroundJob } from "./plugin-background-tools.ts";
import { registerPluginWorkerActivity } from "./plugin-worker-activity.ts";
import { deliverJobResult, setPluginJobRecovery } from "./jobs.ts";
import { createPluginHost } from "./plugin-host.ts";
import { createPluginTransport } from "./plugin-transport.ts";
import { createPluginDocumentConverter } from "./plugin-documents.ts";
import type { AgentBuildOptions } from "../agent/teacher-agent.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";
import { acquireHold } from "../core/host-hold.ts";
import { stampDataFormat } from "../store/data-format.ts";
import { installQuitSequence, requestDesktopRestart, sendLifecycle, startupHookSignal } from "./desktop-lifecycle.ts";

export const pluginDirectory = path.join(/* turbopackIgnore: true */ PATHS.data, "plugins");
// Explicitly staged by build-server, not discovered by Next's filesystem tracer.
const core = {
	directory: path.join(/* turbopackIgnore: true */ PATHS.root, "core-plugins"),
	dataDirectory: path.join(/* turbopackIgnore: true */ PATHS.data, "core-plugin-data"),
	ids: corePluginIds,
};
const coreData = { directory: core.dataDirectory, ids: core.ids };
type Host = ReturnType<typeof createPluginHost>;
interface Runtime { host: Host; ready: Promise<void> }
interface PluginGlobal { __lhPlugins?: Runtime }

/** Single composition for every Next entry. Importing this module does not load
 * plugin code or touch plugin storage; instrumentation (or a route) initializes it. */
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & PluginGlobal;
	if (global.__lhPlugins) return global.__lhPlugins;
	const learning = createPluginLearningData({
		directory: PATHS.data, chatStore: stores.chatStore, graphStore: stores.graphStore,
		isBusy: isTurnRunning, isCompacting: compactionInFlight,
		readMetadata(name) {
			assertGraphFormat();
			try { return JSON.parse(fs.readFileSync(name === "format.json" ? GRAPH_FORMAT_FILE : RENDER_SETTINGS_FILE, "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		},
	});
	const installationErrors: Record<string, string> = Object.create(null);
	const host = createPluginHost({
		directory: pluginDirectory, core, appVersion: packageJson.version, installationErrors,
		// The process-global runtime owns one admission slot across all plugins
		// and every separately compiled Next route module.
		convertDocument: createPluginDocumentConverter().convert,
		createServices({ manifest, dataDirectory, signal }) {
			const inference = createPluginInference({ signal, dataDirectory });
			const agents = createPluginAgentService({
				store: createPluginAgentRecordStore(path.join(/* turbopackIgnore: true */ dataDirectory, "agents")),
				engineFor: inference.engineFor, onUsage: inference.onUsage, signal,
				onChange: () => { if (!signal.aborted) emit("plugin-message", { pluginId: manifest.id, topic: "agents-changed" }); },
			});
			const workerActivity = registerPluginWorkerActivity({
				pluginId: manifest.id, pluginName: manifest.name, signal,
				cancel: taskId => workers.cancel(taskId),
			});
			const workers = createPluginWorkerService({
				store: createPluginTaskRecordStore(path.join(/* turbopackIgnore: true */ dataDirectory, "tasks")),
				engineFor: inference.engineFor, onUsage: inference.onUsage, signal,
				onChange: workerActivity,
			});
			return { learning, inference: inference.inference, agents, workers,
				createBackgroundTool(context, definition) {
					return createPluginBackgroundTool({
						pluginId: manifest.id, context, definition, workers, signal, jobStore: stores.jobStore,
						deliver: deliverJobResult, isActive: () => !signal.aborted,
						registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
					});
				},
			};
		},
		subscribeEvents: subscribe,
		onChange: () => { emit("plugins-changed", {}); reportQuitHooks(); },
		onNotification: (notification) => emit("plugin-message", notification),
		learningDirectory: PATHS.data,
		requestRestart: requestDesktopRestart,
	});
	// The desktop shell waits for beforeQuit hooks only while one exists.
	let quitHooks: boolean | undefined;
	function reportQuitHooks(): void {
		const next = host.hasBeforeQuit();
		if (next === quitHooks) return;
		quitHooks = next;
		sendLifecycle({ op: "hooks", beforeQuit: next });
	}
	installQuitSequence(async (signal) => { await host.runBeforeQuit(signal); });
	// Defer recovery/activation until the process-wide holder is published.
	const ready = Promise.resolve().then(async () => {
		// beforeLoad hooks (e.g. a sync pull) run first, before any data is
		// recovered or loaded, under a host hold so nothing else starts.
		// Failures and the time limit never block startup.
		const startup = startupHookSignal();
		const hold = acquireHold({ owner: "host", reason: "Syncing before load", force: true });
		let announced = false;
		try {
			await host.runBeforeLoad(startup.signal, (plugins) => { announced = true; sendLifecycle({ op: "before-load", state: "start", plugins }); });
		} catch (error) {
			console.error("[plugins] beforeLoad hooks failed:", error);
		} finally {
			hold?.release();
			startup.dispose();
			if (announced) sendLifecycle({ op: "before-load", state: "done" });
		}
		try { stampDataFormat(); }
		catch (error) { console.error("[data-format] could not write the data format stamp:", error); }
		setPluginJobRecovery(job => recoverPluginBackgroundJob(job, {
			jobStore: stores.jobStore, deliver: deliverJobResult,
			readTask: (pluginId, taskId, requestId) => readPluginTaskRecord(pluginDirectory, pluginId, taskId, requestId, coreData),
			registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
		}));
		// Exclusive bootstrap sweep, including disabled packages whose services
		// will not construct. Read-only job recovery never activates plugin code.
		for (const [id, error] of Object.entries(recoverPluginTaskRecords(pluginDirectory, coreData))) {
			installationErrors[id] = `Task recovery failed: ${error}`;
		}
		await host.initialize();
		reportQuitHooks();
	});
	global.__lhPlugins = { host, ready };
	return global.__lhPlugins;
}

export async function initializePlugins(): Promise<void> { await runtime().ready; }
export async function getPluginHost(): Promise<Host> {
	const { host, ready } = runtime();
	await ready;
	return host;
}
/** Await startup once; actual factories run synchronously during per-turn Agent construction. */
export async function getPluginAgentContributions(): Promise<NonNullable<AgentBuildOptions["pluginContributions"]>> {
	return (await getPluginHost()).agentContributions;
}
/** Await startup before reading canonical truth; the returned resolver itself is synchronous. */
export async function getPluginQuestionTypeResolver(): Promise<Host["resolveQuestionType"]> {
	return (await getPluginHost()).resolveQuestionType;
}
export const pluginTransport = createPluginTransport({ getHost: getPluginHost, directory: pluginDirectory });
