import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clipboardImageResponse } from "../src/server/clipboard-images.ts";
import { clipboardImages, imagePastePending, savePastedImages } from "../components/pasted-images.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const request = (body: BodyInit = png, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/clipboard-images", { method: "POST", headers: { origin: "http://localhost:3000", "x-learnharness-image-paste": "1", ...headers }, body });

test("pasted image persists with a generated image path; bad input and cross-origin writes are rejected", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-clipboard-test-"));
	try {
		const response = await clipboardImageResponse(request(), directory);
		assert.equal(response.status, 200);
		const file = (await response.json()).path;
		assert.equal(path.dirname(file), directory);
		assert.match(path.basename(file), /^pasted-image-[\da-f-]+\.png$/);
		assert.deepEqual(await readFile(file), png);
		assert.equal((await clipboardImageResponse(request("<svg onload='bad()'/>"), directory)).status, 415);
		assert.equal((await clipboardImageResponse(request(png, { origin: "https://other.invalid" }), directory)).status, 403);
		assert.equal((await clipboardImageResponse(request(png, { "content-length": String(26 * 1024 * 1024) }), directory)).status, 413);
		const huge = Buffer.from(png); huge.writeUInt32BE(99999, 16);
		assert.equal((await clipboardImageResponse(request(huge), directory)).status, 400);
		assert.equal((await readdir(directory)).length, 1);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("clipboard image files are selected and uploads hold the send gate until success or failure", async () => {
	const file = new File([png], "clipboard.png", { type: "image/png" });
	assert.deepEqual(clipboardImages({ items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } as unknown as DataTransfer), [file]);
	assert.deepEqual(clipboardImages({ files: [file] } as unknown as DataTransfer), [file]);
	const original = globalThis.fetch;
	let finish!: (response: Response) => void;
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "/api/clipboard-images");
			assert.equal(init?.body, file);
			return await new Promise<Response>(resolve => { finish = resolve; });
		};
		const saving = savePastedImages([file]);
		assert.equal(imagePastePending(), true);
		finish(Response.json({ path: "/pasted-image-1.png" }));
		assert.deepEqual(await saving, ["/pasted-image-1.png"]);
		assert.equal(imagePastePending(), false);
		globalThis.fetch = async () => Response.json({ error: "Image refused" }, { status: 415 });
		await assert.rejects(savePastedImages([file]), /Image refused/);
		assert.equal(imagePastePending(), false);
	} finally { globalThis.fetch = original; }
});
