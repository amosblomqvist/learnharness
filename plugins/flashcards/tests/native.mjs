// Real shared widgets in an exact, copied standalone host. Never uses a real profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
const plugin = fileURLToPath(new URL('../', import.meta.url)), repo = path.resolve(plugin, '../..');
const require = createRequire(import.meta.url);
const { openStore } = require('../src/store.cjs'), { createSchedule } = require('../src/scheduler.cjs');
assert.ok(process.env.LH_STANDALONE && process.env.LH_APPROVED_HOST_DIGEST, 'Supply an approved frozen host via LH_STANDALONE and LH_APPROVED_HOST_DIGEST. This test never builds the host.');
const source = fs.realpathSync(process.env.LH_STANDALONE), built = path.join(plugin, 'dist');
function digest(root) {
  const hash = crypto.createHash('sha256');
  function visit(dir) { for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), stat = fs.lstatSync(file); hash.update(path.relative(root, file) + '\0');
    if (stat.isSymbolicLink()) hash.update('link:' + fs.readlinkSync(file)); else if (stat.isDirectory()) visit(file); else if (stat.isFile()) hash.update(fs.readFileSync(file));
  } }
  visit(root); return hash.digest('hex');
}
function verifyLinks(root, dir = root) { for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name), stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) assert.ok(fs.realpathSync(file).startsWith(root + path.sep), `Symlink escapes copy: ${file}`);
  else if (stat.isDirectory()) verifyLinks(root, file);
} }
const sourceDigest = digest(source), builtDigest = digest(built);
assert.equal(sourceDigest, process.env.LH_APPROVED_HOST_DIGEST);
assert.equal(JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'))).id, 'flashcards');
const scratch = fs.realpathSync(fs.mkdtempSync('/tmp/lh-flashcards-tree-native-'));
console.log('Evidence:', scratch);
const home = path.join(scratch, 'home'), data = path.join(home, 'data'), standalone = path.join(scratch, 'standalone'), installed = path.join(data, 'plugins/flashcards');
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: home, USERPROFILE: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch, APPDATA: path.join(home, 'config'), LOCALAPPDATA: path.join(home, 'local'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, 'auth.json'), LH_IGNORE_ENV_KEYS: '1', NODE_ENV: 'production' };
const evidence = { source, sourceDigest, builtDigest, assertions: [], errors: [], failedRequests: [], blockedRequests: [], providerRequests: [], microphoneRequests: [], calls: [], screenshots: [] };
let child, browser, page, stage = 'prepare', injectRenameFailure = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const catalog = http.createServer((req, res) => {
  evidence.providerRequests.push({ method: req.method, path: req.url });
  res.writeHead(req.method === 'GET' && req.url === '/v1/models' ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'offline-flashcards', object: 'model', owned_by: 'offline-fixture' }] }));
});
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };
try {
  fs.cpSync(source, standalone, { recursive: true, verbatimSymlinks: true }); verifyLinks(standalone);
  fs.mkdirSync(installed, { recursive: true }); fs.cpSync(built, path.join(installed, 'dist'), { recursive: true, dereference: true });
  assert.equal(digest(path.join(installed, 'dist')), builtDigest);
  fs.writeFileSync(env.LH_AUTH_FILE, '{}\n');
  const graph = path.join(data, 'graph'); fs.mkdirSync(graph);
  const createdAt = '2026-11-01T00:00:00.000Z', provenance = [{ chatId: 'src_fixture', messageId: '' }];
  const nodes = ['n_fixture_a', 'n_fixture_b'].map((id, i) => ({ id, name: `Proposition ${i + 1}`, statement: `Synthetic proposition ${i + 1}.`, aliases: [], createdAt, provenance }));
  fs.writeFileSync(path.join(graph, 'nodes.jsonl'), nodes.map(n => JSON.stringify(n)).join('\n') + '\n');
  fs.writeFileSync(path.join(graph, 'chains.jsonl'), JSON.stringify({ id: 'arg_fixture', premises: [nodes[0].id], conclusion: nodes[1].id, createdAt, provenance }) + '\n');
  fs.writeFileSync(path.join(graph, 'sources.json'), JSON.stringify({ src_fixture: { id: 'src_fixture', filePath: 'Synthetic knowledge.md', importedAt: createdAt } }));
  fs.writeFileSync(path.join(graph, 'format.json'), '{"version":1}');
  const graphBefore = digest(graph);
  const questions = ['Which identity gives one?', 'Which identity gives **two**?', 'Which identity gives three?'];
  const richAnswer = 'SECRET TWO\n\nInline $1+1=2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n\n```mermaid\ngraph LR\n A-->B\n```';
  openStore(path.join(installed, 'data')).change(s => {
    s.decks = [{ id: 'd1', name: 'Foundations', sourceId: 'src_fixture', newLimit: 20, propositionIds: [...nodes.map(n => n.id), 'n_archived'] }, { id: 'd2', name: 'Practice set', newLimit: 20, propositionIds: [nodes[0].id] }];
    for (const [i, n] of nodes.entries()) s.propositions[n.id] = { ...n, snapshot: n, cues: i ? [{ id: 'c3', question: questions[2], answer: 'Three.', latestRating: null }] : [{ id: 'c1', question: questions[0], answer: 'One.', latestRating: null }, { id: 'c2', question: questions[1], answer: richAnswer, latestRating: null }], schedule: createSchedule(), firstReviewedAt: null, learningCueId: null, version: 1 };
    s.propositions.n_archived = { ...nodes[0], id: 'n_archived', name: 'Archived proposition', cues: [{ id: 'c_archive', question: 'Archived cue?', answer: 'Retained.', latestRating: null }], schedule: createSchedule(), firstReviewedAt: null, learningCueId: null, version: 1 };
  });
  const portProbe = http.createServer(), port = await listen(portProbe); await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const runtime = process.env.LH_NODE_RUNTIME || path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const guard = path.join(scratch, 'imports.mjs');
  fs.writeFileSync(guard, `import {registerHooks} from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';const roots=${JSON.stringify([standalone, path.join(data, 'plugins')])};registerHooks({resolve(s,c,n){const r=n(s,c);if(r.url.startsWith('file:')){const f=realpathSync(fileURLToPath(r.url));if(!roots.some(root=>f===root||f.startsWith(root+path.sep)))throw Error('Import escaped disposable payload: '+f)}return r}});`);
  const log = fs.openSync(path.join(scratch, 'server.log'), 'w');
  child = spawn(runtime, ['--import', guard, path.join(standalone, 'server.js')], { cwd: standalone, env: { ...env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  child.on('error', error => evidence.errors.push(error.message));
  const deadline = Date.now() + 30000;
  while (true) { assert.equal(child.exitCode, null); try { const response = await fetch(base, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) break; } catch {} assert.ok(Date.now() < deadline, 'Server boot timeout'); await delay(100); }
  const api = async (route, method = 'GET', body, extraHeaders = {}) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); assert.equal(response.status, 200, `${route}: ${text}`); return { response, payload: JSON.parse(text) };
  };
  const call = async (operation, input = {}) => (await api('/api/plugins/flashcards/call', 'POST', { operation, input })).payload.result;
  assert.deepEqual((await api('/api/plugins')).payload.plugins.map(p => p.id), ['flashcards']);
  await api('/api/plugins/flashcards', 'PUT', { enabled: true });
  const provider = await api('/api/custom-provider');
  await api('/api/custom-provider', 'POST', { baseUrl: `http://127.0.0.1:${await listen(catalog)}/v1`, authMode: 'keyless' }, { 'If-Match': provider.response.headers.get('etag') });
  const settingsBefore = (await api('/api/settings')).payload;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: path.join(scratch, 'chrome-profile'), env, args: ['--disable-background-networking', '--disable-sync', '--no-first-run', '--no-default-browser-check'] });
  page = await browser.newPage(); page.setDefaultTimeout(15000); await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('requestfailed', r => evidence.failedRequests.push({ stage, url: r.url(), error: r.failure()?.errorText }));
  await page.exposeFunction('__flashcardsMicTripwire', () => evidence.microphoneRequests.push(stage));
  await page.evaluateOnNewDocument(() => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { await window.__flashcardsMicTripwire(); throw Error('Microphone forbidden'); }; });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!(request.url().startsWith(base + '/') || /^(data:|blob:)/.test(request.url()))) { evidence.blockedRequests.push(request.url()); return void request.abort(); }
    if (request.url().endsWith('/api/plugins/flashcards/call') && request.method() === 'POST') {
      const body = JSON.parse(request.postData()); evidence.calls.push({ stage, ...body });
      if (injectRenameFailure && body.operation === 'save-deck') { injectRenameFailure = false; return void request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture rename failure' }) }); }
    }
    void request.continue();
  });
  const button = async (scope, text) => { for (const handle of await page.$$(scope + ' button')) if ((await handle.evaluate(n => n.getAttribute('aria-label') || n.textContent.trim())) === text) { await handle.click(); return; } throw Error(`Missing ${text} in ${scope}`); };
  const row = key => `[data-plugin-tree-row="${key}"]`;
  const shot = async name => { await page.screenshot({ path: path.join(scratch, name + '.png'), fullPage: true }); evidence.screenshots.push(name + '.png'); };
  stage = 'tree';
  await page.goto(base + '/plugins/flashcards/library', { waitUntil: 'networkidle2' }); await page.waitForSelector(row('deck:d1'));
  assert.equal(await page.$eval('.fc-selection-actions', n => n.hidden), false);
  assert.equal(await page.$eval('.fc-selection-summary', n => n.textContent.includes('0 selected') && n.querySelector('button').disabled), true);
  const actionGap = () => page.$$eval('.fc-scope-actions button', ns => ns[1].getBoundingClientRect().left - ns[0].getBoundingClientRect().right);
  assert.ok(Math.abs(await actionGap() - 8) < 1, 'All actions have the natural 8px button gap');
  for (const key of ['deck:d1', 'deck:d1:p:n_fixture_a', 'deck:d2', 'deck:d2:p:n_fixture_a']) await page.locator(`${row(key)} button[aria-expanded="false"]`).click();
  const cueOne = row('deck:d1:p:n_fixture_a:cue:c2'), cueShared = row('deck:d2:p:n_fixture_a:cue:c2');
  await page.waitForSelector(cueOne);
  const deckTopBeforeSelection = await page.$eval(row('deck:d1'), n => n.getBoundingClientRect().y);
  await page.locator(cueOne + ' input[type=checkbox]').click();
  await page.waitForFunction(selector => document.querySelector(selector)?.checked, {}, cueShared + ' input[type=checkbox]');
  assert.equal(await page.$eval(row('deck:d1'), n => n.getBoundingClientRect().y), deckTopBeforeSelection, 'Selection never inserts an action row or moves the tree');
  assert.deepEqual(await page.$$eval('.fc-scope-actions button', ns => ns.map(n => n.textContent.trim())), ['Review selected', 'Practice selected']);
  assert.ok(Math.abs(await actionGap() - 8) < 1, 'Expanded selected labels retain the same button gap');
  assert.equal(await page.$eval(row('deck:d1') + ' input[type=checkbox]', n => n.indeterminate), true);
  assert.equal(await page.$eval(row('deck:d2') + ' input[type=checkbox]', n => n.indeterminate), true);
  await page.locator(row('deck:d1') + ' input[type=checkbox]').click();
  await page.waitForFunction(() => document.querySelector('.fc-selection-actions').textContent.includes('3 selected'));
  await button('.fc-selection-actions', 'Clear'); await page.locator(cueOne + ' input[type=checkbox]').click();
  await shot('tree-selected');
  const columns = await page.evaluate(() => [...document.querySelectorAll('[data-plugin-tree-row]')].map(n => Object.fromEntries([...n.querySelectorAll('[data-plugin-tree-cell]')].map(c => [c.dataset.pluginTreeCell, { x: c.getBoundingClientRect().x, width: c.getBoundingClientRect().width }]))));
  for (const key of ['propositions', 'due', 'new']) for (const cells of columns) assert.ok(Math.abs(cells[key].x - columns[0][key].x) < 1, `${key} alignment`);
  evidence.assertions.push('Actual native tree renders three levels, aligned deck columns, cascade/mixed selection and shared-cue synchronization. Action row stays visible and stationary; two action labels switch to selected scope.');
  stage = 'rename';
  await button(row('deck:d1'), 'Foundations');
  const input = await page.$('input[aria-label="Deck name"]'); await page.keyboard.press('End'); await input.type(' draft');
  await call('save-deck', { id: 'd1', newLimit: 9 });
  await page.waitForFunction(() => document.querySelector('[data-plugin-tree-row="deck:d1"] [data-plugin-tree-cell="new"]')?.textContent.includes('/ 9'));
  assert.equal(await input.evaluate(n => n === document.activeElement && n.value === 'Foundations draft'), true);
  await page.keyboard.press('Enter'); await page.waitForSelector('input[aria-label="Deck name"]', { hidden: true });
  assert.equal((await call('get-state')).decks[0].newLimit, 9);
  await button(row('deck:d1'), 'Foundations draft'); await page.keyboard.press('End'); await page.keyboard.type(' failed'); injectRenameFailure = true; await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.fc-tree-rename-error')?.textContent.includes('Fixture rename failure'));
  assert.equal(await page.$eval('input[aria-label="Deck name"]', n => n.value), 'Foundations draft failed');
  await page.locator('input[aria-label="Deck name"]').click(); await page.keyboard.press('Escape');
  evidence.assertions.push('Native tree retains the identical focused rename input during an SSE refresh; partial rename preserves the latest limit. Failed draft stays visible; Escape cancels.');
  stage = 'preview';
  const previewDialog = '[role=dialog][aria-label="Proposition 1"]';
  await button(cueOne, questions[1]); await page.waitForSelector(previewDialog + ' .katex');
  await page.waitForSelector(previewDialog + ' table'); await shot('cue-preview');
  assert.equal(await page.$eval(previewDialog + ' .fc-dialog-heading', n => n.textContent), nodes[0].name);
  assert.equal(await page.$eval(previewDialog + ' .fc-preview-card', n => n.classList.contains('fc-review-card') && !!n.querySelector('.fc-answer .fc-markdown') && !n.querySelector('.fc-label')), true, 'Preview reuses review QA styling without extra labels');
  assert.equal(await page.$eval(previewDialog + ' button[data-variant=destructive]', n => n.textContent.trim()), 'Delete');
  await button(previewDialog, 'Edit');
  await page.waitForSelector('[role=dialog][aria-label="Edit cue"] textarea');
  assert.equal(await page.$eval('[role=dialog][aria-label="Edit cue"] textarea', n => n.value), questions[1]);
  await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog][aria-label="Edit cue"]', { hidden: true });
  assert.equal(await page.$eval(cueOne + ' button[aria-label="Cue actions"]', n => !!n.querySelector('svg') && !n.textContent.trim()), true, 'Native icon-only gear retains its accessible name');
  await button(cueOne, 'Cue actions'); await page.waitForSelector('[role=menu][aria-label="Cue actions"]');
  await button('[role=menu][aria-label="Cue actions"]', 'Edit'); await page.waitForSelector('[role=dialog][aria-label="Edit cue"] textarea');
  await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog][aria-label="Edit cue"]', { hidden: true });
  await button(row('deck:d1'), 'Deck actions'); await page.waitForSelector('[role=menu][aria-label="Deck actions"]');
  await button('[role=menu][aria-label="Deck actions"]', 'Deck settings'); await page.waitForSelector('[role=dialog][aria-label="Deck settings"] input');
  await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog][aria-label="Deck settings"]', { hidden: true });
  evidence.assertions.push('Actual rich preview opens its editor cleanly; native cue/deck menus open their dialogs and retain existing edit/settings operations.');
  stage = 'review-all';
  await button('.fc-selection-actions', 'Clear');
  await button('.fc-selection-actions', 'Review all');
  await page.waitForFunction(() => document.querySelector('.fc-review-card')?.textContent.includes('Which identity'));
  assert.equal(await page.$eval('.fc-review-surface', n => n.contains(document.activeElement)), true, 'Review all marked-region entry');
  assert.deepEqual(evidence.calls.filter(c => c.operation === 'next-review').at(-1).input, {});
  await page.keyboard.press('Space'); await page.waitForSelector('.fc-answer .fc-markdown');
  await page.locator('[data-plugin-session-surface-frame] button[aria-label=Close]').click();
  await page.waitForSelector('.fc-review-surface', { hidden: true });
  assert.equal((await call('get-state')).propositions.find(p => p.id === nodes[0].id).schedule.reps, 0, 'opening/revealing does not grade');
  stage = 'review';
  await page.locator(cueOne + ' input[type=checkbox]').click();
  await button('.fc-selection-actions', 'Review selected'); await page.waitForSelector('.fc-review-stage[data-plugin-initial-focus]');
  await page.waitForFunction(() => document.querySelector('.fc-review-card')?.textContent.includes('Which identity'));
  assert.equal(await page.$eval('.fc-review-card', n => n.textContent.includes('SECRET TWO')), false);
  assert.equal(await page.$eval('.fc-review-surface', n => n.contains(document.activeElement)), true, 'Host enters the visible marked card region');
  const selectedCall = evidence.calls.filter(c => c.operation === 'next-review').at(-1); assert.deepEqual(selectedCall.input.cueIds, ['c2']);
  const geometry = await page.$eval('.fc-review-card', n => {
    const box = x => { const b = x.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const frame = n.closest('[data-plugin-session-surface-frame]'); return { card: box(n), stage: box(n.closest('.fc-review-stage')), frame: box(frame), blur: getComputedStyle(frame).backdropFilter, header: box(document.querySelector('main header')) };
  });
  assert.ok(geometry.blur.includes('blur')); assert.ok(Math.abs(geometry.card.x + geometry.card.width / 2 - geometry.frame.x - geometry.frame.width / 2) < 2);
  assert.ok(Math.abs(geometry.stage.y + geometry.stage.height / 2 - geometry.frame.y - geometry.frame.height / 2) < 2, 'Card and external controls centered as one stage');
  assert.equal(await page.$eval('.fc-review-card', n => !!n.querySelector('button,h2,.fc-review-remaining,.fc-shortcut')), false, 'Card contains only question/answer');
  assert.equal(await page.$eval('.fc-review-bottom', n => n.previousElementSibling.classList.contains('fc-review-card') && n.nextElementSibling.classList.contains('fc-review-footer')), true, 'Count sits directly between card and controls');
  assert.ok(await page.$eval('.fc-review-bottom', n => { const gap = n.getBoundingClientRect().top - n.previousElementSibling.getBoundingClientRect().bottom; return gap >= 0 && gap <= 10; }), 'Count hugs the card');
  assert.equal(await page.$eval('.fc-review-title', n => n.hidden && !n.textContent), true, 'No generic heading or proposition-name hint before reveal');
  assert.equal(await page.$eval('.fc-review-stage', n => n === document.activeElement), true, 'Host focuses the opted-in visible region, not a hidden heading');
  await shot('review-question'); await page.keyboard.press('Space');
  await page.waitForSelector('.fc-answer .katex'); await page.waitForSelector('.fc-answer table'); await page.waitForSelector('.fc-answer svg');
  await page.mouse.move(1, 1); await shot('review-revealed');
  const variants = await page.$$eval('.fc-review-footer .fc-actions button', ns => ns.map(n => n.getAttribute('data-variant'))); assert.deepEqual(variants, ['custom', 'custom', 'custom', 'custom']);
  const colors = await page.$$eval('.fc-review-footer .fc-actions button', ns => ns.map(n => { const s = getComputedStyle(n); return { text: s.color, background: s.backgroundColor, border: s.borderColor }; }));
  for (const field of ['text', 'background', 'border']) assert.equal(new Set(colors.map(c => c[field])).size, 4, `Four distinct rating ${field} colors`);
  const ratesBeforeSpace = evidence.calls.filter(c => c.operation === 'rate-review').length;
  await page.keyboard.press('Space');
  for (const rating of await page.$$('.fc-review-footer .fc-actions button')) {
    await rating.focus();
    for (const modifier of [null, 'Shift', 'Control', 'Alt', 'Meta']) {
      if (modifier) await page.keyboard.down(modifier);
      await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space');
      if (modifier) await page.keyboard.up(modifier);
    }
  }
  await delay(100);
  assert.equal(evidence.calls.filter(c => c.operation === 'rate-review').length, ratesBeforeSpace, 'Space never grades, including focused native rating buttons');
  await page.keyboard.down('Meta'); await page.keyboard.press(','); await page.keyboard.up('Meta');
  await page.waitForSelector('[data-testid=settings-dialog]', { visible: true });
  const beforeKeys = evidence.calls.filter(c => c.operation === 'rate-review').length;
  await page.keyboard.press('3'); await delay(100); assert.equal(evidence.calls.filter(c => c.operation === 'rate-review').length, beforeKeys);
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-testid=settings-dialog]', { hidden: true });
  assert.ok(await page.$('.fc-review-surface'));
  await button('.fc-review-footer', 'Again · 1m');
  await page.waitForFunction(() => document.querySelector('.fc-review-stage')?.textContent.includes('No cards ready'));
  const state = await call('get-state'); assert.equal(state.propositions.find(p => p.id === nodes[0].id).schedule.reps, 1); assert.equal(state.decks[0].newToday, 1); assert.equal(state.decks[1].newToday, 1);
  await page.locator('[data-plugin-session-surface-frame] button[aria-label=Close]').click(); await page.waitForSelector('.fc-review-surface', { hidden: true });
  evidence.assertions.push('Targetless dimmed surface centers the card in the main pane; the marked visible region receives host focus without a question-side heading; Space reveals real math/table/code/Mermaid but never grades, including on focused rating buttons. Four custom rating palettes render distinct text/background/border colors; Settings owns keys/Escape; clicking a rating updates one shared schedule and both containing introduction counts; host X closes.');
  stage = 'navigation';
  await button(row('deck:d1'), 'Review');
  await page.waitForFunction(() => document.querySelector('.fc-review-card')?.textContent.includes('Which identity gives three?'));
  assert.equal(await page.$eval('.fc-review-surface', n => n.contains(document.activeElement)), true, 'Inline deck marked-region entry');
  assert.deepEqual(evidence.calls.filter(c => c.operation === 'next-review').at(-1).input, { deckIds: ['d1'] });
  await page.keyboard.press('Space'); await page.waitForFunction(() => document.querySelector('.fc-answer')?.textContent.includes('Three.'));
  assert.equal(await page.$eval('.fc-review-title', n => n.textContent), 'Proposition 2', 'Proposition name appears only after reveal');
  evidence.assertions.push('All three review entry points capture the correct scope, retain a visible review, receive marked-region focus and support local Space-to-reveal; opening/revealing never grades automatically.');
  await page.goto(base + '/chat/new', { waitUntil: 'networkidle2' }); assert.equal(await page.$('.fc-review-surface'), null);
  await page.goto(base + '/plugins/flashcards/library', { waitUntil: 'networkidle2' }); await page.waitForSelector('.fc-library'); assert.equal(await page.$('.fc-review-surface'), null);
  await page.setViewport({ width: 760, height: 700 }); await shot('tree-narrow');
  assert.equal(await page.$eval('.fc-tree-viewport', n => n.scrollWidth >= n.clientWidth), true);
  evidence.assertions.push('Real navigation disposes review; reentry does not reopen it. Narrow tree retains its columns inside caller-owned horizontal scrolling.');
  assert.equal(digest(graph), graphBefore); assert.deepEqual((await api('/api/settings')).payload, settingsBefore);
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blockedRequests, []); assert.deepEqual(evidence.failedRequests, []); assert.deepEqual(evidence.microphoneRequests, []);
  assert.ok(evidence.providerRequests.every(r => r.method === 'GET' && r.path === '/v1/models'));
  evidence.passed = true; console.log('PASS', evidence.assertions);
} catch (error) {
  evidence.error = error.stack; evidence.stage = stage; process.exitCode = 1; console.error(error);
  if (page) { await page.screenshot({ path: path.join(scratch, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(scratch, 'failure.html'), await page.content().catch(() => '')); }
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); await exit; clearTimeout(force); }
  if (catalog.listening) { catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve)); }
  evidence.sourceDigestAfter = digest(source); evidence.builtDigestAfter = digest(built);
  evidence.installedCodeDigestAfter = fs.existsSync(path.join(installed, 'dist')) ? digest(path.join(installed, 'dist')) : null;
  if (evidence.sourceDigestAfter !== sourceDigest || evidence.builtDigestAfter !== builtDigest || evidence.installedCodeDigestAfter !== builtDigest) { evidence.passed = false; process.exitCode = 1; evidence.integrityError = 'Host or plugin code bytes changed'; }
  fs.writeFileSync(path.join(scratch, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log('Evidence retained:', scratch);
}
