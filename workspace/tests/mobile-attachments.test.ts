import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveAttachments } from "../src/server/attachments.ts";
import { attachmentFilename, MAX_ATTACHMENT_BYTES } from "../lib/attachment-limits.ts";

test("phone uploads preserve bytes and duplicate filenames without allowing paths or device names", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-uploads-"));
	try {
		const files = [new File(["first"], "notes.txt"), new File(["second"], "notes.txt")];
		const filenames = await saveAttachments(files, { dataDirectory: directory, policy: { restricted: false, folders: [] } });
		assert.equal(new Set(filenames).size, 2);
		assert.equal(await readFile(filenames[0]!, "utf8"), "first"); assert.equal(await readFile(filenames[1]!, "utf8"), "second");
		assert.ok(filenames.every(filename => filename.startsWith(path.join(directory, "attachments") + path.sep)));
		assert.equal(attachmentFilename("../../unsafe:photo?.jpg"), ".._.._unsafe_photo_.jpg");
		for (const name of ["CON", "aux.txt", "LPT1.pdf", "..", ""]) assert.throws(() => attachmentFilename(name));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("upload limits and source restrictions are checked before any file is saved", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-uploads-"));
	try {
		const options = { dataDirectory: directory, policy: { restricted: true, folders: [] } };
		await assert.rejects(saveAttachments([new File(["private"], "notes.txt")], options), /outside the allowed folders/);
		await assert.rejects(saveAttachments([new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large.pdf")], options), /25 MiB/);
		await assert.rejects(saveAttachments([], options), /Choose between/);
		assert.deepEqual(await readdir(directory), []);
		const filenames = await saveAttachments([new File(["allowed"], "notes.txt")], { dataDirectory: directory, policy: { restricted: true, folders: [directory] } });
		assert.equal(await readFile(filenames[0]!, "utf8"), "allowed");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
