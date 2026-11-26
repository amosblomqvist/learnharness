"use strict";

// PHONE ACCESS: a desktop-owned HTTPS gateway that lets paired phones use this
// computer's LearnHarness. It is never a second learning server: every
// authorized request is forwarded to the app's own loopback server, carrying
// the desktop capability that the gateway (not the phone) holds.
//
//   phone ──TLS (pinned self-signed cert)──▶ gateway :4399 ──▶ 127.0.0.1:<app>
//
// Pairing (docs/phone-access.md) is by QR code only: learnharness://pair?…
// carries the address, the certificate fingerprint and a one-time code
// (128 bits, 5 minutes), so the fingerprint reaches the phone through the
// camera. The phone receives a device token (stored here only as a hash)
// that works until revoked. Bonjour only lets a paired phone find this
// computer again after its address changes; it never pairs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { loadIdentity } = require("./phone-access-cert.cjs");

const DEFAULT_PORT = 4399;
const WELL_KNOWN = "/.well-known/learnharness/";
const DEVICE_COOKIE = "lh_device";
const CODE_TTL_MS = 5 * 60 * 1000;
const SEEN_WRITE_MS = 5 * 60 * 1000;
const PAIR_LIMIT = 10; // attempts per address per minute
const MAX_BODY = 4096;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
// Headers a phone must never be able to set on the forwarded request.
const STRIPPED = /^(?:authorization|forwarded|x-forwarded-.*|x-real-ip|x-learnharness-.*|x-middleware-.*|x-nextjs-.*)$/;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
function sameSecret(a, b) {
	const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
	return crypto.timingSafeEqual(x, y);
}

function readJSON(file, fallback) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(value, null, "\t") + "\n", { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/** A device name from the phone: printable, 1–64 characters. */
function cleanDeviceName(value) {
	const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64) : "";
	return name || "Phone";
}

/** Non-internal IPv4 addresses, private ranges first; never link-local. */
function lanAddresses(interfaces = os.networkInterfaces()) {
	const all = Object.values(interfaces).flat().filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."));
	const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
	return [...new Set(all.map((i) => i.address))].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

function cookieValue(header, name) {
	for (const pair of (header ?? "").split(";")) {
		const eq = pair.indexOf("=");
		if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
	}
	return undefined;
}
function withoutCookie(header, name) {
	const kept = (header ?? "").split(";").map((p) => p.trim()).filter((p) => p && p.slice(0, p.indexOf("=")).trim() !== name);
	return kept.length ? kept.join("; ") : undefined;
}

function sendJSON(response, status, value) {
	if (response.headersSent) return response.destroy();
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		if ((request.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") return reject(Object.assign(new Error("Expected JSON."), { status: 415 }));
		let size = 0; const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large."), { status: 413 })); request.destroy(); return; }
			chunks.push(chunk);
		});
		request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(Object.assign(new Error("Invalid JSON."), { status: 400 })); } });
		request.on("error", reject);
	});
}

/**
 * @param {object} options
 * @param {string} options.directory  private state directory (identity, devices, settings)
 * @param {() => ({ origin: string, secret: string | null } | null)} options.upstream  the app's loopback server
 * @param {(service: { name: string, port: number, txt: Record<string, string> }) => { stop(): void }} [options.advertise]  Bonjour
 * @param {() => void} [options.onChange]
 */
function createPhoneAccess({ directory, upstream, advertise = () => ({ stop() {} }), onChange = () => {}, port = DEFAULT_PORT, host = "0.0.0.0", computerName = os.hostname().replace(/\.local$/i, ""), appVersion = "0", now = Date.now, addresses = lanAddresses }) {
	const settingsFile = path.join(directory, "state.json"), devicesFile = path.join(directory, "devices.json");
	let identity = null, server = null, advert = null, error = null, enabled = readJSON(settingsFile, {}).enabled === true;
	/** @type {{ id: string, name: string, tokenHash: string, createdAt: number, lastSeenAt: number }[]} */
	let devices = (readJSON(devicesFile, {}).devices ?? []).filter((d) => d && typeof d.id === "string" && typeof d.tokenHash === "string");
	let code = null; // { value, expiresAt }
	const attempts = new Map(); // address → { count, since }
	const sockets = new Map(); // deviceId → Set<socket>
	const seenWritten = new Map();

	const saveDevices = () => writeJSON(devicesFile, { version: 1, devices });
	const changed = () => { try { onChange(); } catch { /* listener errors never break the gateway */ } };

	function freshCode() {
		code = { value: crypto.randomBytes(16).toString("base64url"), expiresAt: now() + CODE_TTL_MS };
		return code;
	}
	function currentCode() { return code && code.expiresAt > now() ? code : freshCode(); }

	function addDevice(deviceName) {
		const secret = token();
		const device = { id: crypto.randomBytes(8).toString("hex"), name: cleanDeviceName(deviceName), tokenHash: sha256(secret), createdAt: now(), lastSeenAt: now() };
		devices.push(device); saveDevices(); changed();
		return { token: secret, deviceId: device.id };
	}
	function deviceFor(request) {
		const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
		const supplied = bearer ?? cookieValue(request.headers.cookie, DEVICE_COOKIE);
		if (!supplied) return null;
		const hash = sha256(supplied);
		return devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(hash))) ?? null;
	}
	function touch(device, socket) {
		device.lastSeenAt = now();
		if (now() - (seenWritten.get(device.id) ?? 0) > SEEN_WRITE_MS) { seenWritten.set(device.id, now()); saveDevices(); }
		let set = sockets.get(device.id);
		if (!set) sockets.set(device.id, (set = new Set()));
		if (!set.has(socket)) { set.add(socket); socket.once("close", () => set.delete(socket)); }
	}
	function limited(address) {
		const entry = attempts.get(address);
		if (!entry || now() - entry.since > 60_000) { attempts.set(address, { count: 1, since: now() }); return false; }
		entry.count++;
		return entry.count > PAIR_LIMIT;
	}

	// ─── Unauthenticated pairing endpoints ──────────────────────────────────
	async function wellKnown(request, response, route) {
		const address = request.socket.remoteAddress ?? "unknown";
		if (route === "info" && request.method === "GET") {
			return sendJSON(response, 200, { app: "LearnHarness", version: appVersion, name: computerName });
		}
		if (route === "unpair" && request.method === "POST") {
			const device = deviceFor(request);
			if (!device) return sendJSON(response, 401, { error: "This phone is not paired." });
			revoke(device.id);
			return sendJSON(response, 200, { ok: true });
		}
		if (!route.startsWith("pair/")) return sendJSON(response, 404, { error: "Not found." });
		if (limited(address)) return sendJSON(response, 429, { error: "Too many pairing attempts. Wait a minute." });
		if (route === "pair/qr" && request.method === "POST") {
			const body = await readBody(request);
			const active = code && code.expiresAt > now() ? code : null;
			if (!active || typeof body.code !== "string" || !sameSecret(body.code, active.value)) return sendJSON(response, 403, { error: "This pairing code is invalid or expired. Show a new QR code on the computer." });
			freshCode(); // one use
			return sendJSON(response, 200, addDevice(body.deviceName));
		}
		return sendJSON(response, 404, { error: "Not found." });
	}

	// ─── Forwarding ─────────────────────────────────────────────────────────
	/** Request headers for the loopback server, or a refusal message. */
	function forwardHeaders(request, target) {
		const listed = new Set((request.headers.connection ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean));
		const headers = {};
		for (const [name, value] of Object.entries(request.headers)) {
			if (HOP.has(name) || listed.has(name) || STRIPPED.test(name) || name === "referer") continue;
			headers[name] = value;
		}
		const cookie = withoutCookie(request.headers.cookie, DEVICE_COOKIE);
		if (cookie) headers.cookie = cookie; else delete headers.cookie;
		headers.host = target.host;
		// Same-origin from the phone's point of view becomes same-origin for the
		// loopback server; anything cross-site is refused here.
		const gatewayOrigin = `https://${request.headers.host}`;
		if (request.headers["sec-fetch-site"] === "cross-site" || request.headers["sec-fetch-site"] === "same-site") return { refusal: "Cross-site requests are not allowed." };
		if (request.headers.origin !== undefined) {
			if (request.headers.origin !== gatewayOrigin) return { refusal: "Cross-site requests are not allowed." };
			headers.origin = target.origin;
		}
		return { headers };
	}
	function upstreamTarget() {
		const value = upstream();
		return value ? { ...value, url: new URL(value.origin) } : null;
	}

	function handle(request, response) {
		const pathname = (() => { try { return new URL(request.url, "https://gateway").pathname; } catch { return null; } })();
		if (!pathname) return sendJSON(response, 400, { error: "Bad request." });
		if (pathname.startsWith(WELL_KNOWN)) {
			return void wellKnown(request, response, pathname.slice(WELL_KNOWN.length)).catch((e) => sendJSON(response, e.status ?? 500, { error: e.status ? e.message : "Pairing failed." }));
		}
		const device = deviceFor(request);
		if (!device) return sendJSON(response, 401, { error: "This phone is not paired with this computer." });
		touch(device, request.socket);
		const target = upstreamTarget();
		if (!target) return sendJSON(response, 503, { error: "LearnHarness is starting. Try again shortly." });
		const forwarded = forwardHeaders(request, target.url);
		if (forwarded.refusal) return sendJSON(response, 403, { error: forwarded.refusal });
		const headers = forwarded.headers;
		const api = pathname === "/api" || pathname.startsWith("/api/");
		if (api && target.secret) headers["x-learnharness-desktop"] = target.secret;
		const proxy = http.request(new URL(request.url, target.url), { method: request.method, headers }, (incoming) => {
			const out = {};
			for (const [name, value] of Object.entries(incoming.headers)) if (!HOP.has(name)) out[name] = value;
			// Absolute redirects to the loopback server stay on the gateway.
			if (typeof out.location === "string" && out.location.startsWith(target.url.origin)) out.location = out.location.slice(target.url.origin.length) || "/";
			out["referrer-policy"] = "no-referrer";
			response.writeHead(incoming.statusCode ?? 502, out);
			incoming.pipe(response);
		});
		proxy.on("error", () => sendJSON(response, 502, { error: "LearnHarness is reconnecting. Try again shortly." }));
		response.on("close", () => proxy.destroy());
		request.pipe(proxy);
	}

	function upgrade(request, socket, head) {
		socket.on("error", () => socket.destroy());
		const device = deviceFor(request), target = upstreamTarget();
		if (!device || !target) return socket.destroy();
		const forwarded = forwardHeaders(request, target.url);
		if (forwarded.refusal) return socket.destroy();
		touch(device, socket);
		const headers = { ...forwarded.headers, connection: "upgrade", upgrade: request.headers.upgrade };
		const proxy = http.request(new URL(request.url, target.url), { headers });
		proxy.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
			const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
			for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
			socket.write(lines.join("\r\n") + "\r\n\r\n");
			if (upstreamHead?.length) socket.write(upstreamHead);
			if (head?.length) upstreamSocket.write(head);
			upstreamSocket.pipe(socket).pipe(upstreamSocket);
			upstreamSocket.on("error", () => socket.destroy()); socket.on("close", () => upstreamSocket.destroy());
		});
		proxy.on("response", () => socket.destroy()); proxy.on("error", () => socket.destroy());
		proxy.end();
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────
	async function start() {
		if (server) return status();
		error = null;
		identity = loadIdentity(path.join(directory, "identity"), { commonName: `LearnHarness on ${computerName}` });
		const candidate = https.createServer({ key: identity.key, cert: identity.cert, requestTimeout: 0, headersTimeout: 15_000, maxHeaderSize: 16_384 }, handle);
		candidate.on("upgrade", upgrade);
		candidate.on("connection", (socket) => socket.setKeepAlive(true, 30_000));
		try {
			await new Promise((resolve, reject) => { candidate.once("error", reject); candidate.listen(port, host, () => { candidate.off("error", reject); resolve(); }); });
		} catch (cause) {
			error = cause?.code === "EADDRINUSE" ? `Port ${port} is already in use by another program. Phone access needs this port so paired phones can find this computer.` : `Phone access could not start: ${cause?.message ?? cause}`;
			changed();
			return status();
		}
		server = candidate;
		try { advert = advertise({ name: `LearnHarness on ${computerName}`, port, txt: { v: "1", fp: identity.fingerprint.slice(0, 16), ver: appVersion } }); } catch { advert = null; }
		changed();
		return status();
	}
	async function stop() {
		try { advert?.stop(); } catch { /* best effort */ }
		advert = null;
		const closing = server;
		server = null;
		if (closing) {
			for (const set of sockets.values()) for (const socket of set) socket.destroy();
			closing.closeAllConnections?.();
			await new Promise((resolve) => closing.close(() => resolve()));
		}
		changed();
	}
	async function setEnabled(value) {
		enabled = value === true;
		writeJSON(settingsFile, { enabled });
		if (enabled) await start(); else { error = null; await stop(); }
		return status();
	}
	function revoke(id) {
		const before = devices.length;
		devices = devices.filter((d) => d.id !== id);
		if (devices.length === before) return false;
		saveDevices();
		for (const socket of sockets.get(id) ?? []) socket.destroy();
		sockets.delete(id);
		changed();
		return true;
	}
	function status() {
		const running = !!server;
		const hosts = running ? addresses() : [];
		const active = running ? currentCode() : null;
		const listening = server?.address()?.port ?? port;
		const link = running && hosts.length ? `learnharness://pair?v=1&h=${hosts.map(encodeURIComponent).join(",")}&p=${listening}&f=${identity.fingerprint}&c=${active.value}&n=${encodeURIComponent(computerName)}` : null;
		return {
			enabled, running, error, port: listening, addresses: hosts,
			pairingLink: link, codeExpiresAt: active?.expiresAt ?? null,
			devices: devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt, connected: (sockets.get(id)?.size ?? 0) > 0 })),
		};
	}
	return {
		start, stop, setEnabled, revoke, status,
		startIfEnabled: () => (enabled ? start() : Promise.resolve(status())),
		newCode: () => { freshCode(); changed(); return status(); },
		get port() { return server?.address()?.port ?? port; },
	};
}

module.exports = { createPhoneAccess, lanAddresses, cleanDeviceName };
