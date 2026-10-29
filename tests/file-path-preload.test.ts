import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

interface PathBridge {
	platform: string;
	getPathForFile(file: unknown): string;
	[key: string]: unknown;
}

/** Execute the actual preload in a VM, without Electron, IPC or app startup. */
function fixture(resolve: (file: unknown) => string) {
	let bridge!: PathBridge;
	const supplied: unknown[] = [];
	const sent: unknown[][] = [];
	const invoked: unknown[][] = [];
	const imports: string[] = [];
	const exposed: string[] = [];
	const electron = {
		contextBridge: { exposeInMainWorld(name: string, surface: PathBridge) { exposed.push(name); bridge = surface; } },
		webUtils: { getPathForFile(file: unknown) { supplied.push(file); return resolve(file); } },
		ipcRenderer: {
			on() {}, removeListener() {},
			send: (...args: unknown[]) => { sent.push(args); },
			invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); },
		},
	};
	runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
		process: { platform: "darwin", argv: [] },
		require: (name: string) => { imports.push(name); assert.equal(name, "electron"); return electron; },
	});
	return { bridge, supplied, sent, invoked, imports, exposed, electron };
}

describe("path-only preload bridge", () => {
	it("forwards the exact supplied File identity to webUtils, returning only the backing path without IPC", () => {
		const file = new File(["synthetic fixture"], "display-name.pdf", { type: "application/pdf" });
		let reads = 0;
		for (const method of ["text", "arrayBuffer", "stream"] as const) {
			Object.defineProperty(file, method, { value: () => { reads++; throw new Error("Must not read file content"); } });
		}
		const fullPath = "/actual/course/notes with `backticks`.pdf";
		const f = fixture((supplied) => { assert.equal(supplied, file); return fullPath; });
		assert.deepEqual(f.exposed, ["lh"]);
		assert.deepEqual(f.imports, ["electron"]);
		assert.equal(f.bridge.getPathForFile(file), fullPath);
		assert.equal(f.supplied.length, 1);
		assert.equal(f.supplied[0], file);
		assert.notEqual(fullPath, file.name);
		assert.equal(reads, 0);
		assert.deepEqual(f.sent, []);
		assert.deepEqual(f.invoked, []);
	});

	it("keeps Electron's empty result for a File without an OS backing path, never substituting its name", () => {
		const virtual = new File(["virtual"], "/misleading/full/path.pdf");
		const f = fixture(() => "");
		assert.equal(f.bridge.getPathForFile(virtual), "");
		assert.equal(f.supplied[0], virtual);
		assert.deepEqual(f.sent, []);
		assert.deepEqual(f.invoked, []);
	});

	it("preserves webUtils errors for invalid File arguments instead of inventing a path", () => {
		const invalid = { name: "/misleading/filename.pdf", path: "/not/a/capability.pdf" };
		const error = new TypeError("Expected a File");
		const f = fixture((supplied) => { assert.equal(supplied, invalid); throw error; });
		assert.throws(() => f.bridge.getPathForFile(invalid), (caught) => caught === error);
		assert.equal(f.supplied[0], invalid);
		assert.deepEqual(f.sent, []);
		assert.deepEqual(f.invoked, []);
	});

	it("adds just the narrow path resolver to the explicit surface, without exposing Electron or filesystem APIs", () => {
		const f = fixture(() => "");
		assert.deepEqual(Object.keys(f.bridge).sort(), [
			"chatgpt", "checkForUpdates", "expandWindow", "getPathForFile", "getUpdateState", "getZoom",
			"installUpdate", "onOpenSettings", "onUpdateStatus", "onZoom", "platform", "subscriptions",
		]);
		assert.equal(f.bridge.platform, "darwin");
		for (const name of ["webUtils", "ipcRenderer", "electron", "fs", "require", "readFile", "writeFile", "uploadFile", "openPath"]) {
			assert.equal(Object.hasOwn(f.bridge, name), false, name);
		}
		assert.notEqual(f.bridge.getPathForFile, f.electron.webUtils.getPathForFile, "webUtils itself is not exposed");
	});

	it("retains context isolation, sandbox and disabled Node integration in the production window", () => {
		const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
		assert.match(main, /webPreferences:\s*\{\s*contextIsolation:\s*true,\s*sandbox:\s*true,\s*nodeIntegration:\s*false,/);
		assert.match(main, /preload:\s*path\.join\(__dirname,\s*"preload\.cjs"\)/);
	});
});
