import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "lh-auth-failure-"));
process.env.LH_AUTH_FILE = join(directory, "auth.json");
process.env.LH_DATA_DIR = directory;
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.LH_IGNORE_ENV_KEYS;
const { saveKey } = await import("../src/server/keys.ts");
const route = await import("../app/api/keys/[id]/route.ts");
after(() => rmSync(directory, { recursive: true, force: true }));

it("failed key mutations return safe errors and preserve the file and active credential", async () => {
	const id = "AWS_BEARER_TOKEN_BEDROCK";
	assert.equal(saveKey(id, "fixture-existing-token").ok, true);
	const damaged = '{"OPENAI_API_KEY":"fixture-recoverable",';
	writeFileSync(process.env.LH_AUTH_FILE!, damaged);
	for (const method of ["PUT", "DELETE"] as const) {
		const request = new Request(`http://localhost/api/keys/${id}`, {
			method, ...(method === "PUT" ? { body: JSON.stringify({ value: "fixture-replacement-token" }) } : {}),
		});
		const response = await route[method](request, { params: Promise.resolve({ id }) });
		assert.equal(response.status, 500);
		const body = await response.json();
		assert.match(body.error, /credential file/i);
		assert.ok(!JSON.stringify(body).includes("fixture-"));
		assert.equal(readFileSync(process.env.LH_AUTH_FILE!, "utf8"), damaged);
		assert.equal(process.env[id], "fixture-existing-token");
	}
});
