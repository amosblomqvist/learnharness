"use strict";

// A desktop-owned gateway, never a second learning server or credential owner.
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomBytes } = require("node:crypto");
const exec = promisify(execFile);
const LOCAL_PORT = 4397;
const HTTPS_PORT = 9443;
const TARGET = `http://127.0.0.1:${LOCAL_PORT}`;
// DNS-independent link: Tailscale forwards raw TCP with a PROXY v1 header
// naming the visiting tailnet address (same scheme as Budget Terminal).
const DIRECT_LOCAL_PORT = 4398;
const DIRECT_PORT = 9081;
const DIRECT_TARGET = `127.0.0.1:${DIRECT_LOCAL_PORT}`;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function isTailnetIPv4(address) {
	if (!net.isIPv4(address)) return false;
	const [first, second] = address.split(".").map(Number);
	return first === 100 && second >= 64 && second <= 127;
}

function tailnetFrom(status, serve) {
	const self = status?.Self;
	const name = self?.DNSName?.replace(/\.$/, "").toLowerCase();
	const login = status?.User?.[self?.UserID]?.LoginName;
	if (status?.BackendState !== "Running" || !name || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name) || !login || self.Tags?.length) return null;
	const authority = `${name}:${HTTPS_PORT}`;
	const isPrivate = port => !Object.entries(serve?.AllowFunnel ?? {}).some(([host, allowed]) => allowed && host.endsWith(`:${port}`)) &&
		!Object.values(serve?.Foreground ?? {}).some(value => Object.hasOwn(value.TCP ?? {}, port));
	const serving = serve?.TCP?.[HTTPS_PORT]?.HTTPS === true && serve?.Web?.[authority]?.Handlers?.["/"]?.Proxy === TARGET && isPrivate(HTTPS_PORT);
	/** @type {{ origin: string, login: string, serving: boolean, direct?: { origin: string, address: string, owners: Set<string> } }} */
	const result = { origin: `https://${authority}`, login, serving };
	const address = self.TailscaleIPs?.find(isTailnetIPv4);
	const direct = serve?.TCP?.[DIRECT_PORT];
	if (address && direct?.TCPForward === DIRECT_TARGET && direct.ProxyProtocol === 1 && isPrivate(DIRECT_PORT)) {
		// Same-account, untagged, unexpired devices only; checked on every request.
		const owners = [self, ...Object.values(status.Peer ?? {})]
			.filter(node => node.UserID === self.UserID && !node.Tags?.length && node.Expired !== true)
			.flatMap(node => node.TailscaleIPs?.filter(isTailnetIPv4) ?? []);
		result.direct = { origin: `http://${address}:${DIRECT_PORT}`, address, owners: new Set(owners) };
	}
	return result;
}

/** Accept only tailscaled's loopback forwarder: the first line must be a PROXY v1
 * header from a same-account tailnet address to this PC. Anything else is dropped
 * before a single HTTP byte is parsed. */
function startDirect(getRoute, handoff) {
	const sockets = new Set();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		const close = () => socket.destroy();
		socket.setTimeout(3000, close);
		let input;
		const read = chunk => {
			if (input) chunk = Buffer.concat([input, chunk]);
			const end = chunk.indexOf("\r\n");
			if (end < 0 && chunk.length <= 107) { input = chunk; return; }
			if (end < 0 || end > 105) return close();
			const header = /^PROXY TCP4 ([\d.]+) ([\d.]+) ([1-9]\d{0,4}) (\d+)$/.exec(chunk.toString("latin1", 0, end));
			const route = getRoute();
			if (!header || !route || header[2] !== route.address || !route.owners.has(header[1]) || Number(header[3]) > 65535 || Number(header[4]) !== socket.localPort) return close();
			socket.pause();
			socket.off("data", read);
			socket.off("timeout", close);
			socket.setTimeout(0);
			socket.unshift(chunk.subarray(end + 2));
			handoff(socket, header[1]);
			socket.resume();
		};
		socket.on("data", read);
	});
	server.maxConnections = 128;
	return { server, sockets };
}

async function readTailnet() {
	const executable = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:/Program Files", "Tailscale", "tailscale.exe") : process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
	const run = async args => JSON.parse((await exec(executable, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout || "{}");
	return tailnetFrom(await run(["status", "--json"]), await run(["serve", "status", "--json"]));
}

/** Authorize before *any* HTML, API, upload, stream, or websocket is forwarded.
 * Tailscale injects identity at its loopback proxy. Never listen on the LAN. */
function requestOrigin(request, tailnet, localOrigin, previewToken, directSource) {
	if (localOrigin) return request.headers.host === new URL(localOrigin).host && request.headers["x-learnharness-preview"] === previewToken ? localOrigin : null;
	if (directSource) {
		const route = tailnet?.direct;
		return route?.owners.has(directSource) && request.headers.host === new URL(route.origin).host ? route.origin : null;
	}
	return tailnet?.serving && request.headers.host === new URL(tailnet.origin).host && request.headers["tailscale-user-login"] === tailnet.login && request.headers["x-forwarded-proto"] === "https" ? tailnet.origin : null;
}
function sameOrigin(request, origin) {
	const supplied = request.headers.origin;
	return request.headers["sec-fetch-site"] !== "cross-site" && (!supplied || supplied === origin);
}
function forwardHeaders(headers, upstream, desktopSecret) {
	const connection = new Set(String(headers.connection || "").toLowerCase().split(",").map(value => value.trim()));
	const clean = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HOP.has(name) && !connection.has(name) && !/^(?:x-forwarded-|tailscale-|x-learnharness-(?:desktop|preview))/.test(name)) clean[name] = value;
	}
	clean.host = upstream.host;
	if (clean.origin) clean.origin = upstream.origin;
	if (clean.referer) clean.referer = `${upstream.origin}/`;
	if (desktopSecret) clean["x-learnharness-desktop"] = desktopSecret;
	return clean;
}
function json(response, value, status = 200) {
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
	response.end(JSON.stringify(value));
}
async function commandBody(request) {
	if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Expected JSON.");
	const chunks = []; let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > 16384) throw new Error("Request too large.");
		chunks.push(chunk);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command.");
	return value;
}

function createMobileAccess({ app, BrowserWindow, session, origin, directory, desktopSecret, appearance, nativeControl, updateControl, openWebBrowser, openExternal = () => {}, readTailnet: read = readTailnet, port = LOCAL_PORT, directPort = DIRECT_LOCAL_PORT }) {
	const upstream = new URL(origin);
	const setting = path.join(directory, "mobile-access.json");
	let enabled = false, tailnet = null, issue = "", directIssue = "", remoteServer, direct, previewServer, previewWindow, localOrigin, refreshing, timer;
	let queue = Promise.resolve();
	const sockets = new Set();
	/** Sockets that arrived through the PROXY-protocol listener, keyed to the visiting tailnet address. */
	const directSources = new WeakMap();
	const previewToken = randomBytes(32).toString("hex");
	const directUrl = () => enabled && direct && tailnet?.direct ? tailnet.direct.origin : null;
	const status = () => ({ available: true, enabled, remote: false, serving: !!remoteServer && !!tailnet?.serving, url: tailnet?.origin ?? null, directUrl: directUrl(),
		message: issue || (enabled ? tailnet?.serving || directUrl() ? `Ready. Connect your iPhone to the same Tailscale account.${directIssue ? ` ${directIssue}` : ""}` : directIssue || "Set up a Tailscale link, then check the connection." : "Enable Mobile Access while using LearnHarness on your phone."),
		setupCommand: `tailscale serve --bg --https=${HTTPS_PORT} ${TARGET}`, directSetupCommand: `tailscale serve --bg --tcp=${DIRECT_PORT} --proxy-protocol=1 tcp://${DIRECT_TARGET}`,
		transport: desktopSecret ? "desktop" : "web" });
	const disconnect = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); if (direct) { for (const socket of direct.sockets) socket.destroy(); } };
	/** Open streams follow their own link: a removed device or a stopped HTTPS link closes them, not just new requests. */
	const prune = () => { for (const socket of sockets) { const source = directSources.get(socket); if (source ? !tailnet?.direct?.owners.has(source) : !tailnet?.serving) socket.destroy(); } };
	async function startDirectListener() {
		const listener = startDirect(() => tailnet?.direct, (socket, source) => { directSources.set(socket, source); remoteServer?.emit("connection", socket); });
		try { await listen(listener.server, directPort); }
		catch { directIssue = `The direct link could not open local port ${directPort}. Close its other listener, then turn Mobile Access off and on.`; return; }
		directIssue = ""; direct = listener;
	}
	function stopDirectListener() {
		if (!direct) return;
		direct.server.close(); for (const socket of direct.sockets) socket.destroy();
		direct = undefined;
	}
	async function refresh() {
		refreshing ??= (async () => {
			try {
				const next = await read();
				if (tailnet && (tailnet.origin !== next?.origin || tailnet.login !== next?.login || tailnet.direct?.origin !== next?.direct?.origin)) disconnect();
				tailnet = next;
				prune();
				issue = next ? "" : "Connect this PC to Tailscale with your personal account, then check again.";
			} catch { tailnet = null; issue = "Could not check Tailscale. Open Tailscale on the PC and connect, then check again."; disconnect(); }
		})().finally(() => { refreshing = undefined; });
		await refreshing;
		return status();
	}
	async function gatewayControl(request, response, pathname) {
		if (pathname === "/api/mobile-access") {
			if (request.method === "GET") return json(response, { ...status(), remote: true });
			if (request.method !== "POST") return json(response, { error: "Unsupported method." }, 405);
			const command = await commandBody(request);
			if (command.op === "refresh") return json(response, { ...await refresh(), remote: true });
			if (command.op === "enable" && typeof command.enabled === "boolean") {
				// Persist successfully before acknowledging, then close the client's
				// socket only after its response has been delivered.
				const updated = await setEnabled(command.enabled, true);
				if (!command.enabled) response.once("finish", disconnect);
				return json(response, { ...updated, remote: true });
			}
			return json(response, { error: "Use Mobile Access in the desktop app to open a phone viewport." }, 400);
		}
		if (pathname === "/api/mobile-host") {
			if (request.method !== "POST") return json(response, { error: "Unsupported method." }, 405);
			const command = await commandBody(request);
			if (command.kind === "browser" && openWebBrowser) { await openWebBrowser(command.action); return json(response, { value: null }); }
			if (command.kind === "update" && updateControl) return json(response, { value: await updateControl(command.op) });
			return json(response, { error: "Unsupported host operation." }, 400);
		}
		if (pathname === "/api/subscriptions" && desktopSecret && nativeControl) {
			if (request.method === "GET") return json(response, await nativeControl({ op: "status" }));
			if (request.method !== "POST") return json(response, { error: "Unsupported method." }, 405);
			const command = await commandBody(request);
			return json(response, { value: await nativeControl(command) });
		}
		return false;
	}
	function createGateway(local = false) {
		const server = http.createServer({ requestTimeout: 60000, headersTimeout: 15000, maxHeaderSize: 16384 }, (request, response) => {
			void (async () => {
				const accepted = requestOrigin(request, tailnet, local ? localOrigin : undefined, previewToken, local ? undefined : directSources.get(request.socket));
				if (!accepted) return json(response, { error: "Connect to Tailscale with the same account as this PC." }, 403);
				if (!sameOrigin(request, accepted)) return json(response, { error: "Cross-site requests are not allowed." }, 403);
				if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) return json(response, { error: "Invalid path." }, 400);
				const pathname = new URL(request.url, accepted).pathname;
				if (["/api/mobile-access", "/api/mobile-host"].includes(pathname) || pathname === "/api/subscriptions" && desktopSecret) {
					await gatewayControl(request, response, pathname); return;
				}
				const proxy = http.request(new URL(request.url, upstream), { method: request.method, headers: forwardHeaders(request.headers, upstream, desktopSecret) }, incoming => {
					const headers = { ...incoming.headers };
					for (const name of HOP) delete headers[name];
					headers["cache-control"] = "no-store";
					headers["referrer-policy"] = "no-referrer";
					headers["x-frame-options"] = "SAMEORIGIN";
					if (headers.location?.startsWith(upstream.origin)) headers.location = headers.location.replace(upstream.origin, accepted);
					response.writeHead(incoming.statusCode || 502, headers);
					incoming.pipe(response);
					incoming.on("error", () => response.destroy());
				});
				proxy.on("error", () => { if (!response.headersSent) json(response, { error: "LearnHarness is reconnecting. Try again shortly." }, 502); else response.destroy(); });
				response.on("close", () => proxy.destroy());
				request.pipe(proxy);
			})().catch(() => { if (!response.headersSent) json(response, { error: "The operation could not be completed. Try again." }, 400); else response.destroy(); });
		});
		server.on("connection", socket => { if (!local) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); } });
		server.on("upgrade", (request, socket, head) => {
			const accepted = requestOrigin(request, tailnet, local ? localOrigin : undefined, previewToken, local ? undefined : directSources.get(socket));
			if (!accepted || !sameOrigin(request, accepted) || !request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) return socket.destroy();
			const headers = forwardHeaders(request.headers, upstream, desktopSecret);
			headers.connection = "Upgrade"; headers.upgrade = "websocket";
			const proxy = http.request(new URL(request.url, upstream), { headers });
			proxy.on("upgrade", (reply, target, upstreamHead) => {
				socket.write(`HTTP/1.1 ${reply.statusCode} Switching Protocols\r\n${Object.entries(reply.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
				if (head.length) target.write(head);
				if (upstreamHead.length) socket.write(upstreamHead);
				socket.pipe(target).pipe(socket);
				socket.on("close", () => target.destroy()); target.on("error", () => socket.destroy());
			});
			proxy.on("response", () => socket.destroy()); proxy.on("error", () => socket.destroy());
			socket.on("error", () => proxy.destroy()); proxy.end();
		});
		return server;
	}
	async function listen(server, listenPort) {
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
	}
	function setEnabled(next, deferDisconnect = false) {
		const change = queue.then(async () => {
			if (next && !remoteServer) {
				await refresh();
				const server = createGateway();
				try { await listen(server, port); } catch { throw new Error(`Mobile Access could not open local port ${port}. Close its other listener and retry.`); }
				remoteServer = server;
				await startDirectListener();
			}
			try { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(setting, JSON.stringify({ enabled: next }), { mode: 0o600 }); }
			catch (error) { if (!enabled && remoteServer) { stopDirectListener(); remoteServer.close(); disconnect(); remoteServer = undefined; } throw error; }
			enabled = next;
			if (!next && remoteServer) { stopDirectListener(); remoteServer.close(); if (!deferDisconnect) disconnect(); remoteServer = undefined; }
			if (timer) clearInterval(timer);
			if (next) { timer = setInterval(() => { void refresh(); }, 15000); timer.unref(); }
			return status();
		});
		queue = change.catch(() => {});
		return change;
	}
	async function openPreview(size = "phone") {
		const sizes = { compact: [320, 568], phone: [390, 844], large: [430, 932] };
		if (!Object.hasOwn(sizes, size)) throw new Error("Unknown viewport size.");
		const [width, height] = sizes[size];
		if (previewWindow && !previewWindow.isDestroyed()) { previewWindow.setContentSize(width, height); previewWindow.show(); return; }
		if (!previewServer) { previewServer = createGateway(true); await listen(previewServer, 0); localOrigin = `http://127.0.0.1:${previewServer.address().port}`; }
		const isolated = session.fromPartition(`lh-phone-${previewToken}`);
		isolated.webRequest.onBeforeSendHeaders((details, callback) => {
			const headers = { ...details.requestHeaders };
			for (const name of Object.keys(headers)) if (name.toLowerCase() === "x-learnharness-preview") delete headers[name];
			const target = new URL(details.url);
			if (target.host === new URL(localOrigin).host && ["http:", "ws:"].includes(target.protocol)) headers["x-learnharness-preview"] = previewToken;
			callback({ requestHeaders: headers });
		});
		isolated.setPermissionRequestHandler((_contents, permission, callback, details) => callback(new URL(details.requestingUrl).origin === localOrigin && permission === "clipboard-sanitized-write"));
		isolated.setPermissionCheckHandler((_contents, permission, requestingOrigin) => requestingOrigin === localOrigin && permission === "clipboard-sanitized-write");
		previewWindow = new BrowserWindow({ width, height, useContentSize: true, minWidth: 320, minHeight: 320, title: "LearnHarness · Phone viewport", autoHideMenuBar: true, backgroundColor: appearance(), webPreferences: { session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false } });
		previewWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
		previewWindow.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== localOrigin) { event.preventDefault(); openExternal(target); } });
		previewWindow.on("closed", () => { previewWindow = undefined; });
		await previewWindow.loadURL(localOrigin);
	}
	async function initialize() {
		let saved; try { saved = JSON.parse(await fs.readFile(setting, "utf8")); } catch { /* Disabled on first launch. */ }
		if (saved?.enabled === true) { try { await setEnabled(true); } catch (error) { issue = error.message; } }
	}
	function close() {
		if (timer) clearInterval(timer);
		stopDirectListener(); remoteServer?.close(); previewServer?.close(); disconnect();
		previewServer?.closeAllConnections();
	}
	app.once("before-quit", close);
	return { initialize, status, refresh, setEnabled, openPreview, close, address: () => remoteServer?.address(), directAddress: () => direct?.server.address() };
}
module.exports = { createMobileAccess, tailnetFrom, requestOrigin, sameOrigin, forwardHeaders, readTailnet, LOCAL_PORT, HTTPS_PORT, DIRECT_LOCAL_PORT, DIRECT_PORT };
