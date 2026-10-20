/** Platform window chrome, packaging policy, and updater behavior, without
 * launching Electron. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");

/** Decline the single-instance lock so normal boot never spawns a server.
 * Then call the REAL createWindow with a stub Electron API and inspect its
 * constructor options. No rewritten copy of the production logic. */
function windowOptions(platform: string) {
	class FakeWindow {
		constructor(readonly options: unknown) {}
		webContents = { on() {}, setWindowOpenHandler() {} };
		loadURL() {}
		once() {}
	}
	const electron = {
		app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : require(id),
		process: { platform, argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context) as FakeWindow;
	// The options originate in a VM realm; normalize prototypes for assertions.
	return JSON.parse(JSON.stringify(win.options));
}

describe("desktop window chrome", () => {
	it("macOS keeps the proven traffic lights and does not enable WCO", () => {
		const options = windowOptions("darwin");
		assert.equal(options.titleBarStyle, "hiddenInset");
		assert.deepEqual(options.trafficLightPosition, { x: 16, y: 22.5 });
		assert.equal(options.titleBarOverlay, undefined);
		assert.equal(options.autoHideMenuBar, undefined);
	});

	for (const platform of ["win32", "linux"]) {
		it(`${platform} uses native-height right-side controls with an Alt-accessible menu`, () => {
			const options = windowOptions(platform);
			assert.equal(options.titleBarStyle, "hidden");
			assert.deepEqual(options.titleBarOverlay, { color: "#141414", symbolColor: "#e5e5e5" });
			assert.equal(Object.hasOwn(options.titleBarOverlay, "height"), false, "omit height so the OS selects its native default");
			assert.equal(options.trafficLightPosition, undefined);
			assert.equal(options.autoHideMenuBar, true);
			assert.equal(options.webPreferences.contextIsolation, true);
			assert.equal(options.webPreferences.sandbox, true);
			assert.equal(options.webPreferences.nodeIntegration, false);
		});
	}

	it("preload exposes OS identity without exposing Node/Electron to the renderer", () => {
		let bridge: Record<string, unknown> = {};
		const context = {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lh");
						bridge = api;
					},
				},
				ipcRenderer: {},
			}),
		};
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), context);
		assert.equal(bridge.platform, "win32");
		assert.deepEqual(Object.keys(bridge).sort(), [
			"expandWindow", "getZoom", "installUpdate", "onUpdateStatus", "onZoom", "platform",
		]);
	});
});

type MenuItem = { label?: string; submenu?: MenuItem[]; click?: () => unknown };

/** Find a menu item by label in the template main.cjs actually built. */
function findMenuItem(items: MenuItem[], label: string): MenuItem | undefined {
	for (const item of items) {
		if (item.label === label) return item;
		if (item.submenu) {
			const found = findMenuItem(item.submenu, label);
			if (found) return found;
		}
	}
	return undefined;
}

/** Boot the REAL electron/main.cjs in a VM. Only the external surfaces are
 * stubbed — Electron itself, electron-updater, child_process.spawn, and the
 * timer globals — so startup, menu wiring, IPC handlers, scheduling, and
 * server lifetime are the production code paths. App paths live in a
 * throwaway directory; no Electron process, window, network call, real
 * userData, or credential store is touched. */
async function bootShell({ packaged, packageJson, env = {}, updaterAvailable = true }: {
	packaged: boolean;
	packageJson?: Record<string, unknown>;
	env?: Record<string, string>;
	updaterAvailable?: boolean;
}) {
	const root = mkdtempSync(join(os.tmpdir(), "lh-desktop-shell-"));
	if (packageJson) writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));

	class FakeWindow {
		readonly webContents = {
			on() {},
			send() {},
			setWindowOpenHandler() {},
			getZoomFactor: () => 1,
			setZoomFactor() {},
		};
		constructor(readonly options: unknown) {
			state.windows.push(this);
		}
		loadURL() {}
		once() {}
		show() {}
		isMinimized() {
			return false;
		}
		restore() {}
		focus() {}
		getBounds() {
			return { x: 0, y: 0, width: 640, height: 600 };
		}
		setBounds() {}
		static getAllWindows() {
			return state.windows;
		}
		static fromWebContents() {
			return state.windows[0] ?? null;
		}
	}

	const state = {
		updaterLoads: 0,
		checks: 0,
		feedUrls: [] as Record<string, unknown>[],
		intervals: [] as { callback: () => void; delay: number }[],
		timeouts: [] as (() => void)[],
		kills: [] as string[],
		dialogs: [] as Record<string, unknown>[],
		handlers: new Map<string, (...args: unknown[]) => unknown>(),
		quitAndInstall: 0,
		menuTemplate: [] as MenuItem[],
		windows: [] as FakeWindow[],
	};

	const updater = {
		autoDownload: false,
		autoInstallOnAppQuit: false,
		logger: null as unknown,
		setFeedURL(options: Record<string, unknown>) {
			state.feedUrls.push(options);
		},
		checkForUpdates() {
			state.checks += 1;
			return Promise.resolve({ updateInfo: {} });
		},
		quitAndInstall() {
			state.quitAndInstall += 1;
		},
		on() {},
	};

	const childProcess = {
		spawn() {
			return {
				stdout: { on() {} },
				stderr: { on() {} },
				on() {},
				kill(signal: string) {
					state.kills.push(signal);
				},
			};
		},
	};

	const electron = {
		app: {
			name: "LearnHarness",
			isPackaged: packaged,
			setName() {},
			setPath() {},
			getPath: () => root,
			getAppPath: () => root,
			getVersion: () => "0.3.0",
			requestSingleInstanceLock: () => false,
			quit() {},
			exit() {},
			whenReady: async () => {},
			on() {},
			dock: { hide() {} },
			commandLine: { appendSwitch() {} },
		},
		BrowserWindow: FakeWindow,
		Menu: {
			buildFromTemplate(template: MenuItem[]) {
				state.menuTemplate = template;
				return { template };
			},
			setApplicationMenu() {},
		},
		ipcMain: {
			on(channel: string, callback: (...args: unknown[]) => unknown) {
				state.handlers.set(channel, callback);
			},
			handle(channel: string, callback: (...args: unknown[]) => unknown) {
				state.handlers.set(channel, callback);
			},
		},
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
		shell: { openExternal: async () => {} },
		dialog: {
			showMessageBox(options: Record<string, unknown>) {
				state.dialogs.push(options);
				return Promise.resolve({ response: 0 });
			},
		},
	};

	const context: Record<string, unknown> = {
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "electron-updater") {
				state.updaterLoads += 1;
				if (!updaterAvailable) throw new Error("electron-updater unavailable");
				return { autoUpdater: updater };
			}
			if (id === "node:child_process") return childProcess;
			return require(id);
		},
		process: {
			platform: "linux",
			argv: [],
			env: { LH_DEV_URL: "http://127.0.0.1:3999", ...env },
			execPath: "/fake/electron",
			resourcesPath: join(root, "resources"),
			stdin: { resume() {}, on() {} },
			on() {},
			exit() {},
		},
		__dirname: join(root, "electron"),
		console: { log() {}, error() {} },
		setTimeout: (callback: () => void) => {
			state.timeouts.push(callback);
			return state.timeouts.length;
		},
		setInterval: (callback: () => void, delay: number) => {
			state.intervals.push({ callback, delay });
			return state.intervals.length;
		},
		clearTimeout() {},
		clearInterval() {},
	};

	runInNewContext(mainSource, context, { filename: mainFile });
	// main.cjs's startup function is the production boot path; the VM's
	// declined single-instance lock keeps the module's auto-boot out of it.
	await runInNewContext("main()", context);

	return {
		root,
		context,
		state,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Let the updater promise chain finish before asserting its side effects. */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("desktop updater policy", () => {
	it("acceptance test builds never load, configure, schedule, or check the updater", async () => {
		const shell = await bootShell({
			packaged: true,
			packageJson: { name: "learnharness", version: "0.3.0", lhTestBuild: true },
		});
		try {
			assert.equal(shell.state.windows.length, 1, "the shell still boots its window");
			assert.equal(shell.state.updaterLoads, 0, "electron-updater must not even be required");
			assert.deepEqual(shell.state.feedUrls, []);
			assert.equal(shell.state.checks, 0);
			assert.equal(shell.state.intervals.length, 0);

			const checkItem = findMenuItem(shell.state.menuTemplate, "Check for Updates…");
			assert.ok(checkItem, "the update menu stays installed for production parity");
			checkItem.click?.();
			await flush();
			assert.equal(shell.state.checks, 0, "a manual check is inert without an updater");
			assert.equal(shell.state.dialogs.length, 0);
		} finally {
			shell.dispose();
		}
	});

	it("a test build's install IPC cannot kill the live server", async () => {
		const shell = await bootShell({
			packaged: true,
			packageJson: { name: "learnharness", version: "0.3.0", lhTestBuild: true },
		});
		try {
			await runInNewContext("startServer(4100)", shell.context);
			const install = shell.state.handlers.get("lh:update-install");
			assert.ok(install, "the install IPC stays registered");
			install();
			assert.deepEqual(shell.state.kills, [], "the disabled updater must not take down the server");
			assert.equal(shell.state.quitAndInstall, 0);
		} finally {
			shell.dispose();
		}
	});

	it("production packaged builds keep startup, interval, manual, and install behavior", async () => {
		const shell = await bootShell({
			packaged: true,
			packageJson: { name: "learnharness", version: "0.3.0" },
		});
		try {
			assert.equal(shell.state.updaterLoads, 1);
			assert.deepEqual(shell.state.feedUrls, [], "the baked production feed stays untouched");
			assert.equal(shell.state.checks, 1, "one check at startup");
			assert.equal(shell.state.intervals.length, 1, "one recurring check");
			assert.equal(shell.state.intervals[0]?.delay, 24 * 60 * 60 * 1000);

			const checkItem = findMenuItem(shell.state.menuTemplate, "Check for Updates…");
			assert.ok(checkItem);
			checkItem.click?.();
			await flush();
			assert.equal(shell.state.checks, 2, "the menu asks the updater");
			assert.deepEqual(shell.state.dialogs.map((options) => JSON.parse(JSON.stringify(options))), [{
				type: "info",
				message: "You're up to date.",
				detail: "LearnHarness 0.3.0 is the latest version.",
			}]);

			shell.state.intervals[0]?.callback();
			assert.equal(shell.state.checks, 3, "the 24h timer rechecks");

			await runInNewContext("startServer(4101)", shell.context);
			shell.state.handlers.get("lh:update-install")?.();
			assert.deepEqual(shell.state.kills, ["SIGTERM"], "an install stops the server first");
			assert.equal(shell.state.quitAndInstall, 1);
		} finally {
			shell.dispose();
		}
	});

	it("nonpackaged builds keep the updater disabled even with test metadata", async () => {
		const shell = await bootShell({
			packaged: false,
			packageJson: { name: "learnharness", version: "0.3.0", lhTestBuild: true },
		});
		try {
			assert.equal(shell.state.updaterLoads, 0);
			assert.equal(shell.state.checks, 0);
			assert.equal(shell.state.intervals.length, 0);
			await runInNewContext("startServer(4102)", shell.context);
			shell.state.handlers.get("lh:update-install")?.();
			assert.deepEqual(shell.state.kills, []);
		} finally {
			shell.dispose();
		}
	});

	it("only a real boolean lhTestBuild disables updates", async () => {
		const shell = await bootShell({
			packaged: true,
			packageJson: { name: "learnharness", version: "0.3.0", lhTestBuild: "true" },
		});
		try {
			assert.equal(shell.state.updaterLoads, 1);
			assert.equal(shell.state.checks, 1);
			assert.equal(shell.state.intervals.length, 1);
		} finally {
			shell.dispose();
		}
	});

	it("does not mistake the config-only extraMetadata wrapper for the packaged marker", async () => {
		// electron-builder deep-assigns extraMetadata into the packaged
		// package.json ROOT. A package that only has the wrapper is not a
		// test build and must keep updating normally.
		const shell = await bootShell({
			packaged: true,
			packageJson: { name: "learnharness", version: "0.3.0", extraMetadata: { lhTestBuild: true } },
		});
		try {
			assert.equal(shell.state.updaterLoads, 1);
			assert.equal(shell.state.checks, 1);
			assert.equal(shell.state.intervals.length, 1);
		} finally {
			shell.dispose();
		}
	});
});

describe("desktop packaging policy", () => {
	const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
	const config = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

	it("configuration is accepted by the INSTALLED electron-builder schema", async () => {
		const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
		await validateConfiguration(config, { isEnabled: false });
	});

	it("ships Mac arm64, Windows NSIS x64, and both Linux x64 channels", () => {
		assert.deepEqual(config.mac.target, [
			{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] },
		]);
		assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
		assert.equal(config.win.signExecutable, false);
		assert.equal(config.win.verifyUpdateCodeSignature, false);
		assert.deepEqual(config.linux.target, [
			{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] },
		]);
		assert.equal(config.linux.syncDesktopName, true);
		assert.equal(config.publish[0].releaseType, "draft");
	});

	it("deb has public maintainer metadata and a matching desktop identity", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(pkg.author.name, "Amos Blomqvist");
		assert.equal(pkg.author.email, "255718537+amosblomqvist@users.noreply.github.com");
		assert.equal(pkg.homepage, "https://github.com/amosblomqvist/learnharness");
		assert.equal(pkg.desktopName, "learnharness.desktop");
	});
});

describe("desktop acceptance packaging", () => {
	const projectDir = fileURLToPath(new URL("..", import.meta.url));
	const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
	const production = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

	async function effectiveConfig(filename: string) {
		// Use electron-builder's OWN config loader so extends resolution and
		// merge order are the production ones, not a local reimplementation.
		const { getConfig } = require("app-builder-lib/out/util/config/config.js") as {
			getConfig(projectDir: string, configPath: string): Promise<Record<string, any>>;
		};
		// builder-util writes its "loaded configuration" line straight to
		// process.stdout, which collides with the test runner's own stdout
		// protocol. Route that one call through a sink and restore the stream.
		const { log } = require("builder-util") as { log: { stream: { write(chunk: string): boolean } } };
		const stream = log.stream;
		log.stream = { write: () => true };
		try {
			return await getConfig(projectDir, filename);
		} finally {
			log.stream = stream;
		}
	}

	it("inherits production packaging, validates against the installed schema, and marks a real test flag", async () => {
		const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js") as {
			validateConfiguration(config: Record<string, unknown>, options: { isEnabled: boolean }): Promise<void>;
		};
		const acceptance = await effectiveConfig("electron-builder.acceptance.yml");
		await validateConfiguration(acceptance, { isEnabled: false });

		assert.equal(acceptance.extraMetadata?.lhTestBuild, true);
		assert.equal(typeof acceptance.extraMetadata?.lhTestBuild, "boolean");
		assert.equal(production.extraMetadata, undefined, "the production config stays unflagged");
		assert.equal(acceptance.appId, production.appId);
		assert.equal(acceptance.productName, production.productName);
		assert.equal(acceptance.directories.output, production.directories.output);
		assert.deepEqual(acceptance.publish, production.publish, "the production update feed is inherited unchanged");
		assert.deepEqual(acceptance.win.target, production.win.target);
		assert.deepEqual(acceptance.linux.target, production.linux.target);
		assert.deepEqual(acceptance.mac.target, production.mac.target);

		// win.artifactName and linux.artifactName in the base config override
		// the root artifactName, so acceptance must repeat those overrides.
		const names = {
			mac: acceptance.mac.artifactName ?? acceptance.artifactName,
			win: acceptance.win.artifactName,
			linux: acceptance.linux.artifactName,
		};
		for (const [platform, name] of Object.entries(names)) {
			assert.equal(typeof name, "string", `${platform} has an artifact name`);
			assert.match(name as string, /acceptance/, `${platform} installers are visibly acceptance builds`);
		}
		assert.notEqual(acceptance.win.artifactName, production.win.artifactName);
		assert.notEqual(acceptance.linux.artifactName, production.linux.artifactName);
		assert.notEqual(acceptance.artifactName, production.artifactName ?? "");
	});

	/** Run electron-builder's REAL package.json transformer, so the fixture
	 * the shell is tested against is the shape the builder actually ships. */
	async function packagedPackageJson(acceptance: Record<string, any>) {
		const { createTransformer } = require("app-builder-lib/out/fileTransformer.js") as {
			createTransformer(
				srcDir: string,
				configuration: Record<string, any>,
				extraMetadata: Record<string, any>,
				extraTransformer: unknown,
			): (file: string) => Promise<string | null> | null;
		};
		const srcDir = mkdtempSync(join(os.tmpdir(), "lh-packaged-metadata-"));
		try {
			const packageFile = join(srcDir, "package.json");
			writeFileSync(packageFile, JSON.stringify({ name: "learnharness", version: "0.3.0" }));
			const transform = createTransformer(srcDir, acceptance, acceptance.extraMetadata, null);
			const serialized = await transform(packageFile);
			assert.equal(typeof serialized, "string", "the builder rewrites the packaged package.json");
			return JSON.parse(serialized as string) as Record<string, unknown>;
		} finally {
			rmSync(srcDir, { recursive: true, force: true });
		}
	}

	it("disables updates from the REAL electron-builder packaged package.json shape", async () => {
		const acceptance = await effectiveConfig("electron-builder.acceptance.yml");
		const packaged = await packagedPackageJson(acceptance);
		// fileTransformer.modifyMainPackageJson deep-assigns extraMetadata into
		// the package.json root; the wrapper itself is config-only.
		assert.equal(packaged.lhTestBuild, true, "the packaged marker is a root property");
		assert.equal("extraMetadata" in packaged, false, "the config wrapper is not packaged");

		const shell = await bootShell({ packaged: true, packageJson: packaged });
		try {
			assert.equal(shell.state.updaterLoads, 0, "the real packaged shape must not load the updater");
			assert.equal(shell.state.checks, 0);
			assert.equal(shell.state.intervals.length, 0);
		} finally {
			shell.dispose();
		}
	});
});

describe("workflow action versions", () => {
	type Step = { uses?: string; with?: Record<string, unknown> };
	type Workflow = { jobs: Record<string, { steps: Step[] }> };
	const yaml = require("js-yaml") as { load(source: string): Workflow };

	for (const filename of ["ci.yml", "release.yml"]) {
		it(`${filename} uses supported Action runtimes without changing the app's Node 26`, () => {
			const workflow = yaml.load(readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8"));
			const expected = ["actions/checkout@v7", "actions/setup-node@v7"];
			if (filename === "release.yml") {
				expected.push("actions/github-script@v9", "actions/upload-artifact@v7", "maxim-lobanov/setup-xcode@v1");
			}
			const observed = new Set<string>();
			for (const job of Object.values(workflow.jobs)) {
				for (const step of job.steps) {
					if (!step.uses) continue;
					assert.ok(expected.includes(step.uses), `unexpected Action reference: ${step.uses}`);
					observed.add(step.uses);
					if (step.uses === "actions/setup-node@v7") {
						assert.equal(step.with?.["node-version"], "26");
						assert.equal(step.with?.cache, "npm");
					}
					if (step.uses === "actions/upload-artifact@v7") {
						assert.equal(step.with?.archive ?? true, true, "multi-file installers remain zipped artifacts");
					}
				}
			}
			assert.deepEqual([...observed].sort(), expected.sort());
		});
	}
});

describe("desktop acceptance workflow routing", () => {
	type Step = { if?: string; run?: string; env?: Record<string, string> };
	type Workflow = {
		jobs: Record<string, {
			if?: string; steps: Step[];
			strategy?: { matrix: { include: { os: string; platform: string; builder_args?: string }[] } };
		}>;
	};
	const yaml = require("js-yaml") as { load(source: string): Workflow };
	const workflow = yaml.load(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
	const packageJob = workflow.jobs.package;
	assert.ok(packageJob);
	const builderSteps = packageJob.steps.filter((step) => step.run?.includes("electron-builder"));
	const dispatchSteps = builderSteps.filter((step) => step.if?.includes("workflow_dispatch"));
	const tagSteps = builderSteps.filter((step) => step.if?.includes("'push'"));

	it("manual rehearsals package with the acceptance config only, without publishing or releasing", () => {
		assert.equal(dispatchSteps.length, 2, "macOS and Windows/Linux rehearsal commands");
		for (const step of dispatchSteps) {
			assert.match(step.run as string, /--config electron-builder\.acceptance\.yml/);
			assert.match(step.run as string, /--publish never/);
		}
		const mac = dispatchSteps.find((step) => step.if?.includes("macOS"));
		assert.ok(mac);
		assert.match(mac.run as string, /-c\.mac\.notarize=false/);
		assert.equal(mac.env?.CSC_IDENTITY_AUTO_DISCOVERY, "false");

		// Manual dispatch still creates no release and runs no verifier.
		assert.equal(workflow.jobs.draft?.steps[0]?.if, "github.event_name == 'push'");
		assert.equal(workflow.jobs.verify?.if, "github.event_name == 'push'");
	});

	it("tag pushes keep the production commands and config", () => {
		assert.equal(tagSteps.length, 2, "macOS and Windows/Linux release commands");
		for (const step of tagSteps) {
			assert.doesNotMatch(step.run as string, /electron-builder\.acceptance\.yml/);
			assert.match(step.run as string, /--publish always/);
		}
		const mac = tagSteps.find((step) => step.if?.includes("macOS"));
		assert.ok(mac);
		assert.match(mac.run as string, /-c\.forceCodeSigning=true/);
		assert.equal(mac.env?.CSC_LINK, "${{ secrets.MAC_CSC_LINK }}");

		// The OS matrix and native build/boot gates are shared by both modes.
		assert.equal(packageJob.strategy?.matrix.include.length, 3);
		assert.ok(packageJob.steps.some((step) => step.run?.includes("pdf-native-render.test.ts")));
		assert.ok(packageJob.steps.some((step) => step.run === "node scripts/smoke-server.mjs --electron"));
	});
});

describe("desktop release workflow", () => {
	type Step = {
		if?: string; run?: string; uses?: string; env?: Record<string, string>;
		with?: { script?: string; "xcode-version"?: string };
	};
	type Workflow = {
		concurrency: { group: string; "cancel-in-progress": boolean };
		jobs: Record<string, {
			needs?: string | string[]; steps: Step[]; "runs-on"?: string;
			strategy?: { matrix: { include: { os: string; platform: string; builder_args?: string }[] } };
		}>;
	};
	const yaml = require("js-yaml") as { load(source: string): Workflow };
	const workflow = yaml.load(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
	const draft = workflow.jobs.draft;
	const packaging = workflow.jobs.package;
	assert.ok(draft && packaging);
	const prepare = draft.steps[0];
	assert.ok(prepare?.with);
	const script = prepare.with.script;
	assert.ok(script);
	type Release = { id: number; tag_name: string; draft: boolean };

	/** Execute the REAL action script with an in-memory GitHub API. */
	async function prepareDraft(releases: Release[]) {
		const created: Record<string, unknown>[] = [];
		const listReleases = () => {};
		await runInNewContext(`(async () => { ${script} })()`, {
			context: { repo: { owner: "test-owner", repo: "test-repo" }, ref: "refs/tags/v0.3.0" },
			core: { info() {} },
			github: {
				paginate: async (method: unknown, options: unknown) => {
					assert.equal(method, listReleases);
					assert.deepEqual(JSON.parse(JSON.stringify(options)), {
						owner: "test-owner", repo: "test-repo", per_page: 100,
					});
					return releases;
				},
				rest: { repos: {
					listReleases,
					createRelease: async (options: Record<string, unknown>) => {
						created.push(JSON.parse(JSON.stringify(options)));
						return { data: { id: 123 } };
					},
				} },
			},
		});
		return created;
	}

	it("prepares once after gates, never on rehearsals, before parallel packaging", () => {
		assert.equal(draft.needs, "quality");
		assert.equal(prepare.if, "github.event_name == 'push'");
		assert.deepEqual(packaging.needs, ["quality", "draft"]);
		assert.equal(workflow.concurrency.group, "release-${{ github.ref }}");
		assert.equal(workflow.concurrency["cancel-in-progress"], false);
		for (const filename of ["ci.yml", "release.yml"]) {
			const config = yaml.load(readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8"));
			const job = config.jobs[filename === "ci.yml" ? "standalone" : "package"];
			assert.ok(job);
			const steps = job.steps;
			const native = steps.find(step => step.run?.includes("pdf-native-render.test.ts"));
			assert.ok(native);
			assert.ok(native.run?.startsWith("npx electron --import tsx --test "));
			assert.equal(native.env?.ELECTRON_RUN_AS_NODE, "1");
			assert.ok(steps.some(step => step.run === "node scripts/smoke-server.mjs --electron"));
		}
	});

	it("pairs Icon Composer packaging with macOS 26 and Xcode selection, retaining macOS 15 CI", () => {
		const mac = packaging.strategy?.matrix.include.find(entry => entry.platform === "mac-arm64");
		assert.equal(mac?.os, "macos-26", "actool's .icon compiler needs macOS 26 host frameworks, not just newer Xcode");
		assert.equal(mac?.builder_args, "--mac --arm64");
		assert.equal(packaging["runs-on"], "${{ matrix.os }}");
		const xcodeIndex = packaging.steps.findIndex(step => step.uses === "maxim-lobanov/setup-xcode@v1");
		assert.ok(xcodeIndex >= 0);
		const xcode = packaging.steps[xcodeIndex];
		assert.equal(xcode?.if, "runner.os == 'macOS'");
		assert.equal(xcode?.with?.["xcode-version"], "latest-stable");
		const buildIndex = packaging.steps.findIndex(step => step.run?.includes("electron-builder"));
		assert.ok(buildIndex > xcodeIndex, "select Xcode before packaging compiles the icon");

		const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
		const ciMac = ci.jobs.standalone?.strategy?.matrix.include.find(entry => entry.platform === "mac-arm64");
		assert.equal(ciMac?.os, "macos-15", "ordinary CI keeps older macOS build/boot coverage");
	});

	it("creates exactly one unpublished draft when none matches", async () => {
		assert.deepEqual(await prepareDraft([{ id: 9, tag_name: "v0.2.0", draft: false }]), [{
			owner: "test-owner", repo: "test-repo", tag_name: "v0.3.0", name: "0.3.0", draft: true,
		}]);
	});

	it("reuses an existing draft without creating another", async () => {
		assert.deepEqual(await prepareDraft([{ id: 10, tag_name: "v0.3.0", draft: true }]), []);
		// Match the publisher's support for legacy unprefixed tags too.
		assert.deepEqual(await prepareDraft([{ id: 10, tag_name: "0.3.0", draft: true }]), []);
	});

	it("refuses to modify an already-published release", async () => {
		await assert.rejects(prepareDraft([{ id: 10, tag_name: "v0.3.0", draft: false }]), /already published/);
	});

	it("refuses an ambiguous set of drafts instead of splitting assets", async () => {
		await assert.rejects(prepareDraft([
			{ id: 10, tag_name: "v0.3.0", draft: true },
			{ id: 11, tag_name: "v0.3.0", draft: true },
		]), /Multiple releases match/);
	});
});
