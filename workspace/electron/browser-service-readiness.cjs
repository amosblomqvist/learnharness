// No Electron import: the shipping helper's readiness contract is testable
// without a display. Never announce CDP until its exact loopback endpoint works.
const http = require("node:http");

/**
 * @param {number} port
 * @param {{signal?: AbortSignal, timeoutMs?: number, requestTimeoutMs?: number, retryMs?: number}} [options]
 * @returns {Promise<string>}
 */
function waitForBrowserService(port, {
	signal,
	timeoutMs = 5000,
	requestTimeoutMs = 500,
	retryMs = 50,
} = {}) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return Promise.reject(new Error("browser-service: invalid loopback port"));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let activeRequest;
		let attemptTimer;
		let retryTimer;
		let lastError;
		const finish = (error, endpoint) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(attemptTimer);
			clearTimeout(retryTimer);
			signal?.removeEventListener("abort", abort);
			activeRequest?.destroy();
			if (error) reject(error);
			else resolve(endpoint);
		};
		const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("browser-service readiness aborted"));
		const deadline = setTimeout(() => finish(new Error(
			`browser-service: http://127.0.0.1:${port}/json/version not ready within ${timeoutMs}ms`,
			{ cause: lastError },
		)), timeoutMs);
		const attempt = () => {
			if (settled) return;
			let done = false;
			let response;
			const complete = (error, endpoint) => {
				if (done || settled) return;
				done = true;
				clearTimeout(attemptTimer);
				response?.destroy();
				request.destroy();
				activeRequest = undefined;
				if (!error) return finish(null, endpoint);
				lastError = error;
				retryTimer = setTimeout(attempt, retryMs);
			};
			const request = http.get({
				hostname: "127.0.0.1", port, path: "/json/version", agent: false,
			}, (res) => {
				response = res;
				res.on("error", (error) => complete(error));
				if (res.statusCode !== 200) return complete(new Error(`CDP HTTP status ${res.statusCode}`));
				const chunks = [];
				let bytes = 0;
				res.on("data", (chunk) => {
					if (done || settled) return;
					bytes += chunk.length;
					if (bytes > 16 * 1024) return complete(new Error("CDP response exceeds 16 KiB"));
					chunks.push(chunk);
				});
				res.on("end", () => {
					try {
						const info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						const endpoint = new URL(info.webSocketDebuggerUrl);
						if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(port) ||
							endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
							endpoint.href !== `ws://127.0.0.1:${port}${endpoint.pathname}` ||
							!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname)) {
							throw new Error("CDP response has an invalid browser WebSocket endpoint");
						}
						complete(null, endpoint.href);
					} catch (error) { complete(error); }
				});
			});
			activeRequest = request;
			request.on("error", (error) => complete(error));
			attemptTimer = setTimeout(() => complete(new Error("CDP HTTP request timed out")), requestTimeoutMs);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else attempt();
	});
}

module.exports = { waitForBrowserService };
