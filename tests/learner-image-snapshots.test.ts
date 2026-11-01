import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadLearnerImage } from "../src/agent/tools/learner-image.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "../src/agent/tools/learner-image-dimensions.ts";
import { createShowImageTool } from "../src/agent/tools/show-image.ts";
import { annotationPlacementProblem } from "../src/agent/subagents/annotation-svg.ts";
import { embedLearnerImage } from "../src/core/learner-image-svg.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { GET } from "../app/api/chats/[id]/images/[snapshotId]/route.ts";
import type { JobRecord, ShowImageDetails } from "../src/core/contracts.ts";
import type { JobStore } from "../src/core/ports.ts";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-image-snapshots-"));
const chats: string[] = [];
after(async () => {
	for (const id of chats) chatStore.deleteChat(id);
	await fs.rm(scratch, { recursive: true, force: true });
});
function picture(width = 40, height = 30): Buffer {
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}
async function file(name: string, bytes: Uint8Array) {
	const p = path.join(scratch, name);
	await fs.writeFile(p, bytes);
	return p;
}
function newChat() { const chat = chatStore.createChat("Synthetic snapshot regression"); chats.push(chat.id); return chat; }
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><image href="learner-image" width="40" height="30"/><circle cx="5" cy="5" r="2"/></svg>';

describe("session-local learner image snapshots", () => {
	it("shares processed bytes across repeated displays and different paths, preserving captions", async () => {
		const chat = newChat();
		const p = await file("same.png", picture());
		const copy = await file("copy.png", picture());
		const tool = createShowImageTool({ chatId: chat.id, chatStore });
		const a = (await tool.execute("a", { path: p, caption: "First explanation" })).details as ShowImageDetails;
		const b = (await tool.execute("b", { path: copy, caption: "Later explanation" })).details as ShowImageDetails;
		const c = (await tool.execute("c", { path: p })).details as ShowImageDetails;
		assert.equal(a.snapshotId, b.snapshotId);
		assert.equal(a.snapshotId, c.snapshotId);
		assert.equal(a.caption, "First explanation");
		assert.equal(b.caption, "Later explanation");
		assert.ok(!("data" in a));
		const record = chatStore.getChat(chat.id)!;
		assert.equal(Object.keys(record.imageSnapshots!).length, 1);
		assert.equal(record.updatedAt, chat.updatedAt, "snapshot writes do not reorder the sidebar");
		assert.ok(!("imageSnapshots" in chatStore.listChats().find((item) => item.id === chat.id)!));
	});

	it("versions changed contents at the same path and survives source deletion and later message writes", async () => {
		const chat = newChat();
		const p = await file("replaced.png", picture());
		const tool = createShowImageTool({ chatId: chat.id, chatStore });
		const a = (await tool.execute("a", { path: p })).details as ShowImageDetails;
		await fs.writeFile(p, picture(41, 30));
		const b = (await tool.execute("b", { path: p })).details as ShowImageDetails;
		assert.notEqual(a.snapshotId, b.snapshotId);
		await fs.unlink(p);
		chatStore.saveMessages(chat.id, []);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(Object.keys(record.imageSnapshots!).length, 2);
		assert.equal(record.imageSnapshots![a.snapshotId]!.width, 40);
		assert.equal(record.imageSnapshots![b.snapshotId]!.width, 41);
		const response = await GET(new Request("http://localhost/snapshot"), { params: Promise.resolve({ id: chat.id, snapshotId: a.snapshotId }) });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), record.imageSnapshots![a.snapshotId]);
		const other = newChat();
		assert.equal((await GET(new Request("http://localhost/snapshot"), { params: Promise.resolve({ id: other.id, snapshotId: a.snapshotId }) })).status, 404);
		assert.equal((await GET(new Request("http://localhost/snapshot"), { params: Promise.resolve({ id: chat.id, snapshotId: "../file" }) })).status, 404);
	});

	it("stores annotation marks without duplicating the base and exports self-contained SVGs", async () => {
		const chat = newChat();
		const image = await loadLearnerImage(await file("annotation.png", picture()));
		chatStore.saveImageSnapshot(chat.id, image.snapshotId, image);
		chatStore.saveImageSnapshot(chat.id, image.snapshotId, image);
		const one = { svg, image: { path: image.path, snapshotId: image.snapshotId } };
		const two = { ...one, svg: svg.replace('r="2"', 'r="3"') };
		assert.equal(Object.keys(chatStore.getChat(chat.id)!.imageSnapshots!).length, 1);
		assert.ok(!JSON.stringify([one, two]).includes(image.data));
		const exported = embedLearnerImage(one.svg, chatStore.getChat(chat.id)!.imageSnapshots![one.image.snapshotId]!);
		assert.ok(exported.includes(`data:${image.mimeType};base64,${image.data}`));
		assert.ok(!exported.includes('href="learner-image"'));
		assert.equal(embedLearnerImage("<svg><circle/></svg>", image), "<svg><circle/></svg>");
	});

	it("strips source JPEG metadata before storage and content identity", async () => {
		const canvas = createCanvas(40, 30);
		const jpeg = canvas.toBuffer("image/jpeg");
		const marker = Buffer.from("Exif\0\0synthetic-gps-private-metadata", "binary");
		const segment = Buffer.alloc(marker.length + 4);
		segment.set([0xff, 0xe1]); segment.writeUInt16BE(marker.length + 2, 2); segment.set(marker, 4);
		const plain = await loadLearnerImage(await file("plain.jpg", jpeg));
		const tagged = await loadLearnerImage(await file("tagged.jpg", Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)])));
		assert.equal(tagged.snapshotId, plain.snapshotId);
		assert.ok(!Buffer.from(tagged.data, "base64").includes(marker));
	});
});

describe("learner image source safety", () => {
	it("rejects file size and pixel dimensions before decoding", async () => {
		const p = await file("oversize.png", picture());
		await fs.truncate(p, MAX_LEARNER_IMAGE_BYTES + 1);
		await assert.rejects(loadLearnerImage(p), /25 MiB/);
		const header = picture().subarray(0, 32);
		header.writeUInt32BE(8193, 16);
		await assert.rejects(loadLearnerImage(await file("huge-header.png", header)), /8192 pixels/);
		header.writeUInt32BE(5000, 16); header.writeUInt32BE(4000, 20);
		assert.throws(() => checkImageDimensions(header, "image/png"), /16 megapixels/);
		assert.throws(() => checkImageDimensions(Buffer.alloc(5), "image/png"), /Incomplete/);
	});

	it("normalizes GIF and BMP sources after their header checks", async () => {
		const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
		const tiny = await loadLearnerImage(await file("tiny.gif", gif));
		assert.equal(tiny.width, 1);
		assert.equal(tiny.height, 1);
		const bmp = Buffer.alloc(62);
		bmp.write("BM"); bmp.writeUInt32LE(62, 2); bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(1, 22);
		bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(8, 34);
		const converted = await loadLearnerImage(await file("tiny.bmp", bmp));
		assert.equal(converted.width, 2);
		assert.equal(converted.height, 1);
		assert.equal(converted.mimeType, "image/png");
	});

	it("checks compressed WebP frame geometry even when a smaller VP8X canvas was declared", () => {
		const webp = Buffer.alloc(12 + 18 + 14);
		webp.write("RIFF"); webp.writeUInt32LE(webp.length - 8, 4); webp.write("WEBP", 8);
		webp.write("VP8X", 12); webp.writeUInt32LE(10, 16);
		webp.write("VP8L", 30); webp.writeUInt32LE(5, 34); webp[38] = 0x2f;
		webp.writeUInt32LE(16382, 39); // 16383px wide, despite the 1x1 canvas
		assert.throws(() => checkImageDimensions(webp, "image/webp"), /8192 pixels/);
	});

	it("honors cancellation before opening any image", async () => {
		const controller = new AbortController(); controller.abort();
		await assert.rejects(loadLearnerImage(path.join(scratch, "missing.png"), controller.signal), { name: "AbortError" });
	});

	it("terminates an in-progress normalization when cancelled", async () => {
		const p = await file("cancel.png", picture(2000, 2000));
		const controller = new AbortController();
		const pending = loadLearnerImage(p, controller.signal);
		const timer = setTimeout(() => controller.abort(), 10);
		try { await assert.rejects(pending, { name: "AbortError" }); }
		finally { clearTimeout(timer); }
	});

	it("uses the shared sensitive-path guard for displays and annotation dispatch", async () => {
		const home = await fs.mkdtemp(path.join(scratch, "home-"));
		await fs.mkdir(path.join(home, ".claude"));
		await fs.writeFile(path.join(home, ".claude", "private.png"), picture());
		await fs.symlink(path.join(home, ".claude"), path.join(home, "alias"));
		const old = process.env.HOME;
		try {
			process.env.HOME = home;
			const tool = createShowImageTool({ chatId: "never-written", chatStore: { saveImageSnapshot: () => assert.fail("must not save denied image") } });
			await assert.rejects(tool.execute("denied", { path: "alias/private.png" }), /Access denied/);
			const tools = jobTools({ chatId: "x", jobStore: { findJobByToolCallId: () => undefined } as unknown as JobStore, spawn: () => assert.fail("must not spawn") });
			await assert.rejects(tools.visual!.execute("denied", { brief: "mark it", image: "alias/private.png" }), /Access denied/);
		} finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; }
	});

	it("keeps visual dispatch idempotent if the source disappears after the first call", async () => {
		let job: JobRecord | undefined;
		let spawned = 0;
		const store = { findJobByToolCallId: () => job, createJob: (input: object) => job = { ...input, id: "job_same" } as JobRecord } as unknown as JobStore;
		const tools = jobTools({ chatId: "x", jobStore: store, spawn: () => spawned++ });
		const p = await file("idempotent.png", picture());
		const a = await tools.visual!.execute("same", { brief: "mark it", image: p });
		await fs.unlink(p);
		assert.deepEqual(await tools.visual!.execute("same", { brief: "mark it", image: p }), a);
		assert.equal(spawned, 1);
	});
});

describe("annotation placement protocol", () => {
	it("counts actual image elements, not comments, CDATA, text, or lookalike attributes", () => {
		assert.equal(annotationPlacementProblem(svg, 40, 30), null);
		for (const impostor of ['<!-- <image href="learner-image"/> -->', '<text><![CDATA[<image href="learner-image"/>]]></text>', '<g data-href="learner-image"/>']) {
			assert.match(annotationPlacementProblem(`<svg>${impostor}</svg>`, 40, 30)!, /exactly once/);
		}
		assert.match(annotationPlacementProblem(svg.replace('</svg>', '<image href="learner-image"/></svg>'), 40, 30)!, /found 2/);
		assert.match(annotationPlacementProblem(svg.replace('width="40" height="30"/>', 'width="20" height="30"/>'), 40, 30)!, /natural/);
		assert.match(annotationPlacementProblem(svg.replace('href="learner-image"', 'href="learner&#45;image"'), 40, 30)!, /literal/);
		const spoofed = svg.replace('href="learner-image"', `href="learner&#45;image" data-note=' href="learner-image"'`);
		assert.match(annotationPlacementProblem(spoofed, 40, 30)!, /literal/);
	});

	it("refuses executable markup and additional file/URL references", () => {
		for (const markup of ['<script>alert(1)</script>', '<foreignObject/>', '<use href="file:///private.png"/>', '<path style="fill:url(https://example.invalid/image)"/>', '<g onclick="alert(1)"/>', '<set attributeName="href" to="file:///private.png"/>', '<g xml:base="file:///private/"/>', '<path style="fill:u\\\\72l(file:///private.png)"/>']) {
			assert.ok(annotationPlacementProblem(svg.replace('</svg>', `${markup}</svg>`), 40, 30));
		}
		assert.ok(annotationPlacementProblem('<!DOCTYPE svg><svg/>', 40, 30));
	});

	it("embedding preserves comments and replaces only the actual picture", () => {
		const withComment = svg.replace('<image', '<!-- <image href="learner-image"/> --><image');
		const result = embedLearnerImage(withComment, { mimeType: "image/png", data: "AAAA", width: 40, height: 30 });
		assert.ok(result.includes('<!-- <image href="learner-image"/> -->'));
		assert.equal(result.split('data:image/png;base64,AAAA').length, 2);
	});
});
