import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { X509Certificate, createPrivateKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { toDataURL } from "qrcode";
import type { ImportChoices } from "../core/contracts/chat.ts";
import { EXPORT_LIMIT, previewExport, downloadExport, parseTransferJson } from "../store/lesson-export.ts";
import { installImport, previewImport, readImportPackage } from "../store/lesson-import.ts";
import { loadLanIdentity, saveLanIdentity, lanReceipt, lanHash, type LanIdentity } from "../store/lesson-lan.ts";

const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// ponytail: IPv4 LAN only; add IPv6 discovery/address handling when needed.
export function privateLanAddress(ip: string): boolean {
	const parts = ip.replace(/^::ffff:/, "").split(".");
	if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || +p > 255)) return false;
	const [a, b] = parts.map(Number);
	return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || ip === "127.0.0.1";
}
export function lanAddresses(): string[] {
	return [...new Set(Object.values(networkInterfaces()).flatMap(rows => rows ?? [])
		.filter(row => row.family === "IPv4" && !row.internal && privateLanAddress(row.address)).map(row => row.address))];
}
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const declared = request.headers["content-length"];
	if (declared && (!/^\d+$/.test(declared) || +declared > limit)) throw new Error("Request too large");
	const chunks: Buffer[] = []; let length = 0;
	for await (const chunk of request) {
		length += chunk.length; if (length > limit) throw new Error("Request too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
export function createLessonLan(root: string, deps: {
	name: string;
	lessons: () => { id: string; title: string }[];
	idle: (ids: string[], importing: boolean) => void;
	changed: (ids: string[]) => void;
}) {
	let identity: LanIdentity | undefined, server: Server | undefined, starting: Promise<void> | undefined;
	let pairing: { key: string; expires: number } | undefined;
	let active = 0;
	const seen = new Map<string, number>();
	const fingerprint = () => lanHash(new X509Certificate(identity!.cert).raw);
	const info = () => ({ id: identity!.id, name: deps.name.split(" · ")[0]! });
	const reply = (res: ServerResponse, status: number, data: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(JSON.stringify(data));
	};
	async function handle(req: IncomingMessage, res: ServerResponse) {
		// No browser access, redirects, arbitrary URLs, paths or generic application proxying.
		if (!privateLanAddress(req.socket.remoteAddress ?? "") || req.headers.origin || req.headers["sec-fetch-site"]) { reply(res, 403, { error: "LAN client required" }); return; }
		const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
		if (!token) { reply(res, 401, { error: "Pair this device first" }); return; }
		const tokenHash = lanHash(token), device = identity!.devices.find(d => equal(d.tokenHash, tokenHash));
		if (req.method === "POST" && req.url === "/v1/pair") {
			if (device) { seen.set(device.id, performance.now()); reply(res, 200, info()); return; } // Reconcile a lost pairing acknowledgement.
			const key = req.headers["x-pairing-key"];
			if (!pairing || Date.now() >= pairing.expires || typeof key !== "string" || !equal(pairing.key, key) || identity!.devices.length >= 16) {
				reply(res, 403, { error: "Show a fresh QR in LearnHarness" }); return;
			}
			const data = parseTransferJson(await readBody(req, 1024)) as { name?: unknown };
			if (!data || typeof data.name !== "string" || !data.name.trim() || data.name.length > 100 || /[\x00-\x1f]/.test(data.name)) throw new Error("Invalid name");
			// Recheck after body IO: QR consumption, stop and revocation can interleave with reads.
			if (!server?.listening || !pairing || !equal(pairing.key, key) || Date.now() >= pairing.expires) throw new Error("Pairing changed");
			const next = { ...identity!, devices: [...identity!.devices, { id: randomUUID(), name: data.name, tokenHash }] };
			saveLanIdentity(root, next); identity = next; pairing = undefined;
			seen.set(next.devices.at(-1)!.id, performance.now());
			reply(res, 200, info()); return;
		}
		if (!device) { reply(res, 401, { error: "Access revoked or device not paired" }); return; }
		seen.set(device.id, performance.now());
		if (req.method === "GET" && req.url === "/v1/status") { reply(res, 200, info()); return; }
		const authorized = () => { if (!server?.listening || !identity!.devices.some(d => d.id === device.id)) throw new Error("Access revoked"); };
		if (req.method === "GET" && req.url === "/v1/lessons") {
			const lessons = deps.lessons(); if (lessons.length > 10000) throw new Error("Library listing limit");
			reply(res, 200, { ...info(), lessons }); return;
		}
		const receiptMatch = req.url?.match(/^\/v1\/receipts\/([a-f0-9-]{36})$/);
		if (req.method === "GET" && receiptMatch) {
			const receipt = lanReceipt(root, device.id, receiptMatch[1]!);
			reply(res, receipt ? 200 : 404, receipt ?? { error: "No committed receipt" }); return;
		}
		if (req.method === "POST" && req.url === "/v1/export") {
			const data = parseTransferJson(await readBody(req, 65536)) as { ids?: unknown };
			if (!data || !Array.isArray(data.ids) || data.ids.length < 1 || data.ids.length > 100 || data.ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new Error("Invalid selection");
			authorized(); deps.idle(data.ids as string[], false);
			const preview = previewExport(root, data.ids as string[]);
			const file = downloadExport(root, data.ids as string[], "zip", { revision: preview.revision, files: [] });
			// Source registries are unsupported by the receiver too; fail before sending them.
			readImportPackage(file.bytes);
			res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": file.bytes.length, "Cache-Control": "no-store" }); res.end(file.bytes); return;
		}
		const installMatch = req.url?.match(/^\/v1\/import\/([a-f0-9-]{36})$/);
		if (req.method === "POST" && (req.url === "/v1/preview" || installMatch)) {
			if (req.headers["content-type"] !== "application/zip") throw new Error("ZIP required");
			let approval: { revision: string; choices: ImportChoices; receipt: { peer: string; operation: string; requestHash: string } } | undefined;
			if (installMatch) {
				const revision = req.headers["x-transfer-revision"], raw = req.headers["x-transfer-choices"], sha = req.headers["x-transfer-sha"];
				if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || typeof raw !== "string" || raw.length > 32768 || typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Missing approval");
				const choices = parseTransferJson(Buffer.from(raw)) as ImportChoices;
				if (!choices || typeof choices !== "object" || Array.isArray(choices) || Object.entries(choices).some(([k, v]) => !/^[A-Za-z0-9_-]{1,200}$/.test(k) || !["local", "incoming"].includes(v))) throw new Error("Invalid choices");
				const requestHash = lanHash(JSON.stringify([sha, revision, Object.entries(choices).sort()]));
				const previous = lanReceipt(root, device.id, installMatch[1]!);
				if (previous) { req.resume(); reply(res, previous.requestHash === requestHash ? 200 : 409, previous.requestHash === requestHash ? previous : { error: "Operation already used" }); return; }
				approval = { revision, choices, receipt: { peer: device.id, operation: installMatch[1]!, requestHash } };
			}
			const bytes = await readBody(req, EXPORT_LIMIT);
			authorized();
			const pack = readImportPackage(bytes); deps.idle(pack.chats.map(c => c.record.id), true);
			if (!approval) { reply(res, 200, previewImport(root, bytes)); return; }
			if (pack.sha !== req.headers["x-transfer-sha"]) throw new Error("Package changed");
			// Synchronous writer gate + installer + receipt journal share one commit boundary.
			const result = installImport(root, bytes, approval); deps.changed(result.installed);
			reply(res, 200, result); return;
		}
		reply(res, 404, { error: "Unknown LAN operation" });
	}
	return {
		async start(bind = "0.0.0.0") {
			if (starting) return starting;
			if (server?.listening) return;
			starting = (async () => {
				identity ??= await loadLanIdentity(root);
				if (!new X509Certificate(identity.cert).checkPrivateKey(createPrivateKey(identity.privateKey))) throw new Error("Invalid TLS identity");
				const next = createServer({ cert: identity.cert, key: identity.privateKey, minVersion: "TLSv1.2", maxHeaderSize: 65536 }, (req, res) => {
					if (active >= 2) { reply(res, 429, { error: "Another transfer is active" }); return; }
					active++; let finished = false;
					const done = () => { if (!finished) { finished = true; active--; } };
					res.on("finish", done); res.on("close", done);
					void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 409, { error: "Transfer refused. Reconnect or select lessons again; the library may have changed or the package is unsupported." }); else res.destroy(); });
				});
				next.maxConnections = 16;
				next.requestTimeout = 60000; next.headersTimeout = 10000; next.keepAliveTimeout = 1000; next.maxHeadersCount = 32;
				await new Promise<void>((resolve, reject) => { next.once("error", reject); next.listen(identity!.port, bind, () => { next.removeListener("error", reject); resolve(); }); });
				try {
					identity.port = (next.address() as { port: number }).port; saveLanIdentity(root, identity);
					server = next;
				} catch (error) { next.close(); throw error; }
			})();
			try { await starting; } finally { starting = undefined; }
		},
		async stop() {
			if (starting) await starting;
			pairing = undefined; seen.clear();
			const previous = server; server = undefined;
			if (previous) { previous.closeAllConnections(); await new Promise<void>(resolve => previous.close(() => resolve())); }
		},
		status() { return { enabled: !!server?.listening, addresses: lanAddresses(), port: identity?.port,
			pairingActive: !!pairing && Date.now() < pairing.expires,
			devices: identity?.devices.map(({ id, name }) => ({ id, name: name.replace(/^Reasoned · /, ""),
				online: !!server?.listening && performance.now() - (seen.get(id) ?? -Infinity) < 3000 })) ?? [] }; },
		async pairing(address: string) {
			const bound = server?.address();
			if (!server?.listening || (!lanAddresses().includes(address) && !(address === "127.0.0.1" && typeof bound === "object" && bound?.address === "127.0.0.1"))) throw new Error("Choose a local network address");
			pairing = { key: secret(), expires: Date.now() + 5 * 60000 };
			const url = new URL("learnharness-lan://pair");
			for (const [k, v] of Object.entries({ host: address, port: String(identity!.port), sha256: fingerprint(), key: pairing.key })) url.searchParams.set(k, v);
			return { connection: url.href, qr: await toDataURL(url.href, { margin: 2, width: 320 }), expires: pairing.expires };
		},
		revoke(id: string) {
			if (!identity) throw new Error("Enable LAN first");
			const next = { ...identity, devices: identity.devices.filter(d => d.id !== id) };
			saveLanIdentity(root, next); identity = next; seen.delete(id);
		},
	};
}
