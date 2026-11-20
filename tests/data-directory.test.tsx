import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-dir-test-"));
const defaultDataDir = path.join(scratchRoot, "default-data");
const configFile = path.join(scratchRoot, "userData", "data-location.json");
const authFile = path.join(scratchRoot, "userData", "auth.json");

fs.mkdirSync(defaultDataDir, { recursive: true });
fs.mkdirSync(path.dirname(authFile), { recursive: true });
fs.writeFileSync(authFile, JSON.stringify({ OPENAI_API_KEY: "sk-local-only" }), "utf8");

process.env.LH_DATA_DIR = defaultDataDir;
process.env.LH_DEFAULT_DATA_DIR = defaultDataDir;
process.env.LH_DATA_CONFIG_FILE = configFile;
process.env.LH_AUTH_FILE = authFile;

const require = createRequire(import.meta.url);
const {
	inspectDataLocation,
	isFullPath,
	STORE_MARKER,
	resolveStartupDataDir,
	writeConfiguredDataDirPath,
} = require("../electron/data-location.cjs");

const config = await import("../config.ts");
const { getDataDirectoryStatus } = await import("../src/server/data-directory.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { registerJobAbort, unregisterJobAbort } = await import("../src/agent/subagents/aborts.ts");
const {
	GET: getDataDirRoute,
	POST: postDataDirRoute,
} = await import("../app/api/settings/data-dir/route.ts");
const { beginTurn, endTurn, getPluginHost, stores, writeSettingsRecord, readSettingsRecord } = await import("../src/server/index.ts");
const {
	DataDirectoryConfirmBody,
	UnavailableDataDirectoryBody,
} = await import("../components/settings/data-directory-settings.tsx");

after(() => {
	fs.rmSync(scratchRoot, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(configFile, { force: true });
	fs.rmSync(defaultDataDir, { recursive: true, force: true });
	fs.mkdirSync(defaultDataDir, { recursive: true });
	config.setActiveDataDir(defaultDataDir, {
		defaultDir: defaultDataDir,
		configuredDir: null,
		unavailableConfiguredDir: null,
	});
});

describe("electron/data-location.cjs startup resolution & unplugged drive recovery", () => {
	it("rejects protected targets in native recovery and server settings", async () => {
		const dotenvDir = path.join(scratchRoot, ".env.fixture");
		const resources = path.join(scratchRoot, "app-resources");
		const appDir = path.join(resources, "server", "standalone");
		for (const directory of [dotenvDir, appDir]) fs.mkdirSync(directory, { recursive: true });

		const response = await post({ action: "change", path: dotenvDir, copyMode: "switch" });
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /protected/);

		const options = { configFile, defaultDir: defaultDataDir, appRoot: resources, authFile };
		writeConfiguredDataDirPath(configFile, dotenvDir);
		assert.match(inspectDataLocation(options).recoveryReason, /protected/);
		const pointer = fs.readFileSync(configFile, "utf8");
		const candidates = [dotenvDir, appDir];
		const reasons: string[] = [];
		const selected = await resolveStartupDataDir({
			...options,
			dialog: {
				showMessageBox: async () => ({ response: candidates.length ? 1 : 3 }),
				showOpenDialog: async () => ({ canceled: false, filePaths: [candidates.shift()] }),
			},
			log: (reason: string) => { reasons.push(reason); },
		});
		assert.equal(selected, null);
		assert.match(reasons[0]!, /protected/);
		assert.match(reasons[1]!, /application source tree/);
		assert.equal(fs.readFileSync(configFile, "utf8"), pointer);
	});

	it("chooses another folder when the old volume cannot be canonicalized", async () => {
		const oldVolume = path.join(scratchRoot, "offline-volume");
		const source = path.join(oldVolume, "data");
		const target = path.join(scratchRoot, "alternate-volume");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(target);
		writeConfiguredDataDirPath(configFile, source);
		fs.rmSync(oldVolume, { recursive: true });
		const original = fs.lstatSync;
		const unavailable = mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
			if (args[0] === oldVolume) throw Object.assign(new Error("Volume is offline"), { code: "ENODEV" });
			return original(...args);
		});
		try {
			let prompts = 0;
			const selected = await resolveStartupDataDir({
				configFile, defaultDir: defaultDataDir,
				dialog: {
					showMessageBox: async () => ({ response: prompts++ ? 3 : 1 }),
					showOpenDialog: async () => ({ canceled: false, filePaths: [target] }),
				},
			});
			assert.equal(selected, target);
			assert.equal(inspectDataLocation({ configFile, defaultDir: defaultDataDir }).currentDir, target);
		} finally { unavailable.mock.restore(); }
	});

	it("returns defaultDir when data-location.json is absent or points to an accessible custom folder", async () => {
		let dialogCalls = 0;
		const dialog = {
			showMessageBox: async () => {
				dialogCalls++;
				return { response: 2 };
			},
		};

		const initial = await resolveStartupDataDir({ configFile, defaultDir: defaultDataDir, dialog });
		assert.equal(initial, defaultDataDir);
		assert.equal(dialogCalls, 0);

		const externalDir = path.join(scratchRoot, "external-drive-1");
		fs.mkdirSync(externalDir, { recursive: true });
		writeConfiguredDataDirPath(configFile, externalDir);

		const custom = await resolveStartupDataDir({ configFile, defaultDir: defaultDataDir, dialog });
		assert.equal(custom, externalDir);
		assert.equal(dialogCalls, 0);
	});

	it("prompts with Retry, Choose Folder, and Use Default Folder when the external drive is unplugged", async () => {
		const unpluggedDir = path.join(scratchRoot, "unplugged-drive", "lh-data");
		fs.mkdirSync(unpluggedDir, { recursive: true });
		writeConfiguredDataDirPath(configFile, unpluggedDir);
		const marker = fs.readFileSync(path.join(unpluggedDir, STORE_MARKER));
		fs.rmSync(unpluggedDir, { recursive: true });
		const inspected = inspectDataLocation({ configFile, defaultDir: defaultDataDir });
		assert.equal(inspected.currentDir, unpluggedDir);
		assert.equal(inspected.unavailableConfiguredDir, unpluggedDir);

		// 1) Retry succeeds once the drive is reconnected
		let attempts = 0;
		const resolvedAfterRetry = await resolveStartupDataDir({
			configFile,
			defaultDir: defaultDataDir,
			dialog: {
				showMessageBox: async (opts: { buttons: string[]; detail: string }) => {
					attempts++;
					assert.deepEqual(opts.buttons, ["Retry", "Choose Folder…", "Use Default Folder", "Quit"]);
					assert.ok(opts.detail.includes(unpluggedDir));
					// Simulate user plugging in the external drive before clicking Retry
					fs.mkdirSync(unpluggedDir, { recursive: true });
					fs.writeFileSync(path.join(unpluggedDir, STORE_MARKER), marker);
					return { response: 0 };
				},
			},
		});
		assert.equal(attempts, 1);
		assert.equal(resolvedAfterRetry, unpluggedDir);

		// 2) Choose Folder updates data-location.json and uses the picked folder
		fs.rmSync(path.join(scratchRoot, "unplugged-drive"), { recursive: true, force: true });
		const alternateDir = path.join(scratchRoot, "alternate-external");
		fs.mkdirSync(alternateDir);
		const resolvedAfterChoose = await resolveStartupDataDir({
			configFile,
			defaultDir: defaultDataDir,
			dialog: {
				showMessageBox: async () => ({ response: 1 }),
				showOpenDialog: async () => ({ canceled: false, filePaths: [alternateDir] }),
			},
		});
		assert.equal(resolvedAfterChoose, alternateDir);
		assert.equal(inspectDataLocation({ configFile, defaultDir: defaultDataDir }).currentDir, alternateDir);

		// 3) Use Default Folder resets data-location.json and falls back to defaultDir
		fs.rmSync(alternateDir, { recursive: true, force: true });
		const resolvedDefault = await resolveStartupDataDir({
			configFile,
			defaultDir: defaultDataDir,
			dialog: {
				showMessageBox: async () => ({ response: 2 }),
			},
		});
		assert.equal(resolvedDefault, defaultDataDir);
		assert.equal(fs.existsSync(configFile), false);
	});
});

describe("GET / POST /api/settings/data-dir & live store relocation", () => {
	it("switches from an offline volume without resolving the old volume's ancestors", async () => {
		const oldVolume = path.join(scratchRoot, "offline-server-volume");
		const source = path.join(oldVolume, "data");
		const target = path.join(scratchRoot, "alternate-server-volume");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(target);
		const storeId = writeConfiguredDataDirPath(configFile, source);
		config.setActiveDataDir(source, { configuredDir: source, storeId });
		fs.rmSync(oldVolume, { recursive: true });
		const original = fs.lstatSync;
		const unavailable = mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
			if (args[0] === oldVolume) throw Object.assign(new Error("Volume is offline"), { code: "ENODEV" });
			return original(...args);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "switch" });
			assert.equal(response.status, 200);
			assert.equal(config.PATHS.data, target);
		} finally { unavailable.mock.restore(); }
	});

	it("copies data and keeps old data by default, while keeping auth.json on the local machine", async () => {
		// Seed data in defaultDataDir
		const chat = stores.chatStore.createChat("Linear Algebra");
		writeSettingsRecord({ version: 1, general: { autoUpdate: false } });
		const unrelatedFile = path.join(defaultDataDir, "personal-notes.txt");
		fs.writeFileSync(unrelatedFile, "do not delete me", "utf8");

		const statusRes = await getDataDirRoute();
		const initialStatus = (await statusRes.json()) as {
			currentDir: string;
			defaultDir: string;
			isCustom: boolean;
			copySource: ReturnType<typeof getDataDirectoryStatus>["copySource"];
		};
		assert.equal(initialStatus.currentDir, defaultDataDir);
		assert.equal(initialStatus.isCustom, false);

		const externalDir = path.join(scratchRoot, "ext-keep-old");
		const changeRes = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "change",
					path: externalDir,
					copyMode: "copy",
					deleteOld: false,
					expectedSource: initialStatus.copySource,
				}),
			}),
		);
		assert.equal(changeRes.status, 200);
		const changed = (await changeRes.json()) as {
			currentDir: string;
			defaultDir: string;
			isCustom: boolean;
			configuredDir: string | null;
		};
		assert.equal(changed.currentDir, externalDir);
		assert.equal(changed.isCustom, true);
		assert.equal(changed.configuredDir, externalDir);

		// Live config & stores now point to externalDir
		assert.equal(config.PATHS.data, externalDir);
		assert.equal(config.SETTINGS_FILE, path.join(externalDir, "settings.json"));
		assert.equal(stores.chatStore.getChat(chat.id)?.title, "Linear Algebra");
		assert.equal(readSettingsRecord()?.general?.autoUpdate, false);

		// Old data is kept intact in defaultDataDir
		assert.equal(fs.existsSync(path.join(defaultDataDir, "chats", `${chat.id}.json`)), true);
		assert.equal(fs.existsSync(path.join(defaultDataDir, "settings.json")), true);
		assert.equal(fs.existsSync(unrelatedFile), true);

		// Local auth.json was never copied into the external data directory
		assert.equal(fs.existsSync(path.join(externalDir, "auth.json")), false);
		assert.equal(config.AUTH_FILE, authFile);
	});

	it("deletes LearnHarness data from the old folder when deleteOld is true, preserving unrelated files", { skip: process.platform === "win32" }, async () => {
		const chat = stores.chatStore.createChat("Topology");
		writeSettingsRecord({ version: 1, general: { autoUpdate: true } });
		const unrelatedFile = path.join(defaultDataDir, "keep-me.txt");
		fs.writeFileSync(unrelatedFile, "important user file", "utf8");

		const externalDir = path.join(scratchRoot, "ext-delete-old");
		const res = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "change",
					path: externalDir,
					copyMode: "copy",
					deleteOld: true,
					expectedSource: getDataDirectoryStatus().copySource,
				}),
			}),
		);
		assert.equal(res.status, 200);

		// Data exists in externalDir
		assert.equal(fs.existsSync(path.join(externalDir, "chats", `${chat.id}.json`)), true);
		assert.equal(fs.existsSync(path.join(externalDir, "settings.json")), true);

		// LearnHarness data was removed from defaultDataDir, but unrelatedFile remains
		assert.equal(fs.existsSync(path.join(defaultDataDir, "chats")), false);
		assert.equal(fs.existsSync(path.join(defaultDataDir, "settings.json")), false);
		assert.equal(fs.existsSync(unrelatedFile), true);
	});

	it("supports switching without copying (copyMode: 'switch') and resetting back to default", async () => {
		stores.chatStore.createChat("Old Folder Only");

		const preExistingExternal = path.join(scratchRoot, "ext-switch-only");
		fs.mkdirSync(preExistingExternal, { recursive: true });

		const switchRes = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "change",
					path: preExistingExternal,
					copyMode: "switch",
				}),
			}),
		);
		assert.equal(switchRes.status, 200);
		assert.equal(config.PATHS.data, preExistingExternal);
		// Because we switched without copying, the new folder has no chats
		assert.equal(stores.chatStore.listChats().length, 0);

		// Reset to default without copying switches back to defaultDataDir where the chat still lives
		const resetRes = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "reset",
					copyMode: "switch",
				}),
			}),
		);
		assert.equal(resetRes.status, 200);
		assert.equal(config.PATHS.data, defaultDataDir);
		assert.equal(stores.chatStore.listChats().length, 1);
		assert.equal(fs.existsSync(configFile), false);
	});

	it("validates paths strictly and refuses with 409 while a turn is running", async () => {
		for (const badPayload of [
			{ action: "change", path: "relative/folder", copyMode: "copy" },
			{ action: "change", path: "/", copyMode: "copy" },
			{ action: "change", path: os.homedir(), copyMode: "copy" },
			{ action: "change", path: path.join(os.homedir(), ".ssh", "lh"), copyMode: "copy" },
			{ action: "change", path: path.join(config.ROOT, "src"), copyMode: "copy" },
			{ action: "change", path: path.join(defaultDataDir, "nested-inside-current"), copyMode: "copy" },
		]) {
			const res = await postDataDirRoute(
				new Request("http://localhost/api/settings/data-dir", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...badPayload, expectedSource: getDataDirectoryStatus().copySource }),
				}),
			);
			assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(badPayload)}`);
		}

		// Busy guard when a turn is in flight
		const chat = stores.chatStore.createChat("Busy Chat");
		assert.equal(beginTurn(chat.id), true);
		try {
			const busyRes = await postDataDirRoute(
				new Request("http://localhost/api/settings/data-dir", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						action: "change",
						path: path.join(scratchRoot, "ext-busy"),
						copyMode: "copy",
						expectedSource: getDataDirectoryStatus().copySource,
					}),
				}),
			);
			assert.equal(busyRes.status, 409);
		} finally {
			endTurn(chat.id);
		}
	});

	it("handles retry-configured and use-default recovery actions for unavailable drives", async () => {
		const missingDrive = path.join(scratchRoot, "missing-drive", "data");
		fs.mkdirSync(missingDrive, { recursive: true });
		const storeId = writeConfiguredDataDirPath(configFile, missingDrive);
		const marker = fs.readFileSync(path.join(missingDrive, STORE_MARKER));
		fs.rmSync(missingDrive, { recursive: true });
		config.setActiveDataDir(missingDrive, {
			defaultDir: defaultDataDir,
			configuredDir: missingDrive,
			storeId,
			unavailableConfiguredDir: missingDrive,
		});

		// Retry while still missing returns 400
		const retryFail = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "retry-configured" }),
			}),
		);
		assert.equal(retryFail.status, 400);

		// Simulate drive reconnecting, then retry succeeds
		fs.mkdirSync(missingDrive, { recursive: true });
		fs.writeFileSync(path.join(missingDrive, STORE_MARKER), marker);
		const retryOk = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "retry-configured" }),
			}),
		);
		assert.equal(retryOk.status, 200);
		const retryBody = (await retryOk.json()) as { currentDir: string; unavailableConfiguredDir: string | null };
		assert.equal(retryBody.currentDir, missingDrive);
		assert.equal(retryBody.unavailableConfiguredDir, null);

		// Simulate drive unplugging again and user picking use-default
		config.setActiveDataDir(defaultDataDir, {
			defaultDir: defaultDataDir,
			configuredDir: missingDrive,
			storeId,
			unavailableConfiguredDir: missingDrive,
		});
		const useDefaultRes = await postDataDirRoute(
			new Request("http://localhost/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "use-default" }),
			}),
		);
		assert.equal(useDefaultRes.status, 200);
		const defaultBody = (await useDefaultRes.json()) as {
			currentDir: string;
			isCustom: boolean;
			unavailableConfiguredDir: string | null;
		};
		assert.equal(defaultBody.currentDir, defaultDataDir);
		assert.equal(defaultBody.isCustom, false);
		assert.equal(defaultBody.unavailableConfiguredDir, null);
		assert.equal(fs.existsSync(configFile), false);
	});
});

function post(payload: object) {
	return postDataDirRoute(new Request("http://localhost/api/settings/data-dir", {
		method: "POST", body: JSON.stringify(payload),
	}));
}

describe("data directory audit regressions", () => {
	it("requires a confirmed source for keep-old copies and rejects a different store at the same path", async () => {
		const source = path.join(scratchRoot, "replaced-marker-source");
		const destination = path.join(scratchRoot, "replaced-marker-destination");
		assert.equal((await post({ action: "change", path: source, copyMode: "switch" })).status, 200);
		const { copySource: expectedSource } = await (await getDataDirRoute()).json();
		assert.equal(expectedSource.path, source);
		assert.equal(expectedSource.storeId, config.activeStoreId());
		const payload = { action: "change", path: destination, copyMode: "copy" };
		const missing = await post(payload);
		assert.equal(missing.status, 400);
		assert.match((await missing.json()).error, /Confirm the current source/);

		fs.unlinkSync(path.join(source, STORE_MARKER));
		const replacementId = writeConfiguredDataDirPath(configFile, source);
		assert.notEqual(replacementId, expectedSource.storeId);
		config.setActiveDataDir(source, { configuredDir: source, storeId: replacementId });
		const stale = await post({ ...payload, expectedSource });
		assert.equal(stale.status, 400);
		assert.match((await stale.json()).error, /source folder changed/);
		assert.equal(fs.existsSync(destination), false);
		assert.equal((await post({ ...payload, expectedSource: getDataDirectoryStatus().copySource })).status, 200);
	});

	it("rejects a replaced unmarked default store at the confirmed path", async () => {
		const { copySource } = getDataDirectoryStatus();
		assert.equal(copySource?.storeId, null);
		fs.renameSync(defaultDataDir, path.join(scratchRoot, "original-default-store"));
		fs.mkdirSync(defaultDataDir);
		const target = path.join(scratchRoot, "replaced-default-destination");
		const result = await post({ action: "change", path: target, copyMode: "copy", expectedSource: copySource });
		assert.equal(result.status, 400);
		assert.match((await result.json()).error, /source folder changed/);
		assert.equal(fs.existsSync(target), false);
	});

	it("preserves an occupied destination and allows an explicit switch to its existing data", async () => {
		const target = path.join(scratchRoot, "occupied");
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, "settings.json"), "{}");
		writeSettingsRecord({ version: 1, general: { autoUpdate: false } });
		const change = { action: "change", path: target };
		const rejected = await post({ ...change, copyMode: "copy", expectedSource: getDataDirectoryStatus().copySource });
		assert.equal(rejected.status, 400);
		assert.match((await rejected.json()).error, /empty/);
		assert.equal(fs.readFileSync(path.join(target, "settings.json"), "utf8"), "{}");
		assert.equal((await post({ ...change, copyMode: "switch" })).status, 200);
	});

	it("removes a partial staged copy and leaves the empty destination and source intact", async () => {
		const target = path.join(scratchRoot, "failed-copy");
		fs.mkdirSync(target);
		writeSettingsRecord({ version: 1 });
		const original = fs.createWriteStream;
		const failure = mock.method(fs, "createWriteStream", (...[file, options]: Parameters<typeof original>) => {
			if (String(file).includes(".learnharness-copy-")) {
				return new Writable({ write(_chunk, _encoding, done) { done(new Error("injected disk failure")); } });
			}
			return original(file, options);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "copy", deleteOld: true, expectedSource: getDataDirectoryStatus().copySource });
			assert.equal(response.status, 400);
			assert.match((await response.json()).error, /injected disk failure/);
			assert.deepEqual(fs.readdirSync(target), []);
			assert.equal(fs.readdirSync(scratchRoot).some(name => name.startsWith(".learnharness-copy-")), false);
			assert.ok(fs.existsSync(path.join(defaultDataDir, "settings.json")));
			assert.equal(config.PATHS.data, defaultDataDir);
		} finally { failure.mock.restore(); }
	});

	it("keeps the source and active location when the pointer rename fails", async () => {
		const target = path.join(scratchRoot, "failed-pointer");
		writeSettingsRecord({ version: 1 });
		const original = fs.renameSync;
		const failure = mock.method(fs, "renameSync", (...[from, to]: Parameters<typeof original>) => {
			if (to === configFile) throw new Error("injected pointer failure");
			return original(from, to);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "copy", deleteOld: true, expectedSource: getDataDirectoryStatus().copySource });
			assert.equal(response.status, 500);
			assert.match((await response.json()).error, /injected pointer failure/);
			assert.equal(fs.existsSync(target), false);
			assert.ok(fs.existsSync(path.join(defaultDataDir, "settings.json")));
			assert.equal(config.PATHS.data, defaultDataDir);
		} finally { failure.mock.restore(); }
	});

	it("adopts the persisted destination when flushing and rolling back the pointer both fail", { skip: process.platform === "win32" }, async () => {
		const origin = path.join(scratchRoot, "unflushed-origin");
		const target = path.join(scratchRoot, "unflushed-target");
		fs.mkdirSync(origin);
		const oldId = writeConfiguredDataDirPath(configFile, origin);
		config.setActiveDataDir(origin, { configuredDir: origin, storeId: oldId });
		fs.writeFileSync(path.join(origin, "settings.json"), "{}");
		const rename = fs.renameSync;
		const open = fs.openSync;
		let published = false;
		const renameFault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
			if (to === configFile && published) throw new Error("injected rollback rename failure");
			rename(from, to);
			if (to === configFile) published = true;
		});
		const flushFault = mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
			if (published && args[0] === path.dirname(configFile)) throw new Error("injected directory flush failure");
			return open(...args);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "copy", deleteOld: true, expectedSource: getDataDirectoryStatus().copySource });
			assert.equal(response.status, 200);
			assert.match((await response.json()).cleanupFailures.join("\n"), /location could not be flushed/);
			assert.equal(config.PATHS.data, target);
			assert.equal(inspectDataLocation({ configFile, defaultDir: defaultDataDir }).currentDir, target);
			assert.ok(fs.existsSync(path.join(origin, "settings.json")));
			assert.doesNotThrow(() => config.assertDataStoreWritable());
		} finally {
			flushFault.mock.restore();
			renameFault.mock.restore();
		}
	});

	it("requires a restart and blocks writes when the persisted pointer cannot be reconciled", { skip: process.platform === "win32" }, () => {
		const target = path.join(scratchRoot, "unreadable-pointer-target");
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import assert from 'node:assert/strict';
			import fs from 'node:fs';
			import path from 'node:path';
			const target = ${JSON.stringify(target)};
			const configFile = process.env.LH_DATA_CONFIG_FILE;
			const config = await import('./config.ts');
			const route = await import('./app/api/settings/data-dir/route.ts');
			const open = fs.openSync;
			const unlink = fs.unlinkSync;
			const rename = fs.renameSync;
			let published = false;
			fs.renameSync = (...args) => { rename(...args); if (args[1] === configFile) published = true; };
			fs.openSync = (...args) => {
				if (published && [configFile, path.dirname(configFile)].includes(args[0])) throw new Error('injected open failure');
				return open(...args);
			};
			fs.unlinkSync = (file) => { if (published && file === configFile) throw new Error('injected rollback failure'); unlink(file); };
			const result = await route.POST(new Request('http://localhost', { method: 'POST', body:
				JSON.stringify({ action: 'change', path: target, copyMode: 'switch' }) }));
			assert.equal(result.status, 500, await result.text());
			assert.match((await (await route.GET()).json()).recoveryReason, /Restart to recover/);
			assert.throws(() => config.assertDataStoreWritable(), /Restart to recover/);
		`], { encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, child.stderr);
	});

	it("recovery keeps prompting after a failed pointer write and leaves the original pointer intact", async () => {
		const ejected = path.join(scratchRoot, "native-ejected");
		const replacement = path.join(scratchRoot, "native-replacement");
		fs.mkdirSync(ejected);
		fs.mkdirSync(replacement);
		writeConfiguredDataDirPath(configFile, ejected);
		const previous = fs.readFileSync(configFile, "utf8");
		fs.rmSync(ejected, { recursive: true });
		const original = fs.renameSync;
		const injection = mock.method(fs, "renameSync", (...[from, to]: Parameters<typeof original>) => {
			if (to === configFile) throw new Error("injected native pointer failure");
			return original(from, to);
		});
		let prompted = false;
		try {
			const selected = await resolveStartupDataDir({
				configFile, defaultDir: defaultDataDir,
				dialog: {
					showMessageBox: async (opts: { detail: string; cancelId: number }) => {
						if (!prompted) { prompted = true; return { response: 1 }; }
						assert.match(opts.detail, /injected native pointer failure/);
						return { response: opts.cancelId };
					},
					showOpenDialog: async () => ({ filePaths: [replacement], canceled: false }),
				},
			});
			assert.equal(selected, null);
			assert.equal(fs.readFileSync(configFile, "utf8"), previous);
		} finally { injection.mock.restore(); }
	});

	it("reports a pointer removal failure and leaves the custom folder active", async () => {
		const target = path.join(scratchRoot, "failed-reset");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		const original = fs.unlinkSync;
		const failure = mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
			if (file === configFile) throw new Error("injected pointer removal failure");
			return original(file);
		});
		try {
			const response = await post({ action: "reset", copyMode: "switch" });
			assert.equal(response.status, 500);
			assert.match((await response.json()).error, /injected pointer removal failure/);
			assert.equal(config.PATHS.data, target);
		} finally { failure.mock.restore(); }
	});

	it("rejects a symlink or junction in the managed tree and nested canonical targets", async () => {
		const outside = path.join(scratchRoot, "outside-tree");
		fs.mkdirSync(outside);
		fs.mkdirSync(path.join(defaultDataDir, "chats"));
		fs.symlinkSync(outside, path.join(defaultDataDir, "chats", "linked"), "junction");
		const target = path.join(scratchRoot, "unsafe-copy");
		const response = await post({ action: "change", path: target, copyMode: "copy", expectedSource: getDataDirectoryStatus().copySource });
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /Symbolic links and junctions/);
		assert.equal(fs.existsSync(target), false);
		const alias = path.join(scratchRoot, "source-alias");
		fs.symlinkSync(defaultDataDir, alias, "junction");
		const nested = await post({ action: "change", path: path.join(alias, "new"), copyMode: "switch" });
		assert.equal(nested.status, 400);
		assert.equal(fs.existsSync(path.join(defaultDataDir, "new")), false);
		const configured = path.join(scratchRoot, "linked-startup");
		fs.mkdirSync(path.join(configured, "plugins"), { recursive: true });
		writeConfiguredDataDirPath(configFile, configured);
		fs.symlinkSync(outside, path.join(configured, "plugins", "linked"), "junction");
		assert.match(inspectDataLocation({ configFile, defaultDir: defaultDataDir }).recoveryReason, /Symbolic links and junctions/);
	});

	it("verifies an initialized graph store once per ledger append", async () => {
		const target = path.join(scratchRoot, "graph-verification-store");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		const { graphStore } = await import("../src/store/graph.ts");
		const checkpoint = { chatId: "session-1", foldedAt: "2026-11-20T00:00:00.000Z" };
		graphStore.appendCheckpoint(checkpoint);

		const markerFile = path.join(target, STORE_MARKER);
		let markerReads = 0;
		const originalRead = fs.readFileSync;
		const read = mock.method(fs, "readFileSync", (...args: Parameters<typeof originalRead>) => {
			if (args[0] === markerFile) markerReads++;
			return originalRead(...args);
		});
		try {
			graphStore.appendCheckpoint({ ...checkpoint, chatId: "session-2" });
			assert.equal(markerReads, 1);
		} finally {
			read.mock.restore();
		}
		assert.deepEqual(graphStore.readCheckpoints().map(({ chatId }) => chatId), ["session-1", "session-2"]);
	});

	it("retries a transient identity read and recovers automatically when the original marker returns", async () => {
		const target = path.join(scratchRoot, "recoverable-identity-store");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		const markerFile = path.join(target, STORE_MARKER);
		const marker = fs.readFileSync(markerFile);
		const originalRead = fs.readFileSync;
		let markerReads = 0;
		const read = mock.method(fs, "readFileSync", (...args: Parameters<typeof originalRead>) => {
			if (args[0] === markerFile && ++markerReads === 1) throw new Error("Transient marker read error");
			return originalRead(...args);
		});
		try {
			config.assertDataStoreWritable(config.SETTINGS_FILE);
			assert.equal(markerReads, 2);
		} finally {
			read.mock.restore();
		}

		fs.unlinkSync(markerFile);
		assert.throws(() => writeSettingsRecord({ version: 1 }), /unavailable/);
		assert.equal(getDataDirectoryStatus().unavailableConfiguredDir, target);
		fs.writeFileSync(markerFile, marker);
		writeSettingsRecord({ version: 1, general: { autoUpdate: false } });
		const restored = getDataDirectoryStatus();
		assert.equal(restored.unavailableConfiguredDir, null);
		assert.equal(restored.recoveryReason, null);
		assert.equal(readSettingsRecord()?.general?.autoUpdate, false);
	});

	it("detects identity mismatches and prevents chat, settings and job writers from recreating an ejected store", async () => {
		const target = path.join(scratchRoot, "identity-store");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		fs.rmSync(target, { recursive: true });
		assert.throws(() => stores.chatStore.createChat("After eject"), /unavailable/);
		assert.throws(() => writeSettingsRecord({ version: 1 }), /unavailable/);
		assert.throws(() => stores.jobStore.createJob({ kind: "research", chatId: "missing", toolCallId: "missing" }), /unavailable/);
		assert.equal(fs.existsSync(target), false);
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, STORE_MARKER), "a215e4e7-a55b-4f64-9b0a-686ab95c58a7");
		assert.equal((await post({ action: "retry-configured" })).status, 400);
		assert.equal(inspectDataLocation({ configFile, defaultDir: defaultDataDir }).unavailableConfiguredDir, target);
		const dismissed = await resolveStartupDataDir({
			configFile, defaultDir: defaultDataDir,
			dialog: { showMessageBox: async (options: { cancelId: number }) => ({ response: options.cancelId }) },
		});
		assert.equal(dismissed, null);
		assert.ok(fs.existsSync(configFile));
	});

	it("rejects busy migrations, blocks writers during a copy, and requires the confirmed source", async () => {
		const target = path.join(scratchRoot, "gate-target");
		const payload = { action: "change", path: target, copyMode: "copy", expectedSource: getDataDirectoryStatus().copySource! };
		const chat = stores.chatStore.createChat("Side conversation");
		let finishSide!: () => void;
		const sideBlocked = new Promise<void>(resolve => { finishSide = resolve; });
		const side = createSideChatService({
			chatStore: stores.chatStore,
			beforeAsk: () => sideBlocked,
			engineFor: async () => new Response(null, { status: 503 }),
			instructions: () => "",
		});
		const asking = side.ask(chat.id, { text: "Why?", quotes: [] });
		try { assert.equal((await post(payload)).status, 409); }
		finally { finishSide(); await asking; }
		registerJobAbort("orphaned-chat-job", new AbortController());
		try { assert.equal((await post(payload)).status, 409); }
		finally { unregisterJobAbort("orphaned-chat-job"); }
		const stale = await post({ ...payload, deleteOld: true, expectedSource: { ...payload.expectedSource, path: target } });
		assert.equal(stale.status, 400);
		assert.match((await stale.json()).error, /source folder changed/);
		writeSettingsRecord({ version: 1 });
		let notify!: () => void;
		let release!: () => void;
		const reachedStage = new Promise<void>(resolve => { notify = resolve; });
		const allowStage = new Promise<void>(resolve => { release = resolve; });
		const original = fs.promises.mkdtemp;
		const wait = mock.method(fs.promises, "mkdtemp", async (...args: Parameters<typeof original>) => {
			notify();
			await allowStage;
			return original(...args);
		});
		const moving = post(payload);
		try {
			await reachedStage;
			assert.equal((await post(payload)).status, 409);
			assert.equal(beginTurn("another-turn"), false);
			assert.throws(() => stores.chatStore.createChat("During copy"), /in progress/);
			assert.equal((await getDataDirRoute()).status, 200);
		} finally {
			release();
			await moving;
			wait.mock.restore();
		}
		assert.equal((await moving).status, 200);
	});

	it("keeps an edit made after copy verification and blocks app writes during cleanup", { skip: process.platform === "win32" }, async () => {
		const target = path.join(scratchRoot, "edited-source-copy");
		const stateFile = path.join(defaultDataDir, "settings.json");
		fs.writeFileSync(stateFile, '{"original":true}');
		const original = fs.promises.open;
		const edit = mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
			if (args[0] === path.join(target, "settings.json")) {
				assert.throws(() => config.assertDataStoreWritable(), /change is in progress/);
				fs.writeFileSync(stateFile, '{"modified":true}');
			}
			return original(...args);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "copy", deleteOld: true, expectedSource: getDataDirectoryStatus().copySource });
			assert.equal(response.status, 200);
			assert.match((await response.json()).cleanupFailures.join("\n"), /settings.json: The entry changed/);
			assert.equal(fs.readFileSync(stateFile, "utf8"), '{"modified":true}');
			assert.equal(fs.readFileSync(path.join(target, "settings.json"), "utf8"), '{"original":true}');
		} finally { edit.mock.restore(); }
	});

	it("moves plugin state and reports entries that cleanup could not remove", { skip: process.platform === "win32" }, async () => {
		const target = path.join(scratchRoot, "plugin-state-copy");
		const stateFile = path.join(defaultDataDir, "plugins-state.json");
		fs.writeFileSync(stateFile, '{"version":1,"enabled":{}}');
		const original = fs.unlinkSync;
		const failure = mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
			if (file === stateFile) throw new Error("injected cleanup failure");
			return original(file);
		});
		try {
			const response = await post({ action: "change", path: target, copyMode: "copy", deleteOld: true, expectedSource: getDataDirectoryStatus().copySource });
			assert.equal(response.status, 200);
			assert.deepEqual((await response.json()).cleanupFailures, [`${stateFile}: injected cleanup failure`]);
			assert.equal(fs.readFileSync(path.join(target, "plugins-state.json"), "utf8"), fs.readFileSync(stateFile, "utf8"));
		} finally { failure.mock.restore(); }
	});

	it("refuses persisted moves in LH_DATA_DIR-only sessions", () => {
		const env = { ...process.env };
		delete env.LH_DATA_CONFIG_FILE;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			const route = await import('./app/api/settings/data-dir/route.ts');
			const result = await route.POST(new Request('http://localhost', { method: 'POST', body:
				JSON.stringify({ action: 'reset', copyMode: 'switch' }) }));
			console.log(result.status, await result.text());
		`], { env, encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, /400.*LH_DATA_DIR fixes/);
	});

	it("guards a captured plugin workspace creator after a store is unplugged", async () => {
		const target = path.join(scratchRoot, "plugin-offline-store");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		const plugin = path.join(target, "plugins", "workspace-test", "dist");
		fs.mkdirSync(plugin, { recursive: true });
		fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({
			apiVersion: 1, id: "workspace-test", name: "Workspace test", version: "1.0.0", minAppVersion: "0.3.0",
			backend: "backend.cjs",
		}));
		fs.writeFileSync(path.join(plugin, "backend.cjs"), `
			exports.activate = ctx => { ctx.handle("create-directory", () => ctx.createDataDirectory); };
		`);
		const host = await getPluginHost();
		await host.setEnabled("workspace-test", true);
		const createDirectory = await host.call("workspace-test", "create-directory") as (...segments: string[]) => string;
		assert.equal(createDirectory("test-runs"), path.join(target, "plugins", "workspace-test", "data", "test-runs"));
		assert.throws(() => createDirectory(".."), /Invalid plugin data directory path/);
		fs.rmSync(target, { recursive: true });
		assert.throws(() => createDirectory("test-runs", "question"), /unavailable/);
		assert.ok(!fs.existsSync(target));
	});

	it("disposes the old plugin host before the new store becomes active", async () => {
		const host = await getPluginHost();
		const target = path.join(scratchRoot, "plugin-host-switch");
		assert.equal((await post({ action: "change", path: target, copyMode: "switch" })).status, 200);
		assert.throws(() => host.list(), /disposed/);
		assert.notEqual(await getPluginHost(), host);
	});

	it("resolves the desktop pointer in the read-only skill and keeps explicit overrides", { skip: process.platform !== "linux" }, () => {
		const desktop = path.join(scratchRoot, "xdg", "LearnHarness");
		const pointer = path.join(desktop, "data-location.json");
		const chosen = path.join(scratchRoot, "skill-store");
		fs.mkdirSync(chosen);
		writeConfiguredDataDirPath(pointer, chosen);
		const run = (...args: string[]) => spawnSync("python3", ["-B", "-c", `
import sys
sys.path.insert(0, "skills/learnharness/scripts")
from _data import DataError, data_root
try:
    print(data_root(*sys.argv[1:]))
except DataError as error:
    sys.exit(str(error))
`, ...args], { env: { ...process.env, XDG_CONFIG_HOME: path.dirname(desktop) }, encoding: "utf8", timeout: 10_000 });
		const resolved = run();
		assert.equal(resolved.status, 0, resolved.stderr);
		assert.equal(resolved.stdout.trim(), chosen);
		fs.unlinkSync(path.join(chosen, STORE_MARKER));
		assert.match(run().stderr, /Configured data folder unavailable/);
		assert.equal(run(defaultDataDir).stdout.trim(), defaultDataDir);
	});

	it("requires a drive or full UNC share on Windows", () => {
		for (const input of [String.raw`\folder`, "C:folder", "/folder", String.raw`\\host`]) assert.equal(isFullPath(input, "win32"), false, input);
		for (const input of [String.raw`C:\folder`, "C:/folder", String.raw`\\host\share\folder`]) assert.equal(isFullPath(input, "win32"), true, input);
	});

	it("returns 400 for an uncreatable procfs target and permits subsequent requests", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
		const response = await post({ action: "change", path: "/proc/forbidden/child", copyMode: "copy", expectedSource: getDataDirectoryStatus().copySource });
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /Could not prepare.*\/proc/);
		assert.equal((await getDataDirRoute()).status, 200);
		assert.equal((await post({ action: "change", path: path.join(scratchRoot, "after-proc"), copyMode: "switch" })).status, 200);
	});
});

describe("DataDirectoryConfirmBody & UnavailableDataDirectoryBody UI rendering", () => {
	it("renders copy & keep-old options by default and updates button label for delete-old and switch modes", () => {
		const copyKeepHtml = renderToStaticMarkup(
			<DataDirectoryConfirmBody
				currentDir="/Users/me/Library/Application Support/LearnHarness/data"
				targetPath="/Volumes/1700 APFS/LearnHarnessData"
				onTargetPathChange={() => {}}
				isReset={false}
				canBrowse={true}
				onBrowse={() => {}}
				copyMode="copy"
				onCopyModeChange={() => {}}
				deleteOld={false}
				onDeleteOldChange={() => {}}
				busy={false}
				error=""
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		assert.ok(copyKeepHtml.includes("Copy existing data into the new folder"));
		assert.ok(copyKeepHtml.includes("Keep old data in the previous folder (Default)"));
		assert.ok(copyKeepHtml.includes("Delete old data after copying"));
		assert.ok(copyKeepHtml.includes("Copy &amp; switch"));

		const copyDeleteHtml = renderToStaticMarkup(
			<DataDirectoryConfirmBody
				currentDir="/Users/me/Library/Application Support/LearnHarness/data"
				targetPath="/Volumes/1700 APFS/LearnHarnessData"
				onTargetPathChange={() => {}}
				isReset={false}
				canBrowse={false}
				copyMode="copy"
				onCopyModeChange={() => {}}
				deleteOld={true}
				onDeleteOldChange={() => {}}
				busy={false}
				error=""
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		assert.ok(copyDeleteHtml.includes("Copy, switch &amp; delete old"));

		const switchHtml = renderToStaticMarkup(
			<DataDirectoryConfirmBody
				currentDir="/Users/me/Library/Application Support/LearnHarness/data"
				targetPath="/Volumes/1700 APFS/LearnHarnessData"
				onTargetPathChange={() => {}}
				isReset={false}
				canBrowse={false}
				copyMode="switch"
				onCopyModeChange={() => {}}
				deleteOld={false}
				onDeleteOldChange={() => {}}
				busy={false}
				error=""
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		assert.ok(switchHtml.includes("Switch folder"));
		assert.ok(!switchHtml.includes("data-dir-old-cleanup-group"));
	});

	it("renders the unavailable external drive dialog with Retry, Choose folder, and Use default folder", () => {
		const html = renderToStaticMarkup(
			<UnavailableDataDirectoryBody
				unavailableDir="/Volumes/ExternalSSD/LearnHarnessData"
				defaultDir="/Users/me/Library/Application Support/LearnHarness/data"
				choosingFolder={true}
				folderDraft="/Volumes/ExternalSSD/LearnHarnessData"
				onFolderDraftChange={() => {}}
				canBrowse={true}
				onBrowse={() => {}}
				busy={false}
				error="The configured data folder is still unavailable."
				onRetry={() => {}}
				onStartChooseFolder={() => {}}
				onApplyChosenFolder={() => {}}
				onUseDefault={() => {}}
			/>,
		);
		assert.ok(html.includes("Data folder unavailable"));
		assert.ok(html.includes("/Volumes/ExternalSSD/LearnHarnessData"));
		assert.ok(html.includes("Retry"));
		assert.ok(html.includes("Choose folder…"));
		assert.ok(html.includes("Use default folder"));
		assert.ok(html.includes("The configured data folder is still unavailable."));
	});
});
