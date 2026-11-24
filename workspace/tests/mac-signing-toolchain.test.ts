/** Execute the installed signing helper with fake security commands and fake
 * certificates. Never touch a real keychain, credential, or certificate file.
 * Regression: electron-builder #10066 used the p12 password to unlock a
 * temporary keychain that had been created with a different random password. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const sourcePath = require.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
const source = fs.readFileSync(sourcePath, "utf8");
const generatedPassword = Buffer.alloc(32, 42).toString("base64");
const applicationPassword = "fixture-application-export-password";
const installerPassword = "fixture-installer-export-password";
type Command = { executable: string; args: string[] };
type Options = { installer?: boolean; source?: string };

async function simulate({ installer = false, source: code = source }: Options = {}) {
	const commands: Command[] = [];
	const imports: string[] = [];
	const fakeModules: Record<string, unknown> = {
		"builder-util": {
			exec: async (executable: string, args: string[]) => {
				assert.equal(executable, "/usr/bin/security");
				commands.push({ executable, args: [...args] });
				return "";
			},
		},
		"../util/dynamicImport": {},
		crypto: { ...crypto, randomBytes: () => Buffer.alloc(32, 42) },
		"fs/promises": {},
		"lazy-val": { Lazy: class { get value() { throw new Error("Unexpected real certificate-cache initialization"); } } },
		os: { tmpdir: () => "/fixture/tmp" },
		path,
		"temp-file": {},
		"../util/flags": {},
		"./codesign": {
			importCertificate: async (link: string) => {
				assert.ok(["fixture-application", "fixture-installer"].includes(link));
				imports.push(link);
				return `/fixture/${link}.p12`;
			},
		},
	};
	const exports: { createKeychain?: (options: unknown) => Promise<{ keychainFile: string }> } = {};
	vm.runInNewContext(code, {
		exports,
		__dirname: path.dirname(sourcePath),
		// Skip the unrelated bundled-root-certificate cache in this sandbox.
		process: { env: { TRAVIS: "true" }, platform: "darwin" },
		require: (id: string) => {
			assert.ok(Object.hasOwn(fakeModules, id), `Unexpected dependency: ${id}`);
			return fakeModules[id];
		},
	}, { filename: sourcePath });
	assert.ok(exports.createKeychain);
	const result = await exports.createKeychain({
		tmpDir: {},
		currentDir: "/fixture/project",
		cscLink: "fixture-application",
		cscKeyPassword: applicationPassword,
		...(installer ? { cscILink: "fixture-installer", cscIKeyPassword: installerPassword } : {}),
	});
	return { commands, imports, result };
}

function argument(command: Command, flag: string) {
	const index = command.args.indexOf(flag);
	assert.ok(index >= 0, `Missing ${flag} in ${command.args[0]}`);
	return command.args[index + 1];
}

function verifyKeychainPassword(commands: Command[]) {
	const created = commands.find(c => c.args[0] === "create-keychain")!;
	assert.equal(argument(created, "-p"), generatedPassword);
	const unlocked = commands.find(c => c.args[0] === "unlock-keychain")!;
	assert.equal(argument(unlocked, "-p"), generatedPassword);
	const partitions = commands.filter(c => c.args[0] === "set-key-partition-list");
	assert.ok(partitions.length > 0);
	for (const command of partitions) {
		assert.equal(argument(command, "-k"), generatedPassword, "partition-list access requires the generated keychain password, not an export password");
		assert.equal(command.args.at(-1), created.args.at(-1));
	}
}

describe("macOS signing toolchain password separation", () => {
	it("pins the tested packaging tool rather than allowing an implicit upgrade", () => {
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const version = pkg.devDependencies["electron-builder"];
		assert.match(version, /^\d+\.\d+\.\d+$/);
		assert.equal(require("electron-builder/package.json").version, version);
		assert.equal(require("app-builder-lib/package.json").version, version);
	});

	it("uses the export password for import and the generated password for keychain access", async () => {
		const { commands, imports, result } = await simulate();
		assert.deepEqual(imports, ["fixture-application"]);
		const imported = commands.filter(c => c.args[0] === "import");
		assert.equal(imported.length, 1);
		assert.equal(argument(imported[0]!, "-P"), applicationPassword);
		assert.equal(argument(imported[0]!, "-k"), result.keychainFile);
		verifyKeychainPassword(commands);
	});

	it("keeps both certificate export passwords distinct from their shared keychain password", async () => {
		const { commands, imports } = await simulate({ installer: true });
		assert.deepEqual(imports, ["fixture-application", "fixture-installer"]);
		const imported = commands.filter(c => c.args[0] === "import");
		assert.deepEqual(imported.map(c => argument(c, "-P")), [applicationPassword, installerPassword]);
		assert.equal(commands.filter(c => c.args[0] === "set-key-partition-list").length, 2);
		verifyKeychainPassword(commands);
	});

	it("the regression check rejects the historical password mix-up", async () => {
		const broken = source.replace('"-k", keychainPassword, keychainFile', '"-k", password, keychainFile');
		assert.notEqual(broken, source, "the negative control must actually recreate the bug");
		const { commands } = await simulate({ source: broken });
		assert.throws(() => verifyKeychainPassword(commands), /partition-list access requires/);
	});
});
