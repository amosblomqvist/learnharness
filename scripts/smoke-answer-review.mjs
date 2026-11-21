/** Production-browser acceptance with synthetic saved records. No inference. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "lh-answer-review-"));
const port = 3185, origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: root, windowsHide: true,
	env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production", LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", data => { logs = (logs + data).slice(-12000); });
server.stderr.on("data", data => { logs = (logs + data).slice(-12000); });
const click = (page, text) => page.evaluate(text => {
	const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
	if (!button) throw new Error(`Missing button ${text}`); button.click();
}, text);
try {
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* Startup. */ }
		if (server.exitCode !== null) throw new Error(logs);
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	const created = await (await fetch(`${origin}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Synthetic answer review" }) })).json();
	const file = path.join(home, "data", "chats", `${created.id}.json`);
	const record = JSON.parse(await fs.readFile(file, "utf8"));
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (id, content) => ({ id, role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "toolUse", usage, content });
	const question = text => ({ question: text, options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }], correctAnswer: "one", explanation: "The first option is correct." });
	record.messages = [
		{ id: "learner", role: "user", content: "Teach this synthetic concept", timestamp: 0 },
		assistant("posed", [{ type: "text", text: "Earlier explanation." }, { type: "toolCall", id: "q1", name: "probe", arguments: question("Previous question") }]),
		{ id: "graded", role: "toolResult", toolCallId: "q1", toolName: "probe", content: [{ type: "text", text: "Correct" }], details: { kind: "quiz", tool: "probe", questionText: "Previous question", dontKnow: false, answers: [{ index: 0, label: "One", correct: true }], correct: true, explanation: "The first option is correct." }, isError: false, timestamp: 2 },
		assistant("reaction", [{ type: "text", text: "Correct. Your reasoning identifies the key distinction." }, { type: "toolCall", id: "q2", name: "probe", arguments: question("NEXT QUESTION HELD FOR LEARNER") }]),
	];
	await fs.writeFile(file, JSON.stringify(record));
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
	const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
	page.setDefaultTimeout(30000);
	const errors = [], asks = [], main = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.pathname === "/api/chat" && request.method() === "POST") { main.push(JSON.parse(request.postData())); return request.respond({ status: 503, contentType: "application/json", body: '{"error":"No inference in browser test"}' }); }
		if (url.pathname.endsWith("/side-chats") && request.method() === "POST") { asks.push(JSON.parse(request.postData())); return request.respond({ status: 503, contentType: "application/json", body: '{"error":"Synthetic retry fixture"}' }); }
		return request.continue();
	});
	await page.goto(`${origin}/chat/${created.id}`, { waitUntil: "networkidle2" });
	await page.waitForSelector('[data-testid="answer-review"]');
	assert(!(await page.evaluate(() => document.body.innerText)).includes("NEXT QUESTION HELD FOR LEARNER"));
	const spacing = () => page.evaluate(() => {
		const panel=document.querySelector('[data-testid="answer-review"]'), col=panel.parentElement;
		const feedback=[...col.querySelectorAll('p')].find(p=>p.textContent==='Correct. Your reasoning identifies the key distinction.');
		const title=document.querySelector('button[data-plugin-chrome-title]'), header=title.closest('header');
		const a=panel.getBoundingClientRect(), b=feedback.getBoundingClientRect(), c=col.getBoundingClientRect(), t=title.getBoundingClientRect(), h=header.getBoundingClientRect();
		return { gap:a.top-b.bottom, axis:Math.abs(a.left-c.left-parseFloat(getComputedStyle(col).paddingLeft)), titleHeight:t.height, titleBalance:Math.abs((t.top-h.top)-(h.bottom-t.bottom)), overflow:document.documentElement.scrollWidth>innerWidth };
	});
	const desktop=await spacing(); console.log('Desktop spacing',desktop); assert(desktop.gap>=16 && desktop.gap<=40); assert(desktop.axis<1.1); assert.equal(desktop.overflow,false);
	if(process.env.LH_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,'lesson-spacing-desktop.png')});
	await page.setViewport({width:390,height:844});
	await page.click('[aria-label="Close sidebar"]');
	await page.waitForFunction(()=>document.querySelector('[data-session-find-root]').getBoundingClientRect().width>350);
	const mobile=await spacing(); console.log('Mobile spacing',mobile);assert(mobile.axis<1.1);assert(mobile.gap>=16 && mobile.gap<=40);assert.equal(mobile.overflow,false);
	if(process.env.LH_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,'lesson-spacing-mobile.png')});
	await page.setViewport({width:1440,height:1000});
	await click(page, "Ask about this answer");
	await page.waitForSelector('[data-testid="side-thread-input"]'); assert.equal(asks.length, 0); assert.equal(main.length, 0);
	await page.click('[aria-label="Close side conversation"]');
	await click(page, "Explain it to AI");
	await page.waitForFunction(() => document.body.innerText.includes("Feynman practice: one question at a time"));
	await page.type('[data-testid="side-thread-input"]', "My explanation is that the first option follows from the definition.");
	await page.click('[aria-label="Send side question"]');
	await page.waitForFunction(() => document.body.innerText.includes("Synthetic retry fixture"));
	assert(asks[0].text.startsWith("[Feynman practice]\n"));
	assert.equal(asks[0].anchor.messageId, "posed"); assert.equal(main.length, 0);
	if (process.env.LH_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.LH_UI_SCREENSHOTS, "answer-review-feynman.png") });
	await page.click('[aria-label="Close side conversation"]');
	await click(page, "Continue to next question");
	await page.waitForFunction(() => document.body.innerText.includes("NEXT QUESTION HELD FOR LEARNER"));
	assert.equal(main.length, 0);
	await page.reload({ waitUntil: "networkidle2" });
	assert.equal(await page.$('[data-testid="answer-review"]'), null);
	assert((await page.evaluate(() => document.body.innerText)).includes("NEXT QUESTION HELD FOR LEARNER"));
	assert.deepEqual(errors, []);
	console.log("Browser review passed: feedback pause, correct side anchor, optional Feynman request, next reveal, reload acknowledgement; zero main inference.");
} catch (error) { console.error(logs.slice(-4000)); throw error; }
finally {
	await browser?.close();
	server.kill(); if (server.exitCode === null) await once(server, "close");
	await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
