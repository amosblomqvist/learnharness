import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { unzipSync } from "fflate";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { test } from "node:test";
import { createLessonLan, privateLanAddress } from "../src/server/lesson-lan.ts";
import { lanHash, lanReceipt } from "../src/store/lesson-lan.ts";
import { downloadExport, previewExport } from "../src/store/lesson-export.ts";
import { installImport, previewImport, recoverTransfers } from "../src/store/lesson-import.ts";

const record = (text = "Authored offline LAN fixture") => ({ version: 1, id: "chat_lan", title: "Synthetic LAN lesson", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [{ id: "u", role: "user", content: text, timestamp: 1 }], opaque: { preserve: "Ω" } });
function write(root: string, name: string, raw: string) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); }
function archive(root: string, text?: string) { write(root, "chats/chat_lan.json", JSON.stringify(record(text), null, "\t") + "\n"); const p = previewExport(root, ["chat_lan"]); return downloadExport(root, ["chat_lan"], "zip", { revision: p.revision, files: [] }).bytes; }

test("actual pinned HTTPS exchanges, single-use pairing, conflicts, committed retry, revocation and restart", async t => {
	let now = 0; t.mock.method(performance, "now", () => now);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-")), source = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-source-"));
	let busy = false, changes = 0;
	const deps = { name: "Synthetic isolated library", lessons: () => fs.existsSync(path.join(root, "chats/chat_lan.json")) ? [{ id: "chat_lan", title: "Synthetic LAN lesson" }] : [], idle() { if (busy) throw new Error("busy"); }, changed() { changes++; } };
	let lan = createLessonLan(root, deps);
	try {
		await lan.start("127.0.0.1");
		let status = lan.status(); assert.equal(status.enabled, true);
		const identity = JSON.parse(fs.readFileSync(path.join(root, "lesson-lan/identity.json"), "utf8"));
		assert.equal("name" in identity, false);
		if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "lesson-lan/identity.json")).mode & 0o777, 0o600);
		const cert = new X509Certificate(identity.cert), fingerprint = lanHash(cert.raw);
		let token = randomBytes(32).toString("base64url");
		async function request(method: string, url: string, bytes?: Uint8Array, headers: Record<string, string> = {}, pin = fingerprint, dropResponse = false) {
			return new Promise<{ status: number; bytes: Buffer; json: () => any }>((resolve, reject) => {
				const req = https.request({ hostname: "127.0.0.1", port: lan.status().port, path: url, method, ca: identity.cert, agent: false,
					checkServerIdentity: (_, peer) => lanHash(peer.raw) === pin ? undefined : new Error("pin mismatch"),
					headers: { Authorization: `Bearer ${token}`, ...(bytes ? { "Content-Length": String(bytes.length) } : {}), ...headers } }, res => {
					if (dropResponse) { res.destroy(); reject(new Error("Lost acknowledgement")); return; }
					const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("error", reject); res.on("end", () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode!, bytes: b, json: () => JSON.parse(b.toString()) }); });
				}); req.on("error", reject); req.end(bytes);
			});
		}
		assert.equal((await request("GET", "/v1/lessons")).status, 401);
		await assert.rejects(request("GET", "/v1/lessons", undefined, {}, "0".repeat(64)), /pin mismatch/);
		const pairing = await lan.pairing("127.0.0.1"), key = new URL(pairing.connection).searchParams.get("key")!;
		assert.equal(new URL(pairing.connection).searchParams.get("sha256"), fingerprint); assert.match(pairing.qr, /^data:image\/png;base64,/);
		const pair = () => request("POST", "/v1/pair", Buffer.from('{"name":"Authored emulator"}'), { "Content-Type": "application/json", "X-Pairing-Key": key });
		assert.equal(lan.status().pairingActive, true);
		assert.equal((await pair()).status, 200); assert.equal(lan.status().pairingActive, false);
		assert.equal(lan.status().devices[0]!.online, true);
		now += 4000; assert.equal(lan.status().devices[0]!.online, false);
		assert.equal((await request("GET", "/v1/status")).json().name, deps.name);
		assert.equal(lan.status().devices[0]!.online, true);
		assert.equal((await pair()).status, 200); // Lost acknowledgement is recoverable.
		const firstToken = token; token = randomBytes(32).toString("base64url"); assert.equal((await pair()).status, 403); token = firstToken;
		const persisted = fs.readFileSync(path.join(root, "lesson-lan/identity.json"), "utf8"); assert.ok(!persisted.includes(token));
		assert.equal((await request("GET", "/v1/lessons", undefined, { Origin: "https://evil.test" })).status, 403);
		assert.equal((await request("GET", "/api/chats")).status, 404);
		const bytes = archive(source), sha = lanHash(bytes);
		const preview = () => request("POST", "/v1/preview", bytes, { "Content-Type": "application/zip" });
		const p = (await preview()).json(); assert.equal(p.chats[0].kind, "new"); assert.equal(p.blockers.length, 0);
		const operation = randomUUID();
		const headers = { "Content-Type": "application/zip", "X-Transfer-Sha": sha, "X-Transfer-Revision": p.revision, "X-Transfer-Choices": "{}" };
		busy = true; assert.equal((await request("POST", `/v1/import/${operation}`, bytes, headers)).status, 409); busy = false;
		const interrupted = randomUUID();
		await new Promise<void>((resolve, reject) => {
			const req = https.request({ hostname: "127.0.0.1", port: lan.status().port, path: `/v1/import/${interrupted}`, method: "POST", ca: identity.cert, agent: false,
				checkServerIdentity: (_, peer) => lanHash(peer.raw) === fingerprint ? undefined : new Error("pin mismatch"),
				headers: { Authorization: `Bearer ${token}`, ...headers, "Content-Length": bytes.length } });
			let aborting = false;
			req.on("error", e => { if (!aborting) reject(e); }); req.on("close", resolve);
			req.on("socket", socket => socket.once("secureConnect", () => req.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => { aborting = true; req.destroy(); })));
		});
		assert.equal((await request("GET", `/v1/receipts/${interrupted}`)).status, 404); assert.equal(changes, 0);
		assert.ok(!fs.existsSync(path.join(root, "chats/chat_lan.json")));
		await assert.rejects(request("POST", `/v1/import/${operation}`, bytes, headers, fingerprint, true), /Lost acknowledgement/); assert.equal(changes, 1);
		// An edited destination after commit must not be rolled back by a lost-response retry.
		const installed = fs.readFileSync(path.join(root, "chats/chat_lan.json"));
		write(root, "chats/chat_lan.json", JSON.stringify(record("Later learner history")));
		const replay = await request("POST", `/v1/import/${operation}`, bytes, headers); assert.equal(replay.status, 200); assert.equal(changes, 1);
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "chats/chat_lan.json"), "utf8")).messages[0].content, "Later learner history");
		assert.equal((await request("POST", `/v1/import/${operation}`, bytes, { ...headers, "X-Transfer-Sha": "0".repeat(64) })).status, 409);
		assert.equal((await request("GET", `/v1/receipts/${operation}`)).json().installed[0], "chat_lan");
		const conflict = (await preview()).json(); assert.equal(conflict.chats[0].kind, "conflict");
		assert.equal((await request("POST", `/v1/import/${randomUUID()}`, bytes, { ...headers, "X-Transfer-Revision": conflict.revision })).status, 409);
		assert.equal((await request("POST", `/v1/import/${randomUUID()}`, bytes, { ...headers, "X-Transfer-Revision": conflict.revision, "X-Transfer-Choices": '{"chat_lan":"incoming"}' })).status, 200);
		assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_lan.json")), installed);
		const exported = await request("POST", "/v1/export", Buffer.from('{"ids":["chat_lan"]}'), { "Content-Type": "application/json" });
		assert.equal(exported.status, 200); assert.deepEqual(unzipSync(exported.bytes), unzipSync(bytes)); // ZIP header timestamps are not native payload.
		assert.equal((await request("POST", "/v1/preview", Buffer.from("not a package"), { "Content-Type": "application/zip" })).status, 409);
		const port = status.port; await lan.stop(); assert.equal(lan.status().enabled, false);
		lan = createLessonLan(root, deps); await lan.start("127.0.0.1"); status = lan.status(); assert.equal(status.port, port); assert.equal(status.devices[0]!.online, false);
		assert.equal((await request("GET", `/v1/receipts/${operation}`)).status, 200);
		lan.revoke(status.devices[0]!.id); assert.equal((await request("GET", "/v1/lessons")).status, 401);
	} finally { await lan.stop(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(source, { recursive: true, force: true }); }
});

test("receipt participates in installer rollback and blocks unsafe peers and paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-receipt-")), source = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-source-"));
	try {
		const bytes = archive(source), peer = randomUUID(), operation = randomUUID(), approval = { revision: previewImport(root, bytes).revision, choices: {}, receipt: { peer, operation, requestHash: "a".repeat(64) } };
		assert.throws(() => installImport(root, bytes, approval, () => { throw new Error("Injected failure"); })); recoverTransfers(root);
		assert.equal(lanReceipt(root, peer, operation), undefined); assert.ok(!fs.existsSync(path.join(root, "chats/chat_lan.json")));
		installImport(root, bytes, approval); assert.equal(lanReceipt(root, peer, operation)?.installed[0], "chat_lan");
		assert.throws(() => lanReceipt(root, "../", operation));
		for (const ip of ["8.8.8.8", "169.254.1.1", "192.168.1.999", "10.01.1.1", "::1", "host.local"]) assert.equal(privateLanAddress(ip), false, ip);
		for (const ip of ["192.168.1.1", "10.0.2.2", "172.16.0.1", "::ffff:192.168.1.2"]) assert.equal(privateLanAddress(ip), true, ip);
	} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(source, { recursive: true, force: true }); }
});
