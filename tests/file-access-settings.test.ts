import assert from "node:assert/strict";
import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Every store, route and composition-root import sees only these synthetic
// locations. No real settings, credential files or learning records are used.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-folder-settings-")));
const home = path.join(root, "home");
const data = path.join(root, "data");
const auth = path.join(root, "auth.json");
const a = path.join(home, "Study");
const b = path.join(root, "Other");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
for (const directory of [a, b, data]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(auth, "{}\n");
await fs.writeFile(path.join(a, "notes.md"), "synthetic study\n");
await fs.writeFile(path.join(b, "notes.md"), "synthetic other\n");
const { SETTINGS_FILE } = await import("../config.ts");
const { readFileAccessSettings, readSettings, writeSettings } = await import("../src/store/settings.ts");
const { fileAccessPolicy, fileAccessConfigurationError } = await import("../src/server/file-access.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { GET } = await import("../app/api/settings/route.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const stored = async (value: unknown) => fs.writeFile(SETTINGS_FILE, JSON.stringify(value));
const put = (section: string, value: unknown) => PUT(new Request(`http://localhost/api/settings/${section}`, { method: "PUT", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ section }) });
beforeEach(async () => { await fs.rm(SETTINGS_FILE, { recursive: true, force: true }); setFileAccessPolicy(fileAccessPolicy); });
after(async () => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});
const blocked = /File-access configuration.*blocked/;

describe("strict persisted file-access policy", () => {
	it("genuinely absent preferences default OFF, including a not-yet-created data folder", async () => {
		assert.deepEqual(readFileAccessSettings(), { ok: true, settings: { restricted: false, folders: [] } });
		assert.equal(fileAccessConfigurationError(), null);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
		await fs.rmdir(data);
		try { assert.equal(readFileAccessSettings().ok, true); }
		finally { await fs.mkdir(data); }
	});
	it("valid existing preferences with no policy default OFF; a legacy list alone does not turn it ON", async () => {
		await stored({ version: 1, agent: { tools: { pdf: false } } });
		assert.equal(fileAccessPolicy().restricted, false);
		await stored({ version: 1, agent: { fileAccess: { folders: [a] } } });
		assert.equal(fileAccessPolicy().restricted, false);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
	it("reads the latest policy for the next operation, not a cached sanitized default", async () => {
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: ["~/Study"] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [b] } } });
		assert.throws(() => resolveSourcePath("Study/notes.md"), /allowed folders/);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
		await stored({ version: 1, agent: { fileAccess: { restricted: false, folders: [b] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
	});
	it("malformed records and policies fail CLOSED with a safe actionable diagnostic", async () => {
		for (const value of [null, [], 5, { agent: null }, { agent: [] }, { agent: { fileAccess: null } }, { agent: { fileAccess: { restricted: "yes", folders: [a] } } }, { agent: { fileAccess: { folders: [a, "relative"] } } }]) {
			await stored(value);
			assert.equal(readFileAccessSettings().ok, false);
			assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
		}
		await fs.writeFile(SETTINGS_FILE, '{"SYNTHETIC_PRIVATE_PAYLOAD":');
		const response = await GET();
		const body = await response.json();
		assert.equal(body.settings, null);
		assert.match(body.fileAccessError, blocked);
		assert.ok(!JSON.stringify(body).includes("SYNTHETIC_PRIVATE_PAYLOAD"));
	});
	it("an unreadable existing file fails closed (synthetic EACCES, not chmod assumptions)", async (t) => {
		await stored({ version: 1 });
		const original = fsSync.readFileSync;
		t.mock.method(fsSync, "readFileSync", (...args: unknown[]) => {
			if (args[0] === SETTINGS_FILE) throw Object.assign(new Error("synthetic unreadable settings"), { code: "EACCES" });
			return Reflect.apply(original, fsSync, args);
		});
		assert.equal(readSettings(), null);
		assert.equal(readFileAccessSettings().ok, false);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
	});
	it("directories, dangling settings symlinks and dangling data-directory symlinks are not first boot", async () => {
		await fs.mkdir(SETTINGS_FILE);
		assert.equal(readFileAccessSettings().ok, false);
		await fs.rmdir(SETTINGS_FILE);
		await fs.symlink(path.join(root, "missing-settings.json"), SETTINGS_FILE, "file");
		assert.equal(readFileAccessSettings().ok, false);
		await fs.unlink(SETTINGS_FILE);
		await fs.rmdir(data);
		await fs.symlink(path.join(root, "missing-data"), data, process.platform === "win32" ? "junction" : "dir");
		try { assert.equal(readFileAccessSettings().ok, false); }
		finally { await fs.unlink(data); await fs.mkdir(data); }
	});
});

describe("settings HTTP and safe repair", () => {
	it("section writes preserve policy, toggle OFF retains roots, and ON+empty blocks", async () => {
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, b] } })).status, 200);
		assert.equal((await put("appearance", { theme: "catppuccin-mocha" })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: true, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: false, folders: [a, b] } })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: false, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [] } })).status, 200);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		assert.deepEqual(readSettings()?.appearance, { theme: "catppuccin-mocha" });
	});
	it("invalid writes return 400 without altering a valid restricted record", async () => {
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [a] } } });
		const before = await fs.readFile(SETTINGS_FILE, "utf8");
		for (const fileAccess of [{ restricted: "true", folders: [b] }, { restricted: true, folders: ["relative"] }, { restricted: false, folders: [a, 2] }, []]) {
			assert.equal((await put("agent", { fileAccess })).status, 400);
			assert.equal(await fs.readFile(SETTINGS_FILE, "utf8"), before);
		}
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
	});
	it("unrelated writes cannot launder malformed policy into unrestricted access", async () => {
		await stored({ version: 1, agent: { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, 7] } } });
		assert.equal((await put("appearance", { theme: "catppuccin-latte" })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: true, folders: [] });
		assert.deepEqual(readSettings()?.agent?.tools, { pdf: false });
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		await fs.writeFile(SETTINGS_FILE, "broken JSON");
		const response = await put("appearance", { theme: "catppuccin-mocha" });
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).settings.agent.fileAccess, { restricted: true, folders: [] });
		assert.equal(fileAccessConfigurationError(), null);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
	});
	it("an explicit valid File access edit repairs corrupt settings and clears the UI diagnostic", async () => {
		await fs.writeFile(SETTINGS_FILE, "broken JSON");
		assert.match((await (await GET()).json()).fileAccessError, blocked);
		const response = await put("agent", { fileAccess: { restricted: true, folders: [a] } });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).fileAccessError, undefined);
		assert.equal((await (await GET()).json()).fileAccessError, undefined);
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		await fs.writeFile(SETTINGS_FILE, "broken JSON again");
		writeSettings({ version: 1, agent: { fileAccess: { restricted: false, folders: [a] } } });
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
});
