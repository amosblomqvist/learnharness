/** Real-browser proof for createPluginSmokeFixture + verifyPluginServer.
 *
 * The CALLER starts the already-built server with disposable learning/auth data
 * and owns its lifetime. This module never builds, starts a server, downloads a
 * browser, uses a persistent browser profile, or contacts provider accounts.
 *
 *   import { verifyPluginBrowser } from "./scripts/smoke-plugin-browser.mjs";
 *   await verifyPluginBrowser(url, {
 *     executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 *     scratchDirectory: home, // optional screenshots + complete evidence JSON
 *     headers: {},           // optional local-server transport headers
 *     timeoutMs: 30_000,
 *   });
 */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const PLUGIN = "/api/plugins/native-smoke";
const VIEW = "/plugins/native-smoke/proof";
const ROW = '[data-testid="plugin-native-smoke"]';
const TOGGLE = `${ROW} [role="switch"][aria-label="Enable Runtime proof"]`;
const SIDEBAR_LINK = `nav[aria-label="Plugin views"] a[href="${VIEW}"]`;
const MOUNT = 'main [aria-label="Runtime proof"]';

async function chromeExecutable(supplied) {
	const candidates = supplied ? [supplied] : [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		path.join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/opt/google/chrome/chrome",
		...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
			.filter(Boolean).map(directory => path.join(directory, "Google", "Chrome", "Application", "chrome.exe")),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch { /* Try only installed local stable-browser locations. */ }
	}
	throw new Error(supplied
		? `Plugin browser smoke: executablePath is not an executable file: ${supplied}`
		: "Plugin browser smoke: Chrome stable is unavailable. Supply options.executablePath pointing to an installed browser; this smoke never downloads Chromium.");
}

/** @param {string} url An already-running disposable server's loopback origin.
 * @param {{executablePath?: string, scratchDirectory?: string, headers?: Record<string, string>, timeoutMs?: number}} [options]
 * @returns {Promise<object>} Full console, network, RPC, and assertion evidence.
 */
export async function verifyPluginBrowser(url, options = {}) {
	const origin = new URL(url);
	assert.ok(["http:", "https:"].includes(origin.protocol), "Plugin browser smoke requires an HTTP(S) URL");
	assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), "Plugin browser smoke only targets a caller-owned disposable loopback server");
	assert.equal(origin.pathname, "/", "Supply the server origin, not an application route");
	assert.equal(origin.search + origin.hash + origin.username + origin.password, "", "Supply a plain server origin; use options.headers for transport authentication");
	const base = origin.origin;
	const timeoutMs = options.timeoutMs ?? 30_000;
	assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeoutMs must be positive");
	const executablePath = await chromeExecutable(options.executablePath);
	const evidence = {
		origin: base, executablePath, stage: "launch", console: [], pageErrors: [],
		requests: [], responses: [], failedRequests: [], blockedRequests: [],
		rpc: [], disabledProbes: [], screenshots: [], assertions: [],
	};
	let browser;
	let page;
	let recording = true;
	let failed;
	const screenshot = async name => {
		if (!options.scratchDirectory || !page || page.isClosed()) return;
		await mkdir(options.scratchDirectory, { recursive: true });
		const destination = path.join(options.scratchDirectory, `plugin-browser-${name}.png`);
		await page.screenshot({ path: destination, fullPage: true });
		evidence.screenshots.push(destination);
	};
	// This fixture intentionally has no Deepgram credential; the existing app
	// probes dictation readiness at startup. Its missing-key 503 and the app's
	// absent favicon are unrelated baseline responses, not plugin failures.
	// Keep both in evidence and match only exact paths/statuses/resource errors.
	const expectedFixtureResponse = entry => {
		const target = new URL(entry.url);
		return target.origin === base && entry.method === "GET" &&
			((target.pathname === "/api/stt/token" && entry.status === 503) || (target.pathname === "/favicon.ico" && entry.status === 404));
	};
	const expectedFixtureConsole = entry => {
		if (entry.type !== "error" || !entry.location?.url) return false;
		return evidence.responses.some(response => response.url === entry.location.url && expectedFixtureResponse(response)
			&& entry.text === `Failed to load resource: the server responded with a status of ${response.status} (${response.status === 503 ? "Service Unavailable" : "Not Found"})`);
	};
	// Next can cancel an already-200 RSC prefetch when focus/navigation changes.
	// This exception never covers /api/plugins, module assets, or failed status.
	const expectedFrameworkAbort = entry => {
		const target = new URL(entry.url);
		return entry.method === "GET" && entry.failure?.errorText === "net::ERR_ABORTED"
			&& target.origin === base && target.searchParams.has("_rsc") && !target.pathname.startsWith("/api/")
			&& evidence.responses.some(response => response.url === entry.url && response.status === 200);
	};
	const health = async () => {
		const alerts = await page.$$eval(`${ROW} [role="alert"], [data-testid="section-plugins"] > [role="alert"], main [role="alert"]`, elements =>
			elements.filter(element => element.getClientRects().length).map(element => element.textContent?.trim()));
		assert.deepEqual(alerts, [], `Visible plugin/app alerts: ${JSON.stringify(alerts)}`);
		assert.deepEqual(evidence.pageErrors, [], "Browser page errors were emitted");
		assert.deepEqual(evidence.console.filter(entry => (entry.type === "error" || entry.type === "assert") && !expectedFixtureConsole(entry)), [], "Unexpected browser console errors were emitted");
		assert.deepEqual(evidence.failedRequests.filter(entry => !expectedFrameworkAbort(entry)), [], "Unexpected browser requests failed (see network evidence)");
		assert.deepEqual(evidence.blockedRequests, [], "The app attempted an off-origin request; provider/account access is forbidden in this smoke");
		assert.deepEqual(evidence.responses.filter(entry => entry.status >= 400 && !expectedFixtureResponse(entry)), [], "The live app received unexpected unsuccessful HTTP responses");
	};
	const openPlugins = async () => {
		await page.waitForSelector('aside[aria-hidden="false"]', { visible: true });
		await page.locator('[data-testid="settings-entry"]').click();
		await page.locator('[data-testid="settings-nav-plugins"]').click();
		await page.waitForSelector(`${TOGGLE}:not(:disabled)`, { visible: true });
	};
	const closeSettings = async () => {
		await page.locator('[data-testid="settings-close"]').click();
		await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true });
	};
	const toggle = async enabled => {
		const responsePromise = page.waitForResponse(response => {
			const request = response.request();
			return new URL(response.url()).pathname === PLUGIN && request.method() === "PUT"
				&& request.postData() === JSON.stringify({ enabled });
		});
		const [response] = await Promise.all([responsePromise, page.locator(TOGGLE).click()]);
		assert.equal(response.status(), 200, `UI ${enabled ? "enable" : "disable"} failed`);
		const payload = await response.json();
		const plugin = payload.plugins?.find(item => item.id === "native-smoke");
		assert.equal(plugin?.enabled, enabled, "Enable/disable response must contain server truth");
		assert.equal(plugin.status, enabled ? "active" : "disabled");
		await page.waitForSelector(`${TOGGLE}[aria-checked="${enabled}"]:not(:disabled)`, { visible: true });
	};
	const openProof = async () => {
		const responsePromise = page.waitForResponse(response => {
			const request = response.request();
			if (new URL(response.url()).pathname !== `${PLUGIN}/call` || request.method() !== "POST") return false;
			const body = request.postData();
			return body === JSON.stringify({ operation: "proof", input: "browser-bridge" });
		});
		await page.waitForSelector(SIDEBAR_LINK, { visible: true });
		const [response] = await Promise.all([responsePromise, page.locator(SIDEBAR_LINK).click()]);
		assert.equal(response.status(), 200, "The mounted external view must reach the real backend RPC");
		const payload = await response.json();
		assert.equal(payload.result?.answer, "browser-bridge");
		assert.ok(payload.result.node && payload.result.data && payload.result.learning, "RPC proof must come from the fixture's native backend context");
		evidence.rpc.push(payload.result);
		await page.waitForFunction(({ mount, view }) => {
			const root = document.querySelector(mount);
			return window.location.pathname === view
				&& [...(root?.querySelectorAll("h1") ?? [])].some(element => element.textContent === "External module loaded")
				&& [...(root?.querySelectorAll("p") ?? [])].some(element => element.textContent === "browser-bridge");
		}, {}, { mount: MOUNT, view: VIEW });
		assert.deepEqual(await page.evaluate(({ mount, link }) => ({
			links: document.querySelectorAll(link).length,
			roots: document.querySelectorAll(mount).length,
			children: document.querySelector(mount)?.childElementCount,
			headings: [...document.querySelectorAll(`${mount} h1`)].filter(element => element.textContent === "External module loaded").length,
			answers: [...document.querySelectorAll(`${mount} p`)].filter(element => element.textContent === "browser-bridge").length,
		}), { mount: MOUNT, link: SIDEBAR_LINK }), { links: 1, roots: 1, children: 1, headings: 1, answers: 1 }, "A view mount must have one sidebar link, one owned DOM root, and no duplicated content");
		await health();
	};
	const openTranscript = async () => {
		await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-row"]')].some(row => row.textContent.includes("Plugin transcript proof")));
		await page.$$eval('[data-testid="session-row"]', rows => rows.find(row => row.textContent.includes("Plugin transcript proof")).click());
		await page.waitForFunction(() => window.location.pathname === "/chat/chat_plugin_smoke");
	};

	try {
		browser = await puppeteer.launch({
			executablePath, headless: true,
			args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check"],
		});
		page = await browser.newPage();
		page.setDefaultTimeout(timeoutMs);
		page.setDefaultNavigationTimeout(timeoutMs);
		await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
		if (options.headers) await page.setExtraHTTPHeaders(options.headers);
		page.on("console", entry => {
			if (recording) evidence.console.push({ type: entry.type(), text: entry.text(), location: entry.location(), stage: evidence.stage });
		});
		page.on("pageerror", error => {
			if (recording) evidence.pageErrors.push({ message: String(error), stack: error.stack, stage: evidence.stage });
		});
		page.on("requestfailed", request => {
			if (recording) evidence.failedRequests.push({ method: request.method(), url: request.url(), failure: request.failure(), stage: evidence.stage });
		});
		page.on("response", response => {
			if (recording) evidence.responses.push({ method: response.request().method(), url: response.url(), status: response.status(), stage: evidence.stage });
		});
		await page.setRequestInterception(true);
		page.on("request", request => {
			const target = new URL(request.url());
			if (recording) evidence.requests.push({ method: request.method(), url: request.url(), type: request.resourceType(), stage: evidence.stage });
			const external = ["http:", "https:"].includes(target.protocol) && target.origin !== base;
			if (external && recording) evidence.blockedRequests.push({ method: request.method(), url: request.url(), stage: evidence.stage });
			void (external ? request.abort("blockedbyclient") : request.continue()).catch(error => {
				if (recording) evidence.failedRequests.push({ method: request.method(), url: request.url(), failure: { errorText: String(error) }, stage: evidence.stage });
			});
		});

		evidence.stage = "disabled discovery in Settings";
		const documentResponse = await page.goto(base, { waitUntil: "domcontentloaded" });
		assert.equal(documentResponse?.status(), 200, "The caller's live app must serve its home screen");
		await openPlugins();
		const warning = await page.$eval('[data-testid="section-plugins"]', element => element.textContent);
		for (const copy of ["trusted local code", "broad file and network access", "not sandboxed", "restarting LearnHarness", "disabled by default"]) assert.ok(warning.includes(copy), `Missing trust/default-state warning: ${copy}`);
		assert.equal(await page.$eval(TOGGLE, element => element.getAttribute("aria-checked")), "false", "verifyPluginServer must leave the runtime fixture disabled");
		assert.ok((await page.$eval(ROW, element => element.textContent)).includes("Disabled"), "Package row must show the disabled status");
		assert.equal(await page.$$eval(SIDEBAR_LINK, elements => elements.length), 0, "A disabled package must not expose a sidebar view");
		await health();
		evidence.assertions.push("Settings exposes the trust warning and disabled Runtime proof package");

		evidence.stage = "UI enable and external ESM activation";
		await toggle(true);
		await page.waitForSelector(SIDEBAR_LINK);
		await closeSettings();
		await openProof();
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`]) {
			assert.ok(evidence.responses.some(entry => new URL(entry.url).pathname === asset && entry.status === 200), `Browser did not load the actual runtime module asset: ${asset}`);
		}
		assert.ok(evidence.requests.some(entry => new URL(entry.url).pathname === `${PLUGIN}/assets/main.js` && new URL(entry.url).searchParams.has("revision")), "Entry module must use the server revision query");
		evidence.assertions.push("Native external ESM + relative helper module + real browser-to-backend proof RPC");
		await screenshot("enabled");

		evidence.stage = "SPA Home navigation and view reattach";
		await page.locator('aside a[aria-label="Home"]').click();
		await page.waitForFunction(mount => window.location.pathname === "/" && document.querySelectorAll(mount).length === 0, {}, MOUNT);
		assert.equal(await page.$$eval(SIDEBAR_LINK, elements => elements.length), 1, "Activation must survive leaving the view");
		await openProof();
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`, "/api/events"]) {
			assert.equal(evidence.requests.filter(entry => new URL(entry.url).pathname === asset).length, 1, `SPA navigation must not duplicate the loader, activation imports, or standing SSE channel: ${asset}`);
		}
		assert.equal(evidence.rpc.length, 2, "Returning to the view must mount it again and read fresh backend state");
		evidence.assertions.push("Home navigation disposes view DOM; return remounts once without duplicating activation, links, roots, or SSE");
		await screenshot("reattached");

		evidence.stage = "shared lesson renderers with stored native history";
		await openTranscript();
		for (const selector of ["[data-smoke-fence]", "[data-smoke-tool]", "[data-smoke-background]"]) {
			await page.waitForSelector(selector, { visible: true });
			assert.equal(await page.$$eval(selector, nodes => nodes.length), 1, `Expected one native renderer mount: ${selector}`);
		}
		assert.match(await page.$eval("[data-smoke-fence]", node => node.textContent), /Rendered fence: Fence source\./);
		assert.equal(await page.$eval("[data-smoke-fence]", node => node.dataset.smokeMeta), "proof=1");
		assert.equal(await page.$eval("[data-smoke-tool]", node => node.textContent), "Rendered tool: Tool detail");
		assert.equal(await page.$eval("[data-smoke-background]", node => node.textContent), "Rendered worker: Worker detail");
		await health();
		await screenshot("lesson-renderers");
		evidence.assertions.push("External ESM renders lesson fences/metadata, persisted native tool results and separate worker-result markers without a model request");
		await openProof();

		evidence.stage = "UI disable and package unavailability";
		await openPlugins();
		await toggle(false);
		await page.waitForFunction(({ mount, link }) => !document.querySelector(mount) && !document.querySelector(link), {}, { mount: MOUNT, link: SIDEBAR_LINK });
		await closeSettings();
		await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("This plugin is disabled."));
		await health();
		// These intentional negative HTTP probes run outside the page, so their
		// expected 409s cannot mask or be confused with actual plugin console /
		// browser-network errors. Consume every response body for diagnostics.
		for (const [route, method, body] of [
			[`${PLUGIN}/call`, "POST", { operation: "proof", input: "after-disable" }],
			[`${PLUGIN}/assets/main.js`, "GET"],
			[`${PLUGIN}/assets/assets/helper.js`, "GET"],
		]) {
			const response = await fetch(base + route, {
				method, headers: { ...options.headers, ...(body ? { "content-type": "application/json" } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await response.text();
			evidence.disabledProbes.push({ method, route, status: response.status, body: text });
			assert.equal(response.status, 409, `Disabled package still exposes backend/assets (or failed for the wrong reason): ${method} ${route}: ${text}`);
			assert.match(text, /disabled|unavailable/i, "Disabled probes must fail because the plugin is unavailable, not due to unrelated auth/routing errors");
		}
		evidence.assertions.push("UI disable removes sidebar/mounted DOM and makes backend plus both native module assets unavailable");
		await screenshot("disabled");
		await openTranscript();
		await page.waitForSelector('[data-testid="tool-call-card"][data-tool="native_smoke_echo"]');
		assert.equal(await page.$$eval("[data-smoke-fence], [data-smoke-tool], [data-smoke-background]", nodes => nodes.length), 0);
		assert.equal(await page.$$eval('[data-testid="tool-call-card"][data-tool="native_smoke_echo"]', nodes => nodes.length), 1, "Original native call must remain readable with its renderer disabled");
		assert.match(await page.$eval("main", node => node.textContent), /Fence source\./);
		assert.match(await page.$eval("main", node => node.textContent), /Tool detail/);
		assert.match(await page.$eval("main", node => node.textContent), /Worker detail/);
		evidence.assertions.push("Disabling renderers preserves raw fence source, native call details and the later background result");
		await screenshot("lesson-fallbacks");
		await health();
		evidence.expectedFixtureResponses = evidence.responses.filter(expectedFixtureResponse);
		evidence.expectedFrameworkAborts = evidence.failedRequests.filter(expectedFrameworkAbort);
		evidence.stage = "passed";
		console.log("[smoke-plugin-browser] expected keyless-app baseline responses:", evidence.expectedFixtureResponses.map(entry => `${new URL(entry.url).pathname} ${entry.status}`).join(", "));
		console.log("[smoke-plugin-browser] Settings enable → native ESM/relative asset → backend RPC → Home/remount → Settings disable/assets denied");
	} catch (error) {
		failed = error;
		try { await screenshot("failure"); }
		catch (captureError) { evidence.screenshotError = String(captureError); }
	} finally {
		// Browser teardown intentionally closes SSE and outstanding requests;
		// stop recording only AFTER all assertions, not during plugin activity.
		recording = false;
		if (browser) {
			try { await browser.close(); }
			catch (error) { evidence.browserCloseError = String(error); failed ??= error; }
		}
		if (options.scratchDirectory) {
			try {
				await mkdir(options.scratchDirectory, { recursive: true });
				await writeFile(path.join(options.scratchDirectory, "plugin-browser-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
			} catch (error) { failed ??= error; }
		}
	}
	if (failed) {
		const diagnostic = {
			stage: evidence.stage, pageErrors: evidence.pageErrors,
			consoleErrors: evidence.console.filter(entry => entry.type === "error" || entry.type === "assert"),
			failedRequests: evidence.failedRequests, blockedRequests: evidence.blockedRequests,
			unsuccessfulResponses: evidence.responses.filter(entry => entry.status >= 400),
			recentResponses: evidence.responses.slice(-12), screenshots: evidence.screenshots,
		};
		const error = new Error(`Plugin browser smoke failed during ${evidence.stage}: ${failed.message ?? failed}\n${JSON.stringify(diagnostic, null, 2)}`, { cause: failed });
		error.evidence = evidence;
		throw error;
	}
	return evidence;
}
