import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
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
	resolveStartupDataDir,
	writeConfiguredDataDirPath,
} = require("../electron/data-location.cjs");

const config = await import("../config.ts");
const {
	GET: getDataDirRoute,
	POST: postDataDirRoute,
} = await import("../app/api/settings/data-dir/route.ts");
const { beginTurn, endTurn, stores, writeSettingsRecord, readSettingsRecord } = await import("../src/server/index.ts");
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
		writeConfiguredDataDirPath(configFile, unpluggedDir);

		const inspected = inspectDataLocation({ configFile, defaultDir: defaultDataDir });
		assert.equal(inspected.currentDir, defaultDataDir);
		assert.equal(inspected.unavailableConfiguredDir, unpluggedDir);

		// 1) Retry succeeds once the drive is reconnected
		let attempts = 0;
		const resolvedAfterRetry = await resolveStartupDataDir({
			configFile,
			defaultDir: defaultDataDir,
			dialog: {
				showMessageBox: async (opts: { buttons: string[]; detail: string }) => {
					attempts++;
					assert.deepEqual(opts.buttons, ["Retry", "Choose Folder…", "Use Default Folder"]);
					assert.ok(opts.detail.includes(unpluggedDir));
					// Simulate user plugging in the external drive before clicking Retry
					fs.mkdirSync(unpluggedDir, { recursive: true });
					return { response: 0 };
				},
			},
		});
		assert.equal(attempts, 1);
		assert.equal(resolvedAfterRetry, unpluggedDir);

		// 2) Choose Folder updates data-location.json and uses the picked folder
		fs.rmSync(path.join(scratchRoot, "unplugged-drive"), { recursive: true, force: true });
		const alternateDir = path.join(scratchRoot, "alternate-external");
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

	it("deletes LearnHarness data from the old folder when deleteOld is true, preserving unrelated files", async () => {
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
					body: JSON.stringify(badPayload),
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
		writeConfiguredDataDirPath(configFile, missingDrive);
		config.setActiveDataDir(defaultDataDir, {
			defaultDir: defaultDataDir,
			configuredDir: missingDrive,
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
