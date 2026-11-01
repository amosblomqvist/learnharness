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
import { PLUGIN_KNOWLEDGE_FIXTURE as KNOWLEDGE, PLUGIN_PICKER_SETTINGS_FIXTURE as PICKER_SETTINGS } from "./smoke-plugin-runtime.mjs";

const PLUGIN = "/api/plugins/native-smoke";
const VIEW = "/plugins/native-smoke/proof";
const ROW = '[data-testid="plugin-native-smoke"]';
const TOGGLE = `${ROW} [role="switch"][aria-label="Enable Runtime proof"]`;
const SIDEBAR_LINK = '[data-plugin-action="native-smoke/open-sidebar"]';
const MOUNT = 'main div[aria-label="Runtime proof"]';
const WORKER_ROW = '[data-testid="activity-blob-plugin-worker"]';
const CONCURRENCY_INPUT = 'input[type="number"][aria-label="Concurrent worker requests"]';
const KNOWLEDGE_OVERLAY = '[data-testid="chain-table-overlay"]';
const KNOWLEDGE_CHIP = `${MOUNT} [data-testid="practice-props-chip"]`;
const PICKER_DIALOG = '[data-plugin-ui-dialog][aria-label="Picker dialog proof"]';
const PICKER_SETTINGS_ROW = `[data-testid="plugin-${PICKER_SETTINGS.id}"]`;
const PICKER_SETTINGS_TOGGLE = `${PICKER_SETTINGS_ROW} [role="switch"][aria-label="Enable ${PICKER_SETTINGS.name}"]`;

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
		requests: [], responses: [], failedRequests: [], blockedRequests: [], expectedPickerReadAborts: [],
		rpc: [], admission: [], knowledge: [], knowledgeOrganization: [], foreground: [], settingsWrites: [], disabledProbes: [], screenshots: [], assertions: [],
	};
	let browser;
	let page;
	let recording = true;
	let knowledgePickerOpened = false;
	const requestStages = new WeakMap();
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
	// The shared picker aborts its source-directory GET when closing or
	// superseding a notify-driven read. Only the exact observed cleanup is
	// expected: no graph writes, graph snapshot/model/module requests, HTTP
	// error statuses, unrelated stages, or other failure reasons qualify.
	// Retain request-start stage so a late cleanup event cannot be mistaken
	// for an unrelated failure (or require exempting the next proof stage).
	const expectedPickerReadAbort = entry => {
		const target = new URL(entry.url);
		return entry.knowledgePickerOpened === true && entry.method === "GET"
			&& target.origin === base && target.pathname === "/api/graph/sources" && target.search === ""
			&& entry.failure?.errorText === "net::ERR_ABORTED"
			&& ["controlled knowledge bubble and full-content shared picker", "knowledge picker retains normal source rename/folder/drag editing", "SPA Home navigation and view reattach", "public dialog-origin picker foreground", "Settings open closes an active main picker", "custom Settings-origin picker foreground"].includes(entry.requestStage ?? entry.stage);
	};
	const health = async () => {
		evidence.expectedPickerReadAborts = evidence.failedRequests.filter(expectedPickerReadAbort);
		const alerts = await page.$$eval(`${ROW} [role="alert"], [data-testid="section-plugins"] > [role="alert"], main [role="alert"]`, elements =>
			elements.filter(element => element.getClientRects().length).map(element => element.textContent?.trim()));
		assert.deepEqual(alerts, [], `Visible plugin/app alerts: ${JSON.stringify(alerts)}`);
		assert.deepEqual(evidence.pageErrors, [], "Browser page errors were emitted");
		assert.deepEqual(evidence.console.filter(entry => (entry.type === "error" || entry.type === "assert") && !expectedFixtureConsole(entry)), [], "Unexpected browser console errors were emitted");
		assert.deepEqual(evidence.failedRequests.filter(entry => !expectedFrameworkAbort(entry) && !expectedPickerReadAbort(entry)), [], "Unexpected browser requests failed (see network evidence)");
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
		}), { mount: MOUNT, link: SIDEBAR_LINK }), { links: 1, roots: 1, children: 1, headings: 1, answers: 1 }, "A view mount must have one explicitly placed sidebar action, one owned DOM root, and no duplicated content");
		await health();
	};
	const openTranscript = async () => {
		await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-row"]')].some(row => row.textContent.includes("Plugin transcript proof")));
		await page.$$eval('[data-testid="session-row"]', rows => rows.find(row => row.textContent.includes("Plugin transcript proof")).click());
		await page.waitForFunction(() => window.location.pathname === "/chat/chat_plugin_smoke");
	};
	const openKnowledge = async () => {
		await page.locator(KNOWLEDGE_CHIP).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { visible: true });
		knowledgePickerOpened = true;
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 1, "Knowledge picker must reuse one shared chain-table overlay");
		await page.waitForSelector(`${KNOWLEDGE_OVERLAY} [data-testid="add-source-folder"]`, { visible: true });
	};
	const assertKnowledge = async (label, ids, callbacks) => {
		await page.waitForFunction(({ mount, ids, callbacks }) => {
			const state = document.querySelector(`${mount} [data-smoke-knowledge-state]`);
			return state && JSON.stringify(JSON.parse(state.textContent).sort()) === JSON.stringify([...ids].sort())
				&& Number(state.dataset.callbacks) === callbacks;
		}, {}, { mount: MOUNT, ids, callbacks });
		assert.equal(await page.$eval(KNOWLEDGE_CHIP, chip => chip.textContent.trim()), ids.length ? `${ids.length} ${ids.length === 1 ? "node" : "nodes"} selected` : "Pick nodes");
		evidence.knowledge.push({ label, ids: [...ids], callbacks });
	};
	const expandKnowledge = async testid => {
		const selector = `${KNOWLEDGE_OVERLAY} [data-testid=${JSON.stringify(testid)}]`;
		if (await page.$eval(selector, button => button.getAttribute("aria-expanded")) !== "true") await page.locator(selector).click();
	};
	const openForegroundPicker = async root => {
		await page.locator(`${root} [data-testid="practice-props-chip"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { visible: true });
		knowledgePickerOpened = true;
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 1, "Foreground selector must reuse one shared overlay");
		await page.waitForSelector(`${KNOWLEDGE_OVERLAY} [data-testid="add-source-folder"]`, { visible: true });
		assert.deepEqual(await page.$eval(KNOWLEDGE_OVERLAY, overlay => {
			const bounds = overlay.getBoundingClientRect();
			const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
			return { inMain: overlay.parentElement === document.querySelector("main"), zIndex: getComputedStyle(overlay).zIndex, foreground: overlay.contains(hit) };
		}), { inMain: true, zIndex: "40", foreground: true }, "Launching modal must yield to the actual main-column z40 picker, not promote it above all later surfaces");
	};
	const capturePickerOrigin = async (scope, draft) => {
		const root = `[data-smoke-picker-scope="${scope}"]`;
		const selector = `${root} [data-smoke-picker-draft="${scope}"]`;
		await page.locator(selector).fill(draft);
		const input = await page.$(selector);
		assert.ok(input);
		const mountCount = await page.$eval(root, element => Number(element.dataset.mountCount));
		return { root, selector, input, draft, mountCount };
	};
	const assertPickerOrigin = async (label, origin, ids, callbacks, hidden, focused = false) => {
		await page.waitForFunction((input, { hidden, root, ids, callbacks }) => {
			if (!input.isConnected) return false;
			const state = document.querySelector(`${root} [data-smoke-picker-selection]`);
			if (!state || Number(state.dataset.callbacks) !== callbacks || JSON.stringify(JSON.parse(state.textContent).sort()) !== JSON.stringify([...ids].sort())) return false;
			let invisible = false;
			for (let node = input; node; node = node.parentElement) {
				const style = getComputedStyle(node);
				if (node.hidden || style.display === "none" || style.visibility === "hidden") invisible = true;
			}
			return invisible === hidden && (!hidden || !!input.closest("[inert]"));
		}, { timeout: timeoutMs }, origin.input, { hidden, root: origin.root, ids, callbacks });
		if (focused) await page.waitForFunction(root => document.querySelector(`${root} [data-testid="practice-props-chip"]`) === document.activeElement, { timeout: timeoutMs }, origin.root);
		const snapshot = await page.evaluate((input, { root, selector }) => {
			const container = document.querySelector(root);
			const state = container.querySelector("[data-smoke-picker-selection]");
			return { sameInput: document.querySelector(selector) === input, connected: input.isConnected, draft: input.value,
				mountCount: Number(container.dataset.mountCount), ids: JSON.parse(state.textContent), callbacks: Number(state.dataset.callbacks),
				chip: container.querySelector('[data-testid="practice-props-chip"]').textContent.trim(), inert: !!input.closest("[inert]") };
		}, origin.input, { root: origin.root, selector: origin.selector });
		assert.equal(snapshot.sameInput && snapshot.connected, true, "Launching modal/input must stay mounted while its selector is active");
		assert.equal(snapshot.mountCount, origin.mountCount, "Closing a picker must not remount its launching Settings/dialog content");
		assert.equal(snapshot.draft, origin.draft);
		assert.deepEqual([...snapshot.ids].sort(), [...ids].sort());
		assert.equal(snapshot.callbacks, callbacks);
		assert.equal(snapshot.chip, ids.length ? `${ids.length} ${ids.length === 1 ? "node" : "nodes"} selected` : "Pick nodes");
		assert.equal(snapshot.inert, hidden, "Restored origin must become interactive again");
		evidence.foreground.push({ label, hidden, focused, ...snapshot });
	};
	const togglePickerSettings = async enabled => {
		const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/plugins/${PICKER_SETTINGS.id}`
			&& response.request().method() === "PUT" && response.request().postData() === JSON.stringify({ enabled }));
		await page.locator(PICKER_SETTINGS_TOGGLE).click();
		const response = await saved;
		assert.equal(response.status(), 200);
		const payload = await response.json();
		assert.equal(payload.plugins.find(plugin => plugin.id === PICKER_SETTINGS.id)?.enabled, enabled);
		await page.waitForSelector(`${PICKER_SETTINGS_TOGGLE}[aria-checked="${enabled}"]:not(:disabled)`, { visible: true });
	};
	const organizationResponse = action => page.waitForResponse(response => {
		if (new URL(response.url()).pathname !== "/api/graph/sources" || response.request().method() !== "POST") return false;
		let body;
		try { body = JSON.parse(response.request().postData()); } catch { return false; }
		return Object.entries(action).every(([key, value]) => body[key] === value);
	}).then(async response => {
		assert.equal(response.status(), 200, "Picker source organization UI must use the normal mutation route");
		const directory = await response.json();
		evidence.knowledgeOrganization.push({ action, directory });
		return directory;
	});

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
			if (recording) evidence.failedRequests.push({ method: request.method(), url: request.url(), failure: request.failure(), stage: evidence.stage, requestStage: requestStages.get(request), knowledgePickerOpened });
		});
		page.on("response", response => {
			if (recording) evidence.responses.push({ method: response.request().method(), url: response.url(), status: response.status(), stage: evidence.stage });
		});
		await page.setRequestInterception(true);
		page.on("request", request => {
			requestStages.set(request, evidence.stage);
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
		const sidebarLayout = await page.$eval('[data-testid="sidebar-actions"]', node => ({
			columns: getComputedStyle(node).gridTemplateColumns.split(" ").length,
			children: node.children.length, scrollable: node.scrollHeight > node.clientHeight,
			first: node.children[0]?.textContent.trim(), second: node.children[1]?.textContent.trim(),
		}));
		assert.equal(sidebarLayout.columns, 2); assert.equal(sidebarLayout.children, 11);
		assert.equal(sidebarLayout.scrollable, true); assert.match(sidebarLayout.first, /Teaching/); assert.match(sidebarLayout.second, /Practice/);
		evidence.assertions.push("Sidebar uses row-major Teaching/Practice first row and capped two-column overflow above ten total buttons");
		await closeSettings();
		await openProof();
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`]) {
			assert.ok(evidence.responses.some(entry => new URL(entry.url).pathname === asset && entry.status === 200), `Browser did not load the actual runtime module asset: ${asset}`);
		}
		assert.ok(evidence.requests.some(entry => new URL(entry.url).pathname === `${PLUGIN}/assets/main.js` && new URL(entry.url).searchParams.has("revision")), "Entry module must use the server revision query");
		evidence.assertions.push("Native external ESM + relative helper module + real browser-to-backend proof RPC");
		evidence.pluginTitleStyle = await page.$eval('main header [data-plugin-chrome-title]', node => {
			const style = getComputedStyle(node);
			return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing };
		});
		await screenshot("enabled");

		evidence.stage = "host widgets and dedicated plugin settings";
		assert.equal(await page.$$eval('nav[aria-label="Plugin views"]', nodes => nodes.length), 0, "Views must not create an automatic sidebar section");
		await page.locator(`${MOUNT} button[title="Open host dialog"]`).click();
		await page.waitForSelector('[role="dialog"][aria-label="Plugin dialog proof"]', { visible: true });
		assert.match(await page.$eval('[role="dialog"][aria-label="Plugin dialog proof"]', node => node.textContent), /Host dialog content/);
		await page.locator('[aria-label="Close dialog"]').click();
		await page.waitForSelector('[role="dialog"][aria-label="Plugin dialog proof"]', { hidden: true });
		await page.locator(`${MOUNT} [contenteditable="true"]`).fill("Controlled plugin message");
		await page.locator(`${MOUNT} [aria-label="Send"]`).click();
		await page.waitForFunction(() => document.querySelector('[data-smoke-submitted]')?.textContent === "Controlled plugin message");
		await page.locator(`${MOUNT} [contenteditable="true"]`).click();
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await page.keyboard.down(modifier);
		await page.keyboard.press("k");
		await page.keyboard.up(modifier);
		await page.waitForSelector('[data-testid="plugin-model-menu"]', { visible: true });
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="plugin-model-menu"]', { hidden: true });
		await page.locator('main button[aria-label="Plugin settings"]').click();
		await page.waitForSelector('[data-testid="section-plugin-native-smoke"]', { visible: true });
		await page.locator('[data-testid="section-plugin-native-smoke"] [role="switch"]').click();
		await page.waitForSelector('[data-testid="section-plugin-native-smoke"] [role="switch"][aria-checked="true"]');
		await closeSettings();
		await health();
		evidence.assertions.push("Host portal button/dialog, controlled composer and focused Mod+K model menu, gear deep-link and schema toggle work without plugin React imports or settings writes");
		await screenshot("host-ui");

		evidence.stage = "controlled knowledge bubble and full-content shared picker";
		await assertKnowledge("initial controlled empty value", [], 0);
		await openKnowledge();
		evidence.knowledgeBounds = await page.evaluate(selector => {
			const overlay = document.querySelector(selector);
			const main = document.querySelector("main");
			const sidebar = document.querySelector('aside[aria-hidden="false"]');
			const header = overlay.querySelector("header");
			const bounds = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
			const side = sidebar.getBoundingClientRect();
			const hit = document.elementFromPoint(side.left + side.width / 2, side.top + Math.min(side.height / 2, 150));
			return { overlay: bounds(overlay), main: bounds(main), header: bounds(header), sidebar: bounds(sidebar),
				directMainChild: overlay.parentElement === main, sidebarUncovered: sidebar.contains(hit),
				sharedDragHeader: header.classList.contains("lh-drag"), counts: header.textContent };
		}, KNOWLEDGE_OVERLAY);
		const geometry = evidence.knowledgeBounds;
		assert.equal(geometry.directMainChild, true, "Picker must portal into actual host main, not plugin body/sidebar");
		for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(geometry.overlay[dimension] - geometry.main[dimension]) <= 1, `Picker must fill the full host content column: ${dimension}`);
		assert.ok(geometry.overlay.x >= geometry.sidebar.x + geometry.sidebar.width - 1, "Picker must not extend over the sidebar");
		assert.equal(geometry.sidebarUncovered, true);
		assert.equal(geometry.sharedDragHeader, true);
		assert.equal(geometry.header.height, 60, "Picker must retain the standard TopBar");
		assert.equal(geometry.header.y, geometry.main.y);
		assert.match(geometry.counts, /1 chain · 2 nodes/);
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`).click();
		await assertKnowledge("chain selection reports both stable proposition IDs", [KNOWLEDGE.premiseId, KNOWLEDGE.conclusionId], 1);
		assert.match(await page.$eval(`${KNOWLEDGE_OVERLAY} [data-testid="chain-selected-summary"]`, node => node.textContent), /2 nodes → 1 chain/);
		await screenshot("knowledge-chain-selected");
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-practice-done"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertKnowledge("Done closes without applying or discarding selection", [KNOWLEDGE.premiseId, KNOWLEDGE.conclusionId], 1);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		assert.equal(await page.$eval(`[data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`, input => input.checked), true);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-clear"]`).click();
		await assertKnowledge("shared table Clear updates the same controlled value", [], 2);
		await page.locator(`[data-testid="prop-checkbox-${KNOWLEDGE.conclusionId}"]`).click();
		await assertKnowledge("individual proposition selection updates controlled IDs/count", [KNOWLEDGE.conclusionId], 3);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertKnowledge("X keeps the current selection", [KNOWLEDGE.conclusionId], 3);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		assert.equal(await page.$eval(`[data-testid="prop-checkbox-${KNOWLEDGE.premiseId}"]`, input => input.checked), false);
		assert.equal(await page.$eval(`[data-testid="prop-checkbox-${KNOWLEDGE.conclusionId}"]`, input => input.checked), true);
		await page.keyboard.press("Escape");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertKnowledge("Escape also closes without losing selected IDs", [KNOWLEDGE.conclusionId], 3);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		assert.equal(await page.$eval(`[data-testid="prop-checkbox-${KNOWLEDGE.conclusionId}"]`, input => input.checked), true, "Reopen after Escape must retain selection");
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.locator(`${MOUNT} [data-testid="practice-props-clear"]`).click();
		await assertKnowledge("bubble Clear reports an empty controlled array", [], 4);
		assert.equal(await page.$$eval(`${MOUNT} [data-testid="practice-props-clear"]`, nodes => nodes.length), 0);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		assert.equal(await page.$eval(`[data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`, input => input.checked), false);
		await screenshot("knowledge-cleared");
		evidence.assertions.push("Public controlled knowledge picker reuses native bubble and full-main ChainTableOverlay/TopBar, leaves sidebar uncovered, reports chain/proposition IDs and count immediately, retains values through Done/X/Escape and clears via callback");

		evidence.stage = "knowledge picker retains normal source rename/folder/drag editing";
		const sourceRow = `${KNOWLEDGE_OVERLAY} [data-source-drag-row="${KNOWLEDGE.sourceId}"]`;
		assert.equal(await page.$eval(sourceRow, row => row.draggable), true, "Selecting knowledge must not remove normal source drag controls");
		const renameSource = async name => {
			await page.locator(`${sourceRow} button[title="Rename"]`).click();
			const editor = `${sourceRow} [data-testid="source-name-input"]`;
			await page.locator(editor).fill(name);
			const saved = organizationResponse({ action: "rename-source", id: KNOWLEDGE.sourceId, name });
			await page.keyboard.press("Enter");
			const directory = await saved;
			assert.equal(directory.sources.find(source => source.id === KNOWLEDGE.sourceId)?.label, name);
			await page.waitForSelector(editor, { hidden: true });
			assert.equal(await page.$eval(`${sourceRow} button[title="Rename"]`, button => button.textContent), name);
		};
		await renameSource("Renamed plugin picker proof");
		await renameSource(KNOWLEDGE.sourceLabel);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="add-source-folder"]`).click();
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="new-folder-row"] [data-testid="source-name-input"]`).fill("Plugin picker folder");
		const folderCreated = organizationResponse({ action: "create-folder", name: "Plugin picker folder", parentId: null });
		await page.keyboard.press("Enter");
		const created = await folderCreated;
		assert.ok(created.createdFolderId, "Normal folder creation must return its stable ID");
		const folderId = created.createdFolderId;
		const folderRow = `${KNOWLEDGE_OVERLAY} [data-testid="folder-row-${folderId}"]`;
		await page.waitForSelector(folderRow, { visible: true });
		const moveSource = async (parentId, targetSelector) => {
			const saved = organizationResponse({ action: "move", kind: "source", id: KNOWLEDGE.sourceId, parentId });
			// Drive native HTML5 drag/drop; no direct mutation fetch, fake graph
			// state, or production test route substitutes for the picker controls.
			await page.setDragInterception(true);
			try {
				const from = await page.$(sourceRow);
				const to = await page.$(targetSelector);
				assert.ok(from && to, "Native organization drag endpoints must exist");
				await from.dragAndDrop(to);
			} finally { await page.setDragInterception(false); }
			const directory = await saved;
			assert.equal(directory.organization.placements[KNOWLEDGE.sourceId]?.folderId, parentId);
		};
		await moveSource(folderId, folderRow);
		await expandKnowledge(`folder-toggle-${folderId}`);
		await page.waitForSelector(`${KNOWLEDGE_OVERLAY} [data-testid="source-folder-${folderId}"] [data-source-drag-row="${KNOWLEDGE.sourceId}"]`, { visible: true });
		await screenshot("knowledge-native-editing");
		await moveSource(null, `${KNOWLEDGE_OVERLAY} [data-testid="source-root-drop"]`);
		await page.waitForFunction(({ sourceRow, folderId }) => {
			const row = document.querySelector(sourceRow);
			return row && !row.closest(`[data-testid="source-folder-${folderId}"]`);
		}, {}, { sourceRow, folderId });
		await assertKnowledge("organization edits do not change selected IDs", [], 4);
		await health();
		evidence.assertions.push("The same picker permits actual source rename (restored), folder creation, native HTML5 drag into that folder and back to root; dedicated inert notes source leaves transcript identity/title untouched");
		// Leave it OPEN: the existing real Home/remount proof must dispose the
		// content-column portal with the view signal, without extra proof RPCs.

		evidence.stage = "SPA Home navigation and view reattach";
		await page.locator('aside a[aria-label="Home"]').click();
		await page.waitForFunction(mount => window.location.pathname === "/" && document.querySelectorAll(mount).length === 0, {}, MOUNT);
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0, "Route-away must dispose the open knowledge portal, not leave an orphan over Home");
		assert.equal(await page.$$eval(SIDEBAR_LINK, elements => elements.length), 1, "Activation must survive leaving the view");
		await page.waitForSelector('[data-testid="plugin-graph-actions"] [data-plugin-action="native-smoke/open-graph"]', { visible: true });
		const rail = await page.$eval('[data-testid="plugin-graph-actions"]', element => {
			const button = element.querySelector('button');
			const bounds = button.getBoundingClientRect();
			const railBounds = element.getBoundingClientRect();
			const gapTarget = document.elementFromPoint(railBounds.left + 4, bounds.bottom + 4);
			return { width: bounds.width, height: bounds.height, left: bounds.left - railBounds.left, top: bounds.top - railBounds.top,
				pointerEvents: getComputedStyle(element).pointerEvents, buttonPointerEvents: getComputedStyle(button).pointerEvents,
				gapIntercepted: element.contains(gapTarget) };
		});
		assert.deepEqual(rail, { width: 36, height: 36, left: 8, top: 8, pointerEvents: "none", buttonPointerEvents: "auto", gapIntercepted: false });
		evidence.assertions.push("Graph rail matches native 36px controls/8px padding and transparent gaps pass through to the graph");
		const railButton = await page.$('[data-testid="plugin-graph-actions"] button');
		const railBounds = await railButton.boundingBox();
		await page.mouse.move(railBounds.x + railBounds.width / 2, railBounds.y + railBounds.height / 2);
		await page.mouse.wheel({ deltaY: 500 });
		await page.waitForFunction(() => document.querySelector('[data-testid="plugin-graph-actions"]').scrollTop > 0);
		await page.$eval('[data-testid="plugin-graph-actions"]', element => { element.scrollTop = 0; });
		await page.locator('aside button[aria-label="Close sidebar"]').click();
		await page.waitForSelector('aside[aria-hidden="true"]');
		await page.waitForFunction(() => {
			const rail = document.querySelector('[data-testid="plugin-graph-actions"] button')?.getBoundingClientRect();
			const toggle = document.querySelector('button[aria-label="Open sidebar"]')?.getBoundingClientRect();
			return rail && toggle && rail.top >= toggle.bottom + 7 && rail.left === 8;
		});
		await screenshot("graph-rail-sidebar-closed");
		await page.locator('button[aria-label="Open sidebar"]').click();
		await page.waitForSelector('aside[aria-hidden="false"]');
		evidence.assertions.push("Graph rail scrolls over its buttons and stays below the sidebar toggle when the sidebar closes");
		await openProof();
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`, "/api/events"]) {
			assert.equal(evidence.requests.filter(entry => new URL(entry.url).pathname === asset).length, 1, `SPA navigation must not duplicate the loader, activation imports, or standing SSE channel: ${asset}`);
		}
		assert.equal(evidence.rpc.length, 2, "Returning to the view must mount it again and read fresh backend state");
		assert.equal(await page.$$eval(KNOWLEDGE_CHIP, nodes => nodes.length), 1, "Reattached view must not duplicate the picker bubble");
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0);
		await assertKnowledge("fresh view mount owns fresh picker state", [], 0);
		await openKnowledge();
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		evidence.assertions.push("Leaving an open picker disposes its full-column portal; return mounts one bubble and reopens exactly one shared overlay without changing proof-RPC counts");
		evidence.assertions.push("Home navigation disposes view DOM; return remounts once without duplicating activation, links, roots, or SSE");
		await screenshot("reattached");

		evidence.stage = "public dialog-origin picker foreground";
		await page.locator(`${MOUNT} button[title="Open knowledge dialog"]`).click();
		await page.waitForSelector(PICKER_DIALOG, { visible: true });
		const dialogOrigin = await capturePickerOrigin("dialog", "Dialog draft survives selector foreground");
		await openForegroundPicker(dialogOrigin.root);
		await page.waitForSelector(PICKER_DIALOG, { hidden: true });
		await assertPickerOrigin("dialog origin is hidden/inert but its input remains mounted", dialogOrigin, [], 0, true);
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="prop-checkbox-${KNOWLEDGE.conclusionId}"]`).click();
		await assertPickerOrigin("dialog controlled selection updates while origin is covered", dialogOrigin, [KNOWLEDGE.conclusionId], 1, true);
		await screenshot("foreground-dialog-picker");
		await page.keyboard.press("Escape");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.waitForSelector(PICKER_DIALOG, { visible: true });
		await assertPickerOrigin("Escape closes only selector and restores same dialog/input/trigger focus", dialogOrigin, [KNOWLEDGE.conclusionId], 1, false, true);
		await openForegroundPicker(dialogOrigin.root);
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		assert.equal(await page.$eval(`${KNOWLEDGE_OVERLAY} [data-testid="prop-checkbox-${KNOWLEDGE.conclusionId}"]`, input => input.checked), true);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-practice-done"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertPickerOrigin("Done also restores the retained public dialog", dialogOrigin, [KNOWLEDGE.conclusionId], 1, false, true);
		await openForegroundPicker(dialogOrigin.root);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertPickerOrigin("X leaves dialog draft and selected IDs untouched", dialogOrigin, [KNOWLEDGE.conclusionId], 1, false, true);
		await screenshot("foreground-dialog-restored");
		await page.locator(`${PICKER_DIALOG} [aria-label="Close dialog"]`).click();
		await page.waitForFunction(selector => !document.querySelector(selector), {}, PICKER_DIALOG);
		assert.equal(await dialogOrigin.input.evaluate(input => input.isConnected), false, "Normal dialog close must still dispose its content");
		await dialogOrigin.input.dispose();
		await health();
		evidence.assertions.push("Public dialog-origin knowledge picker hides/inerts but retains its launching dialog/input instance; controlled IDs update; Escape/Done/X close only selector and restore original draft, mount count and trigger focus; normal dialog close still disposes content");

		evidence.stage = "Settings open closes an active main picker";
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="prop-checkbox-${KNOWLEDGE.premiseId}"]`).click();
		await assertKnowledge("main picker selection before a newer Settings surface", [KNOWLEDGE.premiseId], 1);
		await page.locator('[data-testid="settings-entry"]').click();
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0, "Any Settings open must close the active picker, not stack over it");
		assert.equal(await page.$eval('[data-testid="settings-dialog"]', dialog => {
			const bounds = dialog.getBoundingClientRect();
			return dialog.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
		}), true, "Settings must open normally in the foreground");
		await assertKnowledge("Settings closes the picker without clearing controlled IDs", [KNOWLEDGE.premiseId], 1);
		await screenshot("foreground-newer-settings");
		await closeSettings();
		await page.waitForFunction(({ selector, earliest }) => !document.querySelector(selector) && Date.now() >= earliest,
			{ timeout: timeoutMs, polling: 100 }, { selector: KNOWLEDGE_OVERLAY, earliest: Date.now() + 300 });
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0, "Closing Settings must not automatically resume the picker");
		await assertKnowledge("picker remains closed after Settings closes; selected IDs remain owned by fixture", [KNOWLEDGE.premiseId], 1);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		assert.equal(await page.$eval(`${KNOWLEDGE_OVERLAY} [data-testid="prop-checkbox-${KNOWLEDGE.premiseId}"]`, input => input.checked), true, "Explicit bubble reopen must retain the selection from before Settings opened");
		await screenshot("foreground-settings-explicit-reopen");
		evidence.foreground.push({ label: "Settings open closes picker without automatic resumption", pickerClosedBySettings: true, autoResumed: false, explicitReopenRetainsIds: true, ids: [KNOWLEDGE.premiseId] });
		await page.keyboard.press("Escape");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.locator(`${MOUNT} [data-testid="practice-props-clear"]`).click();
		await assertKnowledge("main selection cleared explicitly after Settings dismissal proof", [], 2);
		await health();
		evidence.assertions.push("Sidebar Settings open closes the active picker without clearing controlled IDs; closing Settings leaves picker closed; only explicit bubble reopen shows the retained selected IDs again");

		evidence.stage = "custom Settings-origin picker foreground";
		await openPlugins();
		await page.waitForSelector(`${PICKER_SETTINGS_TOGGLE}[aria-checked="false"]`, { visible: true });
		await togglePickerSettings(true);
		const settingsNav = `[data-testid="settings-nav-plugin:${PICKER_SETTINGS.id}"]`;
		await page.waitForSelector(settingsNav, { visible: true });
		await page.locator(settingsNav).click();
		await page.waitForSelector(`[data-testid="section-plugin-${PICKER_SETTINGS.id}"]`, { visible: true });
		const settingsOrigin = await capturePickerOrigin("settings", "Custom Settings draft survives selector foreground");
		await openForegroundPicker(settingsOrigin.root);
		await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true });
		await assertPickerOrigin("custom Settings origin is hidden/inert without remounting", settingsOrigin, [], 0, true);
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`).click();
		const settingsIds = [KNOWLEDGE.premiseId, KNOWLEDGE.conclusionId];
		await assertPickerOrigin("actual Settings-origin chain selection is controlled", settingsOrigin, settingsIds, 1, true);
		await screenshot("foreground-settings-picker");
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-practice-done"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		await assertPickerOrigin("Done restores same Settings input, mount count, IDs and trigger focus", settingsOrigin, settingsIds, 1, false, true);
		await openForegroundPicker(settingsOrigin.root);
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		assert.equal(await page.$eval(`${KNOWLEDGE_OVERLAY} [data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`, input => input.checked), true);
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertPickerOrigin("X also restores the same custom Settings mount", settingsOrigin, settingsIds, 1, false, true);
		await openForegroundPicker(settingsOrigin.root);
		await page.keyboard.press("Escape");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await assertPickerOrigin("Escape closes only selector and restores custom Settings", settingsOrigin, settingsIds, 1, false, true);
		await screenshot("foreground-settings-restored");
		await page.locator('[data-testid="settings-nav-plugins"]').click();
		await page.waitForSelector(`${PICKER_SETTINGS_TOGGLE}[aria-checked="true"]:not(:disabled)`, { visible: true });
		await togglePickerSettings(false);
		await page.waitForSelector(settingsNav, { hidden: true });
		await closeSettings();
		assert.equal(await settingsOrigin.input.evaluate(input => input.isConnected), false, "Leaving/closing custom Settings must still clean up normally");
		await settingsOrigin.input.dispose();
		assert.equal(await page.evaluate(() => window.location.pathname), VIEW);
		assert.equal(evidence.rpc.length, 2, "Foreground proofs must not navigate/remount the underlying proof view");
		assert.equal(evidence.requests.filter(entry => entry.method === "POST" && new URL(entry.url).pathname === `${PLUGIN}/call`).length, 2, "No additional backend proof RPC may be caused by auxiliary activation or modal changes");
		await assertKnowledge("foreground cases retain the underlying view's controlled state", [], 2);
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0);
		await health();
		evidence.assertions.push("Frontend-only auxiliary custom Settings uses the public registration/widget API; selector retains hidden/inert Settings DOM, uncontrolled draft, mount count and controlled IDs; Done/X/Escape restore trigger focus; auxiliary package disables through normal UI without remounting the view or replacing native-smoke schema Settings");

		evidence.stage = "shared lesson renderers with stored native history";
		await openTranscript();
		await page.waitForSelector('[aria-label="More plugin actions"]', { visible: true });
		await page.locator('[aria-label="More plugin actions"]').click();
		await page.waitForSelector('[data-testid="plugin-top-bar-menu"]', { visible: true });
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="plugin-top-bar-menu"]', { hidden: true });
		const sessionTitleStyle = await page.$eval('main header [data-plugin-chrome-title]', node => {
			const style = getComputedStyle(node);
			return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing };
		});
		assert.deepEqual(sessionTitleStyle, evidence.pluginTitleStyle, "Plugin view titles match session-title typography exactly");
		evidence.assertions.push("Session top-bar actions use keyboard-accessible three-dot overflow; plugin titles match session typography exactly");
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

		// This stage uses only the public backend context and real same-origin
		// settings/provider/activity routes. The fixture provider is SERVER-side
		// loopback traffic; the browser's off-origin allowlist stays unchanged.
		const admissionCall = async operation => page.evaluate(async ({ route, operation }) => {
			const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation }) });
			const payload = await response.json();
			if (!response.ok) throw new Error(operation + ": " + response.status + ": " + JSON.stringify(payload));
			return payload.result;
		}, { route: `${PLUGIN}/call`, operation });
		const waitAdmission = async (label, expected, stableMs = 0) => {
			const handle = await page.waitForFunction(async ({ route, expected, earliest }) => {
				const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "admission-status" }) });
				const payload = await response.json();
				if (!response.ok) throw new Error(JSON.stringify(payload));
				const result = payload.result;
				const cancelled = result.tasks.filter(task => task.status === "cancelled").length;
				return Object.entries(expected).every(([key, value]) => (key === "cancelled" ? cancelled : result.counts[key]) === value)
					&& Date.now() >= earliest ? result : false;
			}, { timeout: timeoutMs, polling: 100 }, { route: `${PLUGIN}/call`, expected, earliest: Date.now() + stableMs });
			const snapshot = await handle.jsonValue();
			await handle.dispose();
			assert.equal(snapshot.counts.completed, 0, "Held mock must never complete a provider response");
			evidence.admission.push({ label, ...snapshot });
			return snapshot;
		};
		const setConcurrency = async value => {
			// Exercise the main-header gear deep-link, then the real Agent tab.
			await page.locator('main button[aria-label="Plugin settings"]').click();
			await page.waitForSelector('[data-testid="section-plugin-native-smoke"]', { visible: true });
			await page.locator('[data-testid="settings-nav-agent"]').click();
			await page.waitForSelector(CONCURRENCY_INPUT, { visible: true });
			const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings/agent" && response.request().method() === "PUT");
			await page.locator(CONCURRENCY_INPUT).fill(String(value));
			await page.keyboard.press("Enter");
			const response = await saved;
			assert.equal(response.status(), 200, "Agent UI concurrency write must succeed");
			const record = await page.evaluate(async () => {
				const response = await fetch("/api/settings");
				if (!response.ok) throw new Error("Settings GET failed: " + response.status);
				return response.json();
			});
			assert.equal(record.settings?.agent?.workerRequestConcurrency, value, "GET must confirm the UI's stored numeric override");
			assert.equal(await page.$eval(CONCURRENCY_INPUT, input => input.value), String(value));
			evidence.settingsWrites.push({ value, record });
			await closeSettings();
			await health();
		};
		const taskRow = id => `${WORKER_ROW}[data-activity-id=${JSON.stringify(`native-smoke:${id}`)}]`;
		const assertRows = async ids => {
			await page.waitForFunction(({ selector, ids }) => {
				const rows = [...document.querySelectorAll(selector)];
				return rows.length === ids.length && ids.every(id => rows.some(row => row.dataset.activityId === "native-smoke:" + id));
			}, { timeout: timeoutMs }, { selector: WORKER_ROW, ids });
			for (const id of ids) {
				const selector = taskRow(id);
				assert.match(await page.$eval(selector, row => row.textContent), /Runtime proof · admission-proof/);
				assert.equal(await page.$$eval(`${selector} a[href^="/chat/"]`, links => links.length), 0, "Standalone workers must not invent a conversation link");
			}
			const feed = await page.evaluate(async () => {
				const response = await fetch("/api/activity");
				if (!response.ok) throw new Error("Activity GET failed: " + response.status);
				return response.json();
			});
			const rows = feed.pluginWorkers.filter(row => row.pluginId === "native-smoke");
			assert.deepEqual(rows.map(row => row.taskId).sort(), [...ids].sort(), "Activity feed must agree with the standalone panel rows");
			assert.ok(rows.every(row => row.title === "Runtime proof · admission-proof"));
		};
		const endTask = async id => {
			const selector = taskRow(id);
			const ended = page.waitForResponse(response => new URL(response.url()).pathname === "/api/activity/abort"
				&& response.request().method() === "POST" && response.request().postData() === JSON.stringify({ kind: "plugin-worker", id: `native-smoke:${id}` }));
			await page.locator(`${selector} [data-testid="activity-abort"]`).click();
			assert.equal((await ended).status(), 200, "Actual panel END must cancel the namespaced standalone task");
		};

		evidence.stage = "worker admission: UI limit 1 and keyless LOOPBACK provider";
		const untouched = await admissionCall("admission-status");
		assert.deepEqual(untouched.tasks, [], "Activation must not automatically start workers");
		assert.equal(untouched.counts.requests, 0);
		assert.equal(untouched.counts.active, 0);
		await setConcurrency(1);
		const mock = new URL(untouched.mockBase);
		assert.equal(mock.hostname, "127.0.0.1");
		assert.equal(mock.protocol, "http:");
		assert.equal(mock.pathname, "/v1");
		const configured = await page.evaluate(async baseUrl => {
			const before = await fetch("/api/custom-provider");
			if (!before.ok) throw new Error("Custom provider GET failed: " + before.status);
			const etag = before.headers.get("etag");
			await before.json();
			if (!etag) throw new Error("Custom provider GET did not provide an ETag");
			const response = await fetch("/api/custom-provider", { method: "POST", headers: { "content-type": "application/json", "If-Match": etag }, body: JSON.stringify({ baseUrl, authMode: "keyless" }) });
			const payload = await response.json();
			if (!response.ok) throw new Error("Custom provider POST: " + response.status + ": " + JSON.stringify(payload));
			const after = await fetch("/api/custom-provider");
			if (!after.ok) throw new Error("Custom provider verification GET failed");
			return { etag, payload, configured: await after.json() };
		}, untouched.mockBase);
		assert.equal(configured.configured.baseUrl, untouched.mockBase);
		assert.equal(configured.configured.authMode, "keyless");
		assert.ok(configured.payload.models.some(model => model.id === "admission-fixture"), "Real custom-provider discovery must find the mock /models endpoint");
		evidence.customProvider = configured;
		const batch = await admissionCall("admission-start");
		const ids = batch.tasks.map(task => task.id);
		assert.equal(new Set(ids).size, 3);
		assert.ok(batch.tasks.every(task => task.definitionId === "admission-proof"));
		await waitAdmission("limit 1: one active, two admission waiters", { requests: 1, active: 1, peak: 1, cancelled: 0 }, 400);
		await assertRows(ids);
		await page.locator(`${taskRow(ids[0])} button[aria-expanded]`).click();
		await page.waitForSelector(`${taskRow(ids[0])} [data-testid="activity-blob-detail"]`, { visible: true });
		assert.equal(await page.$$eval(`${WORKER_ROW} a[href^="/chat/"]`, links => links.length), 0, "Expanded standalone detail has no session link");
		await screenshot("admission-limit-1");

		evidence.stage = "worker admission: live UI increase 2 then decrease 1";
		await setConcurrency(2);
		await waitAdmission("limit 2: next FIFO request admitted", { requests: 2, active: 2, peak: 2, cancelled: 0 }, 400);
		await assertRows(ids);
		await screenshot("admission-limit-2");
		await setConcurrency(1);
		await waitAdmission("decrease preserves both active requests and holds third", { requests: 2, active: 2, peak: 2, cancelled: 0 }, 500);
		await assertRows(ids);
		await screenshot("admission-decreased");

		evidence.stage = "worker admission: actual panel END and FIFO release";
		await endTask(ids[0]);
		await waitAdmission("first END leaves one active and third still waiting", { requests: 2, active: 1, peak: 2, aborted: 1, cancelled: 1 }, 500);
		await assertRows(ids.slice(1));
		await screenshot("admission-first-end");
		await endTask(ids[1]);
		await waitAdmission("second END admits third", { requests: 3, active: 1, peak: 2, aborted: 2, cancelled: 2 }, 400);
		await assertRows(ids.slice(2));
		await screenshot("admission-third-admitted");
		await endTask(ids[2]);
		const terminal = await waitAdmission("all END: no active requests, every task cancelled", { requests: 3, active: 0, peak: 2, aborted: 3, cancelled: 3 }, 400);
		await assertRows([]);
		assert.ok(terminal.counts.models >= 1);
		assert.ok(terminal.requests.every(request => request.model === "admission-fixture" && request.stream === true), "Only the explicit fixture model's held streaming protocol was exercised");
		assert.ok(terminal.tasks.every(task => task.status === "cancelled" && task.error?.code === "cancelled"));
		await health();
		await screenshot("admission-cancelled");
		evidence.assertions.push("Agent numeric UI stores 1→2→1; real ETag/keyless custom-provider discovery uses activation-owned loopback only; three standalone workers remain visible without session links; panel END releases FIFO admission and all end cancelled, with zero completed provider responses (no generation tested)");

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
		assert.ok(await page.$('[data-testid="plugin-worker-card"] details:not([open])'), "Default worker fallback uses collapsed research/PDF presentation");
		await page.locator('[data-testid="plugin-worker-card"] details > summary').click();
		await page.waitForSelector('[data-testid="plugin-worker-fallback"]', { visible: true });
		evidence.assertions.push("Disabling renderers preserves raw fence source, native call details and the later background result");
		await screenshot("lesson-fallbacks");
		await health();
		evidence.expectedFixtureResponses = evidence.responses.filter(expectedFixtureResponse);
		evidence.expectedFrameworkAborts = evidence.failedRequests.filter(expectedFrameworkAbort);
		evidence.stage = "passed";
		console.log("[smoke-plugin-browser] expected keyless-app baseline responses:", evidence.expectedFixtureResponses.map(entry => `${new URL(entry.url).pathname} ${entry.status}`).join(", "));
		console.log("[smoke-plugin-browser] Settings enable → native ESM/relative asset → backend RPC → controlled full-content knowledge picker + native source editing → Home/remount → dialog/Settings foreground restoration → Agent UI 1→2→1 + held loopback admission/FIFO + panel END cancellations (no generation) → Settings disable/assets denied");
	} catch (error) {
		failed = error;
		try { await screenshot("failure"); }
		catch (captureError) { evidence.screenshotError = String(captureError); }
	} finally {
		evidence.expectedPickerReadAborts = evidence.failedRequests.filter(expectedPickerReadAbort);
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
			failedRequests: evidence.failedRequests, expectedPickerReadAborts: evidence.expectedPickerReadAborts, blockedRequests: evidence.blockedRequests,
			unsuccessfulResponses: evidence.responses.filter(entry => entry.status >= 400),
			recentResponses: evidence.responses.slice(-12), screenshots: evidence.screenshots,
		};
		const error = new Error(`Plugin browser smoke failed during ${evidence.stage}: ${failed.message ?? failed}\n${JSON.stringify(diagnostic, null, 2)}`, { cause: failed });
		error.evidence = evidence;
		throw error;
	}
	return evidence;
}
