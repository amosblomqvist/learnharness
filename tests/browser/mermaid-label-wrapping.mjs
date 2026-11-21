// Opt-in: CHROME_PATH=/path/to/chromium node tests/browser/mermaid-label-wrapping.mjs
// Uses a local Chromium (no download); deliberately outside the default test glob.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

// tsx already uses esbuild; do not add a second bundler dependency.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const executablePath = process.env.CHROME_PATH;
assert.ok(executablePath, 'Set CHROME_PATH to a local Chromium supporting headless extensions');
const scratch = await mkdtemp(join(tmpdir(), 'lh-mermaid-wrapping-'));
let browser;
try {
	const extension = join(scratch, 'zoom');
	await mkdir(extension);
	await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Zoom regression', version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
	await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
	const fixture = join(scratch, 'fixture.html');
	await writeFile(fixture, '<!doctype html><body></body>');
	const bundle = await build({ stdin: { contents: 'import {renderMermaid, MERMAID_FONT_SIZE} from "./components/mermaid-render"; Object.assign(window, {renderMermaid, MERMAID_FONT_SIZE});', resolveDir: resolve('.') }, bundle: true, write: false, platform: 'browser' });
	browser = await puppeteer.launch({ executablePath, headless: true, enableExtensions: [extension], args: ['--no-sandbox'] });
	console.log(await browser.version());
	const page = await browser.newPage();
	await page.goto(`file://${fixture}`);
	const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension:'));
	const worker = await target.worker();
	for (const zoom of [0.9, 1]) {
		const actual = await worker.evaluate(async zoom => {
			const tabs = (await chrome.tabs.query({})).filter(t => t.active);
			if (tabs.length !== 1) throw Error('Expected one active test tab');
			await chrome.tabs.setZoom(tabs[0].id, zoom);
			return chrome.tabs.getZoom(tabs[0].id);
		}, zoom);
		assert.equal(actual, zoom);
		await page.reload();
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const results = await page.evaluate(async () => {
			const cases = [
				'flowchart TD\n A["Worker checks the current stack top 216"] --> B["Card says: your note is 16 slots below"] --> C["Subtract 16 from 216 then go to slot 200"] --> D["Note in slot 200 says: locker 5000"] --> E["Hello"]',
				'flowchart TD\n A["First line<br/>Second line"] --> B{"Worker checks the current stack top 216"} --> C(["Card says: your note is 16 slots below"]) --> D["`A **bold** label with enough words to wrap onto another line`"]',
			];
			const results = [];
			for (const mode of ['light', 'dark']) for (const [fixture, chart] of cases.entries()) for (const [width, font] of [[480, 16], [390, 14], [340, 16]]) {
				// Fresh render per placement: never reuse Mermaid's SVG ids or layout.
				const panel = document.createElement('div');
				panel.style.cssText = `width:${width}px;font-size:${font}px`;
				const holder = document.createElement('div');
				holder.style.cssText = 'display:flex;justify-content:center;width:100%;margin:auto';
				panel.append(holder); document.body.append(panel);
				holder.innerHTML = await window.renderMermaid(chart, mode);
				const svg = holder.querySelector('svg');
				// Same font-parity cap as MermaidInline and house SVG width rule.
				holder.style.maxWidth = `${svg.viewBox.baseVal.width * font / window.MERMAID_FONT_SIZE}px`;
				svg.style.setProperty('max-width', '100%', 'important');
				const box = panel.getBoundingClientRect(), svgBox = svg.getBoundingClientRect();
				const labels = [...svg.querySelectorAll('g.node foreignObject')].map(fo => {
					const range = document.createRange(); range.selectNodeContents(fo.firstElementChild);
					const bounds = fo.getBoundingClientRect();
					const overflow = Math.max(...[...range.getClientRects()].flatMap(r => [bounds.left-r.left, r.right-bounds.right, bounds.top-r.top, r.bottom-bounds.bottom]));
					return { text: fo.textContent, overflow, width: +fo.getAttribute('width'), height: +fo.getAttribute('height'), fontSize: getComputedStyle(fo.firstElementChild).fontSize };
				});
				results.push({mode, fixture, width, font, fits: svgBox.left >= box.left - .5 && svgBox.right <= box.right + .5, scale: svgBox.width / svg.viewBox.baseVal.width, labels});
				panel.remove();
			}
			return results;
		});
		for (const result of results) {
			assert.ok(result.fits, JSON.stringify(result));
			assert.ok(result.scale * 16 <= result.font + .5, 'Font cap');
			assert.equal(result.labels.length, result.fixture === 0 ? 5 : 4);
			for (const label of result.labels) {
				assert.ok(label.overflow <= .5, JSON.stringify({zoom, ...result, label}));
				assert.equal(label.fontSize, '16px');
			}
			if (result.fixture === 0) {
				assert.ok(result.labels.slice(0, 4).every(l => l.height >= 47.5), 'Long labels wrap');
				assert.ok(result.labels[4].width < 200 && Math.abs(result.labels[4].height - 24) < .5, 'Short label stays compact');
			} else assert.ok(Math.abs(result.labels[0].height - 48) < .5, 'Explicit break stays two lines');
		}
		console.log(`zoom=${zoom}: ${results.length} fresh renders; all text ranges contained; column and font caps pass (light/dark, long/short, br, diamond, stadium, markdown)`);
	}
} finally {
	await browser?.close();
	await rm(scratch, { recursive: true, force: true });
}
