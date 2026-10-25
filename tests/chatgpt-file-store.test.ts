import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createChatGPT, fileStore } = require("../electron/chatgpt.cjs");
const initial = () => ({ version: 1, hostId: "urn:uuid:scratch-host", activeId: null, registrations: [] });
const account = (id: string, subject: string) => ({
	id, clientId: `oaiapp_${id}`, issuer: "https://auth.openai.com", subject, email: `${subject}@example.invalid`,
	tokens: { accessToken: `scratch-access-${id}`, refreshToken: `scratch-refresh-${id}`, idToken: `scratch-id-${id}`, expiresAt: Date.now() + 3600000, scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] },
});
function service(store: unknown) {
	return createChatGPT({ store, openExternal: () => assert.fail("no browser sign-in expected"), fetch: () => assert.fail("no provider request expected") });
}

test("ordinary startup restores saved accounts and global OFF from JSON without OAuth or native storage", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-restore-"));
	const file = path.join(dir, "chatgpt-credentials.json");
	const state = { ...initial(), activeId: "B", registrations: [account("A", "first"), account("B", "second")], allowBackgroundUse: false };
	let connection;
	try {
		await fileStore(file).write(state);
		connection = service(fileStore(file));
		const status = await connection.status();
		assert.equal(status.available, true);
		assert.equal(status.activeId, "B");
		assert.equal(status.allowBackgroundUse, false);
		assert.deepEqual(status.accounts.map((a: { email: string; connected: boolean }) => [a.email, a.connected]), [["first@example.invalid", true], ["second@example.invalid", true]]);
		assert.doesNotMatch(JSON.stringify(status), /scratch-access|scratch-refresh|scratch-id/);
		await connection.status();
		assert.deepEqual(await fileStore(file).read(), state, "startup/status does not change saved credentials");
	} finally { connection?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("new store ignores experimental encrypted files and never alters the separate API-key file", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-fresh-"));
	const file = path.join(dir, "chatgpt-credentials.json");
	const experimental = path.join(dir, "chatgpt-credentials.enc.json");
	const auth = path.join(dir, "auth.json");
	const oldBytes = "not an envelope to parse, decrypt, migrate or delete";
	const apiBytes = '{"OPENAI_API_KEY":"scratch-api-key"}\n';
	let connection;
	try {
		await fs.writeFile(experimental, oldBytes);
		await fs.writeFile(auth, apiBytes);
		connection = service(fileStore(file));
		const status = await connection.status();
		assert.equal(status.available, true); assert.equal(status.allowBackgroundUse, true);
		assert.equal(status.activeId, null); assert.deepEqual(status.accounts, []);
		assert.deepEqual((await connection.models()).models, []);
		await connection.consent(false);
		connection.close(); connection = service(fileStore(file));
		assert.equal((await connection.status()).allowBackgroundUse, false, "zero-account preference survives a real file-backed restart");
		assert.equal(await fs.readFile(experimental, "utf8"), oldBytes);
		assert.equal(await fs.readFile(auth, "utf8"), apiBytes);
	} finally { connection?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

for (const bytes of ["{broken-json", "null", "[]", '{"version":1,"encrypted":"ZXhwZXJpbWVudA=="}']) {
	test(`invalid JSON/record fails closed without overwriting it: ${bytes}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-invalid-"));
		const file = path.join(dir, "chatgpt-credentials.json");
		let connection;
		try {
			await fs.writeFile(file, bytes);
			connection = service(fileStore(file));
			const status = await connection.status();
			assert.equal(status.available, false); assert.equal(status.activeId, null);
			assert.match(status.error, /could not be read or saved/);
			assert.deepEqual((await connection.models()).models, []);
			await assert.rejects(connection.login(), /storage/);
			assert.equal(await fs.readFile(file, "utf8"), bytes);
		} finally { connection?.close(); await fs.rm(dir, { recursive: true, force: true }); }
	});
}

for (const phase of ["sync", "rename"] as const) {
	test(`failed ${phase} leaves the previous JSON intact and removes temporary files`, async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-atomic-"));
		const file = path.join(dir, "chatgpt-credentials.json");
		try {
			const store = fileStore(file);
			await store.write(initial());
			const before = await fs.readFile(file, "utf8");
			if (phase === "rename") t.mock.method(fs, "rename", async () => { throw new Error("scratch rename failure"); });
			else {
				const open = fs.open.bind(fs);
				t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
					const handle = await open(...args);
					if (args[1] === "wx") t.mock.method(handle, "sync", async () => { throw new Error("scratch sync failure"); });
					return handle;
				});
			}
			await assert.rejects(store.write({ ...initial(), allowBackgroundUse: false }), /^Error: storage$/);
			assert.equal(await fs.readFile(file, "utf8"), before);
			assert.deepEqual(await fs.readdir(dir), ["chatgpt-credentials.json"]);
		} finally { await fs.rm(dir, { recursive: true, force: true }); }
	});
}

test("file read/write failures are sanitized and cannot leak credential or path details", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-io-"));
	try {
		// Reading a directory and writing beneath a regular file both fail on all supported platforms.
		await assert.rejects(fileStore(dir).read(), /^Error: storage$/);
		const blocker = path.join(dir, "scratch-private-path"); await fs.writeFile(blocker, "blocker");
		const connection = service(fileStore(path.join(blocker, "chatgpt-credentials.json")));
		try {
			const status = await connection.status();
			assert.equal(status.available, false);
			assert.doesNotMatch(status.error, /scratch-private-path|ENOTDIR|EISDIR/);
			await assert.rejects(connection.login(), /^Error: storage$/);
		} finally { connection.close(); }
		await assert.rejects(fileStore(path.join(blocker, "credentials.json")).write({ ...initial(), secret: "scratch-token" }), /^Error: storage$/);
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("desktop wiring uses only the private JSON path, with no Electron safeStorage dependency", async () => {
	const main = await fs.readFile(new URL("../electron/main.cjs", import.meta.url), "utf8");
	const auth = await fs.readFile(new URL("../electron/chatgpt.cjs", import.meta.url), "utf8");
	assert.match(main, /store: fileStore\(path\.join\(app\.getPath\("userData"\), "chatgpt-credentials\.json"\)\)/);
	assert.doesNotMatch(main + auth, /safeStorage|encryptedStore|chatgpt-credentials\.enc\.json/);
});
