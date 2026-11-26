// Run against a disposable local LearnHarness server with LH_UI_ORIGIN and LH_TEST_CHROME.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const origin = process.env.LH_UI_ORIGIN;
assert(origin && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const browser = await puppeteer.launch({executablePath: process.env.LH_TEST_CHROME, headless: true});
try {
 const page = await browser.newPage();
 async function check(testId, label) {
  await page.evaluate(() => {
   const root = document.documentElement;
   root.classList.add("lh-electron");
   root.dataset.lhPlatform = "win32";
   root.style.setProperty("--lh-wco-right", "138px");
  });
  const anchor = '[data-testid="' + testId + '"]';
  await page.hover(anchor);
  await page.waitForSelector('[role="tooltip"]', {visible: true});
  const bounds = await page.$eval(anchor, async node => {
   const tip = document.getElementById(node.getAttribute("aria-describedby"));
   await Promise.all(tip.getAnimations().map(animation => animation.finished));
   const r = tip.getBoundingClientRect();
   return {text: tip.textContent, right: r.right, left: r.left, anchorRight: node.getBoundingClientRect().right, controlsLeft: innerWidth - 138};
  });
  assert.equal(bounds.text, label);
  assert(bounds.left >= 0 && bounds.right <= bounds.controlsLeft && Math.abs(bounds.right - bounds.anchorRight) <= 1, JSON.stringify(bounds));
  console.log(testId, bounds);
  await page.mouse.move(3, 200);
 }
 for (const width of [1440, 960]) {
  await page.setViewport({width, height: 850});
  await page.goto(origin, {waitUntil: "networkidle2"});
  await check("import-notes", "Extract files into the graph");
  const id = await page.evaluate(async () => {
   const response = await fetch("/api/chats", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({title:"Tooltip geometry fixture"})});
   return (await response.json()).id;
  });
  await page.goto(origin + "/chat/" + id, {waitUntil: "networkidle2"});
  await check("coverage-ring", "Not yet mapped to the knowledge graph");
 }
} finally { await browser.close(); }
