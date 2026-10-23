import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import config from "../next.config.ts";

describe("desktop OAuth runtime payload", () => {
	it("includes lazy flow modules and their callback page outside Next's static trace", () => {
		const includes = config.outputFileTracingIncludes?.["*"] ?? [];
		assert.ok(includes.includes("node_modules/@earendil-works/pi-ai/dist/auth/oauth/**/*.js"));
		assert.ok(includes.includes("node_modules/@earendil-works/pi-ai/dist/utils/oauth-page.js"));
		const dir = path.resolve("node_modules/@earendil-works/pi-ai/dist/auth/oauth");
		for (const file of ["openai-codex.js", "anthropic.js", "xai.js", "callback-server.js", "device-code.js", "pkce.js"]) {
			assert.ok(fs.existsSync(path.join(dir, file)), file);
		}
	});
	it("keeps connection data under the existing excluded data tree", () => {
		assert.ok(config.outputFileTracingExcludes?.["*"]?.includes("data/**/*"));
	});
});
