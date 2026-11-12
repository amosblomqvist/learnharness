import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { it } from "node:test";

it("generated public document API accepts only Files and optional caller cancellation", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-document-types-test-"));
	try {
		const output = path.join(home, "api");
		const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 30_000 });
		assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
		fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
		const consumer = path.join(home, "consumer.mts");
		fs.writeFileSync(consumer, `
import type { PluginBackendContext, PluginFrontendContext } from "./api/index.d.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ExactHelper = Assert<Equal<keyof PluginFrontendContext["documents"], "toMarkdown">>;
type ExactAsyncShape = Assert<Equal<PluginFrontendContext["documents"]["toMarkdown"],
  (file: File, options?: { signal?: AbortSignal }) => Promise<{ name: string; markdown: string; notices: string[] }>>>;
type FrontendOnly = Assert<Equal<"documents" extends keyof PluginBackendContext ? true : false, false>>;
declare const frontend: PluginFrontendContext;
declare const backend: PluginBackendContext;
const file = new File(["UTF-8 text"], "notes.anything", { type: "application/octet-stream" });
const pending = frontend.documents.toMarkdown(file);
const withOptions = frontend.documents.toMarkdown(file, {});
const withSignal = frontend.documents.toMarkdown(file, { signal: new AbortController().signal });
const result = await withSignal;
const name: string = result.name;
const markdown: string = result.markdown;
const notices: string[] = result.notices;
// @ts-expect-error Conversion is asynchronous, not a synchronous result.
const immediate: { name: string; markdown: string; notices: string[] } = pending;
// @ts-expect-error The documents context member is readonly.
frontend.documents = frontend.documents;
// @ts-expect-error Strings and filesystem paths are not uploaded Files.
frontend.documents.toMarkdown("/tmp/notes.txt");
// @ts-expect-error Blobs are not browser Files.
frontend.documents.toMarkdown(new Blob(["text"]));
// @ts-expect-error URLs are not uploaded Files.
frontend.documents.toMarkdown(new URL("https://example.invalid/notes.txt"));
// @ts-expect-error No path option.
frontend.documents.toMarkdown(file, { path: "/tmp/notes.txt" });
// @ts-expect-error No URL option.
frontend.documents.toMarkdown(file, { url: "https://example.invalid/notes.txt" });
// @ts-expect-error Cancellation accepts an AbortSignal, not an AbortController.
frontend.documents.toMarkdown(file, { signal: new AbortController() });
// @ts-expect-error No structured error outcome or public error code.
result.error.code;
// @ts-expect-error No documents helper on the backend context.
backend.documents;
void [pending, withOptions, name, markdown, notices, immediate];
`);
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--allowImportingTsExtensions", "--target", "ES2022", "--lib", "ES2023,DOM,DOM.Iterable", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 120_000 });
		assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
