import { createServer } from "node:http";

/** A fixed return origin lets packaged Electron keep its random app port.
 * Only the one-use attempt + Convex state/code pair can complete sign-in. */
export async function listenForGoogleCallback(complete: (url: URL) => Promise<void>): Promise<{ origin: string; close: () => void }> {
	const port = Number(process.env.LH_CLOUD_CALLBACK_PORT ?? "3211");
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Google callback port.");
	const origin = `http://127.0.0.1:${port}`;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const close = () => { clearTimeout(timeout); server.close(); };
	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.setHeader("X-Content-Type-Options", "nosniff");
		if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(404); response.end("Unavailable."); return; }
		const url = new URL(request.url ?? "/", origin);
		if (url.pathname !== "/labs/google/callback") { response.writeHead(404); response.end("Unavailable."); return; }
		try {
			await complete(url); response.end("Google account connected. Close this tab and return to LearnHarness."); close();
		} catch { response.writeHead(400); response.end("Sign-in could not be completed. Return to LearnHarness → Settings → Labs and try again."); }
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
	});
	server.unref(); timeout = setTimeout(close, 10 * 60_000); timeout.unref();
	return { origin, close };
}
