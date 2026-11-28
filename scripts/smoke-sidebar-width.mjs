// Uses separate application processes, origins and browser contexts with one disposable data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "lh-sidebar-width-"));
let server, browser;
async function open(port) {
 const origin = "http://127.0.0.1:" + port;
 server = spawn(process.execPath, [".next/standalone/server.js"], {cwd:path.resolve(import.meta.dirname,".."),windowsHide:true,stdio:"ignore",
  env:{...process.env, PORT:String(port),HOSTNAME:"127.0.0.1",LH_DATA_DIR:path.join(home,"data"),LH_AUTH_FILE:path.join(home,"auth.json"),LH_IGNORE_ENV_KEYS:"1"}});
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error("Server exited");try{if((await fetch(origin)).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
 browser=await puppeteer.launch({executablePath:process.env.LH_TEST_CHROME,headless:true});
 const page=await browser.newPage();await page.setUserAgent(await browser.userAgent()+" Electron/44");
 await page.setViewport({width:1440,height:900});await page.goto(origin,{waitUntil:"networkidle2"});return page;
}
async function close(){await browser?.close();browser=undefined;if(server && server.exitCode===null){const ended=once(server,"close");server.kill();await ended;}server=undefined;}
const sel='[role="separator"][aria-label="Resize session sidebar"]';
const width=(p,n)=>p.waitForFunction(w=>document.querySelector("aside")?.getBoundingClientRect().width===w,{},n);
try{
 let p=await open(3192);await width(p,288);
 const r=await p.$eval(sel,e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]});
 await p.mouse.move(...r);await p.mouse.down();
 await p.mouse.move(r[0]+96,r[1],{steps:8});await width(p,384);
 const [response]=await Promise.all([p.waitForResponse(r=>r.url().endsWith("/api/settings/sidebar")&&r.request().method()==="PUT"),p.mouse.up()]);
 assert.equal(response.status(),200);await close();
 p=await open(3193);await width(p,384);
 await p.setViewport({width:960,height:800});await width(p,320);
 await p.setViewport({width:900,height:800});await width(p,0);
 await p.setViewport({width:1440,height:900});await width(p,384);
 await p.click('button[aria-label="Close sidebar"]');await width(p,0);
 await p.click('button[aria-label="Open sidebar"]');await width(p,384);
 if(process.env.LH_UI_SCREENSHOTS)await p.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,"sidebar-resized.png")});
 await p.focus(sel);await p.keyboard.press("ArrowLeft");await width(p,376);
 console.log("Real drag: 288 to 384. New server, port and browser restored 384. Narrow clamp, auto-close, toggle and keyboard passed.");
}finally{await close();assert.equal(await fs.realpath(path.dirname(home)),await fs.realpath(os.tmpdir()));await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
