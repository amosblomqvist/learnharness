/** Saved-message rendering regression; synthetic records, no account or inference. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'lh-manual-handoff-'));
const origin='http://127.0.0.1:3191';
const server=spawn(process.execPath,['.next/standalone/server.js'],{cwd:root,windowsHide:true,env:{...process.env,HOSTNAME:'127.0.0.1',PORT:'3191',NODE_ENV:'production',LH_AUTH_FILE:path.join(home,'auth.json'),LH_DATA_DIR:path.join(home,'data'),LH_IGNORE_ENV_KEYS:'1'},stdio:['ignore','pipe','pipe']});
let browser,logs='';
server.stdout.on('data',d=>logs=(logs+d).slice(-8000));server.stderr.on('data',d=>logs=(logs+d).slice(-8000));
try {
 for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
 const created=await(await fetch(`${origin}/api/chats`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Lesson handoff fixture'})})).json();
 const file=path.join(home,'data','chats',`${created.id}.json`),record=JSON.parse(await fs.readFile(file,'utf8'));
 record.messages=[{id:'user',role:'user',content:'Ask a synthetic question.',timestamp:1},{id:'assistant',role:'assistant',provider:'codex',model:'fixture',api:'codex',timestamp:2,stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'text',text:'Choose an answer or start teaching now.'},{type:'toolCall',id:'q',name:'probe',arguments:{question:'NATIVE QUESTION CARD',options:[{label:'Choice one',value:'one'},{label:'Choice two',value:'two'}],correctAnswer:'one',explanation:'Normal hidden answer explanation'}}]}];
 const original=JSON.stringify(record);await fs.writeFile(file,original);
 browser=await puppeteer.launch({executablePath:process.env.LH_TEST_CHROME,headless:true,args:['--disable-background-networking','--no-first-run']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1000});
 await page.goto(`${origin}/chat/${created.id}`,{waitUntil:'networkidle2'});
 await page.waitForFunction(()=>document.body.innerText.includes('NATIVE QUESTION CARD'));
 assert.equal(await page.$('[data-testid="coverage-ring"]'),null);
 const finish='[data-testid="end-probe"]';await page.waitForSelector(finish);
 await page.setRequestInterception(true);let submissions=0;
 page.on('request', req=>{
  if(new URL(req.url()).pathname==='/api/chat' && req.method()==='POST'){
   const data=JSON.parse(req.postData());assert.deepEqual(data.input,{type:'end-probe',lastMessageId:'assistant'});
   submissions++;return req.respond({status:503,body:'Fixture: no inference'});
  }return req.continue();
 });
 page.once('dialog',d=>d.dismiss());await page.click(finish);assert.equal(submissions,0);
 if(process.env.LH_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,'manual-handoff-header.png')});
 page.once('dialog',d=>d.accept());await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat'),page.click(finish)]);
 assert.equal(submissions,1);
 await page.goto(origin,{waitUntil:'networkidle2'});
 const ring='[data-testid="coverage-ring"]';await page.waitForSelector(ring);
 assert.equal(await page.$eval('select[aria-label="Session for graph coverage"]',el=>el.value),created.id);
 await page.hover(ring);await page.waitForSelector('[role="tooltip"]');
 await page.click(ring);await page.waitForSelector('[data-testid="coverage-ring-popover"]');
 if(process.env.LH_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LH_UI_SCREENSHOTS,'graph-session-coverage.png')});
 assert.deepEqual(errors,[]);console.log('Passed: confirmation, canonical request, lesson header and graph coverage details.');
}finally{await browser?.close();server.kill();if(server.exitCode===null)await once(server,'close');assert.equal(await fs.realpath(path.dirname(home)),await fs.realpath(os.tmpdir()));await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
