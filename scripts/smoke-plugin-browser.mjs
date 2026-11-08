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
import { PLUGIN_KNOWLEDGE_FIXTURE as KNOWLEDGE, PLUGIN_PICKER_SETTINGS_FIXTURE as PICKER_SETTINGS, PLUGIN_QUESTION_FIXTURE as QUESTION, PLUGIN_SESSION_FIXTURE as SESSION } from "./smoke-plugin-runtime.mjs";

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
const PICKER_DIALOG = '[role="dialog"][aria-label="Picker dialog proof"] [data-plugin-ui-dialog]';
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

/** Page-origin pickers own the main pane, never the sidebar or a modal. */
export async function assertPaneKnowledgePicker(page) {
	const geometry = await page.$eval(KNOWLEDGE_OVERLAY, overlay => {
		const box = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
		const main = document.querySelector("main"), sidebar = document.querySelector("aside");
		const pane = overlay.closest('[data-plugin-knowledge-picker-pane]');
		const side = sidebar.getBoundingClientRect();
		const hit = document.elementFromPoint(side.left + side.width / 2, side.top + Math.min(side.height / 2, 150));
		return { ...box(overlay), main: box(main), inMain: main.contains(overlay), paneOwned: pane?.parentElement === main,
			region: pane?.getAttribute("role"), popupOwner: pane?.querySelector('[data-interaction-popup-host]')?.getAttribute('data-interaction-popup-host'),
			modal: !!overlay.closest('[role="dialog"]'), isolated: !!overlay.closest('[inert], [aria-hidden="true"]'),
			coversSidebar: overlay.contains(hit), sidebarHit: sidebar.contains(hit), sidebarIsolated: !!sidebar.closest('[inert], [aria-hidden="true"]'),
			focused: overlay.contains(document.activeElement), count: document.querySelectorAll('[data-testid="chain-table-overlay"]').length };
	});
	assert.equal(geometry.count, 1, "Page picker must reuse exactly one shared overlay");
	assert.equal(geometry.inMain && geometry.paneOwned, true, "Page picker must belong to the host's main-pane view");
	assert.equal(geometry.region, "region"); assert.equal(geometry.popupOwner, "knowledge-picker", "Pane owns its popup host");
	assert.equal(geometry.modal || geometry.isolated, false, "Eligible page picker must NOT acquire a modal boundary");
	for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(geometry[dimension] - geometry.main[dimension]) <= 1, `Page picker must fill only the main pane: ${dimension}`);
	assert.equal(geometry.coversSidebar || geometry.sidebarIsolated, false, "Page picker must not cover or isolate the sidebar");
	assert.equal(geometry.sidebarHit && geometry.focused, true, "Sidebar remains hit-testable while picker owns initial content focus");
	return geometry;
}

/** Modal-origin assertions stay strict; never reuse these for page origins. */
export async function assertModalKnowledgePicker(page) {
	const geometry = await page.$eval(KNOWLEDGE_OVERLAY, overlay => {
		const bounds = overlay.getBoundingClientRect();
		const modal = overlay.closest('[role="dialog"][data-interaction-layer]');
		const sidebar = document.querySelector("aside");
		const side = sidebar.getBoundingClientRect();
		const hit = document.elementFromPoint(side.left + side.width / 2, side.top + Math.min(side.height / 2, 150));
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
			viewportWidth: innerWidth, viewportHeight: innerHeight, modal: !!modal, active: modal?.getAttribute("aria-modal") === "true",
			inMain: !!overlay.closest("main"), coversSidebar: overlay.contains(hit), sidebarIsolated: !!sidebar.closest('[inert], [aria-hidden="true"]') };
	});
	assert.equal(geometry.modal && geometry.active, true, "Picker must use the shared active semantic modal boundary");
	assert.equal(geometry.inMain, false, "Picker must not remain portaled beneath a content-area z40 surface");
	for (const [dimension, value] of Object.entries({ x: 0, y: 0, width: geometry.viewportWidth, height: geometry.viewportHeight })) assert.ok(Math.abs(geometry[dimension] - value) <= 1, `Picker must fill the viewport: ${dimension}`);
	assert.equal(geometry.coversSidebar && geometry.sidebarIsolated, true, "The full-window picker must cover and isolate the sidebar");
	return geometry;
}

/** Permanent real registry → Chat regression, independently callable without
 * the broad model/worker campaign. Caller supplies existing public actions. */
export async function verifySessionHelperShortcutOwnership({ page, chord, openSurface, closeSurface }) {
	const helperSelector = '[data-testid="side-thread-popover"]';
	const inputSelector = '[data-testid="side-thread-input"]';
	const nativeEntry = '[data-testid="side-conversation-button"]';
	const draft = "Registry shortcut retained helper draft";
	assert.equal(await page.$(helperSelector), null, "Start with the native helper closed");
	await page.focus(nativeEntry); await chord("j");
	await page.waitForSelector(helperSelector, { visible: true });
	await page.locator(inputSelector).fill(draft);
	const helper = await page.$(helperSelector);
	try {
		await openSurface();
		await page.waitForFunction(() => !!document.activeElement?.closest('[data-plugin-session-surface]'));
		assert.equal(await helper.evaluate(node => node.isConnected && !!node.closest('[inert], [aria-hidden="true"]')), true, "Same open native helper starts covered");
		await chord("j");
		// Let the real command's async finishFor/React close settle on the RED
		// baseline; checking immediately after dispatch can hide the regression.
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const covered = await helper.evaluate((node, { helperSelector, inputSelector }) => ({
			same: node.isConnected && document.querySelector(helperSelector) === node,
			covered: !!node.closest('[inert], [aria-hidden="true"]'), draft: node.querySelector(inputSelector)?.value,
			surfaceOwnsFocus: !!document.activeElement?.closest('[data-plugin-session-surface]'),
		}), { helperSelector, inputSelector });
		assert.equal(covered.same, true, "Registry Mod+J must not close/unmount a covered Chat helper");
		assert.equal(covered.covered && covered.surfaceOwnsFocus, true); assert.equal(covered.draft, draft);
		await closeSurface();
		await page.waitForSelector('[data-plugin-session-surface]', { hidden: true });
		assert.equal(await helper.evaluate(node => node.isConnected && !node.closest('[inert], [aria-hidden="true"]')), true);
		await page.focus(nativeEntry); await chord("j");
		await page.waitForSelector(helperSelector, { hidden: true });
		assert.equal(await helper.evaluate(node => node.isConnected), false, "Eligible registry Mod+J closes normally");
		await openSurface();
		await page.waitForFunction(() => !!document.activeElement?.closest('[data-plugin-session-surface]'));
		await chord("j");
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert.equal(await page.$(helperSelector), null, "Registry Mod+J cannot open an inactive native helper either");
		await closeSurface(); await page.waitForSelector('[data-plugin-session-surface]', { hidden: true });
		await page.focus(nativeEntry); await chord("j");
		await page.waitForSelector(helperSelector, { visible: true });
		assert.equal(await page.$eval(inputSelector, input => input.value), draft, "Eligible reopen retains the exact draft");
		await chord("j"); await page.waitForSelector(helperSelector, { hidden: true });
		return { covered, coveredClosedStaysClosed: true, eligibleOpenCloseReopen: true, draftRetained: true };
	} finally { await helper.dispose(); }
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
		rpc: [], admission: [], questions: [], sessionExtensions: [], questionWire: [], questionScroll: [], questionStreams: [], expectedQuestionReadAborts: [], knowledge: [], knowledgeOrganization: [], foreground: [], tooltips: [], markdown: [], settingsWrites: [], nativeNumbers: [], disabledProbes: [], screenshots: [], assertions: [],
	};
	let browser;
	let page;
	let recording = true;
	let knowledgePickerOpened = false;
	let markdownViewOrigin;
	let questionCanonicalGate;
	const questionWireReads = [];
	const questionNetworkStreams = new Map();
	const questionStreamSnapshots = () => [...questionNetworkStreams.values()].map(({ buffered, chunks, ...entry }) => ({ ...entry, text: Buffer.concat([buffered ?? Buffer.alloc(0), ...chunks]).toString("utf8") }));
	let disabledQuestionEditor;
	const requestStages = new WeakMap();
	let failed;
	const modifier = process.platform === "darwin" ? "Meta" : "Control";
	const chord = async key => {
		await page.keyboard.down(modifier);
		try { await page.keyboard.press(key); } finally { await page.keyboard.up(modifier); }
	};
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
			&& ["controlled knowledge bubble and full-content shared picker", "knowledge picker retains normal source rename/folder/drag editing", "SPA Home navigation and view reattach", "public dialog-origin picker foreground", "fresh Settings nests above an active main picker", "custom Settings-origin picker foreground"].includes(entry.requestStage ?? entry.stage);
	};
	// SessionModel deliberately reader.cancel()s after its explicit SSE [DONE]
	// terminal. Admit only this chat's exact successful terminal streams: CDP
	// must have observed the complete protocol and the same ERR_ABORTED.
	const expectedQuestionReadAbort = entry => {
		const target = new URL(entry.url);
		const streams = questionStreamSnapshots().filter(stream => stream.stage === (entry.requestStage ?? entry.stage)
			&& stream.url === entry.url && stream.failure === "net::ERR_ABORTED");
		return entry.method === "GET" && target.origin === base && [`/api/chats/${QUESTION.chatId}/stream`, `/api/chats/${SESSION.chatId}/stream`, `/api/chats/${SESSION.practiceId}/stream`].includes(target.pathname) && !target.search
			&& entry.failure?.errorText === "net::ERR_ABORTED"
			&& ["native plugin question: canonical predict authority and public editor", "native plugin question: check reading/reveal and thinking-off microphone", "session extensions: surfaces and image-only message", "session extensions: transformed native answer channels", "session extensions: model retry reuses accepted input", "session extensions: image-only practice thinking"].includes(entry.requestStage ?? entry.stage)
			&& streams.length > 0 && streams.every(stream => stream.status === 200 && stream.text.includes("data: [DONE]"))
			&& streams.some(stream => stream.failure === "net::ERR_ABORTED");
	};
	const health = async () => {
		evidence.expectedPickerReadAborts = evidence.failedRequests.filter(expectedPickerReadAbort);
		evidence.questionStreams = questionStreamSnapshots();
		evidence.expectedQuestionReadAborts = evidence.failedRequests.filter(expectedQuestionReadAbort);
		const alerts = await page.$$eval(`${ROW} [role="alert"], [data-testid="section-plugins"] > [role="alert"], main [role="alert"]`, (elements, { row, mount, view }) =>
			elements.filter(element => element.getClientRects().length).map(element => ({ text: element.textContent?.trim(),
				owner: element.closest(row) ? "plugin-native-smoke" : location.pathname === view && element.parentElement?.querySelector(mount.replace("main ", "")) ? "native-smoke/public-proof-panel" : "other" })), { row: ROW, mount: MOUNT, view: VIEW });
		const expectedAlerts = evidence.expectedSessionInterceptorFailure ? alerts.filter(alert => alert.text === "session fixture fail closed" && ["plugin-native-smoke", "native-smoke/public-proof-panel"].includes(alert.owner)) : [];
		assert.deepEqual(alerts.filter(alert => !expectedAlerts.includes(alert)), [], `Unexpected visible plugin/app alerts: ${JSON.stringify(alerts)}`);
		for (const owner of ["plugin-native-smoke", "native-smoke/public-proof-panel"]) assert.ok(expectedAlerts.filter(alert => alert.owner === owner).length <= 1, "Expected failure reporting must not duplicate owner alerts");
		if (expectedAlerts.length) {
			evidence.expectedSessionInterceptorAlerts ??= [];
			evidence.expectedSessionInterceptorAlerts.push({ stage: evidence.stage, alerts: expectedAlerts });
		}
		assert.deepEqual(evidence.pageErrors, [], "Browser page errors were emitted");
		assert.deepEqual(evidence.console.filter(entry => (entry.type === "error" || entry.type === "assert") && !expectedFixtureConsole(entry)), [], "Unexpected browser console errors were emitted");
		assert.deepEqual(evidence.failedRequests.filter(entry => !expectedFrameworkAbort(entry) && !expectedPickerReadAbort(entry) && !expectedQuestionReadAbort(entry)), [], "Unexpected browser requests failed (see network evidence)");
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
		await assertFullWindowPicker();
	};
	const assertFullWindowPicker = () => assertModalKnowledgePicker(page);
	const capturePickerOrigin = async (scope, draft) => {
		const root = `[data-smoke-picker-scope="${scope}"]`;
		const selector = `${root} [data-smoke-picker-draft="${scope}"]`;
		await page.locator(selector).fill(draft);
		const input = await page.$(selector);
		assert.ok(input);
		const identity = await page.$eval(root, element => ({ mountCount: Number(element.dataset.mountCount), instance: element.dataset.instance }));
		return { root, selector, input, draft, ...identity };
	};
	const assertPickerOrigin = async (label, origin, ids, callbacks, inactive, focused = false) => {
		await page.waitForFunction((input, { inactive, root, ids, callbacks }) => {
			if (!input.isConnected) return false;
			const state = document.querySelector(`${root} [data-smoke-picker-selection]`);
			if (!state || Number(state.dataset.callbacks) !== callbacks || JSON.stringify(JSON.parse(state.textContent).sort()) !== JSON.stringify([...ids].sort())) return false;
			let invisible = false;
			for (let node = input; node; node = node.parentElement) {
				const style = getComputedStyle(node);
				if (node.hidden || style.display === "none" || style.visibility === "hidden") invisible = true;
			}
			return !invisible && !!input.closest("[inert]") === inactive;
		}, { timeout: timeoutMs }, origin.input, { inactive, root: origin.root, ids, callbacks });
		if (focused) await page.waitForFunction(root => document.querySelector(`${root} [data-testid="practice-props-chip"]`) === document.activeElement, { timeout: timeoutMs }, origin.root);
		const snapshot = await page.evaluate((input, { root, selector }) => {
			const container = document.querySelector(root);
			const state = container.querySelector("[data-smoke-picker-selection]");
			return { sameInput: document.querySelector(selector) === input, connected: input.isConnected, draft: input.value,
				mountCount: Number(container.dataset.mountCount), instance: container.dataset.instance, signalAborted: container.dataset.signalAborted, cleanupCount: Number(container.dataset.cleanupCount), ids: JSON.parse(state.textContent), callbacks: Number(state.dataset.callbacks),
				chip: container.querySelector('[data-testid="practice-props-chip"]').textContent.trim(), inert: !!input.closest("[inert]") };
		}, origin.input, { root: origin.root, selector: origin.selector });
		assert.equal(snapshot.sameInput && snapshot.connected, true, "Launching modal/input must stay mounted while its selector is active");
		assert.equal(snapshot.mountCount, origin.mountCount, "Closing a picker must not remount its launching Settings/dialog content");
		assert.equal(snapshot.instance, origin.instance);
		assert.equal(snapshot.signalAborted, "false", "Coverage must not abort plugin content's lifetime signal");
		assert.equal(snapshot.cleanupCount, 0, "Coverage must not run plugin content cleanup");
		assert.equal(snapshot.draft, origin.draft);
		assert.deepEqual([...snapshot.ids].sort(), [...ids].sort());
		assert.equal(snapshot.callbacks, callbacks);
		assert.equal(snapshot.chip, ids.length ? `${ids.length} ${ids.length === 1 ? "node" : "nodes"} selected` : "Pick nodes");
		assert.equal(snapshot.inert, inactive, "Painted covered origins are inactive; resumed origins become interactive again");
		evidence.foreground.push({ label, painted: true, inactive, focused, ...snapshot });
	};
	const assertOriginOwnedMenu = async origin => {
		const trigger = `${origin.root} [data-smoke-picker-menu]`;
		await page.locator(trigger).click();
		await page.waitForSelector('[data-testid="plugin-menu"]', { visible: true });
		assert.equal(await page.$eval('[data-testid="plugin-menu"]', (menu, root) => menu.closest('[role="dialog"][data-interaction-layer]') === document.querySelector(root).closest('[role="dialog"][data-interaction-layer]'), origin.root), true, "App-root plugin menu portals must resolve their actual modal anchor owner");
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="plugin-menu"]', { hidden: true });
		await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, trigger);
		assert.equal(await origin.input.evaluate(input => input.isConnected && !input.closest("[inert]")), true, "Menu Escape must leave its parent modal mounted and active");
		assert.equal(await page.$eval(origin.root, root => Number(root.dataset.menuCloses)), 1, "One Escape must invoke only the original popup close callback");
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
	const markdownRoot = scope => `[data-smoke-markdown-scope="${scope}"]`;
	const markdownOutput = scope => `${markdownRoot(scope)} [data-smoke-markdown-output]`;
	const markdownAction = (scope, action) => page.locator(`${markdownRoot(scope)} [data-smoke-markdown-action="${action}"]`).click();
	const assertMarkdownNoControls = async scope => {
		assert.deepEqual(await page.$$eval(`${markdownOutput(scope)} button, ${markdownOutput(scope)} input, ${markdownOutput(scope)} textarea, ${markdownOutput(scope)} select, ${markdownOutput(scope)} [role="button"], ${markdownOutput(scope)} details, ${markdownOutput(scope)} summary, ${markdownOutput(scope)} a[download]`, nodes => nodes.map(node => node.outerHTML)), [], "Public static Markdown must contain no auxiliary action/disclosure controls, even hidden ones");
	};
	const assertMarkdownProse = async scope => {
		const style = await page.$eval(`${markdownOutput(scope)} .lh-prose`, prose => {
			const probe = document.createElement("span");
			probe.style.cssText = "font-family:var(--font-prose);font-size:var(--lh-prose-size);line-height:var(--lh-prose-leading)";
			prose.parentElement.append(probe);
			const actual = getComputedStyle(prose), expected = getComputedStyle(probe);
			const result = { actual: { fontFamily: actual.fontFamily, fontSize: actual.fontSize, lineHeight: actual.lineHeight }, expected: { fontFamily: expected.fontFamily, fontSize: expected.fontSize, lineHeight: expected.lineHeight } };
			probe.remove(); return result;
		});
		assert.deepEqual(style.actual, style.expected, "Public Markdown must use the native Settings-controlled prose typography");
		return style.actual;
	};
	const waitStaticFormatted = async scope => {
		await page.waitForFunction(selector => {
			const output = document.querySelector(selector), svg = output?.querySelector('[data-testid="md-mermaid"] svg'), image = output?.querySelector('img[alt="Static image proof"]');
			const highlighted = [...(output?.querySelectorAll('[data-streamdown="code-block"] code span') ?? [])].some(span => span.textContent.includes("const") && (span.style.color || span.style.getPropertyValue("--shiki-light") || span.style.getPropertyValue("--shiki-dark")));
			return output?.querySelectorAll(".katex").length >= 2 && !output.querySelector(".katex-error") && output.querySelector("table")?.textContent.includes("Static table proof")
				&& output.querySelector('[data-testid="md-callout"][data-alert-kind="important"]')?.textContent.includes("Static callout proof")
				&& highlighted && svg?.querySelector("path,rect,polygon") && svg.textContent.includes("Static start") && svg.getBoundingClientRect().width > 0
				&& image?.complete && image.naturalWidth === 48 && image.naturalHeight === 24;
		}, { timeout: timeoutMs }, markdownOutput(scope));
	};
	const assertStaticFormatted = async (scope, customBaseline) => {
		await waitStaticFormatted(scope); await assertMarkdownNoControls(scope);
		await markdownAction(scope, "probe");
		assert.equal(await page.$eval(markdownRoot(scope), root => Number(root.dataset.customMounts)), customBaseline, "Static registered-language fences must not invoke plugin code-block renderers");
		assert.equal(await page.$$eval(`${markdownOutput(scope)} [data-smoke-fence]`, nodes => nodes.length), 0);
		const snapshot = await page.$eval(markdownOutput(scope), output => ({
			headings: [...output.querySelectorAll("h1")].map(node => node.textContent), math: output.querySelectorAll(".katex").length,
			strong: output.querySelector("strong")?.textContent, emphasis: output.querySelector("em")?.textContent,
			highlightedTokens: [...output.querySelectorAll('[data-streamdown="code-block"] code span')].filter(span => span.style.color || span.style.getPropertyValue("--shiki-light") || span.style.getPropertyValue("--shiki-dark")).length,
			builtInCustomFence: [...output.querySelectorAll("pre")].some(pre => pre.textContent.includes("Static registered-language fence stays built-in.")),
			svgNodes: output.querySelector('[data-testid="md-mermaid"] svg')?.childElementCount,
			image: { src: output.querySelector("img").src, naturalWidth: output.querySelector("img").naturalWidth },
		}));
		assert.equal(snapshot.strong, "bold proof"); assert.equal(snapshot.emphasis, "italic proof"); assert.equal(snapshot.builtInCustomFence, true);
		assert.equal(new URL(snapshot.image.src).origin, base); assert.equal(new URL(snapshot.image.src).pathname, `${PLUGIN}/assets/assets/markdown-proof.svg`);
		const dialogs = await page.$$eval('[role="dialog"]', nodes => nodes.length);
		await page.locator(`${markdownOutput(scope)} img[alt="Static image proof"]`).click();
		assert.equal(await page.$$eval('[role="dialog"]', nodes => nodes.length), dialogs, "Static images do not add expansion/zoom dialogs");
		const link = await page.$eval(`${markdownOutput(scope)} a[href="#static-markdown-${scope}-anchor"]`, anchor => ({ href: anchor.href, target: anchor.target, rel: anchor.rel }));
		assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
		const originalUrl = page.url();
		const navigation = browser.waitForTarget(target => target !== page.target() && target.url() === link.href, { timeout: timeoutMs });
		await page.locator(`${markdownOutput(scope)} a[href="#static-markdown-${scope}-anchor"]`).click();
		const opened = await navigation, linkedPage = await opened.page();
		assert.ok(linkedPage, "Ordinary Markdown links retain the host's native new-tab navigation");
		assert.equal(page.url(), originalUrl, "A normal target=_blank link leaves the rendering page in place");
		await linkedPage.close(); await page.bringToFront();
		assert.equal(await page.$$eval('[role="dialog"]', nodes => nodes.length), dialogs, "Ordinary static Markdown links must not add a safety modal");
		snapshot.link = link;
		evidence.markdown.push({ scope, label: "built-in formatted snapshot", ...snapshot, prose: await assertMarkdownProse(scope), customBaseline });
	};
	const waitMarkdownPlain = async scope => {
		await page.waitForFunction(({ selector, earliest }) => {
			const output = document.querySelector(selector);
			return output?.querySelector(".lh-prose")?.textContent === "Static latest plain proof." && !output.querySelector("svg,pre,table,.katex,img") && Date.now() >= earliest;
		}, { timeout: timeoutMs, polling: 50 }, { selector: markdownOutput(scope), earliest: Date.now() + 500 });
	};
	const assertMarkdownEmpty = async (scope, sentinel) => {
		await page.waitForFunction(({ selector, earliest }) => {
			const output = document.querySelector(selector);
			return output?.childElementCount === 1 && !output.querySelector("[data-plugin-ui-widget],.lh-prose,svg") && Date.now() >= earliest;
		}, { timeout: timeoutMs, polling: 50 }, { selector: markdownOutput(scope), earliest: Date.now() + 500 });
		assert.equal(await sentinel.evaluate((node, selector) => node.isConnected && node.parentElement === document.querySelector(selector) && node.textContent === "Plugin-owned sentinel", markdownOutput(scope)), true, "Widget cleanup must not remove or replace plugin-owned DOM");
	};
	const exerciseStaticMarkdown = async scope => {
		await page.waitForSelector(`${markdownOutput(scope)} .lh-prose`, { visible: true });
		const sentinel = await page.$(`${markdownOutput(scope)} [data-smoke-markdown-sentinel]`);
		const customBaseline = await page.$eval(markdownRoot(scope), root => Number(root.dataset.customMounts));
		const observation = await page.evaluateHandle(selector => {
			const output = document.querySelector(selector), state = { pendingObserved: false, svgObserved: false };
			const observer = new MutationObserver(() => { state.pendingObserved ||= !!output.querySelector('[aria-busy="true"]'); state.svgObserved ||= !!output.querySelector("svg"); });
			observer.observe(output, { subtree: true, childList: true, attributes: true }); return { state, observer };
		}, markdownOutput(scope));
		await markdownAction(scope, "race"); await waitMarkdownPlain(scope);
		const raced = await observation.evaluate(({ state, observer }) => { observer.disconnect(); return state; }); await observation.dispose();
		evidence.markdown.push({ scope, label: "diagram update superseded by latest plain snapshot", ...raced, latestPlainRetained: true });
		assert.equal(raced.pendingObserved, true, "The race proof must observe real async Mermaid work before accepting the latest plain snapshot; an unrendered batched update is not evidence");
		await markdownAction(scope, "formatted"); await assertStaticFormatted(scope, customBaseline);
		await screenshot(`markdown-${scope}-formatted`);
		await markdownAction(scope, "invalid");
		await page.waitForFunction(selector => {
			const output = document.querySelector(selector), error = output?.querySelector('[data-streamdown="mermaid-error"]'), source = error?.querySelector("pre");
			return output?.querySelector("h1")?.textContent === "Invalid diagram proof" && error?.textContent.includes("Diagram failed to render") && source?.textContent.includes("Static[unterminated") && source.getClientRects().length > 0;
		}, { timeout: timeoutMs }, markdownOutput(scope));
		await assertMarkdownNoControls(scope); await screenshot(`markdown-${scope}-invalid-visible-source`);
		evidence.markdown.push({ scope, label: "invalid Mermaid keeps heading, error and source directly visible without disclosure/retry" });
		await markdownAction(scope, "plain"); await waitMarkdownPlain(scope);
		await markdownAction(scope, "diagram");
		await page.waitForFunction(selector => {
			const svg = document.querySelector(selector)?.querySelector('[data-testid="md-mermaid"] svg');
			return svg?.querySelector("path,rect,polygon") && svg.textContent.includes("Updated finish") && svg.getBoundingClientRect().width > 0;
		}, { timeout: timeoutMs }, markdownOutput(scope));
		await assertMarkdownNoControls(scope);
		await markdownAction(scope, "abort"); await assertMarkdownEmpty(scope, sentinel);
		assert.equal(await page.$eval(markdownRoot(scope), root => root.dataset.widgetAborted), "true");
		await markdownAction(scope, "remount"); await markdownAction(scope, "formatted"); await assertStaticFormatted(scope, customBaseline);
		await markdownAction(scope, "dispose"); await assertMarkdownEmpty(scope, sentinel);
		await markdownAction(scope, "remount");
		assert.equal(await page.$$eval(`${markdownOutput(scope)} [data-plugin-ui-widget]`, nodes => nodes.length), 1, "Remount must leave exactly one widget target");
		assert.equal(await sentinel.evaluate(node => node.isConnected), true); await sentinel.dispose();
		evidence.markdown.push({ scope, label: "signal abort, idempotent dispose, stale updates and remount retain owned sentinel without widget orphans", widgetMounts: await page.$eval(markdownRoot(scope), root => Number(root.dataset.widgetMounts)) });
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
		// Observe actual SSE bytes before the app's intentional terminal cancel;
		// Network.getResponseBody/Response.text lose cancelled Chromium bodies.
		const questionNetwork = await page.createCDPSession();
		await questionNetwork.send("Network.enable");
		questionNetwork.on("Network.responseReceived", event => {
			if (![QUESTION.chatId, SESSION.chatId, SESSION.practiceId].some(id => new URL(event.response.url).pathname === `/api/chats/${id}/stream`)) return;
			const stream = { requestId: event.requestId, url: event.response.url, stage: evidence.stage, status: event.response.status, buffered: undefined, chunks: [] };
			questionNetworkStreams.set(event.requestId, stream);
			questionWireReads.push(questionNetwork.send("Network.streamResourceContent", { requestId: event.requestId }).then(result => {
				stream.buffered = Buffer.from(result.bufferedData, "base64");
			}, error => { stream.captureError = String(error); }));
		});
		questionNetwork.on("Network.dataReceived", event => {
			if (event.data && questionNetworkStreams.has(event.requestId)) questionNetworkStreams.get(event.requestId).chunks.push(Buffer.from(event.data, "base64"));
		});
		questionNetwork.on("Network.loadingFailed", event => {
			if (questionNetworkStreams.has(event.requestId)) questionNetworkStreams.get(event.requestId).failure = event.errorText;
		});
		await page.setRequestInterception(true);
		page.on("request", request => {
			requestStages.set(request, evidence.stage);
			const target = new URL(request.url());
			if (recording) evidence.requests.push({ method: request.method(), url: request.url(), type: request.resourceType(), stage: evidence.stage });
			// Hold only the question chat's real terminal canonical GET, never
			// fabricate a record/result. Native persistence keeps running normally.
			if (questionCanonicalGate && target.pathname === `/api/chats/${QUESTION.chatId}` && request.method() === "GET") {
				questionCanonicalGate.requests.push(request); questionCanonicalGate.resolve(); return;
			}
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
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`, `${PLUGIN}/assets/assets/markdown-proof.js`, `${PLUGIN}/assets/assets/question-proof.js`, `${PLUGIN}/assets/assets/session-proof.js`]) {
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

		evidence.stage = "public display-only Markdown in view and dialog";
		await exerciseStaticMarkdown("view");
		markdownViewOrigin = await page.$(markdownRoot("view"));
		assert.equal(await markdownViewOrigin.evaluate(root => Number(root.dataset.viewMount)), 1);
		await page.locator(`${MOUNT} button[title="Open static Markdown dialog"]`).click();
		await page.waitForSelector('[role="dialog"][aria-label="Static Markdown dialog proof"]', { visible: true });
		await exerciseStaticMarkdown("dialog");
		const markdownDialogOrigin = await page.$(markdownRoot("dialog"));
		await page.locator('[role="dialog"][aria-label="Static Markdown dialog proof"] [aria-label="Close dialog"]').click();
		await page.waitForSelector('[role="dialog"][aria-label="Static Markdown dialog proof"]', { hidden: true });
		assert.equal(await markdownDialogOrigin.evaluate(root => !root.isConnected && root.dataset.parentAborted === "true" && !root.querySelector("[data-plugin-ui-widget],svg")), true, "Closing a public dialog must abort and clean its Markdown widgets");
		await markdownDialogOrigin.dispose();
		assert.equal(await page.$$eval('[data-smoke-markdown-scope="dialog"]', nodes => nodes.length), 0);
		await health();
		evidence.assertions.push("Public ctx.ui.mountMarkdown uses native prose/math/highlighting/table/callout/Mermaid/image rendering in ordinary view and public dialog without auxiliary controls or plugin code-block widgets; links navigate normally; invalid Mermaid source is immediately visible; updates, abort, idempotent disposal and remount preserve plugin-owned DOM");

		evidence.stage = "controlled knowledge bubble and full-content shared picker";
		await assertKnowledge("initial controlled empty value", [], 0);
		await openKnowledge();
		evidence.knowledgeBounds = await page.evaluate(selector => {
			const overlay = document.querySelector(selector);
			const main = document.querySelector("main");
			const sidebar = document.querySelector("aside");
			const header = overlay.querySelector("header");
			const bounds = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
			return { overlay: bounds(overlay), main: bounds(main), header: bounds(header), sidebar: bounds(sidebar),
				sharedDragHeader: header.classList.contains("lh-drag"), counts: header.textContent };
		}, KNOWLEDGE_OVERLAY);
		const geometry = evidence.knowledgeBounds;
		evidence.knowledgePaneBounds = await assertPaneKnowledgePicker(page);
		assert.equal(geometry.sharedDragHeader, true);
		assert.equal(geometry.header.height, 60, "Picker must retain the standard TopBar");
		assert.equal(geometry.header.y, 0);
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
		await markdownAction("view", "formatted");
		await assertStaticFormatted("view", 0);
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		assert.equal(await page.$eval(`[data-testid="chain-checkbox-${KNOWLEDGE.chainId}"]`, input => input.checked), false);
		await screenshot("knowledge-cleared");
		evidence.assertions.push("Public controlled page-origin knowledge picker reuses native bubble and main-pane view ChainTableOverlay/TopBar, leaves the sidebar available, reports chain/proposition IDs and count immediately, retains values through Done/X/Escape and clears via callback");

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
		// Leave it OPEN: the existing global Graph/Home chord must dispose the
		// pane with the view signal, without requiring a sidebar interaction
		// or adding proof RPCs.

		evidence.stage = "SPA Home navigation and view reattach";
		await chord("g");
		await page.waitForFunction(mount => window.location.pathname === "/" && document.querySelectorAll(mount).length === 0, {}, MOUNT);
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0, "Route-away must dispose the open knowledge portal, not leave an orphan over Home");
		assert.equal(await markdownViewOrigin.evaluate(root => !root.isConnected && root.dataset.parentAborted === "true" && !root.querySelector("[data-plugin-ui-widget],svg")), true, "Route-away must abort formatted Markdown without stale SVG/widget descendants");
		await markdownViewOrigin.dispose();
		assert.equal(await page.$$eval('[data-smoke-markdown-output]', nodes => nodes.length), 0, "Markdown must not orphan DOM after its plugin view signal ends");
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
		for (const asset of ["/plugin-loader.js", `${PLUGIN}/assets/main.js`, `${PLUGIN}/assets/assets/helper.js`, `${PLUGIN}/assets/assets/markdown-proof.js`, "/api/events"]) {
			assert.equal(evidence.requests.filter(entry => new URL(entry.url).pathname === asset).length, 1, `SPA navigation must not duplicate the loader, activation imports, or standing SSE channel: ${asset}`);
		}
		assert.equal(evidence.rpc.length, 2, "Returning to the view must mount it again and read fresh backend state");
		assert.equal(await page.$$eval(markdownRoot("view"), nodes => nodes.length), 1);
		assert.equal(await page.$eval(markdownRoot("view"), root => Number(root.dataset.viewMount)), 2);
		assert.equal(await page.$$eval(`${markdownOutput("view")} [data-plugin-ui-widget]`, nodes => nodes.length), 1);
		assert.equal(await page.$eval(`${markdownOutput("view")} .lh-prose`, root => root.textContent), "Static plain proof.");
		evidence.markdown.push({ label: "Home disposes formatted view and returning mounts exactly one fresh Markdown widget", viewMount: 2, rpcCount: evidence.rpc.length });
		assert.equal(await page.$$eval(KNOWLEDGE_CHIP, nodes => nodes.length), 1, "Reattached view must not duplicate the picker bubble");
		assert.equal(await page.$$eval(KNOWLEDGE_OVERLAY, nodes => nodes.length), 0);
		await assertKnowledge("fresh view mount owns fresh picker state", [], 0);
		await openKnowledge();
		await page.locator(`${KNOWLEDGE_OVERLAY} [data-testid="chain-table-close"]`).click();
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		evidence.assertions.push("Leaving an open picker disposes its full-window modal; return mounts one bubble and reopens exactly one shared overlay without changing proof-RPC counts");
		evidence.assertions.push("Home navigation disposes view DOM; return remounts once without duplicating activation, links, roots, or SSE");
		await screenshot("reattached");

		evidence.stage = "public dialog-origin picker foreground";
		await page.locator(`${MOUNT} button[title="Open knowledge dialog"]`).click();
		await page.waitForSelector(PICKER_DIALOG, { visible: true });
		const dialogOrigin = await capturePickerOrigin("dialog", "Dialog draft survives selector foreground");
		await assertOriginOwnedMenu(dialogOrigin);
		await openForegroundPicker(dialogOrigin.root);
		await page.waitForSelector(PICKER_DIALOG, { visible: true });
		await assertPickerOrigin("dialog origin remains painted/inert and its input remains mounted", dialogOrigin, [], 0, true);
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
		evidence.assertions.push("Public dialog-origin knowledge picker keeps its launching dialog painted/inert and retains its input instance/lifetime signal; controlled IDs update; Escape/Done/X close only selector and restore original draft, mount count and trigger focus; normal dialog close still disposes content");

		evidence.stage = "fresh Settings nests above an active main picker";
		await openKnowledge();
		await expandKnowledge(`cluster-toggle-${KNOWLEDGE.sourceId}`);
		await expandKnowledge(`chain-toggle-${KNOWLEDGE.chainId}`);
		const selectedPremise = `${KNOWLEDGE_OVERLAY} [data-testid="prop-checkbox-${KNOWLEDGE.premiseId}"]`;
		await page.locator(selectedPremise).click();
		await assertKnowledge("main picker selection before a newer Settings surface", [KNOWLEDGE.premiseId], 1);
		const retainedPicker = await page.$(KNOWLEDGE_OVERLAY);
		const retainedSelection = await page.$(selectedPremise);
		const pickerFocus = await page.evaluateHandle(() => document.activeElement);
		// The sidebar is isolated by the picker. Use the existing global command,
		// not a synthetic click into the inactive background.
		await chord(",");
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1);
		assert.equal(await retainedPicker.evaluate(overlay => overlay.isConnected && !!overlay.closest("[inert]") && getComputedStyle(overlay).display !== "none"), true, "Fresh Settings must cover the same painted picker, not close/remount it");
		assert.equal(await retainedSelection.evaluate(input => input.isConnected && input.checked), true);
		assert.equal(await page.$eval('[data-testid="settings-dialog"]', dialog => {
			const bounds = dialog.getBoundingClientRect();
			return dialog.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
		}), true, "Fresh Settings opens above the retained picker");
		await assertKnowledge("Settings covers the picker without clearing controlled IDs", [KNOWLEDGE.premiseId], 1);
		await screenshot("foreground-newer-settings");
		// Passive help must paint above its owning modal without becoming an
		// Escape owner. One physical Escape still closes Settings, not just help.
		await page.hover('[data-testid="settings-close"]');
		await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="tooltip-content"]')].some(tooltip => {
			const bounds = tooltip.getBoundingClientRect();
			return tooltip.textContent === "Close (Esc)" && bounds.width > 0 && bounds.height > 0 && getComputedStyle(tooltip).visibility !== "hidden";
		}));
		const tooltipPaint = await page.evaluate(() => {
			const tooltip = [...document.querySelectorAll('[data-slot="tooltip-content"]')].find(node => node.textContent === "Close (Esc)" && node.getBoundingClientRect().width > 0);
			const bounds = tooltip.getBoundingClientRect();
			return { text: tooltip.textContent, owned: !!tooltip.closest("[data-interaction-popup-host]"),
				painted: tooltip.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)) };
		});
		assert.deepEqual(tooltipPaint, { text: "Close (Esc)", owned: true, painted: true });
		evidence.tooltips.push(tooltipPaint);
		await screenshot("foreground-settings-passive-tooltip");
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true });
		await page.mouse.move(0, 0);
		await page.waitForFunction(input => document.activeElement === input, { timeout: timeoutMs }, pickerFocus);
		assert.equal(await retainedPicker.evaluate((overlay, selector) => overlay.isConnected && document.querySelector(selector) === overlay && !overlay.closest("[inert]"), KNOWLEDGE_OVERLAY), true);
		assert.equal(await retainedSelection.evaluate(input => input.isConnected && input.checked), true, "Resuming the same picker retains the actual selection control");
		await assertFullWindowPicker();
		await assertKnowledge("closing fresh Settings resumes the mounted picker and its controlled selection", [KNOWLEDGE.premiseId], 1);
		await screenshot("foreground-settings-picker-resumed");
		evidence.foreground.push({ label: "Fresh Settings nests above the same picker and returns focus on close", pickerRetained: true, selectionRetained: true, focusRestored: true, ids: [KNOWLEDGE.premiseId] });
		await retainedPicker.dispose(); await retainedSelection.dispose(); await pickerFocus.dispose();
		await page.keyboard.press("Escape");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.locator(`${MOUNT} [data-testid="practice-props-clear"]`).click();
		await assertKnowledge("main selection cleared explicitly after Settings dismissal proof", [], 2);
		await health();
		evidence.assertions.push("Global Mod+, opens absent Settings above the same painted/inert picker; its passive tooltip paints in the owned portal and does not intercept the single Escape closing Settings; the mounted picker selection and eligible focus resume, and the next Escape closes only picker");

		evidence.stage = "custom Settings-origin picker foreground";
		await openPlugins();
		await page.waitForSelector(`${PICKER_SETTINGS_TOGGLE}[aria-checked="false"]`, { visible: true });
		await togglePickerSettings(true);
		const settingsNav = `[data-testid="settings-nav-plugin:${PICKER_SETTINGS.id}"]`;
		await page.waitForSelector(settingsNav, { visible: true });
		await page.locator(settingsNav).click();
		await page.waitForSelector(`[data-testid="section-plugin-${PICKER_SETTINGS.id}"]`, { visible: true });
		const settingsOrigin = await capturePickerOrigin("settings", "Custom Settings draft survives selector foreground");
		await assertOriginOwnedMenu(settingsOrigin);
		await openForegroundPicker(settingsOrigin.root);
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		await assertPickerOrigin("custom Settings origin remains painted/inert without remounting", settingsOrigin, [], 0, true);
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
		const retainedSettings = await page.$('[data-testid="settings-dialog"]');
		await openForegroundPicker(settingsOrigin.root);
		await assertPickerOrigin("existing Settings remains painted/inert below child before return-to", settingsOrigin, settingsIds, 1, true);
		// Existing same-section deep-link: prove retained plugin content without
		// confusing normal section navigation with a modal remount.
		await page.evaluate(pluginId => window.dispatchEvent(new CustomEvent("lh:open-plugin-settings", { detail: pluginId })), PICKER_SETTINGS.id);
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1, "Return-to must not create another Settings instance");
		assert.equal(await retainedSettings.evaluate(dialog => dialog.isConnected && document.querySelector('[data-testid="settings-dialog"]') === dialog), true);
		await assertPickerOrigin("same-section deep-link closes child through return-to and retains Settings frame/input/mount/IDs", settingsOrigin, settingsIds, 1, false, true);
		await screenshot("foreground-settings-restored");
		await openForegroundPicker(settingsOrigin.root);
		await assertPickerOrigin("custom input is retained until intentional section navigation", settingsOrigin, settingsIds, 1, true);
		await chord(",");
		await page.waitForSelector(KNOWLEDGE_OVERLAY, { hidden: true });
		await page.waitForSelector('[data-testid="section-keys"]', { visible: true });
		assert.equal(await retainedSettings.evaluate(dialog => dialog.isConnected && document.querySelector('[data-testid="settings-dialog"]') === dialog), true, "Mod+, must reuse the same Settings frame while retargeting Providers");
		assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1);
		assert.equal(await settingsOrigin.input.evaluate(input => input.isConnected), false, "Existing Mod+, default intentionally leaves the custom Settings section");
		evidence.foreground.push({ label: "Mod+, guarded return-to reuses Settings frame and retargets existing Providers default", sameSettingsFrame: true, pickerClosed: true, providersVisible: true, customSectionDisposedOnNavigation: true });
		await retainedSettings.dispose();
		await screenshot("foreground-settings-return-providers");
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
		evidence.assertions.push("Frontend-only auxiliary custom Settings uses the public registration/widget API; selector retains painted/inert Settings DOM, uncontrolled draft, mount count, lifetime signal and controlled IDs; Done/X/Escape and same-section return-to restore trigger focus; separate Mod+, returns to the same frame and existing Providers default; auxiliary package disables through normal UI without remounting the view or replacing native-smoke schema Settings");

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
		assert.equal(await page.$eval(markdownRoot("view"), root => Number(root.dataset.customMounts)), 1, "Ordinary stored teaching Markdown still invokes its registered code-block renderer exactly once");

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

		evidence.stage = "Settings native number Escape retention and canonical acknowledgment";
		await chord(",");
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		const settingsRecord = () => page.evaluate(async () => {
			const response = await fetch("/api/settings");
			if (!response.ok) throw new Error("Native-number verification Settings GET failed: " + response.status);
			return response.json();
		});
		const cdp = await page.createCDPSession();
		const selectNativeNumber = async selector => {
			await page.focus(selector);
			// Headless synthetic Mod+A does not invoke macOS's native editing
			// command reliably for number inputs (also reproduced without React).
			// Dispatch Chromium's native selectAll command, never assign .value
			// or replace the number input/native incomplete-token buffer.
			const event = { key: "a", code: "KeyA", modifiers: modifier === "Meta" ? 4 : 2 };
			await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyDown", commands: ["selectAll"] });
			await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
		};
		const numberSnapshot = async selector => {
			const state = await page.$eval(selector, input => ({ value: input.value, badInput: input.validity.badInput,
				focused: document.activeElement === input, type: input.type, min: input.getAttribute("min"), max: input.getAttribute("max"), step: input.getAttribute("step"),
				appearance: getComputedStyle(input).appearance, spinAppearance: getComputedStyle(input, "::-webkit-inner-spin-button").appearance }));
			// Chromium exposes its native editing buffer through the DevTools UA
			// shadow tree on versions that include that tree. DOM .value alone is
			// deliberately NOT used as proof of the visible incomplete token.
			try {
				const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
				const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
				const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
				const descendants = current => [...(current.children ?? []), ...(current.shadowRoots ?? [])];
				const editor = current => {
					const attributes = current.attributes ?? [];
					if (attributes.some((name, index) => index % 2 === 0 && name === "id" && attributes[index + 1] === "editing-view-port")) return current;
					return descendants(current).map(editor).find(Boolean);
				};
				const viewport = editor(node);
				if (!viewport) throw new Error("Chromium native editing viewport unavailable; paired screenshot review required");
				const text = current => current.nodeName === "STYLE" ? "" : (current.nodeType === 3 ? current.nodeValue : "") + descendants(current).map(text).join("");
				// The sibling UA placeholder retains its hidden text (e.g. 8/16).
				// Read only the actual native editor, never concatenate placeholder.
				state.nativeEditorText = text(viewport);
				state.nativeEditorSource = "Chromium user-agent #editing-view-port";
			} catch (error) { state.nativeEditorReadError = String(error); }
			return state;
		};
		const numberScreenshot = async (selector, name) => {
			const input = await page.$(selector);
			assert.ok(input);
			const base64 = await input.screenshot({ encoding: "base64" });
			await input.dispose();
			const image = { encoding: "base64", mimeType: "image/png", data: base64 };
			if (options.scratchDirectory) {
				await mkdir(options.scratchDirectory, { recursive: true });
				image.path = path.join(options.scratchDirectory, `plugin-browser-${name}.png`);
				await writeFile(image.path, Buffer.from(base64, "base64"));
				evidence.screenshots.push(image.path);
			}
			return image;
		};
		const numericCases = [
			{ section: "agent", selector: CONCURRENCY_INPUT, key: "workerRequestConcurrency", valid: "3.0", canonical: 3, expectedMin: "1", expectedStep: "1" },
			{ section: "appearance", selector: '[data-testid="input-prose-size"]', key: "proseFontSize", valid: "-5", canonical: 12, expectedMin: null, expectedStep: null },
		];
		try {
			for (const sample of numericCases) {
				await page.locator(`[data-testid="settings-nav-${sample.section}"]`).click();
				await page.waitForSelector(sample.selector, { visible: true });
				const before = await settingsRecord();
				const writesBefore = evidence.requests.filter(entry => entry.method === "PUT" && new URL(entry.url).pathname === `/api/settings/${sample.section}`).length;
				await selectNativeNumber(sample.selector); await page.keyboard.type("1e");
				const invalidBefore = await numberSnapshot(sample.selector);
				const imageBefore = await numberScreenshot(sample.selector, `native-number-${sample.section}-invalid-before-escape`);
				assert.equal(invalidBefore.type, "number", "Native number type/steppers must not be replaced by a text workaround");
				assert.equal(invalidBefore.min, sample.expectedMin); assert.equal(invalidBefore.step, sample.expectedStep);
				assert.equal(invalidBefore.badInput, true, "Real Chromium typing must produce an incomplete numeric token, not intentional blank input");
				await page.keyboard.press("Escape");
				const invalidAfter = await numberSnapshot(sample.selector);
				const imageAfter = await numberScreenshot(sample.selector, `native-number-${sample.section}-invalid-after-escape`);
				const after = await settingsRecord();
				const visibleTextProved = invalidBefore.nativeEditorText === "1e" && invalidAfter.nativeEditorText === "1e";
				evidence.nativeNumbers.push({ section: sample.section, token: "1e", invalidBefore, invalidAfter, before: before.settings?.[sample.section], after: after.settings?.[sample.section], imageBefore, imageAfter,
					visibleTextProof: visibleTextProved ? "Chromium native UA editing-buffer text before/after Escape" : "Requires human review of paired actual Chromium input screenshots; DOM value is not visual proof" });
				assert.equal(invalidAfter.badInput, true, "Native invalid buffer was erased on Escape/blur: human decision required; do not change input type or production behavior as a smoke workaround");
				assert.equal(invalidAfter.focused, false, "Escape must leave the numeric field");
				assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1, "Invalid field Escape must not close Settings");
				assert.deepEqual(after.settings?.[sample.section], before.settings?.[sample.section], "Invalid native buffer must not accidentally unset or persist any setting");
				assert.equal(evidence.requests.filter(entry => entry.method === "PUT" && new URL(entry.url).pathname === `/api/settings/${sample.section}`).length, writesBefore, "Invalid field Escape must issue no settings PUT");
				for (const attribute of ["type", "min", "max", "step", "appearance", "spinAppearance"]) assert.equal(invalidAfter[attribute], invalidBefore[attribute], `Native number ${attribute} must survive Escape`);
				if (invalidBefore.nativeEditorText === "1e" && invalidAfter.nativeEditorText !== "1e") assert.fail("Chromium erased the visible incomplete token on blur; human review required (see native-number screenshots)");
				await selectNativeNumber(sample.selector); await page.keyboard.type(sample.valid);
				const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/settings/${sample.section}` && response.request().method() === "PUT");
				await page.keyboard.press("Escape");
				const response = await saved;
				assert.equal(response.status(), 200); const acknowledgment = await response.json();
				assert.equal(acknowledgment.settings?.[sample.section]?.[sample.key], sample.canonical, "Successful settings response must acknowledge the canonical normalized section value");
				await page.waitForFunction(({ selector, canonical }) => document.querySelector(selector)?.value === String(canonical), {}, sample);
				const canonical = await settingsRecord();
				assert.equal(canonical.settings?.[sample.section]?.[sample.key], sample.canonical);
				assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1, "Valid field Escape commits but leaves Settings open");
				evidence.nativeNumbers.push({ section: sample.section, typed: sample.valid, canonical: sample.canonical, acknowledgment, stored: canonical.settings?.[sample.section] });
			}
		} finally { await cdp.detach(); }
		await screenshot("native-number-settings");
		await closeSettings(); await health();
		const updatedMarkdownProse = await assertMarkdownProse("view");
		assert.equal(updatedMarkdownProse.fontSize, "12px", "Existing public Markdown must react to the acknowledged Settings prose-size change without remounting");
		evidence.markdown.push({ label: "native Settings prose-size acknowledgment updates the existing public Markdown surface", prose: updatedMarkdownProse });
		evidence.nativeNumberVisualReviewRequired = evidence.nativeNumbers.some(sample => sample.token && !sample.visibleTextProof.startsWith("Chromium native UA"));
		evidence.assertions.push("Actual Chromium native-number 1e buffers consume Escape without writes/unset or dialog dismissal; visible token retention is proved by native UA text when available, otherwise paired input screenshots require human review; valid concurrency 3.0→3 and prose size -5→12 display canonical acknowledgments without changing number types/stepper attributes");

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

		evidence.stage = "native plugin question: canonical predict authority and public editor";
		const questionRoute = `/api/chats/${QUESTION.chatId}`;
		const questionDock = '[data-testid="plugin-question-dock"]';
		const questionEditor = '[data-smoke-question-editor]';
		const readQuestion = async () => {
			const response = await fetch(base + questionRoute, { headers: options.headers, signal: AbortSignal.timeout(timeoutMs) });
			assert.equal(response.status, 200); return response.json();
		};
		const posed = record => record.messages.flatMap(message => Object.values(message.lhQuestions ?? {})).filter(annotation => annotation.questionId);
		const openQuestion = async () => {
			await page.waitForFunction(title => [...document.querySelectorAll('[data-testid="session-row"]')].some(row => row.textContent.includes(title)), {}, QUESTION.title);
			await page.$$eval('[data-testid="session-row"]', (rows, title) => rows.find(row => row.textContent.includes(title)).click(), QUESTION.title);
			await page.waitForFunction(route => location.pathname === route, {}, `/chat/${QUESTION.chatId}`);
		};
		const sendQuestionPrompt = async text => {
			const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST"
				&& JSON.parse(response.request().postData() ?? "{}").input?.text === text);
			await page.locator('[data-testid="composer"] [contenteditable="true"]').fill(text);
			await page.locator('[data-testid="composer"] button[aria-label="Send"]').click();
			assert.equal((await sent).status(), 200, "Explicit composer request must start a genuine native teacher turn");
		};
		const assertPrivateQuestionBoundary = async () => {
			assert.deepEqual(await page.evaluate(() => window.__questionTraceProof.leaks), [], "Live, failed and canonical question attempts must never expose private payload in raw traces");
			assert.equal(await page.$$eval('[data-testid="tool-call-card"]', (cards, tools) => cards.filter(card => tools.includes(card.dataset.tool)).length, [QUESTION.predictTool, QUESTION.checkTool]), 0, "Question attempts must bypass ordinary expandable tool renderers");
		};
		await openQuestion();
		await page.waitForSelector('[data-testid="composer"] [contenteditable="true"]', { visible: true });
		const seededQuestion = await readQuestion();
		assert.deepEqual(posed(seededQuestion), [], "Fixture must not seed pending question authority or answers");
		assert.equal(seededQuestion.tree.nodes[0].id, QUESTION.nodeId);
		assert.deepEqual(seededQuestion.settings.model, { provider: "custom", id: QUESTION.model });
		await page.evaluate(marker => {
			const proof = { leaks: [], samples: 0 };
			const inspect = () => { proof.samples++; if (document.querySelector("main")?.textContent.includes(marker)) proof.leaks.push({ sample: proof.samples, text: document.querySelector("main").textContent }); };
			proof.observer = new MutationObserver(inspect); proof.observer.observe(document.querySelector("main"), { subtree: true, childList: true, characterData: true });
			window.__questionTraceProof = proof; inspect();
		}, QUESTION.referenceMarker);
		let heldResolve;
		const heldCanonical = new Promise(resolve => { heldResolve = resolve; });
		const predictStream = page.waitForResponse(response => new URL(response.url()).pathname === questionRoute + "/stream");
		await sendQuestionPrompt(QUESTION.predictPrompt);
		assert.equal((await predictStream).status(), 200);
		assert.equal(await page.$$eval(questionEditor, nodes => nodes.length), 0, "A live native question attempt cannot mount an actionable editor");
		questionCanonicalGate = { requests: [], resolve: heldResolve };
		try {
			assert.deepEqual(await admissionCall("question-release"), { released: true });
			let gateTimer;
			try { await Promise.race([heldCanonical, new Promise((_, reject) => { gateTimer = setTimeout(() => reject(new Error("Native turn did not request explicit canonical reconciliation")), timeoutMs); })]); }
			finally { clearTimeout(gateTimer); }
			assert.equal(await page.$$eval(questionEditor, nodes => nodes.length), 0, "No actionable editor may mount before terminal canonical reconciliation is adopted");
			const persisted = await readQuestion();
			assert.equal(persisted.turnInFlight, false);
			const predict = posed(persisted).at(-1);
			assert.ok(predict?.questionId, "Only successful native execution can mint durable pending authority");
			assert.equal(predict.typeId, "smoke-predict");
			assert.equal(predict.input.type, "predict");
			assert.equal(predict.input.nodeId, QUESTION.nodeId);
			assert.equal(predict.input.payload.referenceMarker, QUESTION.referenceMarker);
			assert.equal(predict.showThinking, true);
			const attemptMessage = persisted.messages.find(message => message.lhQuestions?.["0"]?.typeId === "smoke-predict");
			assert.equal(attemptMessage.lhQuestions["0"].questionId, undefined, "Failed authoring has visibility classification, never pending authority");
			assert.equal(attemptMessage.lhQuestions["1"].questionId, predict.questionId, "Successful sibling owns its exact content occurrence");
			assert.equal(predict.occurrence.contentIndex, 1);
			assert.ok(persisted.messages.some(message => message.role === "toolResult" && message.toolCallId === "question_predict_bad" && message.isError));
			assert.equal(persisted.messages.some(message => message.role === "toolResult" && message.toolCallId === predict.occurrence.toolCallId), false, "Temporary pose ACK must not persist as a successful native result");
			assert.deepEqual((await readQuestion()).messages, persisted.messages, "Canonical GET must retain stable question identity/snapshot without fabricating results");
			evidence.questions.push({ label: "mixed failed/valid native predict, persisted authority before canonical client adoption", snapshot: predict });
			await assertPrivateQuestionBoundary();
		} finally {
			const held = questionCanonicalGate.requests; questionCanonicalGate = undefined;
			await Promise.all(held.map(request => request.continue()));
		}
		await page.waitForSelector(`${questionEditor}:not(:disabled)`, { visible: true });
		const predictRecord = await readQuestion();
		const predict = posed(predictRecord).at(-1);
		assert.equal(await page.$eval(questionEditor, node => node.dataset.smokeQuestionEditor), predict.questionId);
		assert.equal(await page.$eval('[data-smoke-question-rich]', node => node.dataset.smokeQuestionRich), predict.questionId);
		assert.equal(await page.$eval('[data-smoke-question-rich]', node => node.dataset.immutable), "true", "Public rich-question mount receives immutable normalized context/input");
		assert.equal(await page.$eval(questionEditor, node => !!node.closest("form")), false, "Plugin answer editing must sit outside the host submit form");
		const toolbar = await page.$('[data-testid="stats-bar"]');
		assert.ok(await page.$('[data-testid="stats-model"]'), "Host model control remains present");
		assert.ok(await page.$('[data-testid="stats-thinking"]'), "Host model-thinking control remains present");
		assert.ok(await page.$('[data-testid="dictation-toggle"]'), "Host microphone remains present");
		const draftText = "  exact offline answer\n\tsecond line  \n";
		await page.locator(questionEditor).fill(draftText);
		await page.$eval(questionEditor, node => node.setSelectionRange(3, 8));
		const editor = await page.$(questionEditor);
		const beforeFold = await editor.evaluate(node => ({ mount: node.dataset.mount, value: node.value, start: node.selectionStart, end: node.selectionEnd, publishes: node.dataset.publishes }));
		// Real wheel gestures exercise the existing dock fold machine, not a
		// private expand/fold hook or fabricated keyboard/composition event.
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2250)));
		await page.evaluate(() => {
			window.__questionWheelProof = [];
			window.addEventListener("wheel", event => {
				const sample = { deltaY: event.deltaY, trusted: event.isTrusted, target: event.target?.outerHTML?.slice(0, 200) };
				window.__questionWheelProof.push(sample); queueMicrotask(() => { sample.prevented = event.defaultPrevented; });
			}, { capture: true });
		});
		const scrollMetrics = async label => {
			const sample = await page.evaluate(() => {
				const log = document.querySelector('[role="log"]');
				const scrollers = [log, ...log.querySelectorAll("div")].filter(node => node.scrollHeight > node.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(node).overflowY));
				const rect = log.getBoundingClientRect();
				const point = { x: Math.max(1, Math.min(innerWidth - 1, rect.x + 12)), y: Math.max(80, Math.min(innerHeight - 1, Math.max(0, rect.y) + 100)) };
				return { body: { attributes: [...document.body.attributes].map(attr => [attr.name, attr.value]), style: getComputedStyle(document.body).overflow },
					dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => ({ label: node.getAttribute("aria-label"), inert: node.inert, hidden: node.getAttribute("aria-hidden") })), wheel: window.__questionWheelProof,
					log: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, point,
					hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 400),
					scrollers: scrollers.map(node => ({ tag: node.tagName, className: node.className, top: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY,
						rect: { x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } })),
					ancestors: (() => { const path = []; let node = document.elementFromPoint(point.x, point.y); while (node) { path.push({ tag: node.tagName, className: node.className, overflow: getComputedStyle(node).overflow, top: node.scrollTop }); node = node.parentElement; } return path; })(),
					bar: !!document.querySelector('[data-testid="question-dock-bar"]') };
			});
			evidence.questionScroll.push({ label, ...sample }); return sample;
		};
		const beforeWheel = await scrollMetrics("before native wheel fold");
		assert.ok(beforeWheel.scrollers.length, "Question prerequisite lesson must provide an overflowing transcript for natural wheel folding");
		// Read the transcript from its visible blank margin, outside nested
		// message overflow boxes and the active textarea's editing surface.
		await page.mouse.click(beforeWheel.point.x, beforeWheel.point.y);
		for (const [index, deltaY] of [-420, -420, -840, -420, -420].entries()) {
			await page.mouse.wheel({ deltaY }); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
			const sample = await scrollMetrics("after native wheel " + index); if (sample.bar) break;
		}
		await page.waitForSelector('[data-testid="question-dock-bar"]', { visible: true, timeout: 5000 });
		assert.deepEqual(await editor.evaluate(node => ({ connected: node.isConnected, mount: node.dataset.mount, value: node.value, start: node.selectionStart, end: node.selectionEnd, publishes: node.dataset.publishes, active: node.dataset.active })), { connected: true, ...beforeFold, active: "false" }, "Folding retains the same controlled editor, draft and selection without onChange echo");
		await page.locator('[data-testid="question-dock-bar"]').click();
		await page.waitForSelector(`${questionEditor}:not(:disabled)`, { visible: true });
		assert.equal(await toolbar.evaluate(node => node.isConnected), true, "Question fold/reveal must not replace the persistent host toolbar");
		assert.deepEqual(await editor.evaluate(node => ({ mount: node.dataset.mount, value: node.value, start: node.selectionStart, end: node.selectionEnd, publishes: node.dataset.publishes })), beforeFold);
		await editor.focus();
		await editor.evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
		await page.keyboard.press("Tab");
		assert.equal(await editor.evaluate(node => document.activeElement === node && node.dataset.tabs === "1"), true, "Plain Tab must invoke the current plugin editor once rather than native/global focus traversal");
		await page.keyboard.press("Enter");
		const expectedAnswer = draftText + "\t\n";
		assert.equal(await editor.evaluate(node => node.value), expectedAnswer, "Unclaimed Enter edits the textarea instead of submitting");
		const hostThinking = "Host thinking stays separate from the exact answer.";
		await page.locator(`${questionDock} [contenteditable="true"][aria-label="Your thinking"]`).fill(hostThinking);
		await editor.focus();
		assert.deepEqual((await admissionCall("question-status")).counts, { requests: 1, poses: 1, reviews: 0, completed: 1 }, "Successful mixed pose must stop the native engine until the learner answers");
		const answerResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST"
			&& JSON.parse(response.request().postData() ?? "{}").input?.type === "plugin-question-answer");
		const reviewStream = page.waitForResponse(response => new URL(response.url()).pathname === questionRoute + "/stream");
		await chord("Enter");
		const submitted = await answerResponse;
		assert.equal(submitted.status(), 200, "Host Mod+Enter from inside the textarea must submit through the genuine answer protocol");
		const submittedInput = JSON.parse(submitted.request().postData()).input;
		assert.deepEqual(submittedInput, { type: "plugin-question-answer", questionId: predict.questionId, occurrence: predict.occurrence, answer: expectedAnswer, thinking: hostThinking });
		assert.equal((await reviewStream).status(), 200);
		const beforeReviewBytes = await readQuestion();
		assert.equal(beforeReviewBytes.messages.at(-1).details?.answer, expectedAnswer, "Genuine learner result must be durable before the ordinary native teacher response is released");
		assert.deepEqual(await admissionCall("question-release"), { released: true });
		await page.waitForFunction(review => document.querySelector("main")?.textContent.includes(review), {}, QUESTION.review);
		await page.waitForSelector(questionDock, { hidden: true });
		await page.waitForFunction(async ({ route, review }) => {
			const response = await fetch(route); const record = await response.json();
			return !record.turnInFlight && record.messages.some(message => message.role === "assistant" && message.content?.some(block => block.type === "text" && block.text.includes(review)));
		}, {}, { route: questionRoute, review: QUESTION.review });
		const answeredRecord = await readQuestion();
		const answers = answeredRecord.messages.filter(message => message.role === "toolResult" && message.details?.kind === "plugin-question");
		assert.equal(answers.length, 1);
		assert.deepEqual({ ...answers[0].details, answeredAt: "host timestamp" }, { kind: "plugin-question", questionId: predict.questionId, pluginId: "native-smoke", typeId: "smoke-predict", contractVersion: 1, answer: expectedAnswer, thinking: hostThinking, answeredAt: "host timestamp" });
		assert.ok(Number.isFinite(Date.parse(answers[0].details.answeredAt)));
		assert.deepEqual(answers[0].lhQuestionOccurrence, predict.occurrence);
		assert.equal(await page.$eval(`[data-smoke-question-answered=${JSON.stringify(predict.questionId)}]`, node => node.textContent), expectedAnswer);
		const reviewed = await admissionCall("question-status");
		evidence.questionProvider = reviewed;
		assert.deepEqual(reviewed.counts, { requests: 2, poses: 1, reviews: 1, completed: 2 });
		assert.ok(reviewed.requests.every(request => request.stream && request.model === QUESTION.model && (!request.authenticated || request.keylessPlaceholder) && !request.modelHistoryHasQuestionMetadata), "Native keyless adapter may send only its public not-needed placeholder, never an account credential or app question metadata: " + JSON.stringify(reviewed));
		assert.ok(reviewed.requests[0].tools.includes(QUESTION.predictTool) && reviewed.requests[0].tools.includes(QUESTION.checkTool), "Teach-only question types must be contributed to the real native teacher");
		assert.match(reviewed.requests[1].reviewContent, /plugin-question/);
		assert.ok(reviewed.requests[1].reviewContent.includes(JSON.stringify(expectedAnswer)) && reviewed.requests[1].reviewContent.includes(hostThinking), "Ordinary native teacher continuation receives the actual serialized answer and host thinking, not a fixture-produced final result");
		const staleAnswer = await fetch(base + "/api/chat", { method: "POST", headers: { ...options.headers, "content-type": "application/json" }, body: JSON.stringify({ chatId: QUESTION.chatId, input: submittedInput }), signal: AbortSignal.timeout(timeoutMs) });
		const staleAnswerText = await staleAnswer.text();
		assert.equal(staleAnswer.status, 400, "A post-terminal stale answer cannot save twice or launch another teacher turn: " + staleAnswerText);
		assert.deepEqual((await admissionCall("question-status")).counts, reviewed.counts);
		assert.equal((await readQuestion()).messages.filter(message => message.details?.kind === "plugin-question").length, 1);
		assert.equal(await editor.evaluate(node => !node.isConnected && node.dataset.aborted === "true" && node.dataset.disposes === "1"), true, "Terminal adoption disposes the exact editor lease once");
		await editor.dispose(); await toolbar.dispose();
		await assertPrivateQuestionBoundary();
		await screenshot("question-predict-reviewed");
		evidence.questions.push({ label: "verbatim public-editor answer, separate host thinking, genuine native teacher review; stale terminal submission rejected without another turn", submittedInput, result: answers[0], provider: reviewed, staleSubmission: { status: staleAnswer.status, text: staleAnswerText } });

		evidence.stage = "native plugin question: check reading/reveal and thinking-off microphone";
		const checkStream = page.waitForResponse(response => new URL(response.url()).pathname === questionRoute + "/stream");
		await sendQuestionPrompt(QUESTION.checkPrompt);
		assert.equal((await checkStream).status(), 200);
		assert.deepEqual(await admissionCall("question-release"), { released: true });
		await page.waitForSelector('[data-testid="teach-check-reveal"]', { visible: true });
		await page.waitForSelector('[data-testid="reading-thinking-field"]', { visible: true });
		assert.equal(await page.$$eval(questionEditor, nodes => nodes.some(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden")), false, "Check editor remains non-actionable behind host reading/reveal pacing");
		const readingText = "Host reading thinking before reveal.";
		await page.locator('[data-testid="reading-thinking-field"] [contenteditable="true"]').fill(readingText);
		await page.locator('[data-testid="teach-check-reveal"]').click();
		await page.waitForSelector(`${questionEditor}:not(:disabled)`, { visible: true });
		await page.waitForFunction(() => document.querySelector('[data-testid="dictation-toggle"]')?.disabled === true);
		assert.equal(await page.$eval('[data-testid="dictation-toggle"]', node => node.getClientRects().length > 0), true, "Thinking-off editor without explicit appendTranscript keeps the host microphone visible but disabled");
		assert.equal(await page.$$eval(`${questionDock} [aria-label="Your thinking"]`, nodes => nodes.length), 0, "showThinking:false never invents a host thinking field");
		assert.equal(await page.$eval('[data-testid="reading-thinking-field"] [contenteditable="true"]', node => node.textContent), readingText, "Reveal retains the distinct host reading channel");
		await page.locator(questionEditor).fill("unsubmitted check draft");
		disabledQuestionEditor = await page.$(questionEditor);
		const checkRecord = await readQuestion(); const check = posed(checkRecord).at(-1);
		assert.equal(check.input.type, "check"); assert.equal(check.showThinking, false);
		assert.notEqual(check.questionId, predict.questionId);
		assert.equal(checkRecord.messages.filter(message => message.details?.kind === "plugin-question").length, 1, "Unanswered check must not create a learner result");
		const beforeDisableQuestion = await admissionCall("question-status");
		assert.deepEqual(beforeDisableQuestion.counts, { requests: 3, poses: 2, reviews: 1, completed: 3 });
		await assertPrivateQuestionBoundary();
		await screenshot("question-check-revealed");
		await Promise.all(questionWireReads);
		evidence.questionStreams = questionStreamSnapshots();
		assert.ok(evidence.questionStreams.every(stream => !stream.captureError && stream.text.includes("data: [DONE]")), "CDP must capture every real native stream through its explicit terminal marker");
		evidence.questionWire = evidence.questionStreams.map(stream => stream.text);
		assert.ok(evidence.questionWire.length >= 3, "Capture the real native stream for pose, answer continuation and check");
		const wireEvents = evidence.questionWire.flatMap(text => {
			assert.equal(typeof text, "string", "Real native event streams must remain inspectable");
			return text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
		});
		assert.ok(wireEvents.some(event => event.message?.lhQuestions), "Question-attempt visibility annotations must accompany live native assistant snapshots");
		for (const event of wireEvents) {
			if (["message_start", "message_update", "message_end"].includes(event.type) && event.message?.role === "assistant") {
				for (const annotation of Object.values(event.message.lhQuestions ?? {})) assert.equal(annotation.questionId, undefined, "Wire attempt annotations cannot grant canonical pending authority");
			}
			assert.equal(event.type === "tool_execution_end" && [predict.occurrence.toolCallId, check.occurrence.toolCallId].includes(event.toolCallId) && !event.result?.details?.kind, false, "Temporary pose execution ACK cannot appear on wire");
			assert.equal(JSON.stringify(event).includes("Question posed — the turn ends here"), false, "Temporary ACK must be absent from every stream carrier");
		}
		const afterQuestionAdmission = await admissionCall("admission-status");
		assert.deepEqual(afterQuestionAdmission.counts, terminal.counts, "Question-model requests must not alter held-worker admission/completion counters");
		evidence.questions.push({ label: "check reading/reveal, no implicit answer speech, pending until explicit dismissal", snapshot: check, provider: beforeDisableQuestion, wireEvents: wireEvents.length });
		evidence.assertions.push("External teach-only plugin question types execute through native validated calls against a live plan: mixed failed/valid predict stops with no temporary ACK on wire/history; canonical reconciliation gates public rich/editor slots; real fold preserves selection/draft/mount; editor Tab edits once and Mod+Enter submits verbatim whitespace with separate host thinking; genuine native teacher continuation reviews without grading; check retains reading/reveal and visible disabled microphone without answer speech opt-in");
		await page.evaluate(() => window.__questionTraceProof.observer.disconnect());
		await openProof();
		assert.equal(await disabledQuestionEditor.evaluate(node => !node.isConnected && node.dataset.aborted === "true"), true, "Leaving the chat releases its editor while canonical pending authority survives");
		await disabledQuestionEditor.dispose(); disabledQuestionEditor = undefined;

		await verifySessionExtensions({ page, evidence, admissionCall, openProof, health, screenshot, chord, timeoutMs });

		evidence.stage = "UI disable and package unavailability";
		await markdownAction("view", "formatted"); await assertStaticFormatted("view", 1);
		const disabledMarkdownView = await page.$(markdownRoot("view"));
		await page.locator(`${MOUNT} button[title="Open static Markdown dialog"]`).click();
		await page.waitForSelector('[role="dialog"][aria-label="Static Markdown dialog proof"]', { visible: true });
		await markdownAction("dialog", "formatted"); await assertStaticFormatted("dialog", 1);
		const disabledMarkdownDialog = await page.$(markdownRoot("dialog"));
		// Global Settings is independent of the plugin dialog being unloaded.
		await chord(",");
		await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
		await page.locator('[data-testid="settings-nav-plugins"]').click();
		await page.waitForSelector(`${TOGGLE}:not(:disabled)`, { visible: true });
		await toggle(false);
		await page.waitForFunction(({ mount, link }) => !document.querySelector(mount) && !document.querySelector(link), {}, { mount: MOUNT, link: SIDEBAR_LINK });
		for (const root of [disabledMarkdownView, disabledMarkdownDialog]) {
			assert.equal(await root.evaluate(element => !element.isConnected && element.dataset.parentAborted === "true" && !element.querySelector("[data-plugin-ui-widget],svg")), true, "Disable must abort and remove both public Markdown view/dialog widget lifetimes");
			await root.dispose();
		}
		assert.equal(await page.$$eval('[data-smoke-markdown-output], [role="dialog"][aria-label="Static Markdown dialog proof"]', nodes => nodes.length), 0, "Disabling plugin must not leave Markdown or dialog portals behind");
		assert.equal(await page.$$eval("svg", nodes => nodes.some(node => /Static start|Updated finish/.test(node.textContent))), false, "Late Mermaid work cannot resurrect a disabled static Markdown widget");
		assert.equal(await page.$$eval('[data-testid="settings-dialog"]', nodes => nodes.length), 1, "Unloading the covered plugin dialog must not destroy global Settings");
		evidence.markdown.push({ label: "Disable tears down simultaneously mounted formatted view/dialog Markdown without orphan widgets, Mermaid SVG, or loss of global Settings" });
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
			[`${PLUGIN}/assets/assets/markdown-proof.js`, "GET"],
			[`${PLUGIN}/assets/assets/markdown-proof.svg`, "GET"],
			[`${PLUGIN}/assets/assets/question-proof.js`, "GET"],
			[`${PLUGIN}/assets/assets/session-proof.js`, "GET"],
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
		evidence.assertions.push("UI disable removes sidebar/mounted DOM and makes backend, native module assets and local Markdown image unavailable");
		await screenshot("disabled");

		evidence.stage = "native plugin question: disabled pending fallback and silent host dismissal";
		await openQuestion();
		await page.waitForSelector(questionDock, { visible: true });
		const revealFallback = await page.$('[data-testid="teach-check-reveal"]');
		if (revealFallback && await revealFallback.evaluate(node => node.getClientRects().length > 0)) await revealFallback.click();
		await revealFallback?.dispose();
		await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("Question unavailable"), {}, questionDock);
		assert.equal(await page.$$eval(questionEditor, nodes => nodes.length), 0, "Disabling a pending type removes its editor without inventing an answer");
		const fallbackText = await page.$eval(questionDock, node => node.textContent);
		assert.ok(fallbackText.includes(check.input.question), "Unavailable renderer uses saved readable common question");
		assert.equal(fallbackText.includes(QUESTION.referenceMarker), false, "Unavailable fallback never dumps authored private payload");
		assert.equal(await page.$eval("main", (node, marker) => node.textContent.includes(marker), QUESTION.referenceMarker), false, "Failed attempts and disabled answered/pending renderers remain outside generic raw trace rendering");
		assert.equal(await page.$$eval('[data-testid="tool-call-card"]', (cards, tools) => cards.filter(card => tools.includes(card.dataset.tool)).length, [QUESTION.predictTool, QUESTION.checkTool]), 0);
		const unavailableRecord = await readQuestion();
		assert.equal(posed(unavailableRecord).at(-1).questionId, check.questionId, "Disable preserves exact canonical pending identity; revision is not cancellation");
		assert.equal(unavailableRecord.messages.some(message => message.details?.kind === "plugin-question-cancelled"), false, "Disable must not auto-cancel or fabricate an answer");
		const turnsBeforeDismiss = unavailableRecord.turns?.length ?? 0;
		const nativePostsBeforeDismiss = evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length;
		await screenshot("question-disabled-fallback");
		const dismissed = page.waitForResponse(response => new URL(response.url()).pathname === questionRoute + "/dismiss" && response.request().method() === "POST");
		await page.$$eval(`${questionDock} button`, buttons => buttons.find(button => button.textContent.trim() === "Dismiss question").click());
		assert.equal((await dismissed).status(), 200, "Unavailable question dismissal must use the host identity-bound cancellation route");
		await page.waitForSelector(questionDock, { hidden: true });
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
		const dismissedRecord = await readQuestion();
		assert.equal(dismissedRecord.turnInFlight, false);
		assert.equal(dismissedRecord.turns?.length ?? 0, turnsBeforeDismiss, "Explicit dismissal never creates a teacher turn");
		assert.equal(evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length, nativePostsBeforeDismiss, "Dismissal cannot issue an automatic continuation POST");
		const cancelled = dismissedRecord.messages.filter(message => message.details?.kind === "plugin-question-cancelled");
		assert.equal(cancelled.length, 1);
		assert.equal(cancelled[0].details.questionId, check.questionId);
		assert.equal(cancelled[0].details.reason, "dismissed");
		assert.deepEqual(cancelled[0].details.occurrence, check.occurrence);
		assert.equal(dismissedRecord.messages.filter(message => message.details?.kind === "plugin-question").length, 1, "Silent dismissal leaves only the genuine earlier learner answer");
		evidence.questions.push({ label: "disabled pending fallback → explicit host cancellation with zero extra native turns", snapshot: check, cancellation: cancelled[0], turnsBeforeDismiss, turnsAfterDismiss: dismissedRecord.turns?.length ?? 0, extraContinuationPosts: 0 });
		evidence.assertions.push("Disabling the plugin leaves its unanswered check pending with readable host fallback and no payload trace/editor/automatic cancellation; explicit Dismiss writes a native cancellation for the exact occurrence with zero teacher continuation and no fabricated learner result");
		await health();
		await screenshot("question-dismissed");
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
		console.log("[smoke-plugin-browser] Settings enable → native ESM/relative asset → backend RPC → public display-only Markdown (view/dialog, async built-ins, update/abort/dispose/disable) → controlled full-window modal knowledge picker + native source editing → Home/remount → painted/inert dialog + Settings stack/return-to → native-number Escape/canonical acknowledgment → Agent UI 1→2→1 + held loopback admission/FIFO + panel END cancellations (no generation) → public plugin predict/check via scripted LOOPBACK native teacher, canonical editor/answer/review → Settings disable/assets denied + pending-question fallback/silent dismissal");
	} catch (error) {
		failed = error;
		evidence.failure = { message: String(error?.message ?? error), stack: error?.stack };
		try { await screenshot("failure"); }
		catch (captureError) { evidence.screenshotError = String(captureError); }
	} finally {
		evidence.expectedPickerReadAborts = evidence.failedRequests.filter(expectedPickerReadAbort);
		evidence.questionStreams = questionStreamSnapshots();
		evidence.expectedQuestionReadAborts = evidence.failedRequests.filter(expectedQuestionReadAbort);
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
			recentResponses: evidence.responses.slice(-12), screenshots: evidence.screenshots, sessionExtensions: evidence.sessionExtensions, questions: evidence.questions, questionScroll: evidence.questionScroll, questionStreams: evidence.questionStreams, expectedQuestionReadAborts: evidence.expectedQuestionReadAborts,
			nativeNumbers: evidence.nativeNumbers.map(({ imageBefore, imageAfter, ...sample }) => ({ ...sample, imageBefore: imageBefore?.path, imageAfter: imageAfter?.path })),
			nativeNumberVisualReviewRequired: evidence.nativeNumberVisualReviewRequired,
		};
		const error = new Error(`Plugin browser smoke failed during ${evidence.stage}: ${failed.message ?? failed}\n${JSON.stringify(diagnostic, null, 2)}`, { cause: failed });
		error.evidence = evidence;
		throw error;
	}
	return evidence;
}

/** Bounded, independent native-session extension proof. All plugin state is
 * observed through its public RPC; the host is driven only by native controls.
 * No app module imports, React/store hooks, pending-question seeding or forged
 * host attributes. Provider data below is captured by the loopback listener. */
async function verifySessionExtensions({ page, evidence, admissionCall: call, openProof, health, screenshot, chord, timeoutMs }) {
	const surface = '[data-smoke-session-surface="0"]';
	const nativeSurface = '[data-plugin-session-surface]';
	const composer = '[data-testid="composer"]';
	const send = `${composer} button[aria-label="Send"]`;
	const action = name => page.locator(`${surface} [data-smoke-session-action="${name}"]`).click();
	const read = async id => page.evaluate(async id => {
		const response = await fetch(`/api/chats/${id}`);
		if (!response.ok) throw new Error("Session canonical read failed: " + response.status);
		return response.json();
	}, id);
	const status = () => call("session-status");
	const waitStatus = async predicate => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const snapshot = await status();
			if (predicate(snapshot)) return snapshot;
			await new Promise(resolve => setTimeout(resolve, 60));
		}
		throw new Error("Session fixture public counter condition timed out: " + JSON.stringify(await status()));
	};
	const openSession = async (id, title) => {
		await page.waitForFunction(title => [...document.querySelectorAll('[data-testid="session-row"]')].some(row => row.textContent.includes(title)), {}, title);
		await page.$$eval('[data-testid="session-row"]', (rows, title) => rows.find(row => row.textContent.includes(title)).click(), title);
		await page.waitForFunction(id => location.pathname === `/chat/${id}`, {}, id);
	};
	const openSurface = async () => {
		await page.locator('[aria-label="More plugin actions"]').click();
		await page.waitForSelector('[data-testid="plugin-top-bar-menu"]', { visible: true });
		// Reuse the existing action and placements/counts. Session context alone
		// changes its behavior: the host supplies the opaque surfaceTarget.
		await page.$$eval('[data-testid="plugin-top-bar-menu"] [role="menuitem"]', items => items.find(item => item.textContent.trim() === "Runtime proof").click());
		await page.waitForSelector(surface, { visible: true });
	};
	const arm = async fail => {
		await openSurface();
		await action(fail === "model-error" ? "model-error" : fail ? "fail" : "arm");
		const snapshot = await waitStatus(state => state.events.filter(event => event.event === "armed").length > armedCount);
		const armed = snapshot.events.filter(event => event.event === "armed").at(-1); armedCount++;
		for (const channel of ["answer", "thinking", "reading"]) {
			const bytes = Buffer.from(armed[channel].data, "base64");
			assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "External canvas must produce a genuine PNG");
			assert.ok(bytes.length > 60); assert.equal(armed[channel].mimeType, "image/png");
		}
		await action("close");
		await page.waitForSelector(surface, { hidden: true });
		return armed;
	};
	let armedCount = 0;
	const release = async id => {
		await waitStatus(state => state.pending === 1);
		assert.deepEqual(await call("session-release"), { released: true });
		await page.waitForFunction(async id => {
			const response = await fetch(`/api/chats/${id}`); const record = await response.json();
			return !record.turnInFlight;
		}, {}, id);
		await page.waitForSelector('main button[aria-label="Stop"]', { hidden: true });
	};
	const post = (type, text) => {
		const pending = page.waitForResponse(response => {
			if (new URL(response.url()).pathname !== "/api/chat" || response.request().method() !== "POST") return false;
			const input = JSON.parse(response.request().postData() ?? "{}").input;
			return input?.type === type && (text === undefined || input.text === text);
		});
		// A preceding UI-driver error must not become an unhandled teardown
		// rejection that hides the original diagnostic/evidence file.
		void pending.catch(() => {});
		return pending;
	};
	const sendText = async (id, text) => {
		const response = post("text", text);
		await page.locator(`${composer} [contenteditable="true"]`).fill(text);
		await page.locator(send).click();
		assert.equal((await response).status(), 200);
		await release(id);
	};
	const imageBlocks = value => {
		if (!value || typeof value !== "object") return [];
		if (Array.isArray(value)) return value.flatMap(imageBlocks);
		return value.type === "image_url" ? [value] : Object.values(value).flatMap(imageBlocks);
	};
	const assertProviderImages = (request, expected, label) => {
		assert.equal(request.model, SESSION.model); assert.equal(request.stream, true);
		assert.equal(request.keylessPlaceholder, true, "Only the loopback keyless placeholder may reach this listener");
		const blocks = imageBlocks(request.messages);
		for (const image of expected) {
			assert.ok(blocks.some(block => {
				const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
				if (!url?.startsWith(`data:${image.mimeType};base64,`)) return false;
				return Buffer.from(url.split(",")[1], "base64").equals(Buffer.from(image.data, "base64"));
			}), `${label}: actual provider image_url must carry decoded accepted PNG bytes, not text/metadata`);
		}
	};
	const accepted = state => state.events.filter(event => event.event === "accepted");
	const hooks = state => state.events.filter(event => event.event === "intercept");

	evidence.stage = "session extensions: surfaces and image-only message";
	await openSession(SESSION.chatId, SESSION.title);
	assert.equal((await read(SESSION.chatId)).messages.some(message => message.lhQuestions), false, "Extension bootstrap must contain no pending question authority");
	await page.waitForSelector(`${composer} [contenteditable="true"]`, { visible: true });
	assert.equal(await page.$eval(send, button => button.disabled), true, "Empty ordinary native message starts disabled");
	evidence.stage = "session helper registry shortcut ownership";
	evidence.sessionExtensions.push({ label: evidence.stage, ...await verifySessionHelperShortcutOwnership({ page, chord, openSurface, closeSurface: () => action("close") }) });
	evidence.stage = "session extensions: surfaces and image-only message";
	await openSurface();
	await page.locator(`${surface} input`).fill("Parent DOM draft survives nested coverage");
	const parent = await page.$(`${surface} input`);
	const regionBounds = await page.$eval('[data-session-surface-region]', node => {
		const box = element => { const { x, y, width, height, bottom, right } = element.getBoundingClientRect(); return { x, y, width, height, bottom, right }; };
		return { region: box(node), overlay: box(node.querySelector('[data-plugin-session-surface-frame]')),
			semanticDisplay: getComputedStyle(node.querySelector('[data-plugin-session-surface]')).display,
			semanticBounds: box(node.querySelector('[data-plugin-session-surface]')),
			topbar: box(document.querySelector("main header")), sidebar: box(document.querySelector("aside")),
			visibleTitle: node.querySelector("h2")?.textContent, closeVisible: !!node.querySelector('button[aria-label="Close"]'),
			composerCovered: !!document.querySelector('[data-testid="composer"]')?.closest("[inert]") };
	});
	evidence.sessionExtensions.push({ label: "surface body geometry", ...regionBounds });
	assert.equal(regionBounds.semanticDisplay, "contents", "Semantic interaction owner has no painted box; measure its real frame");
	assert.ok(regionBounds.overlay.width > 0 && regionBounds.overlay.height > 0 && regionBounds.region.width > 0 && regionBounds.region.height > 0, "Actual surface frame and body region must have nonzero painted bounds");
	for (const dimension of ["x", "y", "width", "height", "bottom", "right"]) assert.ok(Math.abs(regionBounds.overlay[dimension] - regionBounds.region[dimension]) <= 1,
		`Surface must fill the actual native session body boundary (${dimension}): ${JSON.stringify(regionBounds)}`);
	assert.ok(regionBounds.region.y >= regionBounds.topbar.bottom - 1, "Surface must not cover native topbar");
	assert.ok(regionBounds.region.x >= regionBounds.sidebar.right - 1, "Surface must not cover sidebar");
	assert.equal(regionBounds.visibleTitle, "Session extension proof"); assert.equal(regionBounds.closeVisible, true);
	assert.equal(regionBounds.composerCovered, true, "Covered native input must not remain interactive");
	await action("nested");
	await page.waitForSelector('[data-smoke-session-surface="1"]', { visible: true });
	assert.equal(await parent.evaluate(input => input.isConnected && input.value === "Parent DOM draft survives nested coverage" && !!input.closest("[inert]")), true);
	await chord(","); await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
	assert.equal(await page.$eval('[data-testid="settings-dialog"]', dialog => { const b = dialog.getBoundingClientRect(); return dialog.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), true, "Global Settings must paint above surfaces");
	await page.keyboard.press("Escape"); await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true });
	assert.equal(await page.$$eval(nativeSurface, nodes => nodes.length), 2, "Settings Escape must not close either surface");
	await page.keyboard.press("Escape"); await page.waitForSelector('[data-smoke-session-surface="1"]', { hidden: true });
	assert.equal(await parent.evaluate(input => input.isConnected && input.value === "Parent DOM draft survives nested coverage" && !input.closest("[inert]")), true, "Single Escape must resume the same painted parent DOM");
	await page.locator(`${surface} [data-smoke-session-action="close"]`).click();
	await page.waitForSelector(surface, { hidden: true }); await parent.dispose();
	// Visible native X independently exercises host close, not fixture disposal.
	await openSurface(); await page.locator(`${nativeSurface} button[aria-label="Close"]`).click();
	await page.waitForSelector(surface, { hidden: true });
	const failedArm = await arm(true);
	await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, {}, send);
	const postsBeforeFailure = evidence.requests.filter(entry => entry.method === "POST" && new URL(entry.url).pathname === "/api/chat").length;
	await page.locator(`${composer} [contenteditable="true"]`).fill("Retained native draft after hook failure");
	await page.locator(send).click();
	await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("session fixture fail closed"));
	assert.equal(await page.$eval(`${composer} [contenteditable="true"]`, input => input.textContent), "Retained native draft after hook failure");
	assert.equal(evidence.requests.filter(entry => entry.method === "POST" && new URL(entry.url).pathname === "/api/chat").length, postsBeforeFailure, "Failed interception must stop before native POST");
	let state = await status(); assert.equal(accepted(state).length, 0); assert.equal(hooks(state).length, 1);
	// Enable the exact owner-scoped reporting assertion only AFTER proving
	// retained native draft, no POST and no acceptance for this deliberate error.
	evidence.expectedSessionInterceptorFailure = { message: "session fixture fail closed", retainedDraft: "Retained native draft after hook failure", postsBeforeFailure, postsAfterFailure: evidence.requests.filter(entry => entry.method === "POST" && new URL(entry.url).pathname === "/api/chat").length, accepted: 0 };
	// Fresh native Submit is a new attempt; empty native text is now enough
	// because the public hasPendingInput + refreshSubmissions advertised PNG.
	await page.locator(`${composer} [contenteditable="true"]`).click();
	// macOS headless Mod+A can omit the native editing command (the existing
	// number proof uses this same Chromium command). Do not assign host value.
	const editing = await page.createCDPSession();
	try {
		const key = { key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 };
		await editing.send("Input.dispatchKeyEvent", { ...key, type: "keyDown", commands: ["selectAll"] });
		await editing.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
		const selection = await page.evaluate(selector => ({ text: document.querySelector(selector)?.textContent,
			selected: getSelection()?.toString(), focused: document.activeElement === document.querySelector(selector) }), `${composer} [contenteditable="true"]`);
		evidence.sessionExtensions.push({ label: "trusted native composer selection before clearing", ...selection });
		assert.equal(selection.focused, true); assert.equal(selection.selected, selection.text, "Native selectAll must select the complete retained composer draft");
		await page.keyboard.press("Backspace");
	} finally { await editing.detach(); }
	await page.waitForFunction(selector => !document.querySelector(selector)?.textContent, {}, `${composer} [contenteditable="true"]`);
	const sent = post("text"); await page.locator(send).click(); const delivered = await sent;
	assert.equal(delivered.status(), 200); const deliveredInput = JSON.parse(delivered.request().postData()).input;
	assert.equal(deliveredInput.text, ""); assert.deepEqual(deliveredInput.images, [failedArm.answer]);
	state = await waitStatus(state => accepted(state).length === 1);
	assert.equal(hooks(state).length, 2); assert.equal(accepted(state)[0].pending, false);
	assertProviderImages(state.requests.at(-1), [failedArm.answer], "Image-only native user submission");
	await release(SESSION.chatId);
	await page.waitForSelector('main img[alt="Submitted image"]', { visible: true });
	const nativeUser = (await read(SESSION.chatId)).messages.find(message => message.role === "user" && Array.isArray(message.content) && message.content.some(block => block.type === "image"));
	assert.ok(nativeUser); assert.deepEqual(nativeUser.content.filter(block => block.type === "image"), [failedArm.answer]);
	await sendText(SESSION.chatId, SESSION.pathText);
	assert.equal(await page.$$eval('main img[alt="Submitted image"]', nodes => nodes.length), 1, ".png attached-looking path must remain text/path, not inferred image");
	const pathRecord = await read(SESSION.chatId);
	assert.ok(pathRecord.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(SESSION.pathText)), "Path stays native text authority");
	evidence.sessionExtensions.push({ label: "body bounds, title/X, mounted stack, Settings/one Escape, fail-closed retained native draft then fresh image-only Submit", regionBounds, deliveredInput, events: state.events });
	await screenshot("session-image-only-and-surfaces");

	evidence.stage = "session extensions: transformed native answer channels";
	await sendText(SESSION.chatId, SESSION.questionPrompt);
	await page.waitForSelector('[data-testid="teach-check-reveal"]', { visible: true });
	await page.locator('[data-testid="reading-thinking-field"] [contenteditable="true"]').fill("Separate reading text before reveal.");
	await page.locator('[data-testid="teach-check-reveal"]').click();
	await page.waitForSelector('[data-smoke-question-editor]:not(:disabled)', { visible: true });
	const original = '  function canvasAnswer() {\n\treturn "<svg> & PNG";\n}  \n';
	await page.locator('[data-smoke-question-editor]').fill(original);
	await page.locator('[data-testid="plugin-question-dock"] [aria-label="Your thinking"]').fill("Separate answer thinking.");
	const answerArm = await arm(false);
	const countBefore = hooks(await status()).length;
	const answered = post("plugin-question-answer");
	await page.focus('[data-smoke-question-editor]'); await chord("Enter");
	const answerResponse = await answered; assert.equal(answerResponse.status(), 200);
	const answerInput = JSON.parse(answerResponse.request().postData()).input;
	assert.equal(answerInput.answer, original + SESSION.codeSuffix);
	assert.equal(answerInput.thinking, "Separate answer thinking."); assert.equal(answerInput.readingThinking, "Separate reading text before reveal.");
	assert.deepEqual(answerInput.images, { answer: [answerArm.answer], thinking: [answerArm.thinking], readingThinking: [answerArm.reading] });
	state = await waitStatus(state => state.pending === 1 && hooks(state).length === countBefore + 1 && accepted(state).length === 2);
	const answerResult = (await read(SESSION.chatId)).messages.find(message => message.role === "toolResult" && message.details?.typeId === SESSION.typeId);
	assert.ok(answerResult, "Native answer result must exist before provider response release");
	assert.equal(answerResult.details.answer, original + SESSION.codeSuffix); assert.deepEqual(answerResult.details.images, answerInput.images);
	assert.deepEqual(answerResult.content.filter(block => block.type === "image"), [answerArm.answer, answerArm.thinking, answerArm.reading], "Native tool result keeps ordered answer, thinking and reading image channels");
	assertProviderImages(state.requests.at(-1), [answerArm.answer, answerArm.thinking, answerArm.reading], "Genuine native answer continuation");
	const modelContent = JSON.stringify(state.requests.at(-1).messages);
	assert.ok(modelContent.includes("reading") && modelContent.includes("thinking"), "Provider projection labels separate thinking channels");
	await release(SESSION.chatId);
	await page.waitForFunction(() => [...document.querySelectorAll('main img[alt="Submitted image"]')].length === 4);
	const channelPlacement = await page.$$eval('main img[alt="Submitted image"]', images => images.map(image => ({ src: image.src,
		thinkingLabel: (() => { let node = image.parentElement; while (node && node.tagName !== "MAIN") { const button = node.querySelector(':scope > button[aria-expanded]'); if (button) return button.textContent.trim(); node = node.parentElement; } return null; })() })));
	assert.ok(channelPlacement.some(entry => entry.thinkingLabel?.includes("THINKING WHILE READING")), "Reading image has separate visible host container");
	assert.ok(channelPlacement.some(entry => entry.thinkingLabel?.includes("YOUR THINKING")), "Question-thinking image has visible host thinking container");
	assert.equal(await page.$eval('[data-smoke-question-answered]', node => node.textContent), original + SESSION.codeSuffix, "Ordinary external renderer preserves transformed code verbatim while host owns images outside it");
	evidence.sessionExtensions.push({ label: "genuine plugin JSON-string answer transform, code verbatim, three native image channels and actual adapter payload", answerInput, answerResult, channelPlacement, provider: state.requests.at(-1) });
	await screenshot("session-native-answer-images");

	evidence.stage = "session extensions: model retry reuses accepted input";
	const retryArm = await arm("model-error");
	const beforeRetry = await status();
	const failedPost = post("text"); await page.locator(send).click();
	assert.equal((await failedPost).status(), 200, "Provider failure follows acknowledged native acceptance, not preparation refusal");
	await page.waitForSelector('[data-testid="retry-failed-turn"]', { visible: true });
	const failedState = await waitStatus(state => accepted(state).length === 3);
	assert.equal(hooks(failedState).length, hooks(beforeRetry).length + 1);
	assert.equal(failedState.requests.length, beforeRetry.requests.length + 1, "Deliberate loopback 400 must produce one model failure without mock auto-retry");
	assertProviderImages(failedState.requests.at(-1), [retryArm.answer], "Failed model request still receives accepted image bytes");
	const modelRetryResponse = post("retry");
	await page.locator('[data-testid="retry-failed-turn"]').click();
	assert.equal((await modelRetryResponse).status(), 200);
	state = await waitStatus(state => state.pending === 1 && state.requests.length === failedState.requests.length + 1);
	assert.equal(hooks(state).length, hooks(failedState).length, "Native model Retry must NOT run submission interception again");
	assert.equal(accepted(state).length, accepted(failedState).length, "Native model Retry must not notify the original acceptance again");
	assertProviderImages(state.requests.at(-1), [retryArm.answer], "Retried model reuses the accepted transformed image");
	await release(SESSION.chatId);
	evidence.sessionExtensions.push({ label: "accepted image survives deliberate model failure; native Retry reuses it without hook/acceptance replay", hooksBeforeRetry: hooks(failedState).length, hooksAfterRetry: hooks(state).length, requests: state.requests.slice(-2) });

	// Native navigation expires the exact opaque token. A retained public
	// plugin control attempts reuse; no fabricated target or host debug hook.
	await openSurface(); const departed = await page.$(surface);
	await openProof(); assert.equal(await departed.evaluate(node => !node.isConnected), true); await departed.dispose();
	assert.ok(evidence.expectedSessionInterceptorAlerts?.some(entry => entry.alerts.some(alert => alert.owner === "native-smoke/public-proof-panel" && alert.text === "session fixture fail closed")), "Intentional interceptor failure remains visibly reported by the exact public fixture owner");
	await page.$$eval(`${MOUNT} button`, buttons => buttons.find(button => button.textContent.trim() === "Probe stale surface target").click());
	state = await waitStatus(state => state.events.some(event => event.event === "stale-target"));
	assert.equal(state.events.find(event => event.event === "stale-target").error, "Surface target is no longer active");
	assert.equal(await page.$$eval(nativeSurface, nodes => nodes.length), 0);
	assert.ok(hooks(state).every(event => event.historyFrozen && event.inputFrozen && event.surfaceTargetPresent), "Only immutable public submission/context snapshots are consumed");
	evidence.sessionExtensions.push({ label: "native navigation destroys surface and stale opaque target fails synchronously", event: state.events.find(event => event.event === "stale-target") });
	evidence.stage = "session extensions: image-only practice thinking";
	await openSession(SESSION.practiceId, SESSION.practiceTitle);
	assert.deepEqual((await read(SESSION.practiceId)).messages, [], "Practice fixture starts with ordinary empty history, no fabricated problem/result/answer");
	await page.waitForSelector(`${composer} [contenteditable="true"]`, { visible: true });
	await sendText(SESSION.practiceId, SESSION.practicePrompt);
	await page.waitForSelector('[data-testid="practice-thinking-field"] [role="textbox"]', { visible: true });
	assert.equal(await page.$eval('[data-testid="practice-send"]', button => button.disabled), true);
	const problemRecord = await read(SESSION.practiceId);
	assert.ok(problemRecord.messages.some(message => message.role === "assistant" && message.content?.some(block => block.type === "toolCall" && block.name === "problem")), "Actual native practice agent must pose the problem through the loopback model");
	const thinkingArm = await arm(false);
	await page.waitForFunction(() => !document.querySelector('[data-testid="practice-send"]')?.disabled);
	assert.equal(await page.$eval('[data-testid="practice-thinking-field"] [role="textbox"]', input => input.textContent), "");
	const thinkingPosts = post("thinking"); await page.locator('[data-testid="practice-send"]').click();
	const thinkingResponse = await thinkingPosts; assert.equal(thinkingResponse.status(), 200);
	const thinkingInput = JSON.parse(thinkingResponse.request().postData()).input;
	assert.equal(thinkingInput.text, ""); assert.deepEqual(thinkingInput.images, [thinkingArm.answer]);
	assert.ok(thinkingInput.occurrence?.messageId && thinkingInput.occurrence?.toolCallId, "Thinking POST binds the actual native problem occurrence");
	state = await waitStatus(state => state.pending === 1 && accepted(state).length === 4);
	assertProviderImages(state.requests.at(-1), [thinkingArm.answer], "Image-only practice thinking projection");
	const thinkingRecord = await read(SESSION.practiceId);
	const marker = thinkingRecord.messages.find(message => message.role === "custom" && message.details?.images?.length);
	assert.ok(marker, "Image-only thinking must persist as a genuine native marker");
	assert.deepEqual(marker.details.images, [thinkingArm.answer]);
	await release(SESSION.practiceId);
	await page.waitForSelector('main img[alt="Submitted image"]', { visible: true });
	assert.equal(await page.$$eval('main img[alt="Submitted image"]', images => images.length), 1);
	evidence.sessionExtensions.push({ label: "real native problem → empty thinking enabled by pending refresh → native marker image → decoded provider image_url bytes", thinkingInput, marker, provider: state.requests.at(-1) });
	await screenshot("session-practice-image-only-thinking");
	await openProof();
	await health();
	evidence.assertions.push("PUBLIC external interceptor and session topbar opaque target: genuine canvas PNG, pending readiness refresh, fail-closed draft retention then fresh empty native Submit, accepted consumption, .png path stays text, verbatim JSON-string/code answer transform with distinct thinking/reading images in native result and decoded OpenAI image_url bytes; body-only titled/X surface stack retains parent DOM, Global Settings and natural one-Escape ordering, navigation expires target");
}
