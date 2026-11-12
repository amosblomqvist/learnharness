/** Static native SVG rendering, bounded render-only repairs, strict annotation
 * input, and native failures that never dispatch a browser or system Chrome. */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import puppeteer from "puppeteer-core";
import { Resvg } from "@resvg/resvg-js";
import * as photon from "@silvia-odwyer/photon-node";
import { realHeadless } from "../src/agent/subagents/headless.ts";

function pngFacts(buf: Buffer): { w: number; h: number; idats: number } {
	assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	let off = 8;
	let idats = 0;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString("ascii");
		if (type === "IDAT") idats++;
		off += 12 + len;
	}
	return { w, h, idats };
}

function forbidBrowser(t: TestContext) {
	const unexpected = () => { assert.fail("SVG rendering must not dispatch a browser or Chrome"); };
	const spawn = t.mock.method(childProcess, "spawn", unexpected);
	const connect = t.mock.method(puppeteer, "connect", unexpected);
	const launch = t.mock.method(puppeteer, "launch", unexpected);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(connect.mock.callCount(), 0);
		assert.equal(launch.mock.callCount(), 0);
	});
}

const RED = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';

describe("native renderSvg (resvg only)", () => {
	it("repairs an ordinary missing namespace and returns actual opaque red pixels", async (t) => {
		forbidBrowser(t);
		const original = RED.replace(' xmlns="http://www.w3.org/2000/svg"', "");
		const png = await realHeadless.renderSvg(original);
		assert.deepEqual(pngFacts(png), { w: 80, h: 40, idats: 1 });
		const image = photon.PhotonImage.new_from_byteslice(png);
		try {
			const pixels = image.get_raw_pixels();
			assert.equal(pixels.length, 80 * 40 * 4);
			for (let i = 0; i < pixels.length; i++) assert.equal(pixels[i], [255, 0, 0, 255][i % 4]);
		} finally { image.free(); }
		assert.equal(original.includes("xmlns"), false, "rendering does not rewrite the original source");
	});

	it("repairs ordinary HTML nbsp exactly like a numeric entity, including attribute values", async (t) => {
		forbidBrowser(t);
		const svg = RED.replace("</svg>", '<text x="2" y="20" aria-label="A&nbsp;B">A&nbsp;B</text></svg>');
		assert.deepEqual(await realHeadless.renderSvg(svg), await realHeadless.renderSvg(svg.replaceAll("&nbsp;", "&#160;")));
	});

	it("keeps annotation inputs strict for both repairs", async (t) => {
		forbidBrowser(t);
		await assert.rejects(realHeadless.renderSvg(RED.replace(' xmlns="http://www.w3.org/2000/svg"', ""), { nativeOnly: true }), /root node/);
		await assert.rejects(realHeadless.renderSvg(RED.replace("</svg>", "<text>A&nbsp;B</text></svg>"), { nativeOnly: true }), /unknown entity/);
	});

	it("does not broaden repairs or dispatch a browser for malformed SVG", async (t) => {
		forbidBrowser(t);
		await assert.rejects(realHeadless.renderSvg(RED.replace('xmlns="http://www.w3.org/2000/svg"', 'xmlns=""')), /root node/);
		await assert.rejects(realHeadless.renderSvg('<svg><unclosed>'), /never closed/);
	});

	it("propagates a native renderer failure without browser/Chrome recovery", async (t) => {
		forbidBrowser(t);
		const error = new Error("owned native renderer failure");
		t.mock.method(Resvg.prototype, "render", () => { throw error; });
		await assert.rejects(realHeadless.renderSvg(RED), value => value === error);
	});
	it("renders an attribute-sized SVG at its intrinsic size", async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#3355aa"/></svg>';
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 240);
		assert.equal(f.h, 160);
		assert.equal(f.idats, 1, "single-IDAT canonical PNG");
	});

	it("viewBox-only SVG gets the 900px-wide default", async () => {
		// No width attr anywhere (svgViewport grabs the FIRST width= in the
		// document — children included — a pre-existing quirk kept for
		// parity; use a circle so the default branch is exercised).
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><circle cx="150" cy="100" r="90" fill="#aa5533"/></svg>';
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 900, "svgViewport default width");
		assert.equal(f.h, 600, "aspect preserved from viewBox");
	});

	it("width/height opts override for viewBox-only SVGs", async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#33aa55"/></svg>';
		const png = await realHeadless.renderSvg(svg, { width: 500, height: 125 });
		const f = pngFacts(png);
		assert.equal(f.w, 500);
	});

	it("text-bearing SVG renders with system fonts (non-trivial output)", async () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">
  <rect width="300" height="100" fill="#ffffff"/>
  <text x="150" y="60" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#111111">Harness</text>
</svg>`;
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 300);
		// A blank 300x100 white PNG is ~300 bytes; glyphs push it well past.
		assert.ok(png.length > 1000, `text rendered (png ${png.length} bytes > 1000)`);
	});
});
