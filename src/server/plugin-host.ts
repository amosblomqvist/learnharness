import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PLUGIN_ID_PATTERN, parsePluginManifest } from "../core/plugins.ts";
import { validatePluginSchema } from "../core/plugin-validation.ts";
import { createPluginQuestionParameters, preparePluginQuestionType } from "../core/plugin-questions.ts";
import type { PluginQuestionTypeDefinition, PluginQuestionVariant } from "../core/plugin-questions.ts";
import type { PluginAgentKind, PluginBackendContext, PluginBackendModule, PluginCleanup, PluginFrontendContext, PluginInfo, PluginInference, PluginInstructions, PluginLearningData, PluginManifest, PluginNotification, PluginToolContext, PluginTools } from "../core/plugins.ts";
import type { PluginAgentService } from "../core/plugin-agents.ts";
import type { PluginWorkerService } from "../core/plugin-workers.ts";
import type { ServerEvent } from "../core/events.ts";
import { pendingBundledPluginIds } from "../store/plugin-installation.ts";

/** Expected host/transport failure. Exceptions thrown by plugin handlers stay ordinary 500 errors. */
export class PluginHostError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message); this.name = "PluginHostError";
		Object.defineProperty(this, Symbol.for("learnharness.plugin-host-error"), { value: true });
	}
}
/** Works across Next module instances holding the same process-global host. */
export function isPluginHostError(error: unknown): error is { status: number; message: string } {
	if (!error || typeof error !== "object") return false;
	try {
		const value = error as Record<string | symbol, unknown>;
		return value[Symbol.for("learnharness.plugin-host-error")] === true &&
			typeof value.message === "string" && typeof value.status === "number" &&
			[400, 404, 409, 413, 500, 503].includes(value.status);
	} catch { return false; }
}

export interface PluginHostDependencies {
	directory: string;
	appVersion: string;
	createServices(info: { manifest: PluginManifest; directory: string; dataDirectory: string; signal: AbortSignal; cleanup: (fn: PluginCleanup) => void }): {
		learning: PluginLearningData; inference: PluginInference; agents: PluginAgentService; workers: PluginWorkerService;
		createBackgroundTool: PluginBackendContext["createBackgroundTool"];
	};
	/** One process-wide pure converter; no backend services are needed for uploads. */
	convertDocument?: (request: Request, signal: AbortSignal) => ReturnType<PluginFrontendContext["documents"]["toMarkdown"]>;
	onChange?: () => void;
	onNotification?: (notification: PluginNotification) => void;
	subscribeEvents?: (listener: (event: ServerEvent) => void) => () => void;
	/** Startup installation/recovery failures, including failures before a package directory exists. */
	installationErrors?: Record<string, string>;
}
interface Instructions { agents: Set<PluginAgentKind>; text: string }
interface Tools { agents: Set<PluginAgentKind>; create: PluginTools["create"] }
type QuestionDefinition = PluginQuestionTypeDefinition<any, any>;
/** Frozen per-turn provenance, admitted atomically with ordinary package contributions. */
export interface PluginQuestionContribution {
	pluginId: string;
	definition: QuestionDefinition;
	variant: PluginQuestionVariant;
	signal: AbortSignal;
	requireActive(): void;
}
export type PluginQuestionResolution =
	| { status: "available"; definition: QuestionDefinition; signal: AbortSignal; requireActive(): void }
	| { status: "incompatible" }
	| { status: "unavailable" };
export interface PluginAgentContributions { instructions: string[]; tools: AgentTool<any>[]; questionTypes?: PluginQuestionContribution[] }
interface Activation {
	controller: AbortController;
	cleanups: PluginCleanup[];
	handlers: Map<string, (input: unknown) => unknown | Promise<unknown>>;
	instructions: Set<Instructions>;
	tools: Set<Tools>;
	questions: Map<string, QuestionDefinition>;
	ready: boolean;
}
interface Package {
	info: PluginInfo;
	rootDirectory: string;
	directory: string;
	files: Map<string, Buffer>;
	activation?: Activation;
	backend?: PluginBackendModule;
	restart?: string;
	blocked?: boolean;
	contributionWarning?: string;
}
interface State { version: 1; enabled: Record<string, boolean> }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const operationId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// Common native provider subset: no punctuation, leading digit, or >64-char names.
const nativeToolName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const agentKinds: readonly PluginAgentKind[] = ["prober", "teacher", "practice"];
function targets(agents: PluginAgentKind[]): Set<PluginAgentKind> {
	if (!Array.isArray(agents) || !agents.length || !agents.every(agent => agentKinds.includes(agent))) throw new Error("Plugin contributions require explicit nonempty prober/teacher/practice targets");
	return new Set(agents);
}
const safeSegment = (p: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p);

function readState(filename: string): State {
	if (!exists(filename)) return { version: 1, enabled: Object.create(null) };
	if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("Unsafe plugins-state.json");
	const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filename, "utf8"));
	if (!object(value) || value.version !== 1 || !object(value.enabled)) throw new Error("Invalid or unsupported plugins-state.json");
	const enabled: Record<string, boolean> = Object.create(null);
	for (const [id, flag] of Object.entries(value.enabled)) {
		if (!PLUGIN_ID_PATTERN.test(id) || typeof flag !== "boolean") throw new Error("Invalid plugins-state.json enabled entry");
		enabled[id] = flag;
	}
	return { version: 1, enabled };
}
function writeState(filename: string, state: State): void {
	const temp = `${filename}.${randomUUID()}.tmp`;
	try {
		const fd = fs.openSync(temp, "wx", 0o600);
		try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, filename);
	} finally { if (exists(temp)) fs.unlinkSync(temp); }
}
function regularFile(root: string, relative: string): string {
	const segments = relative.split("/");
	if (!segments.every(safeSegment)) throw new Error("Invalid plugin file path");
	let current = root;
	if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Unsafe plugin directory");
	const realRoot = fs.realpathSync(/* turbopackIgnore: true */ root);
	for (let i = 0; i < segments.length; i++) {
		current = path.join(current, segments[i]!);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Symlinks and non-files are not plugin assets");
		const real = fs.realpathSync(/* turbopackIgnore: true */ current);
		if (!real.startsWith(realRoot + path.sep)) throw new Error("Plugin file escapes its package");
	}
	return current;
}
function pluginRoot(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe plugin directory");
}
function snapshot(rootDirectory: string, id: string, appVersion: string): Package {
	pluginRoot(rootDirectory);
	const directory = path.join(/* turbopackIgnore: true */ rootDirectory, "dist");
	if (!exists(directory)) throw new Error("Missing plugin build: expected dist/manifest.json. Build the plugin into dist/ or install a built package there.");
	pluginRoot(directory);
	const files = new Map<string, Buffer>();
	const manifestBytes = fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, "manifest.json"));
	const manifest = Object.freeze(parsePluginManifest(JSON.parse(manifestBytes.toString("utf8")), id, appVersion));
	function collect(relative: string): void {
		for (const name of fs.readdirSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory, relative)).sort()) {
			if (!safeSegment(name) || (!relative && name === "data")) continue;
			const file = relative ? `${relative}/${name}` : name;
			const stat = fs.lstatSync(path.join(directory, file));
			if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in plugin package files: ${file}`);
			if (stat.isDirectory()) {
				if (file === "assets" || file.startsWith("assets/")) collect(file);
			} else if (stat.isFile()) files.set(file, fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, file)));
			else throw new Error(`Invalid plugin file: ${file}`);
		}
	}
	collect("");
	for (const entry of [manifest.main, manifest.backend, manifest.styles]) if (entry && !files.has(entry)) throw new Error(`Missing plugin entry: ${entry}`);
	const hash = createHash("sha256");
	for (const [file, bytes] of files) { hash.update(`${file.length}:${file}:${bytes.length}:`); hash.update(bytes); }
	return { rootDirectory, directory, files, info: { id, manifest, enabled: false, status: "disabled", revision: hash.digest("hex") } };
}
const mimeTypes: Record<string, string> = {
	".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/** Injectable, trusted-local-code host. Importing this module does no IO. */
export function createPluginHost(deps: PluginHostDependencies) {
	// Installed packages/state are runtime inputs, not build-time dependencies.
	const directory = path.resolve(/* turbopackIgnore: true */ deps.directory);
	const stateFile = path.resolve(/* turbopackIgnore: true */ directory, "..", "plugins-state.json");
	const packages = new Map<string, Package>();
	let initialized = false, disposed = false;
	let serial: Promise<unknown> = Promise.resolve();
	let disposing: Promise<void> | undefined;
	const assertOpen = () => { if (disposed) throw new PluginHostError(503, "Plugin host is disposed"); };
	const change = () => { if (disposed) return; try { deps.onChange?.(); } catch { /* Observers do not own host lifecycle. */ } };
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = serial.then(fn); serial = result.catch(() => {}); return result;
	};
	const get = (id: string) => { const pkg = packages.get(id); if (!pkg) throw new PluginHostError(404, `Unknown plugin: ${id}`); return pkg; };
	const live = (pkg: Package, activation: Activation) => !disposed && pkg.activation === activation && !activation.controller.signal.aborted;

	async function deactivate(pkg: Package): Promise<string[]> {
		const activation = pkg.activation;
		if (!activation) return [];
		pkg.activation = undefined; // Invalidate callbacks BEFORE abort listeners and cleanup run.
		activation.ready = false;
		activation.handlers.clear();
		activation.instructions.clear();
		activation.tools.clear();
		activation.questions.clear();
		activation.controller.abort();
		const failures: string[] = [];
		for (const cleanup of activation.cleanups.splice(0).reverse()) {
			try { await cleanup(); } catch (e) { failures.push(errorText(e)); }
		}
		return failures;
	}
	async function activate(pkg: Package): Promise<void> {
		assertOpen();
		if (!pkg.info.manifest || pkg.blocked || pkg.restart) {
			pkg.info.status = "error";
			return;
		}
		const manifest = pkg.info.manifest;
		const activation: Activation = { controller: new AbortController(), cleanups: [], handlers: new Map(), instructions: new Set(), tools: new Set(), questions: new Map(), ready: false };
		pkg.activation = activation;
		const requireLive = () => { if (!live(pkg, activation)) throw new Error("Plugin activation is no longer active"); };
		const cleanup = (fn: PluginCleanup) => {
			if (typeof fn !== "function") throw new Error("Plugin cleanup must be a function");
			if (live(pkg, activation)) activation.cleanups.push(fn);
			else { try { Promise.resolve(fn()).catch(() => {}); } catch { /* Late cleanup still gets a chance to release resources. */ } }
		};
		try {
			if (manifest.backend) {
				pluginRoot(pkg.rootDirectory);
				const dataDirectory = path.join(/* turbopackIgnore: true */ pkg.rootDirectory, "data");
				if (!exists(dataDirectory)) fs.mkdirSync(dataDirectory);
				if (!fs.lstatSync(dataDirectory).isDirectory() || fs.lstatSync(dataDirectory).isSymbolicLink()) throw new Error("Unsafe plugin data directory");
				const services = deps.createServices({ manifest, directory: pkg.directory, dataDirectory, signal: activation.controller.signal, cleanup });
				cleanup(() => services.agents.dispose());
				cleanup(() => services.workers.dispose());
				const ctx: PluginBackendContext = {
					manifest, directory: pkg.directory, dataDirectory, signal: activation.controller.signal, cleanup, ...services,
					createBackgroundTool(context, definition) { requireLive(); return services.createBackgroundTool(context, definition); },
					registerInstructions(contribution: PluginInstructions) {
						requireLive();
						const agents = targets(contribution?.agents);
						if (typeof contribution.text !== "string" || !contribution.text.trim()) throw new Error("Plugin instructions must contain nonempty text");
						const registered = { agents, text: contribution.text };
						activation.instructions.add(registered);
						return () => { activation.instructions.delete(registered); };
					},
					registerTools(contribution: PluginTools) {
						requireLive();
						const agents = targets(contribution?.agents);
						if (typeof contribution.create !== "function") throw new Error("Plugin tools require a native tool factory");
						const registered = { agents, create: contribution.create.bind(contribution) };
						activation.tools.add(registered);
						return () => { activation.tools.delete(registered); };
					},
					registerQuestionType(definition) {
						requireLive();
						const registered = preparePluginQuestionType(definition);
						if (activation.questions.has(registered.id)) throw new Error(`Duplicate plugin question type: ${registered.id}`);
						activation.questions.set(registered.id, registered);
						if (activation.ready) change();
						return () => {
							if (activation.questions.get(registered.id) !== registered) return;
							activation.questions.delete(registered.id);
							if (activation.ready && live(pkg, activation)) change();
						};
					},
					handle(name, handler) {
						requireLive();
						if (!operationId.test(name) || typeof handler !== "function") throw new Error("Invalid plugin operation id or handler");
						if (activation.handlers.has(name)) throw new Error(`Duplicate plugin operation: ${name}`);
						// Unique token prevents a stale unregister from deleting a replacement.
						const registered = (input: unknown) => handler(input);
						activation.handlers.set(name, registered);
						return () => { if (activation.handlers.get(name) === registered) activation.handlers.delete(name); };
					},
					events: {
						on(listener) {
							requireLive();
							if (typeof listener !== "function") throw new Error("Invalid plugin event listener");
							let subscribed = true;
							const unsubscribe = deps.subscribeEvents?.(event => {
								if (!subscribed || !live(pkg, activation)) return;
								try { Promise.resolve(listener(event)).catch(() => {}); } catch { /* Isolate plugin listeners. */ }
							});
							const off = () => { if (subscribed) { subscribed = false; unsubscribe?.(); } };
							cleanup(off); return off;
						},
						emit(topic, data) {
							if (!live(pkg, activation)) return;
							if (!operationId.test(topic)) throw new Error("Invalid plugin notification topic");
							try { deps.onNotification?.({ pluginId: manifest.id, topic, data }); } catch { /* Isolate observers. */ }
						},
					},
				};
				if (!pkg.backend) {
					const entry = regularFile(pkg.directory, manifest.backend);
					// This absolute runtime path is deliberately NOT an import/require in
					// Next's module graph. Ship scripts/plugin-loader.cjs alongside app.
					const sidecar = path.join(process.cwd(), "scripts", "plugin-loader.cjs");
					const nativeRequire = createRequire(sidecar);
					const loader = nativeRequire(sidecar) as { load(filename: string): PluginBackendModule };
					pkg.backend = loader.load(entry);
					if (!pkg.backend || typeof pkg.backend.activate !== "function") throw new Error("Plugin backend must export activate(context)");
				}
				const returned = await pkg.backend.activate(ctx);
				if (returned !== undefined) cleanup(returned);
			}
			if (!live(pkg, activation)) { await deactivate(pkg); pkg.info.status = "disabled"; return; }
			activation.ready = true;
			pkg.info.status = "active";
			delete pkg.contributionWarning;
			delete pkg.info.error;
		} catch (e) {
			const failures = await deactivate(pkg);
			pkg.info.status = "error";
			pkg.info.error = [errorText(e), ...failures.map(f => `Cleanup: ${f}`)].join("; ");
		}
	}

	async function discover(state: State): Promise<void> {
		const pending = new Set(pendingBundledPluginIds(directory));
		const installationErrors = deps.installationErrors ?? {};
		const failed = (id: string) => Object.hasOwn(installationErrors, id);
		const ids = new Set([...fs.readdirSync(/* turbopackIgnore: true */ directory), ...pending, ...Object.keys(installationErrors)]);
		for (const id of [...ids].sort()) {
			const root = path.join(directory, id);
			// Non-package files are ignored, but malformed package folders are visible.
			if (!pending.has(id) && !failed(id) && !fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink()) continue;
			let candidate: Package;
			try {
				if (failed(id)) throw new Error(`Plugin startup failed: ${installationErrors[id]}`);
				if (pending.has(id)) throw new Error("Bundled installation incomplete; retry installation before activation");
				candidate = snapshot(root, id, deps.appVersion);
			} catch (e) {
				candidate = { rootDirectory: root, directory: path.join(/* turbopackIgnore: true */ root, "dist"), files: new Map(), info: { id, enabled: false, status: "error", error: errorText(e), revision: "" }, blocked: true };
			}
			const current = packages.get(id);
			// An unbuilt/invalid package has never admitted executable code. Its
			// first valid build is ordinary discovery, not a code reload.
			if (current && !(current.blocked && !current.info.manifest)) {
				if (pending.has(id) || failed(id)) {
					await deactivate(current); current.blocked = true; current.info.status = "error";
					current.info.error = candidate.info.error;
				} else if (candidate.info.revision !== current.info.revision || candidate.info.error !== undefined) {
					current.restart = `Restart required: plugin package changed${candidate.info.error ? ` (${candidate.info.error})` : ""}`;
					current.info.error = [current.restart, current.contributionWarning].filter(Boolean).join("; ");
				}
				continue;
			}
			candidate.info.enabled = state.enabled[id] === true;
			packages.set(id, candidate);
			if (candidate.info.enabled && !candidate.blocked) await activate(candidate);
		}
		for (const [id, pkg] of packages) if (!ids.has(id)) {
			pkg.restart = "Restart required: plugin package removed";
			pkg.info.error = [pkg.restart, pkg.contributionWarning].filter(Boolean).join("; ");
		}
	}
	async function initializeInternal(): Promise<void> {
		assertOpen();
		if (initialized) return;
		const state = readState(stateFile); // Never hide corrupt/future state or execute code first.
		fs.mkdirSync(directory, { recursive: true });
		if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe plugins directory");
		await discover(state);
		initialized = true; change();
	}

	/** One synchronous per-turn snapshot. Failed packages contribute nothing, not even instructions. */
	function agentContributions(context: PluginToolContext, reservedToolNames: readonly string[]): PluginAgentContributions {
		assertOpen();
		if (!initialized) throw new PluginHostError(503, "Plugin host is not initialized");
		if (!context || typeof context.chatId !== "string" || !context.chatId.trim() || !agentKinds.includes(context.agent)) throw new PluginHostError(400, "Invalid plugin tool context");
		const turn = Object.freeze({ chatId: context.chatId, agent: context.agent });
		const names = new Set(reservedToolNames);
		const result: PluginAgentContributions = { instructions: [], tools: [] };
		// Capture ALL registration lists before any factory can change registrations.
		const contributions = [...packages.keys()].sort().flatMap(id => {
			const pkg = packages.get(id)!, activation = pkg.activation;
			return pkg.info.enabled && activation?.ready && live(pkg, activation)
				? [{ pkg, activation, instructions: [...activation.instructions], factories: [...activation.tools], questions: [...activation.questions.values()] }]
				: [];
		});
		for (const { pkg, activation, instructions, factories, questions } of contributions) {
			try {
				const texts = instructions.filter(item => item.agents.has(turn.agent)).map(item => item.text);
				const tools: AgentTool<any>[] = [];
				const packageNames = new Set<string>();
				for (const factory of factories.filter(item => item.agents.has(turn.agent))) {
					if (!live(pkg, activation)) break;
					const created: unknown = factory.create(turn);
					if (!Array.isArray(created)) {
						// A contract-violating async factory must not leak an unhandled rejection.
						if (created && typeof (created as { then?: unknown }).then === "function") void Promise.resolve(created).catch(() => {});
						throw new Error("Plugin tool factory must synchronously return a native tool array");
					}
					for (const tool of created as AgentTool<any>[]) {
						if (!tool || typeof tool.name !== "string" || !nativeToolName.test(tool.name)) throw new Error("Invalid native plugin tool name (letter/underscore first, letters/digits/_/-, max 64 characters)");
						if (names.has(tool.name) || packageNames.has(tool.name)) throw new Error(`Plugin tool name collision: ${tool.name}`);
						if (typeof tool.execute !== "function" || typeof tool.label !== "string" || typeof tool.description !== "string" ||
							(tool.prepareArguments !== undefined && typeof tool.prepareArguments !== "function") ||
							(tool.executionMode !== undefined && tool.executionMode !== "parallel" && tool.executionMode !== "sequential") ||
							(tool.replay !== undefined && tool.replay !== "safe" && tool.replay !== "never")) throw new Error(`Invalid native plugin tool definition: ${tool.name}`);
						try {
							validatePluginSchema(tool.parameters);
							if (tool.outputSchema !== undefined) validatePluginSchema(tool.outputSchema);
						} catch (error) { throw new Error(`Invalid native plugin tool schema (${tool.name}): ${errorText(error)}`); }
						packageNames.add(tool.name);
						const execute = tool.execute, prepare = tool.prepareArguments;
						const requireActive = () => { if (!live(pkg, activation)) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`); };
						tools.push({
							...tool,
							...(prepare ? { prepareArguments: args => { requireActive(); return prepare.call(tool, args); } } : {}),
							async execute(toolCallId, input, signal, onUpdate) {
								requireActive();
								const combined = signal ? AbortSignal.any([signal, activation.controller.signal]) : activation.controller.signal;
								combined.throwIfAborted();
								const output = await execute.call(tool, toolCallId, input, combined, onUpdate ? update => {
									if (live(pkg, activation) && !combined.aborted) onUpdate(update);
								} : undefined);
								combined.throwIfAborted();
								return output;
							},
						});
					}
				}
				const questionTypes: PluginQuestionContribution[] = [];
				const variant = turn.agent === "prober" ? "probe" : turn.agent === "teacher" ? "teach" : undefined;
				if (variant) for (const definition of questions) {
					const tool = definition[variant];
					if (!tool) continue;
					if (names.has(tool.toolName) || packageNames.has(tool.toolName)) throw new Error(`Plugin tool name collision: ${tool.toolName}`);
					validatePluginSchema(createPluginQuestionParameters(definition, variant));
					packageNames.add(tool.toolName);
					questionTypes.push(Object.freeze({
						pluginId: pkg.info.id, definition, variant, signal: activation.controller.signal,
						requireActive() { if (!live(pkg, activation)) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`); },
					}));
				}
				if (!live(pkg, activation)) continue;
				for (const name of packageNames) names.add(name);
				result.instructions.push(...texts);
				result.tools.push(...tools);
				if (questionTypes.length) (result.questionTypes ??= []).push(...questionTypes);
				if (pkg.contributionWarning !== undefined) {
					delete pkg.contributionWarning;
					if (pkg.restart) pkg.info.error = pkg.restart;
					else delete pkg.info.error;
					change(); // The current loadout recovered; independent package diagnostics remain.
				}
			} catch (e) {
				if (!live(pkg, activation)) continue;
				const warning = `Agent contributions (${turn.agent}): ${errorText(e)}`;
				if (pkg.contributionWarning !== warning) {
					pkg.contributionWarning = warning;
					pkg.info.error = [pkg.restart, warning].filter(Boolean).join("; ");
					change(); // Activation stays active: views, assets and operations remain usable.
				}
			}
		}
		return result;
	}

	return {
		initialize: () => enqueue(initializeInternal),
		agentContributions,
		resolveQuestionType(pluginId: string, typeId: string, contractVersion: number): PluginQuestionResolution {
			assertOpen();
			if (!initialized) throw new PluginHostError(503, "Plugin host is not initialized");
			const pkg = packages.get(pluginId), activation = pkg?.activation;
			if (!pkg || !pkg.info.enabled || !activation?.ready || !live(pkg, activation)) return { status: "unavailable" };
			const definition = activation.questions.get(typeId);
			if (!definition) return { status: "unavailable" };
			if (definition.incompatibleContractVersions?.includes(contractVersion)) return { status: "incompatible" };
			if (definition.contractVersion !== contractVersion) return { status: "unavailable" };
			return { status: "available", definition, signal: activation.controller.signal,
				requireActive() {
					if (!live(pkg, activation) || activation.questions.get(typeId) !== definition) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`);
				} };
		},
		list(): PluginInfo[] {
			assertOpen();
			return [...packages.values()].map(({ info }) => ({ ...info, ...(info.manifest ? { manifest: { ...info.manifest } } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
		},
		setEnabled(id: string, enabled: boolean): Promise<void> {
			// Let a cooperative in-flight activation finish so queued teardown cannot deadlock.
			if (!enabled) {
				const activation = packages.get(id)?.activation;
				if (activation && !activation.ready) activation.controller.abort();
			}
			return enqueue(async () => {
				assertOpen(); await initializeInternal();
				if (!PLUGIN_ID_PATTERN.test(id) || typeof enabled !== "boolean") throw new PluginHostError(400, "Invalid plugin enable request");
				const pkg = get(id);
				const state = readState(stateFile); // Recheck before overwriting externally changed state.
				state.enabled[id] = enabled; writeState(stateFile, state);
				if (enabled && pkg.activation?.ready) return;
				pkg.info.enabled = enabled;
				if (!enabled) {
					delete pkg.contributionWarning;
					const failures = await deactivate(pkg);
					pkg.info.status = failures.length || pkg.blocked ? "error" : "disabled";
					pkg.info.error = failures.length ? `Cleanup: ${failures.join("; ")}` : pkg.restart ?? (pkg.blocked ? pkg.info.error : undefined);
				} else {
					// Discover edits BEFORE first native evaluation or reactivation.
					await discover(state);
					await activate(pkg);
				}
				change();
			});
		},
		refresh: () => enqueue(async () => { assertOpen(); await initializeInternal(); await discover(readState(stateFile)); change(); }),
		async call(id: string, operation: string, input?: unknown): Promise<unknown> {
			assertOpen();
			const pkg = get(id), activation = pkg.activation;
			if (!pkg.info.enabled || !activation?.ready || !live(pkg, activation)) throw new PluginHostError(409, "Plugin is disabled or unavailable");
			if (!operationId.test(operation)) throw new PluginHostError(400, "Invalid plugin operation id");
			const handler = activation.handlers.get(operation);
			if (!handler) throw new PluginHostError(404, `Unknown plugin operation: ${operation}`);
			return handler(input);
		},
		async convertDocument(id: string, request: Request): ReturnType<PluginFrontendContext["documents"]["toMarkdown"]> {
			assertOpen();
			const pkg = get(id), activation = pkg.activation;
			if (!pkg.info.enabled || !activation?.ready || !live(pkg, activation)) throw new PluginHostError(409, "Plugin is disabled or unavailable");
			const requireCurrent = () => {
				assertOpen();
				if (!pkg.info.enabled || !activation.ready || !live(pkg, activation)) throw new PluginHostError(409, "Plugin is disabled or unavailable");
				if (request.signal.aborted) throw new PluginHostError(409, "Document conversion was cancelled");
			};
			requireCurrent();
			if (!deps.convertDocument) throw new PluginHostError(503, "Document conversion is unavailable");
			const signal = AbortSignal.any([activation.controller.signal, request.signal]);
			try {
				const result = await deps.convertDocument(request, signal);
				requireCurrent();
				return result;
			} catch (error) { requireCurrent(); throw error; }
		},
		asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string } {
			assertOpen();
			const pkg = get(id), manifest = pkg.info.manifest;
			if (!pkg.info.enabled || pkg.info.status !== "active" || !manifest || pkg.blocked) throw new PluginHostError(409, "Plugin assets are disabled or unavailable");
			if (!segments.length || !segments.every(safeSegment)) throw new PluginHostError(400, "Invalid plugin asset path");
			const file = segments.join("/");
			if (!(segments.length === 1 && (file === manifest.main || file === manifest.styles)) && !(segments.length > 1 && segments[0] === "assets")) throw new PluginHostError(404, "Plugin asset is not allowlisted");
			if (segments.some(s => s === "data") || file === manifest.backend) throw new PluginHostError(404, "Private plugin file");
			try { pluginRoot(pkg.rootDirectory); regularFile(pkg.directory, file); } catch { throw new PluginHostError(404, "Unknown or unsafe plugin asset"); }
			const bytes = pkg.files.get(file);
			if (!bytes) throw new PluginHostError(404, "Unknown plugin asset");
			return { bytes: Uint8Array.from(bytes), contentType: mimeTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
		},
		dispose(): Promise<void> {
			if (disposing) return disposing;
			disposed = true; // Immediately fence callers, including queued work.
			for (const pkg of packages.values()) pkg.activation?.controller.abort();
			disposing = enqueue(async () => {
				for (const pkg of packages.values()) { await deactivate(pkg); pkg.info.status = "disabled"; }
			});
			return disposing;
		},
	};
}
