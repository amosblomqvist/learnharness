/**
 * Wikimedia Commons pictures (find_image + show_image({ commons })) —
 * deterministic, zero network: safeFetchOverride answers every request.
 *
 *   1. commons.ts: HTML metadata → plain text, title normalization, the
 *      candidate list, host pinning for thumbnails
 *   2. find_image: text-only candidates, nothing shown
 *   3. show_image({ commons }): one text line, the picture + attribution
 *      as details, never an image part to the model
 *   4. registries: the find_image toggle drops both find_image and the
 *      commons input, for the teacher and the practitioner
 *   5. the card: attribution line under the picture
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { safeFetchOverride } from "../src/agent/tools/safe-fetch.ts";
import { formatCandidates, normalizeCommonsTitle, plainText, searchCommons } from "../src/agent/tools/commons.ts";
import { findImageTool } from "../src/agent/tools/find-image.ts";
import { createShowImageTool } from "../src/agent/tools/show-image.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { ImagePresentation, isWebImageDetails } from "../components/artifacts/image-card.tsx";
import { TOGGLEABLE_TOOLS, type ImageSnapshot } from "../src/core/index.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

function png(width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	const g = canvas.getContext("2d");
	g.fillStyle = "#2266aa";
	g.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

const PAGE = {
	title: "File:Animal mitochondrion diagram en.svg",
	index: 1,
	imageinfo: [{
		thumburl: "https://upload.wikimedia.org/thumb/mito.png",
		width: 2000,
		height: 1200,
		descriptionurl: "https://commons.wikimedia.org/wiki/File:Animal_mitochondrion_diagram_en.svg",
		extmetadata: {
			ImageDescription: { value: "<p>Diagram of an <b>animal mitochondrion</b> &amp; its parts</p>" },
			Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:LadyofHats\">LadyofHats</a>" },
			LicenseShortName: { value: "Public domain" },
			LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
		},
	}],
};

interface Seen { url: URL; headers: Record<string, string> }
function serve(pages: unknown[], thumb: Buffer = png(64, 40)): Seen[] {
	const seen: Seen[] = [];
	safeFetchOverride.current = async (raw, init) => {
		const url = new URL(raw);
		seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
		if (url.hostname === "commons.wikimedia.org") return new Response(JSON.stringify({ query: { pages } }), { headers: { "content-type": "application/json" } });
		if (url.hostname === "upload.wikimedia.org") return new Response(new Uint8Array(thumb), { headers: { "content-type": "image/png" } });
		return new Response("not found", { status: 404 });
	};
	return seen;
}

afterEach(() => { safeFetchOverride.current = undefined; });

describe("commons client", () => {
	it("turns Commons HTML metadata into plain text", () => {
		assert.equal(plainText("<p>A &amp; B&#39;s <i>cell</i>&nbsp;wall</p>"), "A & B's cell wall");
		assert.equal(plainText("   "), undefined);
		assert.equal(plainText(42), undefined);
	});

	it("normalizes titles to the File: namespace", () => {
		assert.equal(normalizeCommonsTitle("Foo bar.jpg"), "File:Foo bar.jpg");
		assert.equal(normalizeCommonsTitle(" file:Foo.png "), "File:Foo.png");
	});

	it("searches bitmap and drawing files only, best first, with a generic User-Agent", async () => {
		const second = { ...PAGE, title: "File:Second.png", index: 2 };
		const seen = serve([second, PAGE, { title: "File:No thumb.pdf", index: 3, imageinfo: [{}] }]);
		const results = await searchCommons("mitochondrion diagram");
		assert.deepEqual(results.map((r) => r.title), [PAGE.title, "File:Second.png"], "sorted by rank; files without thumbnails dropped");
		assert.deepEqual(results[0], {
			title: PAGE.title,
			description: "Diagram of an animal mitochondrion & its parts",
			width: 2000,
			height: 1200,
			license: "Public domain",
			author: "LadyofHats",
		});
		const query = seen[0]!.url.searchParams;
		assert.equal(query.get("gsrsearch"), "mitochondrion diagram filetype:bitmap|drawing");
		assert.equal(query.get("gsrnamespace"), "6");
		assert.equal(query.get("gsrlimit"), "5");
		assert.match(seen[0]!.headers["User-Agent"]!, /^LearnHarness\/[\d.]+ \(https:\/\/github\.com\/amosblomqvist\/learnharness\)$/);
	});

	it("formats candidates as one short line each, and says when nothing matched", () => {
		const text = formatCandidates("x", [{ title: "File:A.png", description: "An A", width: 10, height: 20, license: "CC BY 4.0", author: "Ann" }]);
		assert.match(text, /Nothing has been shown yet/);
		assert.match(text, /^1\. File:A\.png — An A \(10×20, CC BY 4\.0, Ann\)$/m);
		assert.match(formatCandidates("zzz", []), /No Wikimedia Commons images matched "zzz"/);
	});
});

describe("find_image", () => {
	it("returns text candidates and no image", async () => {
		serve([PAGE]);
		const result = await findImageTool.execute!("call-f1", { query: "  mitochondrion  " });
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0]!.type, "text");
		assert.match((result.content[0] as { text: string }).text, /results for "mitochondrion"/);
		assert.match((result.content[0] as { text: string }).text, /File:Animal mitochondrion diagram en\.svg/);
	});
});

describe("show_image with commons", () => {
	const snapshots = new Map<string, ImageSnapshot>();
	const tool = createShowImageTool({ chatId: "t", chatStore: { saveImageSnapshot: (_c, id, image) => snapshots.set(id, image) }, commons: true });

	it("shows the picture with attribution; the model gets one text line", async () => {
		const seen = serve([PAGE]);
		const result = await tool.execute!("call-w1", { commons: "Animal mitochondrion diagram en.svg", caption: " Its folded inner membrane " });
		assert.equal(seen[0]!.url.searchParams.get("titles"), "File:Animal mitochondrion diagram en.svg");
		assert.equal(seen[1]!.url.hostname, "upload.wikimedia.org");
		assert.deepEqual(result.content, [{ type: "text", text: "Shown to the learner: File:Animal mitochondrion diagram en.svg from Wikimedia Commons (64×40), with its attribution." }]);
		const details = result.details as Record<string, unknown>;
		assert.ok(isWebImageDetails(details));
		assert.deepEqual({ ...details, snapshotId: "…" }, {
			source: "commons",
			title: PAGE.title,
			pageUrl: PAGE.imageinfo[0]!.descriptionurl,
			author: "LadyofHats",
			license: "Public domain",
			licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
			caption: "Its folded inner membrane",
			mimeType: "image/png",
			snapshotId: "…",
			width: 64,
			height: 40,
		});
		assert.ok(snapshots.has(details.snapshotId as string), "the picture is stored as a session snapshot");
	});

	it("refuses a thumbnail outside upload.wikimedia.org", async () => {
		serve([{ ...PAGE, imageinfo: [{ ...PAGE.imageinfo[0], thumburl: "https://evil.example/x.png" }] }]);
		await assert.rejects(tool.execute!("call-w2", { commons: PAGE.title }), /outside upload\.wikimedia\.org/);
	});

	it("explains a missing title, and refuses path + commons together", async () => {
		serve([{ title: "File:Nope.png", missing: true }]);
		await assert.rejects(tool.execute!("call-w3", { commons: "Nope.png" }), /No Wikimedia Commons file named "File:Nope\.png"/);
		await assert.rejects(tool.execute!("call-w4", { commons: "A.png", path: "~/a.png" }), /either path or commons/);
		await assert.rejects(tool.execute!("call-w5", {}), /Give path/);
	});

	it("without the toggle the input has no commons field and a commons call is not honoured", async () => {
		const local = createShowImageTool({ chatId: "t", chatStore: { saveImageSnapshot: () => {} } });
		assert.ok(!("commons" in (local.parameters as { properties: object }).properties));
		assert.ok(!/Wikimedia/.test(local.description));
		let fetched = false;
		safeFetchOverride.current = async () => { fetched = true; return new Response("{}"); };
		await assert.rejects(local.execute!("call-w6", { commons: PAGE.title }), /path/);
		assert.equal(fetched, false, "no request leaves the machine");
	});
});

describe("registries", () => {
	const ctx = {
		chatId: "synthetic",
		chatStore: { getChat: () => null, saveImageSnapshot: () => {} } as unknown as ChatStore,
		jobStore: {} as unknown as JobStore,
		spawn: () => {},
	};
	const commonsField = (tools: Record<string, { parameters: unknown }>) => "commons" in (tools.show_image!.parameters as { properties: object }).properties;

	it("find_image is a toggleable tool, on by default", () => {
		assert.ok((TOGGLEABLE_TOOLS as readonly string[]).includes("find_image"));
		const teacher = createTeacherTools(ctx);
		assert.ok(teacher.find_image);
		assert.ok(commonsField(teacher));
		const practice = practiceTools(ctx);
		assert.ok(practice.find_image && practice.show_image);
		assert.ok(commonsField(practice));
	});

	it("switching find_image off drops it and the commons input, for teacher and practice", () => {
		const teacher = createTeacherTools(ctx, { find_image: false });
		assert.ok(!teacher.find_image);
		assert.ok(teacher.show_image && !commonsField(teacher), "local show_image stays");
		const practice = practiceTools(ctx, undefined, { find_image: false });
		assert.ok(!practice.find_image);
		assert.ok(practice.show_image && !commonsField(practice));
	});
});

describe("web image card", () => {
	it("shows the attribution line with links to the file page and license", () => {
		const html = renderToStaticMarkup(
			<ImagePresentation
				image={{ path: "Animal mitochondrion diagram en.svg", mimeType: "image/png", data: png(8, 8).toString("base64"), width: 8, height: 8 }}
				attribution={{ title: PAGE.title, pageUrl: "https://commons.wikimedia.org/wiki/File:X", author: "LadyofHats", license: "CC BY-SA 4.0", licenseUrl: "javascript:alert(1)" }}
			/>,
		);
		assert.match(html, /data-testid="image-attribution"/);
		assert.match(html, /<a href="https:\/\/commons\.wikimedia\.org\/wiki\/File:X"[^>]*>Animal mitochondrion diagram en\.svg<\/a> by LadyofHats, CC BY-SA 4\.0, via Wikimedia Commons/);
		assert.ok(!html.includes("javascript:"), "a non-http license URL is not linked");
	});
});
