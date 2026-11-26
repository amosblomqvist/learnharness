/**
 * Built-in ```pixel fences: the parser/validator and the static render.
 * tsx note: classic JSX transform — the React global shim provides React.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { parsePixelArt, pixelRuns, pixelSvgDocument, PIXEL_MAX_SIDE } from "../components/pixel-art.tsx";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const render = (md: string) => renderMarkup(<InteractionLayersProvider><MessageResponse mode="static">{md}</MessageResponse></InteractionLayersProvider>);

const WATER = [
	"title: Water molecule",
	"palette:",
	"  r: #E53935   # oxygen",
	"  w: #fff      # hydrogen",
	"  k: #222222",
	"---",
	"ww..ww",
	".rrrr.",
	"..kk..",
].join("\n");

function fail(source: string): string {
	const parsed = parsePixelArt(source);
	assert.equal(parsed.ok, false, "expected a parse failure");
	return (parsed as { error: string }).error;
}

describe("pixel art — parser", () => {
	it("parses title, palette labels and rows; '.' is transparent", () => {
		const parsed = parsePixelArt(WATER);
		assert.ok(parsed.ok);
		const { art } = parsed;
		assert.equal(art.title, "Water molecule");
		assert.deepEqual(art.palette, [
			{ key: "r", hex: "#e53935", label: "oxygen" },
			{ key: "w", hex: "#fff", label: "hydrogen" },
			{ key: "k", hex: "#222222" },
		]);
		assert.equal(art.width, 6);
		assert.equal(art.height, 3);
		assert.equal(art.scale, 16, "small pictures get the largest automatic scale");
	});

	it("honours an explicit scale and trims indentation and blank edge rows", () => {
		const parsed = parsePixelArt("scale: 3\npalette:\n  a: #000\n---\n\n   aa\n   a.  \n\n");
		assert.ok(parsed.ok);
		assert.equal(parsed.art.scale, 3);
		assert.deepEqual(parsed.art.rows, ["aa", "a."]);
	});

	it("auto-scales a 32-wide picture to 10px per pixel", () => {
		const row = "a".repeat(PIXEL_MAX_SIDE);
		const parsed = parsePixelArt(`palette:\n a: #123456\n---\n${Array(PIXEL_MAX_SIDE).fill(row).join("\n")}`);
		assert.ok(parsed.ok);
		assert.equal(parsed.art.scale, 10);
	});

	it("names the line of each mistake", () => {
		assert.match(fail("palette:\n a: #000\naa"), /Missing the `---`/);
		assert.match(fail("palette:\n---\naa"), /palette is empty/);
		assert.match(fail("palette:\n a: #000\n---\naa\naaa"), /Line 5: row is 3 pixels wide but the first row is 2/);
		assert.match(fail("palette:\n a: #000\n---\naz"), /Line 4: `z` is not in the palette/);
		assert.match(fail("palette:\n a: #000\n---\na a"), /`space` is not in the palette/);
		assert.match(fail("palette:\n a: #00000g\n---\naa"), /Line 2: `#00000g` is not a #rgb or #rrggbb colour/);
		assert.match(fail("palette:\n a: #000\n a: #fff\n---\naa"), /Line 3: palette key `a` is defined twice/);
		assert.match(fail("palette:\n .: #000\n---\n.."), /can't be a palette key/);
		assert.match(fail("scale: 0\npalette:\n a: #000\n---\na"), /scale must be a whole number from 1 to 32/);
		assert.match(fail("palette:\n a: #000\n---\naa\n\naa"), /blank row inside the picture/);
		assert.match(fail("hello\npalette:\n a: #000\n---\na"), /Line 1: expected `title:`/);
	});

	it("caps size at 32×32 and the palette at 16 colours", () => {
		assert.match(fail(`palette:\n a: #000\n---\n${"a".repeat(33)}`), /33 pixels wide; the limit is 32/);
		assert.match(fail(`palette:\n a: #000\n---\n${Array(33).fill("a").join("\n")}`), /33 rows; the limit is 32/);
		const keys = "abcdefghijklmnopq";
		assert.match(fail(`palette:\n${[...keys].map((k) => ` ${k}: #000`).join("\n")}\n---\na`), /17 colours; the limit is 16/);
	});

	it("merges horizontal runs and skips transparent pixels", () => {
		const parsed = parsePixelArt(WATER);
		assert.ok(parsed.ok);
		assert.deepEqual(pixelRuns(parsed.art), [
			{ x: 0, y: 0, w: 2, hex: "#fff" },
			{ x: 4, y: 0, w: 2, hex: "#fff" },
			{ x: 1, y: 1, w: 4, hex: "#e53935" },
			{ x: 2, y: 2, w: 2, hex: "#222222" },
		]);
		const svg = pixelSvgDocument(parsed.art);
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="48" viewBox="0 0 6 3" shape-rendering="crispEdges">/);
		assert.equal(svg.match(/<rect /g)?.length, 4);
	});
});

describe("pixel art — markdown render", () => {
	it("a pixel fence renders as a picture with title, legend and hover actions", () => {
		const html = render("```pixel\n" + WATER + "\n```");
		assert.ok(html.includes('data-testid="md-pixel"'), "the pixel figure mounts");
		assert.ok(!html.includes('data-testid="md-code"'), "not rendered as a code block");
		assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Water molecule"/);
		const picture = /<svg[^>]*role="img"[^>]*>(.*?)<\/svg>/s.exec(html)?.[1] ?? "";
		assert.equal(picture.match(/<rect /g)?.length, 4, "one rect per colour run");
		assert.ok(html.includes('data-testid="md-pixel-title"'));
		assert.match(html, /data-testid="md-pixel-legend".*oxygen.*hydrogen/s);
		assert.ok(!/<li[^>]*>.*#222222/s.test(html.split('data-testid="md-pixel-legend"')[1] ?? ""), "unlabelled colours have no legend chip");
		assert.match(html, /aria-label="Copy pixel source"/);
		assert.match(html, /aria-label="Download PNG"/);
	});

	it("an invalid fence shows the error card with the source", () => {
		const html = render("```pixel\npalette:\n a: #000\n---\naz\n```");
		assert.ok(html.includes('data-testid="md-pixel-error"'));
		assert.match(html, /Pixel art failed to render/);
		assert.match(html, /`z` is not in the palette/);
		assert.match(html, /Show pixel source/);
	});
});

describe("pixel art — prompts", () => {
	it("the teacher and practitioner learn the format and the picture ladder; the prober does not", () => {
		const teacher = composeInstructions("teacher");
		const practice = composeInstructions("practice");
		const prober = composeInstructions("prober");
		for (const prompt of [teacher, practice]) {
			assert.match(prompt, /```pixel/);
			assert.match(prompt, /find_image/);
			assert.match(prompt, /show_image` with `commons`/);
		}
		assert.match(teacher, /\*\*`visual`:\*\* only for precise geometry/);
		assert.ok(!/`visual`/.test(practice.split("## Pictures as nudges")[1] ?? ""), "practice has no visual tool");
		assert.ok(!prober.includes("```pixel"), "the prober stays text-only");
	});

	it("every pixel example in the prompts parses", () => {
		const prompts = `${composeInstructions("teacher")}\n${composeInstructions("practice")}`;
		// Checkouts may carry CRLF (core.autocrlf); the parser accepts both.
		const examples = [...prompts.matchAll(/```pixel\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
		assert.equal(examples.length, 2, "one example each in the teacher and practice prompts");
		for (const source of examples) {
			const parsed = parsePixelArt(source);
			assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
			assert.ok(parsed.art.palette.every((c) => c.label), "examples label every colour");
		}
	});
});
