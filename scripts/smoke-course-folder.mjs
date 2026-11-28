/** Real local source selection -> preview -> native opening request, no inference. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "lh-material-browser-"));
const vault = path.join(home, "vault"), origin = "http://127.0.0.1:3197";
await fs.mkdir(path.join(vault,"Systems","Week 1"),{recursive:true}); await fs.mkdir(path.join(vault,"Assets")); await fs.writeFile(path.join(vault,"Systems","Week 1","Intro.md"),"![[Shared.pdf]]"); await fs.copyFile(path.join(root,"tests/fixtures/sample-3page.pdf"),path.join(vault,"Assets","Shared.pdf")); for(const [name,dir] of [["Scheduling.ppt","Systems"],["Scheduling.pptx","Systems/Week 1"]]) await fs.copyFile(path.join(root,"tests/fixtures/course-slides",name),path.join(vault,dir,name));
const server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: root, windowsHide: true, env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3197", NODE_ENV: "production", LH_AUTH_FILE: path.join(home, "auth.json"), LH_DATA_DIR: path.join(home, "data"), LH_IGNORE_ENV_KEYS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser, logs = "";
server.stdout.on("data", data => { logs = (logs + data).slice(-12000); }); server.stderr.on("data", data => { logs = (logs + data).slice(-12000); });
const click = (page, text) => page.evaluate(text => { const button = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === text); if (!button) throw new Error(`Missing ${text}`); button.click(); }, text);
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 200)); }
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
	const page = await browser.newPage(); page.setDefaultTimeout(30000); await page.setViewport({ width: 1440, height: 1000 });
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	const model = { id: "synthetic", name: "Synthetic", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 4096 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.pathname === "/api/models") return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [model], slots: { strong: slot, cheap: slot, vision: slot }, providers: [{ id: "fixture", label: "Fixture", keyPresent: true }] }) });
		if (url.pathname === "/api/chat" && request.method() === "POST") return request.respond({ status: 503, contentType: "application/json", body: '{"error":"No inference in browser acceptance"}' });
		return request.continue();
	});
	await page.goto(`${origin}/materials`, { waitUntil: "networkidle2" });
	await page.type('[aria-label="Obsidian vault folder"]', vault); await click(page, "Save connections");
	await page.waitForFunction(()=>document.body.innerText.includes("↳ Systems")); await click(page,"↳ Systems"); await click(page,"Study this folder");
	await page.waitForSelector('[aria-label="Course learning goal"]');
	const labels=await page.$$eval('[aria-label="Course folder"] label',ls=>ls.map(l=>[l.innerText,l.querySelector("input").checked]));assert.equal(labels.length,4);assert.equal(labels.filter(l=>l[1]).length,3);
	await page.evaluate(()=>[...document.querySelectorAll('[aria-label="Course folder"] label')].find(l=>l.textContent.includes("Shared.pdf")).querySelector("input").click());
	await page.type('[aria-label="Course learning goal"]',"Teach round robin");
	if(process.env.LH_UI_SCREENSHOTS) await page.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,"course-folder.png")});
	const posted=page.waitForRequest(r=>new URL(r.url()).pathname==="/api/chat" && r.method()==="POST",{timeout:120000});
	await click(page,"Start course lesson");
	const input=JSON.parse((await posted).postData()).input.text;
	assert(input.includes("Teach round robin") && input.includes("Shared.pdf") && input.includes("Intro.md"));assert(input.includes("Scheduling.pptx") && input.includes("Scheduling.ppt"));
	const pdfs=await fs.readdir(path.join(home,"data","course-pdfs"),{recursive:true});
	assert.equal(pdfs.filter(f=>f.endsWith(".pdf")).length,2);
	for(const f of pdfs.filter(f=>f.endsWith(".pdf"))){const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs"); const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(path.join(home,"data","course-pdfs",f)))});const doc=await task.promise;const t=await(await doc.getPage(1)).getTextContent(); assert(t.items.map(i=>i.str).join(" ").includes("time quantum"));await task.destroy();}
	assert.deepEqual(errors,[]);console.log("Course folder → selected notes + linked attachment + real PPT/PPTX → readable PDFs → native lesson opening verified.");
} catch (error) { console.error(logs.slice(-4000)); throw error; }
finally { await browser?.close(); server.kill(); if (server.exitCode === null) await once(server, "close"); assert.equal(await fs.realpath(path.dirname(home)), await fs.realpath(os.tmpdir())); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
