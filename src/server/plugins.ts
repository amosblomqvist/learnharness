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
import { installBundledPlugins } from "../store/plugin-installation.ts";
import { assertGraphFormat } from "../store/graph-format.ts";
import { createPluginLearningData } from "./plugin-learning.ts";
import { createPluginInference } from "./plugin-inference.ts";
import { createPluginBackgroundTool, recoverPluginBackgroundJob } from "./plugin-background-tools.ts";
import { registerPluginWorkerActivity } from "./plugin-worker-activity.ts";
import { deliverJobResult, setPluginJobRecovery } from "./jobs.ts";
import { createPluginHost } from "./plugin-host.ts";
import { createPluginTransport } from "./plugin-transport.ts";
import type { AgentBuildOptions } from "../agent/teacher-agent.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";

export const pluginDirectory = path.join(/* turbopackIgnore: true */ PATHS.data, "plugins");
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
		directory: pluginDirectory, appVersion: packageJson.version, installationErrors,
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
		onChange: () => emit("plugins-changed", {}),
		onNotification: (notification) => emit("plugin-message", notification),
	});
	// Defer installation/activation until the process-wide holder is published.
	const ready = Promise.resolve().then(async () => {
		setPluginJobRecovery(job => recoverPluginBackgroundJob(job, {
			jobStore: stores.jobStore, deliver: deliverJobResult,
			readTask: (pluginId, taskId, requestId) => readPluginTaskRecord(pluginDirectory, pluginId, taskId, requestId),
			registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
		}));
		// Exclusive bootstrap sweep, including disabled packages whose services
		// will not construct. Read-only job recovery never activates plugin code.
		for (const [id, error] of Object.entries(recoverPluginTaskRecords(pluginDirectory))) {
			installationErrors[id] = `Task recovery failed: ${error}`;
		}
		const bundled = path.join(PATHS.root, "bundled-plugins");
		if (fs.existsSync(bundled)) {
			const report = installBundledPlugins(bundled, pluginDirectory, packageJson.version);
			for (const [id, error] of Object.entries(report.errors)) {
				const diagnostic = `Bundled installation failed: ${error}`;
				installationErrors[id] = Object.hasOwn(installationErrors, id) ? `${installationErrors[id]}; ${diagnostic}` : diagnostic;
			}
		}
		await host.initialize();
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
export const pluginTransport = createPluginTransport({ getHost: getPluginHost, directory: pluginDirectory });
